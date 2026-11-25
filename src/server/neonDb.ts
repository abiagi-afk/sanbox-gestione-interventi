import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from '@neondatabase/serverless';
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

interface RequestDbContext {
  connectionString: string;
  pool: Pool | null;
}

const requestDbStorage = new AsyncLocalStorage<RequestDbContext>();
let schemaVerifiedForHost = '';

export function runWithNeonContext<T>(
  rawDatabaseUrl: string | undefined,
  fn: () => Promise<T>
): { promise: Promise<T>; cleanup: () => Promise<void> } {
  const cfg = resolveNeonConnectionString(rawDatabaseUrl);
  const ctx: RequestDbContext = {
    connectionString: cfg.configured ? cfg.connectionString : '',
    pool: null,
  };
  const promise = requestDbStorage.run(ctx, fn);
  const cleanup = async () => {
    if (ctx.pool) {
      await ctx.pool.end().catch(() => undefined);
      ctx.pool = null;
    }
  };
  return { promise, cleanup };
}

export interface ResolvedNeonConfig {
  configured: boolean;
  connectionString: string;
  hostHint: string;
}

export function resolveNeonConnectionString(
  explicitUrl?: string
): ResolvedNeonConfig {
  const store = requestDbStorage.getStore();
  const rawCandidate = (
    explicitUrl ||
    store?.connectionString ||
    (typeof process !== 'undefined' ? process.env?.NEON_DATABASE_URL : '') ||
    (typeof process !== 'undefined' ? process.env?.DATABASE_URL : '') ||
    ''
  ).trim();

  if (!rawCandidate) {
    return { configured: false, connectionString: '', hostHint: '' };
  }

  let cleaned = rawCandidate;
  if (/^psql\s+/i.test(cleaned)) {
    cleaned = cleaned.replace(/^psql\s+/i, '').trim();
  }
  cleaned = cleaned.replace(/^['"`]+|['"`]+$/g, '').trim();

  const embeddedMatch = cleaned.match(/postgres(?:ql)?:\/\/[^\s'"`]+/i);
  if (embeddedMatch && embeddedMatch[0]) {
    cleaned = embeddedMatch[0];
  }

  const upper = cleaned.toUpperCase();
  if (
    cleaned.length < 16 ||
    cleaned === '123' ||
    upper.startsWith('MY_') ||
    upper.startsWith('YOUR_') ||
    cleaned.includes('ep-example.eu-central-1.aws.neon.tech')
  ) {
    return { configured: false, connectionString: '', hostHint: '' };
  }

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return { configured: false, connectionString: '', hostHint: '' };
    }
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('channel_binding');
    return {
      configured: true,
      connectionString: parsed.toString(),
      hostHint: parsed.hostname,
    };
  } catch {
    return { configured: false, connectionString: '', hostHint: '' };
  }
}

export async function getReadyNeonPool(): Promise<Pool | null> {
  const store = requestDbStorage.getStore();
  const cfg = resolveNeonConnectionString();
  if (!cfg.configured) {
    return null;
  }

  if (store) {
    if (!store.pool) {
      store.pool = new Pool({ connectionString: cfg.connectionString });
    }
    if (schemaVerifiedForHost !== cfg.hostHint) {
      await ensureNeonSchema(store.pool);
      schemaVerifiedForHost = cfg.hostHint;
    }
    return store.pool;
  }

  const fallbackPool = new Pool({ connectionString: cfg.connectionString });
  await ensureNeonSchema(fallbackPool);
  return fallbackPool;
}

async function ensureNeonSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_admins (
      uid TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      granted_by_uid TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_users (
      uid TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      role TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      directory_member_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_directory (
      member_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      secondary_email TEXT NOT NULL DEFAULT '',
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      role TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      linked_uid TEXT NOT NULL DEFAULT '',
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by_uid TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      config_id TEXT PRIMARY KEY,
      exempt_commesse JSONB NOT NULL DEFAULT '[]'::jsonb,
      drive_root_folder_name TEXT NOT NULL DEFAULT 'Gestione Commesse',
      drive_shared_folder_id TEXT NOT NULL DEFAULT '',
      google_sheet_id TEXT NOT NULL DEFAULT '',
      operator_color_labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by_uid TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE site_settings
      ADD COLUMN IF NOT EXISTS google_sheet_id TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS site_articles (
      article_id TEXT PRIMARY KEY,
      codice_articolo TEXT NOT NULL,
      descrizione TEXT NOT NULL,
      categoria TEXT NOT NULL,
      unita_misura TEXT NOT NULL DEFAULT 'pz',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by_uid TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_tasks (
      task_id TEXT PRIMARY KEY,
      task_code TEXT NOT NULL,
      commessa TEXT NOT NULL DEFAULT '',
      descrizione TEXT NOT NULL,
      inizio TEXT NOT NULL,
      inizio_ms BIGINT NOT NULL,
      fine TEXT NOT NULL,
      fine_ms BIGINT NOT NULL,
      stato_prevalente TEXT NOT NULL,
      assigned_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_acl_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_deliverable_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_statuses JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      admin_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      altro_reparto BOOLEAN NOT NULL DEFAULT FALSE,
      pending_admin_review BOOLEAN NOT NULL DEFAULT FALSE,
      color_id TEXT NOT NULL DEFAULT 'peacock',
      created_by_role TEXT NOT NULL DEFAULT 'admin',
      created_by_uid TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_assignments (
      assignment_id TEXT PRIMARY KEY,
      assignment_code TEXT NOT NULL,
      task_id TEXT NOT NULL,
      commessa TEXT NOT NULL DEFAULT '',
      descrizione_task TEXT NOT NULL,
      inizio TEXT NOT NULL,
      inizio_ms BIGINT NOT NULL,
      fine TEXT NOT NULL,
      fine_ms BIGINT NOT NULL,
      technician_email TEXT NOT NULL,
      technician_name TEXT NOT NULL,
      technician_uid TEXT NOT NULL DEFAULT '',
      technician_alias_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      stato TEXT NOT NULL,
      note_tecnico TEXT NOT NULL DEFAULT '',
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      squad_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      squad_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      squad_deliverable_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      color_id TEXT NOT NULL DEFAULT 'peacock',
      created_by_uid TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_used_materials (
      used_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      commessa TEXT NOT NULL DEFAULT '',
      technician_email TEXT NOT NULL,
      technician_name TEXT NOT NULL,
      technician_uid TEXT NOT NULL DEFAULT '',
      article_id TEXT NOT NULL,
      codice_articolo TEXT NOT NULL,
      descrizione_articolo TEXT NOT NULL,
      categoria TEXT NOT NULL,
      unita_misura TEXT NOT NULL DEFAULT 'pz',
      quantita DOUBLE PRECISION NOT NULL,
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      squad_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_intervention_photos (
      photo_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      commessa TEXT NOT NULL DEFAULT '',
      technician_email TEXT NOT NULL,
      technician_name TEXT NOT NULL,
      technician_uid TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL,
      drive_file_id TEXT NOT NULL,
      drive_web_view_link TEXT NOT NULL,
      drive_thumbnail_link TEXT NOT NULL DEFAULT '',
      folder_path TEXT NOT NULL DEFAULT '',
      caption TEXT NOT NULL DEFAULT '',
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      squad_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      drive_subfolder_id TEXT NOT NULL DEFAULT '',
      owner_consolidated BOOLEAN NOT NULL DEFAULT FALSE,
      pending_cleanup_file_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_absences (
      absence_id TEXT PRIMARY KEY,
      technician_email TEXT NOT NULL,
      technician_name TEXT NOT NULL,
      technician_uid TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL,
      all_day BOOLEAN NOT NULL DEFAULT TRUE,
      inizio TEXT NOT NULL,
      inizio_ms BIGINT NOT NULL,
      fine TEXT NOT NULL,
      fine_ms BIGINT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by_uid TEXT NOT NULL DEFAULT '',
      created_by_role TEXT NOT NULL DEFAULT 'technician',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_push_subscriptions (
      sub_id TEXT PRIMARY KEY,
      owner_uid TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      device_label TEXT NOT NULL DEFAULT 'Dispositivo Admin',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_email_outbox (
      outbox_id TEXT PRIMARY KEY,
      to_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      cc_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
      reply_to TEXT NOT NULL DEFAULT '',
      sender_display_name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL,
      created_by_uid TEXT NOT NULL DEFAULT '',
      created_by_email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      sent_channel TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      attempt_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE site_email_outbox
      ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_site_assignments_task_id ON site_assignments (task_id);
    CREATE INDEX IF NOT EXISTS idx_site_materials_task_id ON site_used_materials (task_id);
    CREATE INDEX IF NOT EXISTS idx_site_photos_task_id ON site_intervention_photos (task_id);
    CREATE INDEX IF NOT EXISTS idx_site_tasks_inizio_ms ON site_tasks (inizio_ms);
    CREATE INDEX IF NOT EXISTS idx_site_absences_inizio_ms ON site_absences (inizio_ms);
    CREATE INDEX IF NOT EXISTS idx_site_email_outbox_status_created ON site_email_outbox (status, created_at ASC);

    CREATE TABLE IF NOT EXISTS site_on_call_shifts (
  shift_id TEXT PRIMARY KEY,
  group_name TEXT NOT NULL DEFAULT 'technicians',
  week_start_date TEXT NOT NULL,
  starts_at_0700 BOOLEAN NOT NULL DEFAULT FALSE,
  inizio TEXT NOT NULL,
  inizio_ms BIGINT NOT NULL,
  fine TEXT NOT NULL,
  fine_ms BIGINT NOT NULL,
  technician_email TEXT NOT NULL,
  technician_name TEXT NOT NULL,
  technician_uid TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_uid TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_name, week_start_date)
);

CREATE TABLE IF NOT EXISTS site_on_call_overrides (
  override_id TEXT PRIMARY KEY,
  shift_id TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'technicians',
  scope TEXT NOT NULL DEFAULT 'daily',
  inizio TEXT NOT NULL,
  inizio_ms BIGINT NOT NULL,
  fine TEXT NOT NULL,
  fine_ms BIGINT NOT NULL,
  original_technician_email TEXT NOT NULL DEFAULT '',
  original_technician_name TEXT NOT NULL DEFAULT '',
  substitute_technician_email TEXT NOT NULL,
  substitute_technician_name TEXT NOT NULL,
  substitute_technician_uid TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  admin_uids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_uid TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_by_role TEXT NOT NULL DEFAULT 'technician',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_on_call_shifts_inizio_ms ON site_on_call_shifts (inizio_ms);
CREATE INDEX IF NOT EXISTS idx_site_on_call_overrides_shift_id ON site_on_call_overrides (shift_id);
CREATE INDEX IF NOT EXISTS idx_site_on_call_overrides_inizio_ms ON site_on_call_overrides (inizio_ms);
  `);
}

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
  if (!Array.isArray(val)) return [];
  return val.map((item) => String(item ?? ''));
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
  const labels =
    row.operator_color_labels &&
    typeof row.operator_color_labels === 'object' &&
    !Array.isArray(row.operator_color_labels)
      ? (row.operator_color_labels as Partial<Record<TaskColorId, string>>)
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
  const pool = await getReadyNeonPool();
  if (!pool) return [];
  const res = await pool.query(
    `SELECT sub_id, owner_uid, endpoint, p256dh, auth, device_label
     FROM site_push_subscriptions
     WHERE active = TRUE
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
  const pool = await getReadyNeonPool();
  if (!pool) return false;

  const adminCheck = await pool.query(
    `SELECT 1 FROM site_admins WHERE uid = $1 OR LOWER(email) = $2 LIMIT 1`,
    [uid, cleanEmail]
  );
  if ((adminCheck.rowCount || 0) > 0) return true;

  const dirCheck = await pool.query(
    `SELECT 1 FROM site_directory
     WHERE active = TRUE AND role = 'admin'
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
  const pool = await getReadyNeonPool();
  if (!pool) return null;

  await pool.query(
    `INSERT INTO site_email_outbox (
       outbox_id, to_emails, cc_emails, reply_to, sender_display_name,
       subject, body_text, created_by_uid, created_by_email,
       status, last_error, created_at, updated_at
     ) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9, 'pending', $10, NOW(), NOW())`,
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
  const pool = await getReadyNeonPool();
  if (!pool) {
    return { pendingCount: 0, items: [] };
  }

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM site_email_outbox WHERE status = 'pending'`
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
    createdAtIso:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at || new Date().toISOString()),
  }));

  return { pendingCount, items };
}

export async function fetchAutoRetryableOutboxItems(
  limit = 10
): Promise<EmailOutboxEntry[]> {
  const pool = await getReadyNeonPool();
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
    createdAtIso:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at || new Date().toISOString()),
  }));
}

export async function markEmailOutboxSent(
  outboxId: string,
  sentChannel: string
): Promise<void> {
  const pool = await getReadyNeonPool();
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
  const pool = await getReadyNeonPool();
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

