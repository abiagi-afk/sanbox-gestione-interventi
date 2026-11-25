import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BOOTSTRAPPED_ADMIN_EMAILS,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_EXEMPT_COMMESSE,
  extractDriveFolderId,
  extractGoogleSheetId,
} from '../types/siteHelpers.ts';
import type {
  Absence,
  AbsenceType,
  AppSettings,
  Article,
  Assignment,
  AssignmentStatus,
  InterventionPhoto,
  OnCallGroup,
  OnCallOverride,
  OnCallOverrideScope,
  OnCallShift,
  PushSubscriptionDoc,
  StaffMember,
  Task,
  TaskColorId,
  TaskStatus,
  UsedMaterial,
  UserProfile,
  UserRole,
} from '../types/siteHelpers.ts';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}

export interface D1PoolClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  release(): void;
}

export interface D1Pool {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  connect(): Promise<D1PoolClient>;
}

interface RequestD1Context {
  db: D1Database | null;
  pool: D1Pool | null;
}

const requestD1Storage = new AsyncLocalStorage<RequestD1Context>();

export function runWithD1Context<T>(
  db: D1Database | undefined | null,
  fn: () => Promise<T>
): Promise<T> {
  const ctx: RequestD1Context = {
    db: db ?? null,
    pool: null,
  };
  return requestD1Storage.run(ctx, fn);
}

function normalizeSqlForD1(
  rawSql: string,
  rawParams: unknown[] = []
): { sql: string; params: unknown[]; isTxControl: boolean; returnsRows: boolean } {
  const trimmed = rawSql.trim().replace(/;+$/, '').trim();
  const upper = trimmed.toUpperCase();

  if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') {
    return { sql: '', params: [], isTxControl: true, returnsRows: false };
  }

  let sql = trimmed.replace(/\bFOR\s+UPDATE\b/gi, '');
  sql = sql.replace(/\bNOW\(\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

  sql = sql.replace(
    /([a-zA-Z0-9_.]+)\s*=\s*ANY\(\$(\d+)(?:::[a-zA-Z0-9_\[\]]+)?\)/gi,
    (_match, col: string, idxStr: string) => {
      const idx = Number(idxStr) - 1;
      const candidate = rawParams[idx];
      const arr = Array.isArray(candidate) ? candidate : [];
      if (arr.length === 0) {
        return '1 = 0';
      }
      const tokens = arr.map((_, j) => `__ARR_${idx}_${j}__`).join(', ');
      return `${col} IN (${tokens})`;
    }
  );

  sql = sql.replace(/::[a-zA-Z0-9_\[\]]+/g, '');

  const boundParams: unknown[] = [];
  sql = sql.replace(/\$(\d+)|__ARR_(\d+)_(\d+)__/g, (_token, pIdx, aIdx, aElemIdx) => {
    let val: unknown;
    if (pIdx !== undefined) {
      const idx = Number(pIdx) - 1;
      val = idx >= 0 && idx < rawParams.length ? rawParams[idx] : null;
    } else {
      const idx = Number(aIdx);
      const j = Number(aElemIdx);
      const arr = Array.isArray(rawParams[idx]) ? (rawParams[idx] as unknown[]) : [];
      val = j >= 0 && j < arr.length ? arr[j] : null;
    }

    if (val === undefined || val === null) {
      boundParams.push(null);
    } else if (typeof val === 'boolean') {
      boundParams.push(val ? 1 : 0);
    } else if (val instanceof Date) {
      boundParams.push(val.toISOString());
    } else if (typeof val === 'object') {
      boundParams.push(JSON.stringify(val));
    } else {
      boundParams.push(val);
    }
    return '?';
  });

  const cleanUpper = sql.trim().toUpperCase();
  const returnsRows =
    cleanUpper.startsWith('SELECT') ||
    cleanUpper.startsWith('WITH') ||
    cleanUpper.startsWith('PRAGMA') ||
    /\bRETURNING\b/i.test(sql);

  return { sql, params: boundParams, isTxControl: false, returnsRows };
}

function createD1Pool(db: D1Database): D1Pool {
  const executeQuery = async <R = Record<string, unknown>>(
    rawSql: string,
    rawParams: unknown[] = []
  ): Promise<QueryResult<R>> => {
    const { sql, params, isTxControl, returnsRows } = normalizeSqlForD1(
      rawSql,
      rawParams
    );
    if (isTxControl || !sql) {
      return { rows: [], rowCount: 0 };
    }

    const prepared = db.prepare(sql);
    const bound = params.length > 0 ? prepared.bind(...params) : prepared;

    if (returnsRows) {
      const res = await bound.all<R>();
      const rows = Array.isArray(res.results) ? res.results : [];
      return { rows, rowCount: rows.length };
    }

    const res = await bound.run();
    const changes = Number(res.meta?.changes ?? 0);
    return { rows: [], rowCount: changes };
  };

  return {
    query: executeQuery,
    async connect(): Promise<D1PoolClient> {
      return {
        query: executeQuery,
        release() {},
      };
    },
  };
}

export async function getReadyD1Pool(): Promise<D1Pool | null> {
  const store = requestD1Storage.getStore();
  if (!store?.db) {
    return null;
  }
  if (!store.pool) {
    store.pool = createD1Pool(store.db);
  }
  return store.pool;
}

export const getReadyNeonPool = getReadyD1Pool;

function toTimestampObj(val: unknown): { seconds: number } | undefined {
  if (!val) return undefined;
  const ms =
    val instanceof Date
      ? val.getTime()
      : typeof val === 'string' || typeof val === 'number'
      ? new Date(val).getTime()
      : NaN;
  if (Number.isNaN(ms)) return undefined;
  return { seconds: Math.floor(ms / 1000) };
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val.map((item) => String(item ?? ''));
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item ?? ''));
      }
    } catch {
      return [];
    }
  }
  return [];
}

export function mapUserRow(row: Record<string, unknown>): UserProfile {
  return {
    uid: String(row.uid || ''),
    email: String(row.email || ''),
    nome: String(row.nome || ''),
    cognome: String(row.cognome || ''),
    role: (row.role === 'admin' ? 'admin' : 'technician') as UserRole,
    active: Boolean(row.active),
    ...(row.directory_member_id
      ? { directoryMemberId: String(row.directory_member_id) }
      : {}),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapDirectoryRow(row: Record<string, unknown>): StaffMember {
  return {
    memberId: String(row.member_id || ''),
    email: String(row.email || ''),
    secondaryEmail: String(row.secondary_email || ''),
    nome: String(row.nome || ''),
    cognome: String(row.cognome || ''),
    role: (row.role === 'admin' ? 'admin' : 'technician') as UserRole,
    active: Boolean(row.active),
    linkedUid: String(row.linked_uid || ''),
    adminUids: asStringArray(row.admin_uids),
    createdByUid: String(row.created_by_uid || ''),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapSettingsRow(row?: Record<string, unknown>): AppSettings {
  if (!row) {
    return {
      exemptCommesse: [...DEFAULT_EXEMPT_COMMESSE],
      driveRootFolderName: 'Gestione Commesse',
      driveSharedFolderId: DEFAULT_DRIVE_SHARED_FOLDER_ID,
      googleSheetId: '',
      operatorColorLabels: {},
      updatedByUid: '',
    };
  }
  let rawLabels: unknown = row.operator_color_labels;
  if (typeof rawLabels === 'string') {
    try {
      rawLabels = JSON.parse(rawLabels);
    } catch {
      rawLabels = {};
    }
  }
  const labels =
    rawLabels &&
    typeof rawLabels === 'object' &&
    !Array.isArray(rawLabels)
      ? (rawLabels as Partial<Record<TaskColorId, string>>)
      : {};
  return {
    exemptCommesse: asStringArray(row.exempt_commesse),
    driveRootFolderName:
      String(row.drive_root_folder_name || '') || 'Gestione Commesse',
    driveSharedFolderId: extractDriveFolderId(
      String(row.drive_shared_folder_id || DEFAULT_DRIVE_SHARED_FOLDER_ID)
    ),
    googleSheetId: extractGoogleSheetId(String(row.google_sheet_id || '')),
    operatorColorLabels: labels,
    updatedByUid: String(row.updated_by_uid || ''),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapArticleRow(row: Record<string, unknown>): Article {
  return {
    articleId: String(row.article_id || ''),
    codiceArticolo: String(row.codice_articolo || ''),
    descrizione: String(row.descrizione || ''),
    categoria: String(row.categoria || ''),
    unitaMisura: String(row.unita_misura || 'pz'),
    active: Boolean(row.active),
    adminUids: asStringArray(row.admin_uids),
    createdByUid: String(row.created_by_uid || ''),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    taskId: String(row.task_id || ''),
    taskCode: String(row.task_code || ''),
    commessa: String(row.commessa || ''),
    descrizione: String(row.descrizione || ''),
    inizio: String(row.inizio || ''),
    inizioMs: Number(row.inizio_ms || 0),
    fine: String(row.fine || ''),
    fineMs: Number(row.fine_ms || 0),
    statoPrevalente: String(row.stato_prevalente || 'Assegnato') as TaskStatus,
    assignedEmails: asStringArray(row.assigned_emails),
    assignedAclEmails: asStringArray(row.assigned_acl_emails),
    assignedNames: asStringArray(row.assigned_names),
    assignedDeliverableEmails: asStringArray(row.assigned_deliverable_emails),
    assignedStatuses: asStringArray(row.assigned_statuses) as AssignmentStatus[],
    assignedNotes: asStringArray(row.assigned_notes),
    adminUids: asStringArray(row.admin_uids),
    adminEmails: asStringArray(row.admin_emails),
    altroReparto: Boolean(row.altro_reparto),
    pendingAdminReview: Boolean(row.pending_admin_review),
    colorId: (String(row.color_id || 'peacock') || 'peacock') as TaskColorId,
    createdByRole: (row.created_by_role === 'technician'
      ? 'technician'
      : 'admin') as UserRole,
    createdByUid: String(row.created_by_uid || ''),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapAssignmentRow(row: Record<string, unknown>): Assignment {
  return {
    assignmentId: String(row.assignment_id || ''),
    assignmentCode: String(row.assignment_code || ''),
    taskId: String(row.task_id || ''),
    commessa: String(row.commessa || ''),
    descrizioneTask: String(row.descrizione_task || ''),
    inizio: String(row.inizio || ''),
    inizioMs: Number(row.inizio_ms || 0),
    fine: String(row.fine || ''),
    fineMs: Number(row.fine_ms || 0),
    technicianEmail: String(row.technician_email || ''),
    technicianName: String(row.technician_name || ''),
    technicianUid: String(row.technician_uid || ''),
    technicianAliasEmails: asStringArray(row.technician_alias_emails),
    stato: String(row.stato || 'Assegnato') as AssignmentStatus,
    noteTecnico: String(row.note_tecnico || ''),
    adminUids: asStringArray(row.admin_uids),
    squadEmails: asStringArray(row.squad_emails),
    squadNames: asStringArray(row.squad_names),
    squadDeliverableEmails: asStringArray(row.squad_deliverable_emails),
    colorId: (String(row.color_id || 'peacock') || 'peacock') as TaskColorId,
    createdByUid: String(row.created_by_uid || ''),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapUsedMaterialRow(row: Record<string, unknown>): UsedMaterial {
  return {
    usedId: String(row.used_id || ''),
    assignmentId: String(row.assignment_id || ''),
    taskId: String(row.task_id || ''),
    commessa: String(row.commessa || ''),
    technicianEmail: String(row.technician_email || ''),
    technicianName: String(row.technician_name || ''),
    technicianUid: String(row.technician_uid || ''),
    articleId: String(row.article_id || ''),
    codiceArticolo: String(row.codice_articolo || ''),
    descrizioneArticolo: String(row.descrizione_articolo || ''),
    categoria: String(row.categoria || ''),
    unitaMisura: String(row.unita_misura || 'pz'),
    quantita: Number(row.quantita || 0),
    adminUids: asStringArray(row.admin_uids),
    squadEmails: asStringArray(row.squad_emails),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapInterventionPhotoRow(
  row: Record<string, unknown>
): InterventionPhoto {
  return {
    photoId: String(row.photo_id || ''),
    assignmentId: String(row.assignment_id || ''),
    taskId: String(row.task_id || ''),
    commessa: String(row.commessa || ''),
    technicianEmail: String(row.technician_email || ''),
    technicianName: String(row.technician_name || ''),
    technicianUid: String(row.technician_uid || ''),
    fileName: String(row.file_name || ''),
    driveFileId: String(row.drive_file_id || ''),
    driveWebViewLink: String(row.drive_web_view_link || ''),
    driveThumbnailLink: String(row.drive_thumbnail_link || ''),
    folderPath: String(row.folder_path || ''),
    caption: String(row.caption || ''),
    adminUids: asStringArray(row.admin_uids),
    squadEmails: asStringArray(row.squad_emails),
    driveSubfolderId: String(row.drive_subfolder_id || ''),
    ownerConsolidated: Boolean(row.owner_consolidated),
    pendingCleanupFileId: String(row.pending_cleanup_file_id || ''),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapAbsenceRow(row: Record<string, unknown>): Absence {
  return {
    absenceId: String(row.absence_id || ''),
    technicianEmail: String(row.technician_email || ''),
    technicianName: String(row.technician_name || ''),
    technicianUid: String(row.technician_uid || ''),
    tipo: String(row.tipo || 'Altro') as AbsenceType,
    allDay: Boolean(row.all_day),
    inizio: String(row.inizio || ''),
    inizioMs: Number(row.inizio_ms || 0),
    fine: String(row.fine || ''),
    fineMs: Number(row.fine_ms || 0),
    note: String(row.note || ''),
    adminUids: asStringArray(row.admin_uids),
    createdByUid: String(row.created_by_uid || ''),
    createdByRole: (row.created_by_role === 'admin'
      ? 'admin'
      : 'technician') as UserRole,
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapOnCallShiftRow(row: Record<string, unknown>): OnCallShift {
  const grp = row.group_name === 'coordinators' ? 'coordinators' : 'technicians';
  return {
    shiftId: String(row.shift_id || ''),
    group: grp as OnCallGroup,
    weekStartDate: String(row.week_start_date || ''),
    startsAt0700: Boolean(row.starts_at_0700),
    inizio: String(row.inizio || ''),
    inizioMs: Number(row.inizio_ms || 0),
    fine: String(row.fine || ''),
    fineMs: Number(row.fine_ms || 0),
    technicianEmail: String(row.technician_email || ''),
    technicianName: String(row.technician_name || ''),
    technicianUid: String(row.technician_uid || ''),
    note: String(row.note || ''),
    adminUids: asStringArray(row.admin_uids),
    createdByUid: String(row.created_by_uid || ''),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapOnCallOverrideRow(row: Record<string, unknown>): OnCallOverride {
  const grp = row.group_name === 'coordinators' ? 'coordinators' : 'technicians';
  const rawScope = String(row.scope || 'daily');
  const scope: OnCallOverrideScope =
    rawScope === 'full' || rawScope === 'hourly' ? rawScope : 'daily';
  return {
    overrideId: String(row.override_id || ''),
    shiftId: String(row.shift_id || ''),
    group: grp as OnCallGroup,
    scope,
    inizio: String(row.inizio || ''),
    inizioMs: Number(row.inizio_ms || 0),
    fine: String(row.fine || ''),
    fineMs: Number(row.fine_ms || 0),
    originalTechnicianEmail: String(row.original_technician_email || ''),
    originalTechnicianName: String(row.original_technician_name || ''),
    substituteTechnicianEmail: String(row.substitute_technician_email || ''),
    substituteTechnicianName: String(row.substitute_technician_name || ''),
    substituteTechnicianUid: String(row.substitute_technician_uid || ''),
    note: String(row.note || ''),
    adminUids: asStringArray(row.admin_uids),
    createdByUid: String(row.created_by_uid || ''),
    createdByName: String(row.created_by_name || ''),
    createdByRole: (row.created_by_role === 'admin'
      ? 'admin'
      : 'technician') as UserRole,
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export function mapPushSubscriptionRow(
  row: Record<string, unknown>
): PushSubscriptionDoc {
  return {
    subId: String(row.sub_id || ''),
    ownerUid: String(row.owner_uid || ''),
    endpoint: String(row.endpoint || ''),
    p256dh: String(row.p256dh || ''),
    auth: String(row.auth || ''),
    deviceLabel: String(row.device_label || 'Dispositivo Admin'),
    active: Boolean(row.active),
    adminUids: asStringArray(row.admin_uids),
    createdAt: toTimestampObj(row.created_at),
    updatedAt: toTimestampObj(row.updated_at),
  };
}

export async function fetchActivePushSubscriptionsFromNeon(
  deadEndpoints: ReadonlySet<string> = new Set()
): Promise<
  Array<{
    subId: string;
    ownerUid: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel: string;
  }>
> {
  const pool = await getReadyD1Pool();
  if (!pool) return [];
  const res = await pool.query(
    `SELECT sub_id, owner_uid, endpoint, p256dh, auth, device_label
     FROM site_push_subscriptions
     WHERE active = 1
     ORDER BY updated_at DESC
     LIMIT 50`
  );
  const subs: Array<{
    subId: string;
    ownerUid: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel: string;
  }> = [];
  for (const row of res.rows) {
    const endpoint = String(row.endpoint || '');
    const subId = String(row.sub_id || '');
    const p256dh = String(row.p256dh || '');
    const auth = String(row.auth || '');
    if (subId && endpoint && p256dh && auth && !deadEndpoints.has(endpoint)) {
      subs.push({
        subId,
        ownerUid: String(row.owner_uid || ''),
        endpoint,
        p256dh,
        auth,
        deviceLabel: String(row.device_label || 'Dispositivo Admin'),
      });
    }
  }
  return subs;
}

export interface EmailOutboxEntry {
  outboxId: string;
  to: string[];
  cc: string[];
  replyTo: string;
  senderDisplayName: string;
  subject: string;
  bodyText: string;
  createdByUid: string;
  createdByEmail: string;
  status: 'pending' | 'sent' | 'error';
  sentChannel: string;
  lastError: string;
  createdAtIso: string;
}

export async function isVerifiedAdminInNeon(
  uid: string,
  email: string
): Promise<boolean> {
  const cleanEmail = email.trim().toLowerCase();
  if (
    (BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]).some(
      (adm) => adm.toLowerCase() === cleanEmail
    )
  ) {
    return true;
  }
  const pool = await getReadyD1Pool();
  if (!pool) return false;

  const adminCheck = await pool.query(
    `SELECT 1 FROM site_admins WHERE uid = $1 OR LOWER(email) = $2 LIMIT 1`,
    [uid, cleanEmail]
  );
  if ((adminCheck.rowCount || 0) > 0) return true;

  const dirCheck = await pool.query(
    `SELECT 1 FROM site_directory
     WHERE active = 1 AND role = 'admin'
       AND (LOWER(email) = $1 OR LOWER(secondary_email) = $1)
     LIMIT 1`,
    [cleanEmail]
  );
  return (dirCheck.rowCount || 0) > 0;
}

export async function enqueueEmailOutboxEntry(params: {
  outboxId: string;
  to: string[];
  cc: string[];
  replyTo?: string;
  senderDisplayName: string;
  subject: string;
  bodyText: string;
  createdByUid: string;
  createdByEmail: string;
  lastError?: string;
}): Promise<string | null> {
  const pool = await getReadyD1Pool();
  if (!pool) return null;

  await pool.query(
    `INSERT INTO site_email_outbox (
       outbox_id, to_emails, cc_emails, reply_to, sender_display_name,
       subject, body_text, created_by_uid, created_by_email,
       status, last_error, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW(), NOW())`,
    [
      params.outboxId,
      JSON.stringify(params.to),
      JSON.stringify(params.cc),
      params.replyTo || '',
      params.senderDisplayName,
      params.subject,
      params.bodyText,
      params.createdByUid,
      params.createdByEmail.trim().toLowerCase(),
      (params.lastError || '').slice(0, 500),
    ]
  );

  return params.outboxId;
}

export async function fetchPendingEmailOutboxSummary(limit = 25): Promise<{
  pendingCount: number;
  items: EmailOutboxEntry[];
}> {
  const pool = await getReadyD1Pool();
  if (!pool) {
    return { pendingCount: 0, items: [] };
  }

  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM site_email_outbox WHERE status = 'pending'`
  );
  const pendingCount = Number(countRes.rows[0]?.cnt || 0);
  if (pendingCount === 0) {
    return { pendingCount: 0, items: [] };
  }

  const rowsRes = await pool.query(
    `SELECT outbox_id, to_emails, cc_emails, reply_to, sender_display_name,
            subject, body_text, created_by_uid, created_by_email,
            status, sent_channel, last_error, created_at
     FROM site_email_outbox
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 50))]
  );

  const items: EmailOutboxEntry[] = rowsRes.rows.map((row) => ({
    outboxId: String(row.outbox_id || ''),
    to: asStringArray(row.to_emails),
    cc: asStringArray(row.cc_emails),
    replyTo: String(row.reply_to || ''),
    senderDisplayName: String(row.sender_display_name || ''),
    subject: String(row.subject || ''),
    bodyText: String(row.body_text || ''),
    createdByUid: String(row.created_by_uid || ''),
    createdByEmail: String(row.created_by_email || ''),
    status: 'pending',
    sentChannel: String(row.sent_channel || ''),
    lastError: String(row.last_error || ''),
    createdAtIso: String(row.created_at || new Date().toISOString()),
  }));

  return { pendingCount, items };
}

export async function fetchAutoRetryableOutboxItems(
  limit = 10
): Promise<EmailOutboxEntry[]> {
  const pool = await getReadyD1Pool();
  if (!pool) return [];

  const rowsRes = await pool.query(
    `SELECT outbox_id, to_emails, cc_emails, reply_to, sender_display_name,
            subject, body_text, created_by_uid, created_by_email,
            status, sent_channel, last_error, created_at
     FROM site_email_outbox
     WHERE status = 'pending' AND attempt_count < 25
     ORDER BY created_at ASC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 25))]
  );

  return rowsRes.rows.map((row) => ({
    outboxId: String(row.outbox_id || ''),
    to: asStringArray(row.to_emails),
    cc: asStringArray(row.cc_emails),
    replyTo: String(row.reply_to || ''),
    senderDisplayName: String(row.sender_display_name || ''),
    subject: String(row.subject || ''),
    bodyText: String(row.body_text || ''),
    createdByUid: String(row.created_by_uid || ''),
    createdByEmail: String(row.created_by_email || ''),
    status: 'pending',
    sentChannel: String(row.sent_channel || ''),
    lastError: String(row.last_error || ''),
    createdAtIso: String(row.created_at || new Date().toISOString()),
  }));
}

export async function markEmailOutboxSent(
  outboxId: string,
  sentChannel: string
): Promise<void> {
  const pool = await getReadyD1Pool();
  if (!pool) return;
  await pool.query(
    `UPDATE site_email_outbox
     SET status = 'sent',
         sent_channel = $2,
         last_error = '',
         sent_at = NOW(),
         updated_at = NOW()
     WHERE outbox_id = $1`,
    [outboxId, sentChannel]
  );
}

export async function markEmailOutboxError(
  outboxId: string,
  errorMsg: string
): Promise<void> {
  const pool = await getReadyD1Pool();
  if (!pool) return;
  await pool.query(
    `UPDATE site_email_outbox
     SET last_error = $2,
         attempt_count = attempt_count + 1,
         updated_at = NOW()
     WHERE outbox_id = $1`,
    [outboxId, errorMsg.slice(0, 500)]
  );
}
