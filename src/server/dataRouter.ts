import { Hono, type Context } from 'hono';
import type { D1Pool as Pool, D1PoolClient as PoolClient } from './d1Db.ts';
import {
  ABSENCE_TYPES,
  areSameTechnicianEmails,
  BOOTSTRAPPED_ADMIN_EMAILS,
  buildTechnicianEmailAliases,
  canonicalSiteBaseEmail,
  canonicalTechnicianKey,
  computeOnCallWeekWindow,
  computeTaskPrevalentStatus,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_EXEMPT_COMMESSE,
  EXCEL_ON_CALL_PRESET_2025_2028,
  expandSquadAclEmails,
  extractDriveFolderId,
  extractGoogleSheetId,
  findStaffMemberByAnyEmail,
  getDeliverableEmail,
  isAssignmentOwnedByViewer,
  isEligibleForOnCallGroup,
  isLoginOnlyIdEmail,
  isWorkspaceDriveEmail,
  ON_CALL_GROUPS,
  ON_CALL_OVERRIDE_SCOPES,
  TASK_COLOR_IDS,
  VALIDATION_LIMITS,
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
  StaffMember,
  Task,
  TaskColorId,
  TaskStatus,
  UsedMaterial,
  UserProfile,
  UserRole,
} from '../types/siteHelpers.ts';
import {
  getReadyD1Pool,
  mapAbsenceRow,
  mapArticleRow,
  mapAssignmentRow,
  mapDirectoryRow,
  mapInterventionPhotoRow,
  mapOnCallOverrideRow,
  mapOnCallShiftRow,
  mapSettingsRow,
  mapTaskRow,
  mapUsedMaterialRow,
  mapUserRow,
} from './d1Db.ts';

export interface VerifiedServerUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

export type VerifyBearerFn = (
  authHeader?: string
) => Promise<{ token: string; user: VerifiedServerUser } | null>;

export type BroadcastSyncFn = (scopes: string[], actorUid?: string) => void;

function makeSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  const raw = `${prefix}_${ts}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
  return raw.slice(0, VALIDATION_LIMITS.ID_MAX_LEN);
}

function normalizeEmail(email?: string | null): string {
  return String(email || '')
    .trim()
    .toLowerCase()
    .slice(0, VALIDATION_LIMITS.EMAIL_MAX_LEN);
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const trimmed = String(val ?? '').trim();
  if (!trimmed && fallback) return fallback.slice(0, maxLen);
  return trimmed.slice(0, maxLen);
}

function splitDisplayName(
  displayName: string | null | undefined,
  email: string
): { nome: string; cognome: string } {
  const cleaned = String(displayName || '').trim();
  if (cleaned) {
    const parts = cleaned.split(/\s+/);
    const nome = clampStr(
      parts[0] || 'Utente',
      VALIDATION_LIMITS.NAME_MAX_LEN,
      'Utente'
    );
    const cognome = clampStr(
      parts.slice(1).join(' ') || '-',
      VALIDATION_LIMITS.NAME_MAX_LEN,
      '-'
    );
    return { nome, cognome };
  }
  const local = (email.split('@')[0] || 'utente').replace(/\.id$/i, '');
  const dotParts = local.split('.');
  const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
  return {
    nome: clampStr(
      cap(dotParts[0]) || 'Utente',
      VALIDATION_LIMITS.NAME_MAX_LEN,
      'Utente'
    ),
    cognome: clampStr(
      cap(dotParts.slice(1).join(' ')) || 'SITE',
      VALIDATION_LIMITS.NAME_MAX_LEN,
      'SITE'
    ),
  };
}

function extractTsSeconds(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const maybe = raw as { seconds?: number };
  return typeof maybe.seconds === 'number' ? maybe.seconds : 0;
}

async function resolveCallerRole(
  clientOrPool: Pool | PoolClient,
  user: VerifiedServerUser,
  preloadedDirectory?: StaffMember[]
): Promise<{ isAdmin: boolean; directory: StaffMember[] }> {
  const email = normalizeEmail(user.email);
  const canonical = canonicalSiteBaseEmail(email);
  const isBootstrapped = (
    BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]
  ).includes(canonical);

  const directory =
    preloadedDirectory ??
    (
      await clientOrPool.query(
        `SELECT * FROM site_directory ORDER BY cognome ASC, nome ASC`
      )
    ).rows.map(mapDirectoryRow);

  if (isBootstrapped) {
    return { isAdmin: true, directory };
  }

  const adminGrant = await clientOrPool.query(
    `SELECT uid FROM site_admins WHERE uid = $1 LIMIT 1`,
    [user.uid]
  );
  if (adminGrant.rowCount && adminGrant.rowCount > 0) {
    return { isAdmin: true, directory };
  }

  const matchedDir =
    directory.find((m) => m.linkedUid === user.uid) ||
    findStaffMemberByAnyEmail(email, directory);

  if (matchedDir && matchedDir.role === 'admin' && matchedDir.active) {
    return { isAdmin: true, directory };
  }

  return { isAdmin: false, directory };
}

interface SelectedAssigneePayload {
  email: string;
  fullName: string;
  linkedUid: string;
  deliverableEmail?: string;
}

function computeSquadTransitionServer(params: {
  freshAsg: Assignment;
  siblingList: Assignment[];
  freshTask?: Task;
  newStatus: AssignmentStatus;
  cleanNote: string;
  directory: StaffMember[];
}): {
  taskBecameCompleted: boolean;
  nextTaskStatus: TaskStatus;
  completedCount: number;
  totalSquadCount: number;
  nextAssignedStatuses: AssignmentStatus[];
  nextAssignedNotes: string[];
  authoritativeTask?: Task;
  squadNotesByEmail: Record<string, string>;
} {
  const {
    freshAsg,
    siblingList,
    freshTask,
    newStatus,
    cleanNote,
    directory,
  } = params;

  const effectiveActorEmail = normalizeEmail(freshAsg.technicianEmail);
  const effectiveActorCanon = canonicalTechnicianKey(
    effectiveActorEmail,
    directory
  );

  const freshSibByCanon = new Map<string, Assignment>();
  for (const sd of siblingList) {
    if (
      !sd.assignmentId ||
      sd.assignmentId === freshAsg.assignmentId ||
      sd.stato === 'Annullato'
    ) {
      continue;
    }
    const canon = canonicalTechnicianKey(sd.technicianEmail, directory);
    if (!canon || canon === effectiveActorCanon) continue;
    const prev = freshSibByCanon.get(canon);
    if (
      !prev ||
      extractTsSeconds(sd.updatedAt) >= extractTsSeconds(prev.updatedAt)
    ) {
      freshSibByCanon.set(canon, sd);
    }
  }

  const orderedSquadRoster: Array<{
    canonKey: string;
    email: string;
    taskSlotIdx: number;
  }> = [];
  const seenCanon = new Set<string>();

  const pushRosterMember = (rawEm: string, taskSlotIdx: number) => {
    const em = normalizeEmail(rawEm);
    const canon = canonicalTechnicianKey(em, directory);
    if (!em || !canon || seenCanon.has(canon)) return;
    seenCanon.add(canon);
    orderedSquadRoster.push({ canonKey: canon, email: em, taskSlotIdx });
  };

  if (freshTask?.assignedEmails && freshTask.assignedEmails.length > 0) {
    freshTask.assignedEmails.forEach((em, idx) => pushRosterMember(em, idx));
  } else if (
    freshAsg.squadEmails &&
    freshAsg.squadNames &&
    freshAsg.squadEmails.length === freshAsg.squadNames.length &&
    freshAsg.squadEmails.length > 0
  ) {
    freshAsg.squadEmails.forEach((em, idx) => pushRosterMember(em, idx));
  }

  if (effectiveActorEmail) {
    pushRosterMember(effectiveActorEmail, -1);
  }
  for (const sib of freshSibByCanon.values()) {
    pushRosterMember(sib.technicianEmail, -1);
  }

  const trimmedRoster = orderedSquadRoster.slice(
    0,
    VALIDATION_LIMITS.MAX_BOUNDED_ARRAY
  );

  const squadNotesByEmail: Record<string, string> = {};

  const prevSquadStatuses: AssignmentStatus[] = trimmedRoster.map((slot) => {
    if (slot.canonKey === effectiveActorCanon) {
      return freshAsg.stato;
    }
    const sib = freshSibByCanon.get(slot.canonKey);
    if (sib) return sib.stato;
    const rawSlot =
      slot.taskSlotIdx >= 0
        ? freshTask?.assignedStatuses?.[slot.taskSlotIdx]
        : undefined;
    if (
      rawSlot === 'Assegnato' ||
      rawSlot === 'Preso in Carico' ||
      rawSlot === 'Completato'
    ) {
      return rawSlot;
    }
    return 'Assegnato';
  });

  const nextAssignedStatuses: AssignmentStatus[] = trimmedRoster.map((slot) => {
    if (slot.canonKey === effectiveActorCanon) {
      squadNotesByEmail[slot.email] = cleanNote;
      if (effectiveActorEmail && effectiveActorEmail !== slot.email) {
        squadNotesByEmail[effectiveActorEmail] = cleanNote;
      }
      return newStatus;
    }

    const sib = freshSibByCanon.get(slot.canonKey);
    const slotNote =
      slot.taskSlotIdx >= 0
        ? clampStr(
            freshTask?.assignedNotes?.[slot.taskSlotIdx] || '',
            VALIDATION_LIMITS.NOTE_MAX_LEN
          )
        : '';
    const sibNote = sib
      ? clampStr(sib.noteTecnico || '', VALIDATION_LIMITS.NOTE_MAX_LEN)
      : '';
    const resolvedNote = sib ? sibNote || slotNote : slotNote;
    squadNotesByEmail[slot.email] = resolvedNote;
    if (sib) {
      const normSibEm = normalizeEmail(sib.technicianEmail);
      if (normSibEm) squadNotesByEmail[normSibEm] = resolvedNote;
      return sib.stato;
    }

    const rawSlot =
      slot.taskSlotIdx >= 0
        ? freshTask?.assignedStatuses?.[slot.taskSlotIdx]
        : undefined;
    if (
      rawSlot === 'Assegnato' ||
      rawSlot === 'Preso in Carico' ||
      rawSlot === 'Completato'
    ) {
      return rawSlot;
    }
    return 'Assegnato';
  });

  const nextAssignedNotes: string[] = trimmedRoster.map((slot) =>
    clampStr(
      squadNotesByEmail[slot.email] || '',
      VALIDATION_LIMITS.NOTE_MAX_LEN
    )
  );

  const statusesForPrevalent =
    nextAssignedStatuses.length > 0 ? nextAssignedStatuses : [newStatus];
  const prevStatusesForPrevalent =
    prevSquadStatuses.length > 0 ? prevSquadStatuses : [freshAsg.stato];

  const prevAuthoritativeStatus = computeTaskPrevalentStatus(
    prevStatusesForPrevalent
  );
  const newTaskStatus = computeTaskPrevalentStatus(statusesForPrevalent);

  const taskBecameCompleted =
    prevAuthoritativeStatus !== 'Completato' && newTaskStatus === 'Completato';

  const authoritativeTask: Task | undefined = freshTask
    ? {
        ...freshTask,
        statoPrevalente: newTaskStatus,
        assignedStatuses:
          nextAssignedStatuses.length > 0
            ? nextAssignedStatuses
            : freshTask.assignedStatuses,
        assignedNotes:
          nextAssignedNotes.length > 0
            ? nextAssignedNotes
            : freshTask.assignedNotes,
      }
    : undefined;

  const completedCount = statusesForPrevalent.filter(
    (s) => s === 'Completato'
  ).length;

  return {
    taskBecameCompleted,
    nextTaskStatus: newTaskStatus,
    completedCount,
    totalSquadCount: statusesForPrevalent.length,
    nextAssignedStatuses,
    nextAssignedNotes,
    authoritativeTask,
    squadNotesByEmail,
  };
}

interface AdaptedRequest {
  headers: { authorization?: string };
  body: Record<string, any>;
}

interface AdaptedResponse {
  statusCode: number;
  headers: Record<string, string>;
  payload: unknown;
  sent: boolean;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => AdaptedResponse;
  json: (data: unknown) => AdaptedResponse;
}

type AdaptedHandler = (req: AdaptedRequest, res: AdaptedResponse) => Promise<unknown> | unknown;

function adaptHonoHandler(handler: AdaptedHandler) {
  return async (c: Context) => {
    let parsedBody: Record<string, any> = {};
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      parsedBody = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    }
    const req: AdaptedRequest = {
      headers: {
        authorization: c.req.header('authorization'),
      },
      body: parsedBody,
    };
    const res: AdaptedResponse = {
      statusCode: 200,
      headers: {},
      payload: { ok: true },
      sent: false,
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(data: unknown) {
        res.payload = data;
        res.sent = true;
        return res;
      },
    };
    await handler(req, res);
    for (const [k, v] of Object.entries(res.headers)) {
      c.header(k, v);
    }
    return c.json(res.payload as any, res.statusCode as any);
  };
}

export function createDataRouter(params: {
  verifyBearerToken: VerifyBearerFn;
  broadcastSync: BroadcastSyncFn;
}): Hono {
  const { verifyBearerToken, broadcastSync } = params;
  const honoRouter = new Hono();

  honoRouter.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    await next();
  });

  const router = {
    get(routePath: string, handler: AdaptedHandler) {
      honoRouter.get(routePath, adaptHonoHandler(handler));
    },
    post(routePath: string, handler: AdaptedHandler) {
      honoRouter.post(routePath, adaptHonoHandler(handler));
    },
  };

  // ---------------------------------------------------------------------------
  // Database Connection Status (Zero secrets exposed)
  // ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  try {
    const pool = await getReadyD1Pool();
    if (!pool) {
      res.json({
        configured: false,
        connected: false,
        hostHint: 'Cloudflare D1 (binding DB mancante)',
      });
      return;
    }
    await pool.query('SELECT 1');

    let counts:
      | {
          directory: number;
          articles: number;
          tasks: number;
          assignments: number;
        }
      | undefined;

    const verified = await verifyBearerToken(req.headers.authorization);
    if (verified) {
      const countRes = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM site_directory) AS directory_count,
          (SELECT COUNT(*) FROM site_articles) AS articles_count,
          (SELECT COUNT(*) FROM site_tasks) AS tasks_count,
          (SELECT COUNT(*) FROM site_assignments) AS assignments_count
      `);
      const r = countRes.rows[0] || {};
      counts = {
        directory: Number(r.directory_count || 0),
        articles: Number(r.articles_count || 0),
        tasks: Number(r.tasks_count || 0),
        assignments: Number(r.assignments_count || 0),
      };
    }

    res.json({
      configured: true,
      connected: true,
      hostHint: 'Cloudflare D1 (SQLite Edge)',
      ...(counts ? { counts } : {}),
    });
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    res.status(200).json({
      configured: true,
      connected: false,
      hostHint: 'Cloudflare D1 (SQLite Edge)',
      code: 'NEON_CONNECTION_ERROR',
      error: `Errore database Cloudflare D1: ${rawMsg}`,
    });
  }
});

async function requireAuthAndDb(
  req: AdaptedRequest,
  res: AdaptedResponse
): Promise<{ pool: Pool; user: VerifiedServerUser } | null> {
  const verified = await verifyBearerToken(req.headers.authorization);
  if (!verified) {
    res.status(401).json({ error: 'Autenticazione Google richiesta.' });
    return null;
  }
  try {
    const pool = await getReadyD1Pool();
    if (!pool) {
      res.status(500).json({
        code: 'NEON_NOT_CONFIGURED',
        error:
          'Database Cloudflare D1 non collegato (aggiungi binding D1 con nome variabile DB su Cloudflare).',
      });
      return null;
    }
    return { pool, user: verified.user };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      code: 'NEON_CONNECTION_ERROR',
      error: `Errore connessione Cloudflare D1: ${rawMsg}`,
    });
    return null;
  }
}

  // ---------------------------------------------------------------------------
  // 1. User Bootstrap & Directory Linking
  // ---------------------------------------------------------------------------
  router.post('/bootstrap', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;
    const displayName = String(req.body?.displayName || '').trim();
    const email = normalizeEmail(user.email);
    const uid = user.uid;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const [adminSnap, settingsSnap, dirSnap, userSnap] = await Promise.all([
        client.query(`SELECT uid FROM site_admins WHERE uid = $1`, [uid]),
        client.query(
          `SELECT * FROM site_settings WHERE config_id = 'general' LIMIT 1`
        ),
        client.query(`SELECT * FROM site_directory`),
        client.query(`SELECT * FROM site_users WHERE uid = $1 LIMIT 1`, [uid]),
      ]);

      const allDirectory = dirSnap.rows.map(mapDirectoryRow);
      let directoryEntry =
        allDirectory.find((m) => m.linkedUid === uid) ||
        findStaffMemberByAnyEmail(email, allDirectory) ||
        null;

      const canonicalEmail = canonicalSiteBaseEmail(email);
      const isBootstrappedAdminEmail = (
        BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]
      ).includes(canonicalEmail);
      const hasAdminGrant = (adminSnap.rowCount || 0) > 0;
      const isSystemUninitialized = (settingsSnap.rowCount || 0) === 0;
      const isDirAdmin =
        Boolean(directoryEntry) &&
        directoryEntry!.role === 'admin' &&
        directoryEntry!.active;

      const isEffectiveAdmin =
        isBootstrappedAdminEmail ||
        hasAdminGrant ||
        isDirAdmin ||
        isSystemUninitialized;

      if (isSystemUninitialized) {
        await client.query(
          `INSERT INTO site_settings (config_id, exempt_commesse, drive_root_folder_name, drive_shared_folder_id, operator_color_labels, updated_by_uid, updated_at)
           VALUES ('general', $1::jsonb, 'Gestione Commesse', $2, '{}'::jsonb, $3, NOW())
           ON CONFLICT (config_id) DO NOTHING`,
          [
            JSON.stringify([...DEFAULT_EXEMPT_COMMESSE]),
            DEFAULT_DRIVE_SHARED_FOLDER_ID,
            uid,
          ]
        );
      } else {
        const existingSettings = mapSettingsRow(settingsSnap.rows[0]);
        if (!existingSettings.driveSharedFolderId) {
          await client.query(
            `UPDATE site_settings
             SET drive_shared_folder_id = $1, updated_by_uid = $2, updated_at = NOW()
             WHERE config_id = 'general'`,
            [DEFAULT_DRIVE_SHARED_FOLDER_ID, uid]
          );
        }
      }

      if (isEffectiveAdmin && !hasAdminGrant) {
        await client.query(
          `INSERT INTO site_admins (uid, email, granted_by_uid, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (uid) DO NOTHING`,
          [uid, email, uid]
        );
      }

      const derivedNames = splitDisplayName(displayName, email);
      const nome = clampStr(
        directoryEntry?.nome || derivedNames.nome,
        VALIDATION_LIMITS.NAME_MAX_LEN,
        'Tecnico'
      );
      const cognome = clampStr(
        directoryEntry?.cognome || derivedNames.cognome,
        VALIDATION_LIMITS.NAME_MAX_LEN,
        'SITE'
      );
      const role: UserRole = isEffectiveAdmin ? 'admin' : 'technician';

      let resolvedDirectoryMemberId = directoryEntry?.memberId || '';
      let directoryChanged = false;

      if (directoryEntry && directoryEntry.linkedUid !== uid) {
        await client.query(
          `UPDATE site_directory
           SET linked_uid = $1, updated_at = NOW()
           WHERE member_id = $2`,
          [uid, directoryEntry.memberId]
        );
        directoryEntry = { ...directoryEntry, linkedUid: uid };
        directoryChanged = true;
      }

      if (isEffectiveAdmin && !directoryEntry) {
        const memberId = makeSafeId('staff');
        await client.query(
          `INSERT INTO site_directory
             (member_id, email, secondary_email, nome, cognome, role, active, linked_uid, admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1, $2, '', $3, $4, 'admin', TRUE, $5, $6::jsonb, $5, NOW(), NOW())`,
          [memberId, email, nome, cognome, uid, JSON.stringify([uid])]
        );
        resolvedDirectoryMemberId = memberId;
        directoryChanged = true;
      }

      // Backfill technician_uid on any unassigned rows matching this user's corporate aliases
      const updatedDirectory = directoryChanged
        ? (await client.query(`SELECT * FROM site_directory`)).rows.map(
            mapDirectoryRow
          )
        : allDirectory;

      const openAsgRes = await client.query(
        `SELECT assignment_id, technician_email, technician_uid, technician_alias_emails
         FROM site_assignments
         WHERE technician_uid = ''`
      );
      const matchingAsgIds: string[] = [];
      for (const r of openAsgRes.rows) {
        const mapped = {
          technicianEmail: String(r.technician_email || ''),
          technicianUid: String(r.technician_uid || ''),
          technicianAliasEmails: Array.isArray(r.technician_alias_emails)
            ? (r.technician_alias_emails as string[])
            : [],
        };
        if (isAssignmentOwnedByViewer(mapped, email, uid, updatedDirectory)) {
          matchingAsgIds.push(String(r.assignment_id));
        }
      }
      if (matchingAsgIds.length > 0) {
        await client.query(
          `UPDATE site_assignments
           SET technician_uid = $1, updated_at = NOW()
           WHERE assignment_id = ANY($2::text[])`,
          [uid, matchingAsgIds]
        );
      }

      let profile: UserProfile;
      if ((userSnap.rowCount || 0) === 0) {
        const activeFlag = directoryEntry ? directoryEntry.active : true;
        const ins = await client.query(
          `INSERT INTO site_users
             (uid, email, nome, cognome, role, active, directory_member_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
           RETURNING *`,
          [
            uid,
            email,
            nome,
            cognome,
            role,
            activeFlag,
            resolvedDirectoryMemberId,
          ]
        );
        profile = mapUserRow(ins.rows[0]);
      } else {
        const existingUser = mapUserRow(userSnap.rows[0]);
        const targetNome = directoryEntry
          ? clampStr(
              directoryEntry.nome,
              VALIDATION_LIMITS.NAME_MAX_LEN,
              existingUser.nome
            )
          : existingUser.nome;
        const targetCognome = directoryEntry
          ? clampStr(
              directoryEntry.cognome,
              VALIDATION_LIMITS.NAME_MAX_LEN,
              existingUser.cognome
            )
          : existingUser.cognome;
        const targetRole: UserRole = isEffectiveAdmin
          ? 'admin'
          : directoryEntry
          ? directoryEntry.role
          : existingUser.role;
        const targetActive = isEffectiveAdmin
          ? true
          : directoryEntry
          ? directoryEntry.active
          : existingUser.active;
        const targetDirId =
          resolvedDirectoryMemberId || existingUser.directoryMemberId || '';

        const upd = await client.query(
          `UPDATE site_users
           SET email = $2,
               nome = $3,
               cognome = $4,
               role = $5,
               active = $6,
               directory_member_id = $7,
               updated_at = NOW()
           WHERE uid = $1
           RETURNING *`,
          [
            uid,
            email,
            targetNome,
            targetCognome,
            targetRole,
            targetActive,
            targetDirId,
          ]
        );
        profile = mapUserRow(upd.rows[0]);
      }

      await client.query('COMMIT');

      if (directoryChanged || matchingAsgIds.length > 0) {
        broadcastSync(['directory', 'assignments'], uid);
      }

      res.json({ profile });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore inizializzazione profilo utente.',
      });
    } finally {
      client.release();
    }
  });

async function queryWorkspaceVersion(pool: Pool): Promise<string> {
  const versionRes = await pool.query(`
    SELECT (
      MAX(
        COALESCE((SELECT MAX(updated_at) FROM site_tasks), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_assignments), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_used_materials), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_intervention_photos), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_absences), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_on_call_shifts), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_on_call_overrides), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_directory), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_articles), '1970-01-01T00:00:00.000Z'),
        COALESCE((SELECT MAX(updated_at) FROM site_settings), '1970-01-01T00:00:00.000Z')
      ) || ':' ||
      CAST((
        (SELECT COUNT(*) FROM site_tasks) +
        (SELECT COUNT(*) FROM site_assignments) +
        (SELECT COUNT(*) FROM site_used_materials) +
        (SELECT COUNT(*) FROM site_intervention_photos) +
        (SELECT COUNT(*) FROM site_absences) +
        (SELECT COUNT(*) FROM site_on_call_shifts) +
        (SELECT COUNT(*) FROM site_on_call_overrides) +
        (SELECT COUNT(*) FROM site_directory) +
        (SELECT COUNT(*) FROM site_articles)
      ) AS TEXT)
    ) AS version
  `);
  const row = versionRes.rows[0] as { version?: string } | undefined;
  return String(row?.version || '');
}

  // ---------------------------------------------------------------------------
  // 1b. Lightweight Workspace Version Check (prevents redundant full snapshots)
  // ---------------------------------------------------------------------------
  router.get('/version', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;

    try {
      const version = await queryWorkspaceVersion(ctx.pool);
      res.json({ version });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore controllo versione database.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Role-Filtered Workspace Snapshot
  // ---------------------------------------------------------------------------
  router.get('/snapshot', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    try {
      const [
        version,
        settingsRes,
        articlesRes,
        directoryRes,
        tasksRes,
        assignmentsRes,
        materialsRes,
        photosRes,
        absencesRes,
        onCallShiftsRes,
        onCallOverridesRes,
      ] = await Promise.all([
        queryWorkspaceVersion(pool),
        pool.query(
          `SELECT * FROM site_settings WHERE config_id = 'general' LIMIT 1`
        ),
        pool.query(
          `SELECT * FROM site_articles ORDER BY categoria ASC, codice_articolo ASC`
        ),
        pool.query(
          `SELECT * FROM site_directory ORDER BY cognome ASC, nome ASC`
        ),
        pool.query(`SELECT * FROM site_tasks ORDER BY inizio_ms ASC`),
        pool.query(`SELECT * FROM site_assignments ORDER BY inizio_ms ASC`),
        pool.query(`SELECT * FROM site_used_materials ORDER BY created_at ASC`),
        pool.query(
          `SELECT * FROM site_intervention_photos ORDER BY created_at ASC`
        ),
        pool.query(`SELECT * FROM site_absences ORDER BY inizio_ms ASC`),
        pool.query(`SELECT * FROM site_on_call_shifts ORDER BY inizio_ms ASC`),
        pool.query(`SELECT * FROM site_on_call_overrides ORDER BY inizio_ms ASC`),
      ]);

      const settings: AppSettings = mapSettingsRow(settingsRes.rows[0]);
      const allArticles = articlesRes.rows.map(mapArticleRow);
      const allDirectory = directoryRes.rows.map(mapDirectoryRow);
      const allTasks = tasksRes.rows.map(mapTaskRow);
      const allAssignments = assignmentsRes.rows.map(mapAssignmentRow);
      const allMaterials = materialsRes.rows.map(mapUsedMaterialRow);
      const allPhotos = photosRes.rows.map(mapInterventionPhotoRow);
      const allAbsences = absencesRes.rows.map(mapAbsenceRow);
      const allOnCallShifts = onCallShiftsRes.rows.map(mapOnCallShiftRow);
      const allOnCallOverrides = onCallOverridesRes.rows.map(mapOnCallOverrideRow);

      const { isAdmin } = await resolveCallerRole(pool, user, allDirectory);

      if (isAdmin) {
        res.json({
          version,
          settings,
          articles: allArticles,
          directory: allDirectory,
          tasks: allTasks,
          assignments: allAssignments,
          usedMaterials: allMaterials,
          photos: allPhotos,
          absences: allAbsences,
          onCallShifts: allOnCallShifts,
          onCallOverrides: allOnCallOverrides,
        });
        return;
      }

      // Technician view: full multi-alias squad visibility across all corporate email variants
      const email = normalizeEmail(user.email);
      const uid = user.uid;

      const ownedTaskIds = new Set<string>();
      for (const asg of allAssignments) {
        if (isAssignmentOwnedByViewer(asg, email, uid, allDirectory)) {
          ownedTaskIds.add(asg.taskId);
        }
      }

      const visibleTasks = allTasks.filter((t) => {
        if (t.createdByUid === uid || ownedTaskIds.has(t.taskId)) {
          return true;
        }
        if (
          t.assignedEmails.some((em) =>
            areSameTechnicianEmails(em, email, allDirectory)
          )
        ) {
          return true;
        }
        if (
          (t.assignedAclEmails || []).some((em) =>
            areSameTechnicianEmails(em, email, allDirectory)
          )
        ) {
          return true;
        }
        return false;
      });

      const visibleTaskIds = new Set<string>(ownedTaskIds);
      for (const t of visibleTasks) {
        visibleTaskIds.add(t.taskId);
      }

      const visibleAssignments = allAssignments.filter(
        (asg) =>
          visibleTaskIds.has(asg.taskId) ||
          isAssignmentOwnedByViewer(asg, email, uid, allDirectory) ||
          (asg.squadEmails || []).some((em) =>
            areSameTechnicianEmails(em, email, allDirectory)
          )
      );

      const visibleMaterials = allMaterials.filter(
        (mat) =>
          visibleTaskIds.has(mat.taskId) ||
          mat.technicianUid === uid ||
          areSameTechnicianEmails(mat.technicianEmail, email, allDirectory)
      );

      const visiblePhotos = allPhotos.filter(
        (p) =>
          visibleTaskIds.has(p.taskId) ||
          p.technicianUid === uid ||
          areSameTechnicianEmails(p.technicianEmail, email, allDirectory)
      );

      const visibleAbsences = allAbsences.filter(
        (ab) =>
          ab.technicianUid === uid ||
          areSameTechnicianEmails(ab.technicianEmail, email, allDirectory)
      );

      const visibleDirectory = allDirectory.filter(
        (m) =>
          m.active ||
          m.linkedUid === uid ||
          areSameTechnicianEmails(m.email, email, allDirectory)
      );

      res.json({
        version,
        settings,
        articles: allArticles.filter((a) => a.active),
        directory: visibleDirectory,
        tasks: visibleTasks,
        assignments: visibleAssignments,
        usedMaterials: visibleMaterials,
        photos: visiblePhotos,
        absences: visibleAbsences,
        onCallShifts: allOnCallShifts,
        onCallOverrides: allOnCallOverrides,
      });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore caricamento dati dal database.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. App Settings (Admin)
  // ---------------------------------------------------------------------------
  router.post('/settings', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const body = req.body || {};
    const rawExempt = Array.isArray(body.exemptCommesse)
      ? body.exemptCommesse
      : [];
    const cleanedCommesse = Array.from(
      new Set(
        rawExempt
          .map((c: unknown) => String(c || '').trim().toUpperCase())
          .filter(Boolean)
          .map((c: string) => c.slice(0, VALIDATION_LIMITS.COMMESSA_MAX_LEN))
      )
    ).slice(0, VALIDATION_LIMITS.MAX_EXEMPT_COMMESSE);

    const driveRoot = clampStr(
      body.driveRootFolderName,
      VALIDATION_LIMITS.DRIVE_FOLDER_MAX_LEN,
      'Gestione Commesse'
    );
    const driveSharedFolderId = extractDriveFolderId(
      String(body.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID)
    );

    try {
      const existingSnap = await pool.query(
        `SELECT * FROM site_settings WHERE config_id = 'general' LIMIT 1`
      );
      const existing = mapSettingsRow(existingSnap.rows[0]);
      const rawLabels =
        body.operatorColorLabels !== undefined
          ? body.operatorColorLabels
          : existing.operatorColorLabels;

      const googleSheetId =
        body.googleSheetId !== undefined
          ? extractGoogleSheetId(String(body.googleSheetId || ''))
          : existing.googleSheetId || '';

      const sanitizedLabels: Partial<Record<TaskColorId, string>> = {};
      if (rawLabels && typeof rawLabels === 'object') {
        for (const colorId of TASK_COLOR_IDS) {
          const val = (rawLabels as Record<string, unknown>)[colorId];
          if (typeof val === 'string') {
            const trimmed = val
              .trim()
              .slice(0, VALIDATION_LIMITS.OPERATOR_LABEL_MAX_LEN);
            if (trimmed) {
              sanitizedLabels[colorId] = trimmed;
            }
          }
        }
      }

      await pool.query(
        `INSERT INTO site_settings
           (config_id, exempt_commesse, drive_root_folder_name, drive_shared_folder_id, google_sheet_id, operator_color_labels, updated_by_uid, updated_at)
         VALUES ('general', $1::jsonb, $2, $3, $4, $5::jsonb, $6, NOW())
         ON CONFLICT (config_id) DO UPDATE SET
           exempt_commesse = EXCLUDED.exempt_commesse,
           drive_root_folder_name = EXCLUDED.drive_root_folder_name,
           drive_shared_folder_id = EXCLUDED.drive_shared_folder_id,
           google_sheet_id = EXCLUDED.google_sheet_id,
           operator_color_labels = EXCLUDED.operator_color_labels,
           updated_by_uid = EXCLUDED.updated_by_uid,
           updated_at = NOW()`,
        [
          JSON.stringify(cleanedCommesse),
          driveRoot,
          driveSharedFolderId,
          googleSheetId,
          JSON.stringify(sanitizedLabels),
          user.uid,
        ]
      );

      broadcastSync(['settings'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio impostazioni.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Staff Directory Upsert & Delete (Admin)
  // ---------------------------------------------------------------------------
  router.post('/staff/upsert', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const body = req.body || {};
    const role: UserRole = body.role === 'admin' ? 'admin' : 'technician';
    const email = normalizeEmail(body.email);
    if (!VALIDATION_LIMITS.EMAIL_PATTERN.test(email)) {
      res
        .status(400)
        .json({ error: 'Inserire un indirizzo email aziendale valido.' });
      return;
    }
    if (!isWorkspaceDriveEmail(email)) {
      res.status(400).json({
        error:
          "Nel primo campo inserisci l'account Google Workspace (@sitespa.it oppure nome.cognome.id@sitespa.it). L'indirizzo @tecnicositespa.it va inserito nel secondo campo per invio/ricezione mail.",
      });
      return;
    }
    if (role === 'admin' && isLoginOnlyIdEmail(email)) {
      res.status(400).json({
        error:
          'Gli account Admin devono utilizzare una casella completa @sitespa.it.',
      });
      return;
    }
    const secondaryEmail = normalizeEmail(body.secondaryEmail || '');
    if (secondaryEmail && !VALIDATION_LIMITS.EMAIL_PATTERN.test(secondaryEmail)) {
      res.status(400).json({
        error:
          'Inserire un indirizzo email di posta valido (es. nome.cognome@tecnicositespa.it).',
      });
      return;
    }
    if (secondaryEmail && isLoginOnlyIdEmail(secondaryEmail)) {
      res.status(400).json({
        error:
          "L'email secondaria di recapito posta non può essere un account di solo accesso (.id@sitespa.it).",
      });
      return;
    }

    const nome = clampStr(body.nome, VALIDATION_LIMITS.NAME_MAX_LEN);
    const cognome = clampStr(body.cognome, VALIDATION_LIMITS.NAME_MAX_LEN);
    if (!nome || !cognome) {
      res.status(400).json({ error: 'Nome e Cognome sono obbligatori.' });
      return;
    }

    const active = body.active !== false;
    const currentAdminUids = Array.isArray(body.currentAdminUids)
      ? body.currentAdminUids.map(String)
      : [];
    const boundedAdmins = Array.from(
      new Set([user.uid, ...currentAdminUids].filter(Boolean))
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const existingMemberId = clampStr(
      body.existingMember?.memberId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (existingMemberId) {
        const curRes = await client.query(
          `SELECT * FROM site_directory WHERE member_id = $1 FOR UPDATE`,
          [existingMemberId]
        );
        const curLinkedUid = curRes.rows[0]
          ? String(curRes.rows[0].linked_uid || '')
          : String(body.existingMember?.linkedUid || '');

        await client.query(
          `UPDATE site_directory
           SET email = $2,
               secondary_email = $3,
               nome = $4,
               cognome = $5,
               role = $6,
               active = $7,
               admin_uids = $8::jsonb,
               updated_at = NOW()
           WHERE member_id = $1`,
          [
            existingMemberId,
            email,
            secondaryEmail,
            nome,
            cognome,
            role,
            active,
            JSON.stringify(boundedAdmins),
          ]
        );

        if (curLinkedUid) {
          if (role === 'admin') {
            await client.query(
              `INSERT INTO site_admins (uid, email, granted_by_uid, created_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (uid) DO NOTHING`,
              [curLinkedUid, email, user.uid]
            );
          } else if (
            !(BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]).includes(
              canonicalSiteBaseEmail(email)
            )
          ) {
            await client.query(`DELETE FROM site_admins WHERE uid = $1`, [
              curLinkedUid,
            ]);
          }

          await client.query(
            `UPDATE site_users
             SET nome = $2,
                 cognome = $3,
                 role = $4,
                 active = $5,
                 directory_member_id = $6,
                 updated_at = NOW()
             WHERE uid = $1`,
            [curLinkedUid, nome, cognome, role, active, existingMemberId]
          );
        }
      } else {
        const dupRes = await client.query(
          `SELECT member_id FROM site_directory WHERE LOWER(email) = $1 LIMIT 1`,
          [email]
        );
        if (dupRes.rowCount && dupRes.rowCount > 0) {
          await client.query('ROLLBACK');
          res.status(409).json({
            error: `Esiste già una scheda in organico per ${email}. Modifica o rimuovi quella esistente.`,
          });
          return;
        }

        const memberId = makeSafeId('staff');
        // Automatically link UID if user already logged in previously
        const userMatch = await client.query(
          `SELECT uid FROM site_users WHERE LOWER(email) = $1 LIMIT 1`,
          [email]
        );
        const linkedUid = userMatch.rows[0] ? String(userMatch.rows[0].uid) : '';

        await client.query(
          `INSERT INTO site_directory
             (member_id, email, secondary_email, nome, cognome, role, active, linked_uid, admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, NOW(), NOW())`,
          [
            memberId,
            email,
            secondaryEmail,
            nome,
            cognome,
            role,
            active,
            linkedUid,
            JSON.stringify(boundedAdmins),
            user.uid,
          ]
        );

        if (linkedUid && role === 'admin') {
          await client.query(
            `INSERT INTO site_admins (uid, email, granted_by_uid, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (uid) DO NOTHING`,
            [linkedUid, email, user.uid]
          );
        }
      }

      await client.query('COMMIT');
      broadcastSync(['directory'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio operatore in organico.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/staff/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const memberId = clampStr(req.body?.memberId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!memberId) {
      res.status(400).json({ error: 'ID operatore mancante.' });
      return;
    }

    try {
      const targetRes = await pool.query(
        `SELECT * FROM site_directory WHERE member_id = $1 LIMIT 1`,
        [memberId]
      );
      if (!targetRes.rowCount) {
        res.json({ ok: true });
        return;
      }
      const member = mapDirectoryRow(targetRes.rows[0]);
      if (normalizeEmail(member.email) === normalizeEmail(user.email)) {
        res.status(400).json({
          error: 'Non puoi eliminare il tuo stesso profilo mentre sei connesso.',
        });
        return;
      }

      await pool.query(`DELETE FROM site_directory WHERE member_id = $1`, [
        memberId,
      ]);

      if (
        member.linkedUid &&
        !(BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]).includes(
          canonicalSiteBaseEmail(member.email)
        )
      ) {
        await pool.query(`DELETE FROM site_admins WHERE uid = $1`, [
          member.linkedUid,
        ]);
      }

      broadcastSync(['directory'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : "Errore rimozione operatore dall'organico.",
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Articles Catalog (Admin)
  // ---------------------------------------------------------------------------
  router.post('/articles/upsert', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const body = req.body || {};
    const codiceArticolo = clampStr(
      body.codiceArticolo,
      VALIDATION_LIMITS.CODE_MAX_LEN
    );
    const descrizione = clampStr(
      body.descrizione,
      VALIDATION_LIMITS.ARTICLE_DESC_MAX_LEN
    );
    const categoria = clampStr(
      body.categoria,
      VALIDATION_LIMITS.CATEGORY_MAX_LEN
    );
    const unitaMisura = clampStr(
      body.unitaMisura,
      VALIDATION_LIMITS.UNIT_MAX_LEN,
      'pz'
    );
    const active = body.active !== false;

    if (!codiceArticolo || !descrizione || !categoria) {
      res.status(400).json({
        error: 'Codice Articolo, Descrizione e Categoria sono obbligatori.',
      });
      return;
    }

    const currentAdminUids = Array.isArray(body.currentAdminUids)
      ? body.currentAdminUids.map(String)
      : [];
    const boundedAdmins = Array.from(
      new Set([user.uid, ...currentAdminUids].filter(Boolean))
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const existingId = clampStr(
      body.existingArticle?.articleId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );

    try {
      if (existingId) {
        await pool.query(
          `UPDATE site_articles
           SET codice_articolo = $2,
               descrizione = $3,
               categoria = $4,
               unita_misura = $5,
               active = $6,
               admin_uids = $7::jsonb,
               updated_at = NOW()
           WHERE article_id = $1`,
          [
            existingId,
            codiceArticolo,
            descrizione,
            categoria,
            unitaMisura,
            active,
            JSON.stringify(boundedAdmins),
          ]
        );
      } else {
        const articleId = makeSafeId('art');
        await pool.query(
          `INSERT INTO site_articles
             (article_id, codice_articolo, descrizione, categoria, unita_misura, active, admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
          [
            articleId,
            codiceArticolo,
            descrizione,
            categoria,
            unitaMisura,
            active,
            JSON.stringify(boundedAdmins),
            user.uid,
          ]
        );
      }

      broadcastSync(['articles'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio articolo.',
      });
    }
  });

  router.post('/articles/bulk-import', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      res.status(400).json({ error: 'Nessun articolo valido da importare.' });
      return;
    }

    const currentAdminUids = Array.isArray(req.body?.currentAdminUids)
      ? req.body.currentAdminUids.map(String)
      : [];
    const boundedAdminsJson = JSON.stringify(
      Array.from(new Set([user.uid, ...currentAdminUids].filter(Boolean))).slice(
        0,
        VALIDATION_LIMITS.MAX_BOUNDED_ARRAY
      )
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let imported = 0;

      for (const raw of items) {
        const codiceArticolo = clampStr(
          raw?.codiceArticolo,
          VALIDATION_LIMITS.CODE_MAX_LEN
        );
        const descrizione = clampStr(
          raw?.descrizione,
          VALIDATION_LIMITS.ARTICLE_DESC_MAX_LEN
        );
        const categoria = clampStr(
          raw?.categoria || 'Generale',
          VALIDATION_LIMITS.CATEGORY_MAX_LEN,
          'Generale'
        );
        const unitaMisura = clampStr(
          raw?.unitaMisura || 'pz',
          VALIDATION_LIMITS.UNIT_MAX_LEN,
          'pz'
        );
        if (!codiceArticolo || !descrizione) continue;

        const articleId = makeSafeId('art');
        await client.query(
          `INSERT INTO site_articles
             (article_id, codice_articolo, descrizione, categoria, unita_misura, active, admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6::jsonb, $7, NOW(), NOW())`,
          [
            articleId,
            codiceArticolo,
            descrizione,
            categoria,
            unitaMisura,
            boundedAdminsJson,
            user.uid,
          ]
        );
        imported += 1;
      }

      await client.query('COMMIT');
      broadcastSync(['articles'], user.uid);
      res.json({ imported });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore importazione massiva articoli.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/articles/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const articleId = clampStr(
      req.body?.articleId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );
    if (!articleId) {
      res.status(400).json({ error: 'articleId mancante.' });
      return;
    }

    try {
      await pool.query(`DELETE FROM site_articles WHERE article_id = $1`, [
        articleId,
      ]);
      broadcastSync(['articles'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Errore eliminazione articolo.',
      });
    }
  });

  router.post('/articles/bulk-active', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const ids = Array.isArray(req.body?.articleIds)
      ? Array.from(new Set(req.body.articleIds.map(String).filter(Boolean)))
      : [];
    const active = Boolean(req.body?.active);
    if (ids.length === 0) {
      res.json({ updated: 0 });
      return;
    }

    try {
      const upd = await pool.query(
        `UPDATE site_articles
         SET active = $1, updated_at = NOW()
         WHERE article_id = ANY($2::text[])`,
        [active, ids]
      );
      broadcastSync(['articles'], user.uid);
      res.json({ updated: upd.rowCount || ids.length });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore aggiornamento articoli.',
      });
    }
  });

  router.post('/articles/bulk-delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const ids = Array.isArray(req.body?.articleIds)
      ? Array.from(new Set(req.body.articleIds.map(String).filter(Boolean)))
      : [];
    if (ids.length === 0) {
      res.json({ deleted: 0 });
      return;
    }

    try {
      const del = await pool.query(
        `DELETE FROM site_articles WHERE article_id = ANY($1::text[])`,
        [ids]
      );
      broadcastSync(['articles'], user.uid);
      res.json({ deleted: del.rowCount || ids.length });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Errore eliminazione articoli.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Tasks & Squad Assignments (Admin Create / Update / Color / Delete / Status)
  // ---------------------------------------------------------------------------
  router.post('/tasks/save', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const body = req.body || {};
    const existingTaskId = clampStr(
      body.existingTaskId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );
    const isAltroReparto = Boolean(body.altroReparto);
    const commessa = clampStr(
      String(body.commessa || '').toUpperCase(),
      VALIDATION_LIMITS.COMMESSA_MAX_LEN
    );
    const descrizione = clampStr(
      body.descrizione,
      VALIDATION_LIMITS.TASK_DESC_MAX_LEN
    );

    if (!descrizione) {
      res.status(400).json({ error: 'La Descrizione Lavoro è obbligatoria.' });
      return;
    }
    if (!isAltroReparto && !commessa) {
      res.status(400).json({
        error:
          'Il codice Commessa è obbligatorio (oppure attiva "Lavorazione altro AT").',
      });
      return;
    }

    const inizioDate = new Date(String(body.inizioIso || ''));
    const fineDate = new Date(String(body.fineIso || ''));
    const inizioMs = inizioDate.getTime();
    const fineMs = fineDate.getTime();
    if (Number.isNaN(inizioMs) || Number.isNaN(fineMs)) {
      res.status(400).json({
        error: 'Inserire date e orari di inizio e fine validi.',
      });
      return;
    }
    if (fineMs < inizioMs + VALIDATION_LIMITS.MIN_TASK_DURATION_MS) {
      res.status(400).json({
        error:
          "L'orario di fine deve essere ad almeno un'ora di distanza dall'orario di inizio.",
      });
      return;
    }

    const rawAssignees: SelectedAssigneePayload[] = Array.isArray(body.assignees)
      ? body.assignees
      : [];
    const uniqueAssigneesMap = new Map<string, SelectedAssigneePayload>();
    for (const a of rawAssignees) {
      const em = normalizeEmail(a?.email);
      const canonKey = canonicalTechnicianKey(em, directory);
      if (em && canonKey && !uniqueAssigneesMap.has(canonKey)) {
        const matchedMember = findStaffMemberByAnyEmail(em, directory);
        const candDeliv = normalizeEmail(
          a?.deliverableEmail ||
            (matchedMember ? getDeliverableEmail(matchedMember) : em)
        );
        uniqueAssigneesMap.set(canonKey, {
          email: em,
          fullName: clampStr(a?.fullName, VALIDATION_LIMITS.FULL_NAME_MAX_LEN, em),
          linkedUid: String(a?.linkedUid || matchedMember?.linkedUid || ''),
          deliverableEmail:
            VALIDATION_LIMITS.EMAIL_PATTERN.test(candDeliv) &&
            !isLoginOnlyIdEmail(candDeliv)
              ? candDeliv
              : !isLoginOnlyIdEmail(em)
              ? em
              : '',
        });
      }
    }
    const cleanAssignees = Array.from(uniqueAssigneesMap.values()).slice(
      0,
      VALIDATION_LIMITS.MAX_BOUNDED_ARRAY
    );

    const assignedEmails = cleanAssignees.map((a) => a.email);
    const assignedAclEmails = expandSquadAclEmails(assignedEmails, directory);
    const assignedNames = cleanAssignees.map((a) => a.fullName);
    const assignedDeliverableEmails = cleanAssignees
      .map((a) => a.deliverableEmail || a.email)
      .filter((addr) => addr && !isLoginOnlyIdEmail(addr));

    const currentAdminUids = Array.isArray(body.currentAdminUids)
      ? body.currentAdminUids.map(String)
      : [];
    const boundedAdmins = Array.from(
      new Set([user.uid, ...currentAdminUids].filter(Boolean))
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const rawAdminEmails: string[] = Array.isArray(body.activeAdminEmails)
      ? body.activeAdminEmails.map(String)
      : [];
    const boundedAdminEmails = Array.from(
      new Set(
        (rawAdminEmails.length > 0
          ? rawAdminEmails
          : [...BOOTSTRAPPED_ADMIN_EMAILS]
        )
          .map((em: string) => normalizeEmail(em))
          .filter((em: string) => VALIDATION_LIMITS.EMAIL_PATTERN.test(em))
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const inizioFormatted = inizioDate.toISOString();
    const fineFormatted = fineDate.toISOString();
    const codePrefix = commessa || 'ALTRO_AT';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!existingTaskId) {
        const countRes = commessa
          ? await client.query(
              `SELECT COUNT(*)::int AS cnt FROM site_tasks WHERE UPPER(commessa) = $1`,
              [commessa]
            )
          : await client.query(
              `SELECT COUNT(*)::int AS cnt FROM site_tasks WHERE altro_reparto = TRUE AND commessa = ''`
            );
        const sameGroupCount = Number(countRes.rows[0]?.cnt || 0);
        const seq = String(sameGroupCount + 1).padStart(3, '0');
        const taskCode = clampStr(
          `T_${codePrefix}_${seq}`,
          VALIDATION_LIMITS.CODE_MAX_LEN
        );
        const taskId = makeSafeId('task');
        const resolvedColorId: TaskColorId =
          body.colorId &&
          (TASK_COLOR_IDS as readonly string[]).includes(String(body.colorId))
            ? (body.colorId as TaskColorId)
            : isAltroReparto
            ? 'lavender'
            : 'peacock';

        const initialStatuses: AssignmentStatus[] = cleanAssignees.map(
          () => 'Assegnato'
        );
        const initialNotes: string[] = cleanAssignees.map(() => '');
        const statoPrevalente = computeTaskPrevalentStatus(initialStatuses);

        await client.query(
          `INSERT INTO site_tasks
             (task_id, task_code, commessa, descrizione, inizio, inizio_ms, fine, fine_ms,
              stato_prevalente, assigned_emails, assigned_acl_emails, assigned_names,
              assigned_deliverable_emails, assigned_statuses, assigned_notes,
              admin_uids, admin_emails, altro_reparto, pending_admin_review,
              color_id, created_by_role, created_by_uid, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,FALSE,$19,'admin',$20,NOW(),NOW())`,
          [
            taskId,
            taskCode,
            commessa,
            descrizione,
            inizioFormatted,
            inizioMs,
            fineFormatted,
            fineMs,
            statoPrevalente,
            JSON.stringify(assignedEmails),
            JSON.stringify(assignedAclEmails),
            JSON.stringify(assignedNames),
            JSON.stringify(assignedDeliverableEmails),
            JSON.stringify(initialStatuses),
            JSON.stringify(initialNotes),
            JSON.stringify(boundedAdmins),
            JSON.stringify(boundedAdminEmails),
            isAltroReparto,
            resolvedColorId,
            user.uid,
          ]
        );

        for (let idx = 0; idx < cleanAssignees.length; idx++) {
          const assignee = cleanAssignees[idx];
          const assignmentId = makeSafeId('asg');
          const asgSeq = String(idx + 1).padStart(3, '0');
          const assignmentCode = clampStr(
            `A_${codePrefix}_${asgSeq}`,
            VALIDATION_LIMITS.CODE_MAX_LEN
          );
          const techAliases = buildTechnicianEmailAliases(
            assignee.email,
            directory
          );

          await client.query(
            `INSERT INTO site_assignments
               (assignment_id, assignment_code, task_id, commessa, descrizione_task,
                inizio, inizio_ms, fine, fine_ms, technician_email, technician_name,
                technician_uid, technician_alias_emails, stato, note_tecnico,
                admin_uids, squad_emails, squad_names, squad_deliverable_emails,
                color_id, created_by_uid, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'Assegnato','',$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,NOW(),NOW())`,
            [
              assignmentId,
              assignmentCode,
              taskId,
              commessa,
              descrizione,
              inizioFormatted,
              inizioMs,
              fineFormatted,
              fineMs,
              assignee.email,
              assignee.fullName,
              assignee.linkedUid,
              JSON.stringify(techAliases),
              JSON.stringify(boundedAdmins),
              JSON.stringify(assignedAclEmails),
              JSON.stringify(assignedNames),
              JSON.stringify(assignedDeliverableEmails),
              resolvedColorId,
              user.uid,
            ]
          );
        }

        await client.query('COMMIT');
        broadcastSync(['tasks', 'assignments'], user.uid);
        res.json({ taskId, becameCompleted: false });
      } else {
        const taskSnap = await client.query(
          `SELECT * FROM site_tasks WHERE task_id = $1 FOR UPDATE`,
          [existingTaskId]
        );
        if (!taskSnap.rowCount) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'Task non trovato.' });
          return;
        }
        const t = mapTaskRow(taskSnap.rows[0]);
        const asgSnap = await client.query(
          `SELECT * FROM site_assignments WHERE task_id = $1 FOR UPDATE`,
          [existingTaskId]
        );
        const existingTaskAssignments = asgSnap.rows.map(mapAssignmentRow);

        const resolvedColorId: TaskColorId =
          body.colorId &&
          (TASK_COLOR_IDS as readonly string[]).includes(String(body.colorId))
            ? (body.colorId as TaskColorId)
            : t.colorId &&
              (TASK_COLOR_IDS as readonly string[]).includes(t.colorId)
            ? t.colorId
            : isAltroReparto
            ? 'lavender'
            : 'peacock';

        const existingByCanon = new Map<string, Assignment>();
        for (const asg of existingTaskAssignments) {
          const canon = canonicalTechnicianKey(asg.technicianEmail, directory);
          if (
            canon &&
            (!existingByCanon.has(canon) || asg.stato !== 'Annullato')
          ) {
            existingByCanon.set(canon, asg);
          }
        }

        const resultingStatuses: AssignmentStatus[] = [];
        const resultingNotes: string[] = [];
        for (const assignee of cleanAssignees) {
          const canon = canonicalTechnicianKey(assignee.email, directory);
          const prev = existingByCanon.get(canon);
          const prevTaskIdx = t.assignedEmails.findIndex((em) =>
            areSameTechnicianEmails(em, assignee.email, directory)
          );
          resultingStatuses.push(
            prev
              ? prev.stato
              : prevTaskIdx >= 0 && t.assignedStatuses?.[prevTaskIdx]
              ? t.assignedStatuses[prevTaskIdx]
              : 'Assegnato'
          );
          resultingNotes.push(
            clampStr(
              prev
                ? prev.noteTecnico
                : prevTaskIdx >= 0
                ? t.assignedNotes?.[prevTaskIdx] || ''
                : '',
              VALIDATION_LIMITS.NOTE_MAX_LEN
            )
          );
        }
        const statoPrevalente = computeTaskPrevalentStatus(resultingStatuses);

        let taskCode = t.taskCode;
        if (t.createdByRole !== 'technician' && t.commessa !== commessa) {
          const countRes = commessa
            ? await client.query(
                `SELECT COUNT(*)::int AS cnt FROM site_tasks WHERE UPPER(commessa) = $1`,
                [commessa]
              )
            : await client.query(
                `SELECT COUNT(*)::int AS cnt FROM site_tasks WHERE altro_reparto = TRUE AND commessa = ''`
              );
          const cnt = Number(countRes.rows[0]?.cnt || 0);
          taskCode = clampStr(
            `T_${codePrefix}_${String(cnt + 1).padStart(3, '0')}`,
            VALIDATION_LIMITS.CODE_MAX_LEN
          );
        }

        const nextPendingReview =
          Boolean(t.pendingAdminReview) && !commessa && !isAltroReparto;

        await client.query(
          `UPDATE site_tasks
           SET task_code = $2,
               commessa = $3,
               descrizione = $4,
               inizio = $5,
               inizio_ms = $6,
               fine = $7,
               fine_ms = $8,
               stato_prevalente = $9,
               assigned_emails = $10::jsonb,
               assigned_acl_emails = $11::jsonb,
               assigned_names = $12::jsonb,
               assigned_deliverable_emails = $13::jsonb,
               assigned_statuses = $14::jsonb,
               assigned_notes = $15::jsonb,
               admin_uids = $16::jsonb,
               admin_emails = $17::jsonb,
               altro_reparto = $18,
               pending_admin_review = $19,
               color_id = $20,
               updated_at = NOW()
           WHERE task_id = $1`,
          [
            t.taskId,
            taskCode,
            commessa,
            descrizione,
            inizioFormatted,
            inizioMs,
            fineFormatted,
            fineMs,
            statoPrevalente,
            JSON.stringify(assignedEmails),
            JSON.stringify(assignedAclEmails),
            JSON.stringify(assignedNames),
            JSON.stringify(assignedDeliverableEmails),
            JSON.stringify(resultingStatuses),
            JSON.stringify(resultingNotes),
            JSON.stringify(boundedAdmins),
            JSON.stringify(boundedAdminEmails),
            isAltroReparto,
            nextPendingReview,
            resolvedColorId,
          ]
        );

        let seqCounter = existingTaskAssignments.length;
        for (const assignee of cleanAssignees) {
          const canon = canonicalTechnicianKey(assignee.email, directory);
          const prev = existingByCanon.get(canon);
          const techAliases = buildTechnicianEmailAliases(
            assignee.email,
            directory
          );

          if (prev) {
            await client.query(
              `UPDATE site_assignments
               SET commessa = $2,
                   descrizione_task = $3,
                   inizio = $4,
                   inizio_ms = $5,
                   fine = $6,
                   fine_ms = $7,
                   technician_email = $8,
                   technician_name = $9,
                   technician_uid = $10,
                   technician_alias_emails = $11::jsonb,
                   admin_uids = $12::jsonb,
                   squad_emails = $13::jsonb,
                   squad_names = $14::jsonb,
                   squad_deliverable_emails = $15::jsonb,
                   color_id = $16,
                   updated_at = NOW()
               WHERE assignment_id = $1`,
              [
                prev.assignmentId,
                commessa,
                descrizione,
                inizioFormatted,
                inizioMs,
                fineFormatted,
                fineMs,
                assignee.email,
                assignee.fullName,
                assignee.linkedUid || prev.technicianUid,
                JSON.stringify(techAliases),
                JSON.stringify(boundedAdmins),
                JSON.stringify(assignedAclEmails),
                JSON.stringify(assignedNames),
                JSON.stringify(assignedDeliverableEmails),
                resolvedColorId,
              ]
            );
          } else {
            seqCounter += 1;
            const assignmentId = makeSafeId('asg');
            const assignmentCode = clampStr(
              `A_${codePrefix}_${String(seqCounter).padStart(3, '0')}`,
              VALIDATION_LIMITS.CODE_MAX_LEN
            );
            await client.query(
              `INSERT INTO site_assignments
                 (assignment_id, assignment_code, task_id, commessa, descrizione_task,
                  inizio, inizio_ms, fine, fine_ms, technician_email, technician_name,
                  technician_uid, technician_alias_emails, stato, note_tecnico,
                  admin_uids, squad_emails, squad_names, squad_deliverable_emails,
                  color_id, created_by_uid, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'Assegnato','',$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,NOW(),NOW())`,
              [
                assignmentId,
                assignmentCode,
                t.taskId,
                commessa,
                descrizione,
                inizioFormatted,
                inizioMs,
                fineFormatted,
                fineMs,
                assignee.email,
                assignee.fullName,
                assignee.linkedUid,
                JSON.stringify(techAliases),
                JSON.stringify(boundedAdmins),
                JSON.stringify(assignedAclEmails),
                JSON.stringify(assignedNames),
                JSON.stringify(assignedDeliverableEmails),
                resolvedColorId,
                user.uid,
              ]
            );
          }
        }

        const selectedCanonSet = new Set(
          cleanAssignees.map((a) => canonicalTechnicianKey(a.email, directory))
        );
        const removedAsgIds = existingTaskAssignments
          .filter(
            (oldAsg) =>
              !selectedCanonSet.has(
                canonicalTechnicianKey(oldAsg.technicianEmail, directory)
              )
          )
          .map((oldAsg) => oldAsg.assignmentId);

        if (removedAsgIds.length > 0) {
          await client.query(
            `DELETE FROM site_assignments WHERE assignment_id = ANY($1::text[])`,
            [removedAsgIds]
          );
        }

        await client.query(
          `UPDATE site_used_materials
           SET commessa = $2, admin_uids = $3::jsonb, squad_emails = $4::jsonb, updated_at = NOW()
           WHERE task_id = $1`,
          [
            t.taskId,
            commessa,
            JSON.stringify(boundedAdmins),
            JSON.stringify(assignedAclEmails),
          ]
        );

        await client.query(
          `UPDATE site_intervention_photos
           SET commessa = $2, admin_uids = $3::jsonb, squad_emails = $4::jsonb, updated_at = NOW()
           WHERE task_id = $1`,
          [
            t.taskId,
            commessa,
            JSON.stringify(boundedAdmins),
            JSON.stringify(assignedAclEmails),
          ]
        );

        await client.query('COMMIT');
        broadcastSync(
          ['tasks', 'assignments', 'materials', 'photos'],
          user.uid
        );
        res.json({
          taskId: t.taskId,
          becameCompleted:
            t.statoPrevalente !== 'Completato' &&
            statoPrevalente === 'Completato',
          nextPendingReview,
        });
      }
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio task e assegnazioni.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/tasks/color', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const taskId = clampStr(req.body?.taskId, VALIDATION_LIMITS.ID_MAX_LEN);
    const colorId = String(req.body?.colorId || '');
    if (!taskId || !(TASK_COLOR_IDS as readonly string[]).includes(colorId)) {
      res.status(400).json({ error: 'Task o colore evento non valido.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE site_tasks SET color_id = $2, updated_at = NOW() WHERE task_id = $1`,
        [taskId, colorId]
      );
      await client.query(
        `UPDATE site_assignments SET color_id = $2, updated_at = NOW() WHERE task_id = $1`,
        [taskId, colorId]
      );
      await client.query('COMMIT');
      broadcastSync(['tasks', 'assignments'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore aggiornamento colore evento.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/tasks/autonomous', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { directory } = await resolveCallerRole(pool, user);
    const body = req.body || {};
    const descrizione = clampStr(
      body.descrizione,
      VALIDATION_LIMITS.TASK_DESC_MAX_LEN
    );
    if (!descrizione) {
      res.status(400).json({
        error:
          "Inserire la descrizione dell'attività (eventuale numero TK incluso nella descrizione).",
      });
      return;
    }

    const inizioDate = new Date(String(body.inizioIso || ''));
    const fineDate = new Date(String(body.fineIso || ''));
    const inizioMs = inizioDate.getTime();
    const fineMs = fineDate.getTime();
    if (Number.isNaN(inizioMs) || Number.isNaN(fineMs)) {
      res
        .status(400)
        .json({ error: 'Inserire date e orari di inizio e fine validi.' });
      return;
    }
    if (fineMs < inizioMs + VALIDATION_LIMITS.MIN_TASK_DURATION_MS) {
      res.status(400).json({
        error:
          "L'orario di fine deve essere ad almeno un'ora di distanza dall'orario di inizio.",
      });
      return;
    }

    const cleanEmail = normalizeEmail(body.technicianEmail || user.email);
    const matchedMember = findStaffMemberByAnyEmail(cleanEmail, directory);
    const rawDeliverable = normalizeEmail(
      body.technicianDeliverableEmail ||
        (matchedMember ? getDeliverableEmail(matchedMember) : cleanEmail)
    );
    const cleanDeliverableEmail =
      VALIDATION_LIMITS.EMAIL_PATTERN.test(rawDeliverable) &&
      !isLoginOnlyIdEmail(rawDeliverable)
        ? rawDeliverable
        : !isLoginOnlyIdEmail(cleanEmail)
        ? cleanEmail
        : '';
    const cleanName = clampStr(
      body.technicianFullName ||
        (matchedMember
          ? `${matchedMember.nome} ${matchedMember.cognome}`
          : cleanEmail),
      VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
      cleanEmail
    );
    const techAliases = buildTechnicianEmailAliases(cleanEmail, directory);
    const squadAclEmails = expandSquadAclEmails([cleanEmail], directory);

    const adminUidsFromDir = directory
      .filter((m) => m.role === 'admin' && m.active && m.linkedUid)
      .map((m) => m.linkedUid);
    const adminEmailsFromDir = directory
      .filter((m) => m.role === 'admin' && m.active)
      .map((m) => getDeliverableEmail(m))
      .filter(Boolean);

    const boundedAdmins = Array.from(
      new Set([
        ...adminUidsFromDir,
        ...(Array.isArray(body.knownAdminUids)
          ? body.knownAdminUids.map(String)
          : []),
      ].filter(Boolean))
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const boundedAdminEmails = Array.from(
      new Set(
        (adminEmailsFromDir.length > 0
          ? adminEmailsFromDir
          : [...BOOTSTRAPPED_ADMIN_EMAILS]
        )
          .map((em) => normalizeEmail(em))
          .filter((em) => VALIDATION_LIMITS.EMAIL_PATTERN.test(em))
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const cntRes = await client.query(
        `SELECT COUNT(*)::int AS cnt FROM site_tasks WHERE created_by_role = 'technician'`
      );
      const existingAutonomousCount = Number(cntRes.rows[0]?.cnt || 0);
      const seq = String(existingAutonomousCount + 1).padStart(3, '0');
      const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
      const taskCode = clampStr(
        `T_AUT_${seq}_${suffix}`,
        VALIDATION_LIMITS.CODE_MAX_LEN
      );
      const assignmentCode = clampStr(
        `A_AUT_${seq}_001`,
        VALIDATION_LIMITS.CODE_MAX_LEN
      );
      const taskId = makeSafeId('task');
      const assignmentId = makeSafeId('asg');
      const inizioFormatted = inizioDate.toISOString();
      const fineFormatted = fineDate.toISOString();

      await client.query(
        `INSERT INTO site_tasks
           (task_id, task_code, commessa, descrizione, inizio, inizio_ms, fine, fine_ms,
            stato_prevalente, assigned_emails, assigned_acl_emails, assigned_names,
            assigned_deliverable_emails, assigned_statuses, assigned_notes,
            admin_uids, admin_emails, altro_reparto, pending_admin_review,
            color_id, created_by_role, created_by_uid, created_at, updated_at)
         VALUES ($1,$2,'',$3,$4,$5,$6,$7,'Preso in Carico',$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,FALSE,TRUE,'peacock','technician',$16,NOW(),NOW())`,
        [
          taskId,
          taskCode,
          descrizione,
          inizioFormatted,
          inizioMs,
          fineFormatted,
          fineMs,
          JSON.stringify([cleanEmail]),
          JSON.stringify(squadAclEmails),
          JSON.stringify([cleanName]),
          JSON.stringify(
            cleanDeliverableEmail ? [cleanDeliverableEmail] : []
          ),
          JSON.stringify(['Preso in Carico']),
          JSON.stringify(['']),
          JSON.stringify(boundedAdmins),
          JSON.stringify(boundedAdminEmails),
          user.uid,
        ]
      );

      await client.query(
        `INSERT INTO site_assignments
           (assignment_id, assignment_code, task_id, commessa, descrizione_task,
            inizio, inizio_ms, fine, fine_ms, technician_email, technician_name,
            technician_uid, technician_alias_emails, stato, note_tecnico,
            admin_uids, squad_emails, squad_names, squad_deliverable_emails,
            color_id, created_by_uid, created_at, updated_at)
         VALUES ($1,$2,$3,'',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'Preso in Carico','',$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,'peacock',$11,NOW(),NOW())`,
        [
          assignmentId,
          assignmentCode,
          taskId,
          descrizione,
          inizioFormatted,
          inizioMs,
          fineFormatted,
          fineMs,
          cleanEmail,
          cleanName,
          user.uid,
          JSON.stringify(techAliases),
          JSON.stringify(boundedAdmins),
          JSON.stringify(squadAclEmails),
          JSON.stringify([cleanName]),
          JSON.stringify(
            cleanDeliverableEmail ? [cleanDeliverableEmail] : []
          ),
        ]
      );

      await client.query('COMMIT');
      broadcastSync(['tasks', 'assignments'], user.uid);
      res.json({ taskId, assignmentId, taskCode });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore creazione task autonomo.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/tasks/review', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const body = req.body || {};
    const taskId = clampStr(body.taskId, VALIDATION_LIMITS.ID_MAX_LEN);
    const commessa = clampStr(
      String(body.commessa || '').toUpperCase(),
      VALIDATION_LIMITS.COMMESSA_MAX_LEN
    );
    const descrizione = clampStr(
      body.descrizione,
      VALIDATION_LIMITS.TASK_DESC_MAX_LEN
    );
    if (!taskId || !commessa || !descrizione) {
      res.status(400).json({
        error:
          "Inserire codice Commessa e descrizione dell'attività per completare la revisione.",
      });
      return;
    }

    const inizioDate = new Date(String(body.inizioIso || ''));
    const fineDate = new Date(String(body.fineIso || ''));
    const inizioMs = inizioDate.getTime();
    const fineMs = fineDate.getTime();
    if (
      Number.isNaN(inizioMs) ||
      Number.isNaN(fineMs) ||
      fineMs < inizioMs + VALIDATION_LIMITS.MIN_TASK_DURATION_MS
    ) {
      res.status(400).json({
        error:
          "Date e orari non validi (fine ad almeno un'ora dall'inizio).",
      });
      return;
    }

    const rawAssignees: SelectedAssigneePayload[] = Array.isArray(body.assignees)
      ? body.assignees
      : [];
    const uniqueAssigneesMap = new Map<string, SelectedAssigneePayload>();
    for (const a of rawAssignees) {
      const em = normalizeEmail(a?.email);
      const canonKey = canonicalTechnicianKey(em, directory);
      if (em && canonKey && !uniqueAssigneesMap.has(canonKey)) {
        const matchedMember = findStaffMemberByAnyEmail(em, directory);
        const candDeliv = normalizeEmail(
          a?.deliverableEmail ||
            (matchedMember ? getDeliverableEmail(matchedMember) : em)
        );
        uniqueAssigneesMap.set(canonKey, {
          email: em,
          fullName: clampStr(a?.fullName, VALIDATION_LIMITS.FULL_NAME_MAX_LEN, em),
          linkedUid: String(a?.linkedUid || matchedMember?.linkedUid || ''),
          deliverableEmail:
            VALIDATION_LIMITS.EMAIL_PATTERN.test(candDeliv) &&
            !isLoginOnlyIdEmail(candDeliv)
              ? candDeliv
              : !isLoginOnlyIdEmail(em)
              ? em
              : '',
        });
      }
    }
    const cleanAssignees = Array.from(uniqueAssigneesMap.values()).slice(
      0,
      VALIDATION_LIMITS.MAX_BOUNDED_ARRAY
    );
    if (cleanAssignees.length === 0) {
      res.status(400).json({
        error: 'Selezionare almeno un tecnico in squadra per la revisione.',
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const taskSnap = await client.query(
        `SELECT * FROM site_tasks WHERE task_id = $1 FOR UPDATE`,
        [taskId]
      );
      if (!taskSnap.rowCount) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Task non trovato.' });
        return;
      }
      const task = mapTaskRow(taskSnap.rows[0]);
      const asgSnap = await client.query(
        `SELECT * FROM site_assignments WHERE task_id = $1 FOR UPDATE`,
        [taskId]
      );
      const existingTaskAssignments = asgSnap.rows.map(mapAssignmentRow);

      const assignedEmails = cleanAssignees.map((a) => a.email);
      const assignedAclEmails = expandSquadAclEmails(assignedEmails, directory);
      const assignedNames = cleanAssignees.map((a) => a.fullName);
      const assignedDeliverableEmails = cleanAssignees
        .map((a) => a.deliverableEmail || a.email)
        .filter((addr) => addr && !isLoginOnlyIdEmail(addr));

      const currentAdminUids = Array.isArray(body.currentAdminUids)
        ? body.currentAdminUids.map(String)
        : [];
      const boundedAdmins = Array.from(
        new Set([user.uid, ...currentAdminUids].filter(Boolean))
      ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

      const rawAdminEmails: string[] = Array.isArray(body.activeAdminEmails)
        ? body.activeAdminEmails.map(String)
        : [];
      const boundedAdminEmails = Array.from(
        new Set(
          (rawAdminEmails.length > 0
            ? rawAdminEmails
            : [...BOOTSTRAPPED_ADMIN_EMAILS]
          )
            .map((em: string) => normalizeEmail(em))
            .filter((em: string) => VALIDATION_LIMITS.EMAIL_PATTERN.test(em))
        )
      ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

      const existingByCanon = new Map<string, Assignment>();
      for (const asg of existingTaskAssignments) {
        const canon = canonicalTechnicianKey(asg.technicianEmail, directory);
        if (
          canon &&
          (!existingByCanon.has(canon) || asg.stato !== 'Annullato')
        ) {
          existingByCanon.set(canon, asg);
        }
      }

      const statusForAddedColleague: AssignmentStatus =
        task.statoPrevalente === 'Completato' &&
        body.markAddedColleaguesCompleted !== false
          ? 'Completato'
          : 'Preso in Carico';

      const resultingStatuses: AssignmentStatus[] = [];
      const resultingNotes: string[] = [];
      for (const assignee of cleanAssignees) {
        const canon = canonicalTechnicianKey(assignee.email, directory);
        const prev = existingByCanon.get(canon);
        resultingStatuses.push(prev ? prev.stato : statusForAddedColleague);
        resultingNotes.push(
          clampStr(prev ? prev.noteTecnico : '', VALIDATION_LIMITS.NOTE_MAX_LEN)
        );
      }
      const resultingTaskStatus = computeTaskPrevalentStatus(resultingStatuses);
      const inizioFormatted = inizioDate.toISOString();
      const fineFormatted = fineDate.toISOString();
      const resolvedReviewColorId: TaskColorId =
        body.colorId &&
        (TASK_COLOR_IDS as readonly string[]).includes(String(body.colorId))
          ? (body.colorId as TaskColorId)
          : task.colorId &&
            (TASK_COLOR_IDS as readonly string[]).includes(task.colorId)
          ? task.colorId
          : 'peacock';

      await client.query(
        `UPDATE site_tasks
         SET commessa = $2,
             descrizione = $3,
             inizio = $4,
             inizio_ms = $5,
             fine = $6,
             fine_ms = $7,
             stato_prevalente = $8,
             assigned_emails = $9::jsonb,
             assigned_acl_emails = $10::jsonb,
             assigned_names = $11::jsonb,
             assigned_deliverable_emails = $12::jsonb,
             assigned_statuses = $13::jsonb,
             assigned_notes = $14::jsonb,
             admin_uids = $15::jsonb,
             admin_emails = $16::jsonb,
             altro_reparto = FALSE,
             pending_admin_review = FALSE,
             color_id = $17,
             updated_at = NOW()
         WHERE task_id = $1`,
        [
          task.taskId,
          commessa,
          descrizione,
          inizioFormatted,
          inizioMs,
          fineFormatted,
          fineMs,
          resultingTaskStatus,
          JSON.stringify(assignedEmails),
          JSON.stringify(assignedAclEmails),
          JSON.stringify(assignedNames),
          JSON.stringify(assignedDeliverableEmails),
          JSON.stringify(resultingStatuses),
          JSON.stringify(resultingNotes),
          JSON.stringify(boundedAdmins),
          JSON.stringify(boundedAdminEmails),
          resolvedReviewColorId,
        ]
      );

      let seqCounter = existingTaskAssignments.length;
      const updatedAssignments: Assignment[] = [];

      for (const assignee of cleanAssignees) {
        const canon = canonicalTechnicianKey(assignee.email, directory);
        const prev = existingByCanon.get(canon);
        const techAliases = buildTechnicianEmailAliases(
          assignee.email,
          directory
        );
        if (prev) {
          const updRes = await client.query(
            `UPDATE site_assignments
             SET commessa = $2,
                 descrizione_task = $3,
                 inizio = $4,
                 inizio_ms = $5,
                 fine = $6,
                 fine_ms = $7,
                 technician_email = $8,
                 technician_name = $9,
                 technician_uid = $10,
                 technician_alias_emails = $11::jsonb,
                 admin_uids = $12::jsonb,
                 squad_emails = $13::jsonb,
                 squad_names = $14::jsonb,
                 squad_deliverable_emails = $15::jsonb,
                 color_id = $16,
                 updated_at = NOW()
             WHERE assignment_id = $1
             RETURNING *`,
            [
              prev.assignmentId,
              commessa,
              descrizione,
              inizioFormatted,
              inizioMs,
              fineFormatted,
              fineMs,
              assignee.email,
              assignee.fullName,
              assignee.linkedUid || prev.technicianUid,
              JSON.stringify(techAliases),
              JSON.stringify(boundedAdmins),
              JSON.stringify(assignedAclEmails),
              JSON.stringify(assignedNames),
              JSON.stringify(assignedDeliverableEmails),
              resolvedReviewColorId,
            ]
          );
          updatedAssignments.push(mapAssignmentRow(updRes.rows[0]));
        } else {
          seqCounter += 1;
          const assignmentId = makeSafeId('asg');
          const assignmentCode = clampStr(
            `A_${commessa}_${String(seqCounter).padStart(3, '0')}`,
            VALIDATION_LIMITS.CODE_MAX_LEN
          );
          const insRes = await client.query(
            `INSERT INTO site_assignments
               (assignment_id, assignment_code, task_id, commessa, descrizione_task,
                inizio, inizio_ms, fine, fine_ms, technician_email, technician_name,
                technician_uid, technician_alias_emails, stato, note_tecnico,
                admin_uids, squad_emails, squad_names, squad_deliverable_emails,
                color_id, created_by_uid, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'',$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,NOW(),NOW())
             RETURNING *`,
            [
              assignmentId,
              assignmentCode,
              task.taskId,
              commessa,
              descrizione,
              inizioFormatted,
              inizioMs,
              fineFormatted,
              fineMs,
              assignee.email,
              assignee.fullName,
              assignee.linkedUid,
              JSON.stringify(techAliases),
              statusForAddedColleague,
              JSON.stringify(boundedAdmins),
              JSON.stringify(assignedAclEmails),
              JSON.stringify(assignedNames),
              JSON.stringify(assignedDeliverableEmails),
              resolvedReviewColorId,
              user.uid,
            ]
          );
          updatedAssignments.push(mapAssignmentRow(insRes.rows[0]));
        }
      }

      const selectedCanonSet = new Set(
        cleanAssignees.map((a) => canonicalTechnicianKey(a.email, directory))
      );
      const removedIds = existingTaskAssignments
        .filter(
          (oldAsg) =>
            !selectedCanonSet.has(
              canonicalTechnicianKey(oldAsg.technicianEmail, directory)
            )
        )
        .map((oldAsg) => oldAsg.assignmentId);

      if (removedIds.length > 0) {
        await client.query(
          `DELETE FROM site_assignments WHERE assignment_id = ANY($1::text[])`,
          [removedIds]
        );
      }

      await client.query(
        `UPDATE site_used_materials
         SET commessa = $2, admin_uids = $3::jsonb, squad_emails = $4::jsonb, updated_at = NOW()
         WHERE task_id = $1`,
        [
          task.taskId,
          commessa,
          JSON.stringify(boundedAdmins),
          JSON.stringify(assignedAclEmails),
        ]
      );

      const newFolderPath = clampStr(
        body.newFolderPath,
        VALIDATION_LIMITS.FOLDER_PATH_MAX_LEN
      );
      const resolvedSubfolderId = clampStr(
        body.resolvedSubfolderId,
        VALIDATION_LIMITS.DRIVE_ID_MAX_LEN
      );

      await client.query(
        `UPDATE site_intervention_photos
         SET commessa = $2,
             folder_path = CASE WHEN $3 <> '' THEN $3 ELSE folder_path END,
             drive_subfolder_id = CASE WHEN $4 <> '' THEN $4 ELSE drive_subfolder_id END,
             admin_uids = $5::jsonb,
             squad_emails = $6::jsonb,
             updated_at = NOW()
         WHERE task_id = $1`,
        [
          task.taskId,
          commessa,
          newFolderPath,
          resolvedSubfolderId,
          JSON.stringify(boundedAdmins),
          JSON.stringify(assignedAclEmails),
        ]
      );

      await client.query('COMMIT');
      broadcastSync(['tasks', 'assignments', 'materials', 'photos'], user.uid);
      res.json({
        resultingTaskStatus,
        updatedAssignments,
        becameCompleted:
          task.statoPrevalente !== 'Completato' &&
          resultingTaskStatus === 'Completato',
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore revisione task autonomo.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/tasks/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const taskId = clampStr(req.body?.taskId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!taskId) {
      res.status(400).json({ error: 'taskId mancante.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM site_used_materials WHERE task_id = $1`, [
        taskId,
      ]);
      await client.query(
        `DELETE FROM site_intervention_photos WHERE task_id = $1`,
        [taskId]
      );
      await client.query(`DELETE FROM site_assignments WHERE task_id = $1`, [
        taskId,
      ]);
      await client.query(`DELETE FROM site_tasks WHERE task_id = $1`, [taskId]);
      await client.query('COMMIT');

      broadcastSync(['tasks', 'assignments', 'materials', 'photos'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Errore eliminazione task.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/tasks/admin-status', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const taskId = clampStr(req.body?.taskId, VALIDATION_LIMITS.ID_MAX_LEN);
    const newStatus = String(req.body?.newStatus || '') as TaskStatus;
    const trimmedAdminNote = clampStr(
      req.body?.adminNoteOptional,
      VALIDATION_LIMITS.NOTE_MAX_LEN
    );

    if (
      !taskId ||
      !['Non Assegnato', 'Assegnato', 'Preso in Carico', 'Completato'].includes(
        newStatus
      )
    ) {
      res.status(400).json({ error: 'Parametri stato task non validi.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const taskSnap = await client.query(
        `SELECT * FROM site_tasks WHERE task_id = $1 FOR UPDATE`,
        [taskId]
      );
      if (!taskSnap.rowCount) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Task non trovato.' });
        return;
      }
      const task = mapTaskRow(taskSnap.rows[0]);
      const asgSnap = await client.query(
        `SELECT * FROM site_assignments WHERE task_id = $1 FOR UPDATE`,
        [taskId]
      );
      const activeAsgs = asgSnap.rows
        .map(mapAssignmentRow)
        .filter((a) => a.stato !== 'Annullato');

      const boundedTaskEmails = task.assignedEmails.slice(
        0,
        VALIDATION_LIMITS.MAX_BOUNDED_ARRAY
      );

      if (activeAsgs.length === 0 || newStatus === 'Non Assegnato') {
        if (newStatus === 'Non Assegnato' && activeAsgs.length > 0) {
          await client.query(
            `UPDATE site_assignments
             SET stato = 'Assegnato', updated_at = NOW()
             WHERE task_id = $1 AND stato <> 'Annullato'`,
            [taskId]
          );
          await client.query(
            `UPDATE site_tasks
             SET stato_prevalente = 'Assegnato',
                 assigned_statuses = $2::jsonb,
                 updated_at = NOW()
             WHERE task_id = $1`,
            [
              taskId,
              JSON.stringify(boundedTaskEmails.map(() => 'Assegnato')),
            ]
          );
        } else {
          const emptySquadStatus: AssignmentStatus =
            newStatus === 'Completato'
              ? 'Completato'
              : newStatus === 'Preso in Carico'
              ? 'Preso in Carico'
              : 'Assegnato';
          await client.query(
            `UPDATE site_tasks
             SET stato_prevalente = $2,
                 assigned_statuses = $3::jsonb,
                 updated_at = NOW()
             WHERE task_id = $1`,
            [
              taskId,
              newStatus,
              JSON.stringify(boundedTaskEmails.map(() => emptySquadStatus)),
            ]
          );
        }
      } else {
        const targetAsgStatus: AssignmentStatus =
          newStatus === 'Completato'
            ? 'Completato'
            : newStatus === 'Preso in Carico'
            ? 'Preso in Carico'
            : 'Assegnato';

        const nextNoteByCanon = new Map<string, string>();
        for (const asg of activeAsgs) {
          const nextNote = trimmedAdminNote
            ? asg.noteTecnico.trim()
              ? `${asg.noteTecnico.trim()}\n[Admin]: ${trimmedAdminNote}`.slice(
                  0,
                  VALIDATION_LIMITS.NOTE_MAX_LEN
                )
              : trimmedAdminNote
            : asg.noteTecnico;

          const canon = canonicalTechnicianKey(asg.technicianEmail, directory);
          if (canon) {
            nextNoteByCanon.set(
              canon,
              clampStr(nextNote, VALIDATION_LIMITS.NOTE_MAX_LEN)
            );
          }

          await client.query(
            `UPDATE site_assignments
             SET stato = $2, note_tecnico = $3, updated_at = NOW()
             WHERE assignment_id = $1`,
            [asg.assignmentId, targetAsgStatus, nextNote]
          );
        }

        const nextAssignedNotes = boundedTaskEmails.map((em, idx) => {
          const canon = canonicalTechnicianKey(em, directory);
          return clampStr(
            (canon ? nextNoteByCanon.get(canon) : undefined) ??
              task.assignedNotes?.[idx] ??
              '',
            VALIDATION_LIMITS.NOTE_MAX_LEN
          );
        });

        await client.query(
          `UPDATE site_tasks
           SET stato_prevalente = $2,
               assigned_statuses = $3::jsonb,
               assigned_notes = $4::jsonb,
               updated_at = NOW()
           WHERE task_id = $1`,
          [
            taskId,
            newStatus,
            JSON.stringify(boundedTaskEmails.map(() => targetAsgStatus)),
            JSON.stringify(nextAssignedNotes),
          ]
        );
      }

      await client.query('COMMIT');
      broadcastSync(['tasks', 'assignments'], user.uid);
      res.json({
        ok: true,
        becameCompleted:
          task.statoPrevalente !== 'Completato' && newStatus === 'Completato',
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore aggiornamento stato task.',
      });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Technician / Admin Assignment Status & Notes (Atomic SQL Transaction)
  // ---------------------------------------------------------------------------
  router.post('/assignments/status', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const assignmentId = clampStr(
      req.body?.assignmentId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );
    const fallbackTaskId = clampStr(
      req.body?.taskId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );
    const fallbackTechEmail = normalizeEmail(req.body?.technicianEmail || '');
    const fallbackTechName = clampStr(
      req.body?.technicianName,
      VALIDATION_LIMITS.FULL_NAME_MAX_LEN
    );
    const newStatus = String(req.body?.newStatus || '') as AssignmentStatus;
    const cleanNote = clampStr(
      req.body?.noteTecnico,
      VALIDATION_LIMITS.NOTE_MAX_LEN
    );
    const isAltroReparto = Boolean(req.body?.isAltroReparto);
    const exemptCommesse = Array.isArray(req.body?.exemptCommesse)
      ? req.body.exemptCommesse.map((c: unknown) =>
          String(c || '').trim().toUpperCase()
        )
      : [];

    if (
      (!assignmentId && !fallbackTaskId) ||
      !['Assegnato', 'Preso in Carico', 'Completato', 'Annullato'].includes(
        newStatus
      )
    ) {
      res.status(400).json({ error: 'Parametri assegnazione non validi.' });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { isAdmin, directory } = await resolveCallerRole(client, user);

      let freshAsg: Assignment | undefined;
      if (assignmentId) {
        const asgRes = await client.query(
          `SELECT * FROM site_assignments WHERE assignment_id = $1 FOR UPDATE`,
          [assignmentId]
        );
        if (asgRes.rowCount && asgRes.rows[0]) {
          freshAsg = mapAssignmentRow(asgRes.rows[0]);
        }
      }

      // Fallback 1: Resolve active assignment by (taskId + canonical technician) if superseded by concurrent squad edit
      if (!freshAsg && fallbackTaskId) {
        const taskAsgsRes = await client.query(
          `SELECT * FROM site_assignments WHERE task_id = $1 FOR UPDATE`,
          [fallbackTaskId]
        );
        const candidates = taskAsgsRes.rows
          .map(mapAssignmentRow)
          .filter((a) => a.stato !== 'Annullato');

        const targetEmail = fallbackTechEmail || normalizeEmail(user.email);
        const targetCanon = canonicalTechnicianKey(targetEmail, directory);

        freshAsg = candidates.find(
          (a) =>
            (targetCanon &&
              canonicalTechnicianKey(a.technicianEmail, directory) ===
                targetCanon) ||
            (!isAdmin && Boolean(user.uid) && a.technicianUid === user.uid)
        );

        if (!freshAsg && isAdmin && !fallbackTechEmail && candidates.length === 1) {
          freshAsg = candidates[0];
        }
      }

      // Fallback 2: Auto-heal missing assignment row if task still includes the technician (or Admin acts directly)
      if (!freshAsg && fallbackTaskId) {
        const taskCheckRes = await client.query(
          `SELECT * FROM site_tasks WHERE task_id = $1 FOR UPDATE`,
          [fallbackTaskId]
        );
        if (taskCheckRes.rowCount && taskCheckRes.rows[0]) {
          const parentTask = mapTaskRow(taskCheckRes.rows[0]);
          const callerAssigned = parentTask.assignedEmails.some((em) =>
            areSameTechnicianEmails(em, user.email, directory)
          );
          if (isAdmin || callerAssigned) {
            const targetEmail = normalizeEmail(
              fallbackTechEmail ||
                parentTask.assignedEmails.find((em) =>
                  areSameTechnicianEmails(em, user.email, directory)
                ) ||
                user.email
            );
            const matchedStaff = findStaffMemberByAnyEmail(
              targetEmail,
              directory
            );
            const targetName = clampStr(
              fallbackTechName ||
                (matchedStaff
                  ? `${matchedStaff.nome} ${matchedStaff.cognome}`.trim()
                  : targetEmail),
              VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
              targetEmail
            );
            const targetUid = isAdmin
              ? matchedStaff?.linkedUid || ''
              : user.uid;
            const repairedId = makeSafeId('asg');
            const repairedCode = clampStr(
              `A_${(parentTask.commessa || 'REP').slice(0, 12)}_R1`,
              VALIDATION_LIMITS.CODE_MAX_LEN
            );
            const techAliases = buildTechnicianEmailAliases(
              targetEmail,
              directory
            );
            const repairedSquadEmails =
              parentTask.assignedAclEmails &&
              parentTask.assignedAclEmails.length > 0
                ? parentTask.assignedAclEmails
                : expandSquadAclEmails(
                    [...parentTask.assignedEmails, targetEmail],
                    directory
                  );
            const repairedSquadNames =
              parentTask.assignedNames.length > 0
                ? parentTask.assignedNames
                : [targetName];
            const repairedDeliverables =
              parentTask.assignedDeliverableEmails &&
              parentTask.assignedDeliverableEmails.length > 0
                ? parentTask.assignedDeliverableEmails
                : [
                    matchedStaff
                      ? getDeliverableEmail(matchedStaff)
                      : isLoginOnlyIdEmail(targetEmail)
                      ? ''
                      : targetEmail,
                  ].filter(Boolean);

            const insertedRes = await client.query(
              `INSERT INTO site_assignments
                 (assignment_id, assignment_code, task_id, commessa, descrizione_task,
                  inizio, inizio_ms, fine, fine_ms, technician_email, technician_name,
                  technician_uid, technician_alias_emails, stato, note_tecnico,
                  admin_uids, squad_emails, squad_names, squad_deliverable_emails,
                  color_id, created_by_uid, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'Assegnato','',$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,NOW(),NOW())
               RETURNING *`,
              [
                repairedId,
                repairedCode,
                parentTask.taskId,
                parentTask.commessa,
                parentTask.descrizione,
                parentTask.inizio || new Date(parentTask.inizioMs).toISOString(),
                parentTask.inizioMs,
                parentTask.fine || new Date(parentTask.fineMs).toISOString(),
                parentTask.fineMs,
                targetEmail,
                targetName,
                targetUid,
                JSON.stringify(techAliases),
                JSON.stringify(parentTask.adminUids || [user.uid]),
                JSON.stringify(repairedSquadEmails),
                JSON.stringify(repairedSquadNames),
                JSON.stringify(repairedDeliverables),
                parentTask.colorId || 'peacock',
                user.uid,
              ]
            );
            if (insertedRes.rows[0]) {
              freshAsg = mapAssignmentRow(insertedRes.rows[0]);
            }
          }
        }
      }

      if (!freshAsg) {
        await client.query('ROLLBACK');
        res.status(404).json({
          code: 'ASSIGNMENT_NOT_FOUND',
          error:
            'Questa assegnazione è stata aggiornata di recente. Riprova tra un istante dopo il riallineamento automatico.',
        });
        return;
      }

      if (
        !isAdmin &&
        !isAssignmentOwnedByViewer(freshAsg, user.email, user.uid, directory)
      ) {
        await client.query('ROLLBACK');
        res.status(422).json({
          error:
            'Non disponi dei permessi per modificare questa quota di lavoro.',
        });
        return;
      }

      const taskRes = await client.query(
        `SELECT * FROM site_tasks WHERE task_id = $1 FOR UPDATE`,
        [freshAsg.taskId]
      );
      const freshTask = taskRes.rows[0]
        ? mapTaskRow(taskRes.rows[0])
        : undefined;

      const effectiveAltroReparto =
        isAltroReparto || Boolean(freshTask?.altroReparto);
      const isCommessaExempt =
        effectiveAltroReparto ||
        (Boolean(freshAsg.commessa.trim()) &&
          exemptCommesse.includes(freshAsg.commessa.trim().toUpperCase()));

      if (
        !isAdmin &&
        newStatus === 'Completato' &&
        !isCommessaExempt &&
        !cleanNote
      ) {
        await client.query('ROLLBACK');
        const label = freshAsg.commessa.trim()
          ? `sulla commessa ${freshAsg.commessa.trim()}`
          : 'per chiudere il task';
        res
          .status(400)
          .json({ error: `Le Note Attività sono obbligatorie ${label}.` });
        return;
      }

      const sibRes = await client.query(
        `SELECT * FROM site_assignments WHERE task_id = $1 FOR UPDATE`,
        [freshAsg.taskId]
      );
      const siblingList = sibRes.rows.map(mapAssignmentRow);

      const computed = computeSquadTransitionServer({
        freshAsg,
        siblingList,
        freshTask,
        newStatus,
        cleanNote,
        directory,
      });

      const nextTechUid = isAdmin
        ? freshAsg.technicianUid
        : user.uid || freshAsg.technicianUid;

      await client.query(
        `UPDATE site_assignments
         SET stato = $2,
             note_tecnico = $3,
             technician_uid = $4,
             updated_at = NOW()
         WHERE assignment_id = $1`,
        [freshAsg.assignmentId, newStatus, cleanNote, nextTechUid]
      );

      if (freshTask) {
        await client.query(
          `UPDATE site_tasks
           SET stato_prevalente = $2,
               assigned_statuses = CASE WHEN $3::int > 0 THEN $4::jsonb ELSE assigned_statuses END,
               assigned_notes = CASE WHEN $3::int > 0 THEN $5::jsonb ELSE assigned_notes END,
               updated_at = NOW()
           WHERE task_id = $1`,
          [
            freshTask.taskId,
            computed.nextTaskStatus,
            computed.nextAssignedStatuses.length,
            JSON.stringify(computed.nextAssignedStatuses),
            JSON.stringify(computed.nextAssignedNotes),
          ]
        );
      }

      await client.query('COMMIT');
      broadcastSync(['tasks', 'assignments'], user.uid);

      res.json({
        taskBecameCompleted: computed.taskBecameCompleted,
        nextTaskStatus: computed.nextTaskStatus,
        completedCount: computed.completedCount,
        totalSquadCount: computed.totalSquadCount,
        authoritativeTask: computed.authoritativeTask,
        squadNotesByEmail: computed.squadNotesByEmail,
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio stato e note assegnazione.',
      });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Used Materials on Task (Add / Update Qty / Delete)
  // ---------------------------------------------------------------------------
  router.post('/materials/add', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const body = req.body || {};
    const qty = Number(body.quantita);
    if (
      !Number.isFinite(qty) ||
      qty <= 0 ||
      qty > VALIDATION_LIMITS.MAX_MATERIAL_QTY
    ) {
      res
        .status(400)
        .json({ error: 'Inserire una quantità valida maggiore di zero.' });
      return;
    }

    const { directory } = await resolveCallerRole(pool, user);
    const asg = body.assignment || {};
    const art = body.article || {};
    const rawAssignmentId = clampStr(
      asg.assignmentId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );
    const taskId = clampStr(asg.taskId, VALIDATION_LIMITS.ID_MAX_LEN);
    const articleId = clampStr(art.articleId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!taskId || !articleId) {
      res.status(400).json({ error: 'Dati materiale o intervento incompleti.' });
      return;
    }

    const techEmail = normalizeEmail(asg.technicianEmail || user.email);
    const techCanon = canonicalTechnicianKey(techEmail, directory);

    const rawSquad: string[] = Array.isArray(body.squadEmails)
      ? body.squadEmails.map(String)
      : Array.isArray(asg.squadEmails)
      ? asg.squadEmails.map(String)
      : [String(asg.technicianEmail || user.email)];

    const squadEmails = expandSquadAclEmails([...rawSquad, techEmail], directory);
    const adminUids = Array.isArray(asg.adminUids)
      ? asg.adminUids.map(String).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY)
      : [];

    const usedId = makeSafeId('mat');

    try {
      let resolvedAssignmentId = rawAssignmentId;
      let resolvedCommessa = clampStr(
        asg.commessa,
        VALIDATION_LIMITS.COMMESSA_MAX_LEN
      );

      const liveAsgsRes = await pool.query(
        `SELECT assignment_id, technician_email, stato, commessa
         FROM site_assignments
         WHERE task_id = $1`,
        [taskId]
      );
      if (liveAsgsRes.rowCount && liveAsgsRes.rows.length > 0) {
        const exactMatch = liveAsgsRes.rows.find(
          (r) => String(r.assignment_id || '') === rawAssignmentId
        );
        if (exactMatch) {
          resolvedAssignmentId = String(exactMatch.assignment_id);
          if (!resolvedCommessa && exactMatch.commessa) {
            resolvedCommessa = clampStr(
              exactMatch.commessa,
              VALIDATION_LIMITS.COMMESSA_MAX_LEN
            );
          }
        } else {
          const activeRows = liveAsgsRes.rows.filter(
            (r) => String(r.stato || '') !== 'Annullato'
          );
          const canonMatch =
            activeRows.find(
              (r) =>
                canonicalTechnicianKey(
                  String(r.technician_email || ''),
                  directory
                ) === techCanon
            ) || activeRows[0];
          if (canonMatch) {
            resolvedAssignmentId = String(canonMatch.assignment_id);
            if (!resolvedCommessa && canonMatch.commessa) {
              resolvedCommessa = clampStr(
                canonMatch.commessa,
                VALIDATION_LIMITS.COMMESSA_MAX_LEN
              );
            }
          }
        }
      }
      if (!resolvedAssignmentId) {
        resolvedAssignmentId = makeSafeId('asg_mat');
      }

      await pool.query(
        `INSERT INTO site_used_materials
           (used_id, assignment_id, task_id, commessa, technician_email, technician_name,
            technician_uid, article_id, codice_articolo, descrizione_articolo, categoria,
            unita_misura, quantita, admin_uids, squad_emails, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,NOW(),NOW())`,
        [
          usedId,
          resolvedAssignmentId,
          taskId,
          resolvedCommessa,
          techEmail,
          clampStr(
            asg.technicianName,
            VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
            techEmail
          ),
          user.uid,
          articleId,
          clampStr(art.codiceArticolo, VALIDATION_LIMITS.CODE_MAX_LEN),
          clampStr(art.descrizione, VALIDATION_LIMITS.ARTICLE_DESC_MAX_LEN),
          clampStr(art.categoria, VALIDATION_LIMITS.CATEGORY_MAX_LEN, 'Generale'),
          clampStr(art.unitaMisura, VALIDATION_LIMITS.UNIT_MAX_LEN, 'pz'),
          Math.round(qty * 100) / 100,
          JSON.stringify(adminUids),
          JSON.stringify(squadEmails),
        ]
      );

      broadcastSync(['materials'], user.uid);
      res.json({ usedId });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore registrazione materiale utilizzato.',
      });
    }
  });

  router.post('/materials/qty', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const usedId = clampStr(req.body?.usedId, VALIDATION_LIMITS.ID_MAX_LEN);
    const qty = Number(req.body?.quantita);
    if (
      !usedId ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      qty > VALIDATION_LIMITS.MAX_MATERIAL_QTY
    ) {
      res
        .status(400)
        .json({ error: 'Inserire una quantità valida maggiore di zero.' });
      return;
    }

    try {
      await pool.query(
        `UPDATE site_used_materials
         SET quantita = $2, updated_at = NOW()
         WHERE used_id = $1`,
        [usedId, Math.round(qty * 100) / 100]
      );
      broadcastSync(['materials'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore modifica quantità materiale.',
      });
    }
  });

  router.post('/materials/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const usedId = clampStr(req.body?.usedId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!usedId) {
      res.status(400).json({ error: 'usedId mancante.' });
      return;
    }

    try {
      await pool.query(`DELETE FROM site_used_materials WHERE used_id = $1`, [
        usedId,
      ]);
      broadcastSync(['materials'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Errore rimozione materiale.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Intervention Photos Metadata (Google Drive Links & Consolidation)
  // ---------------------------------------------------------------------------
  router.post('/photos/add', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { directory } = await resolveCallerRole(pool, user);
    const body = req.body || {};
    const asg = body.assignment || {};
    const rawAssignmentId = clampStr(
      asg.assignmentId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );
    const taskId = clampStr(asg.taskId, VALIDATION_LIMITS.ID_MAX_LEN);
    const driveFileId = clampStr(
      body.driveFileId,
      VALIDATION_LIMITS.DRIVE_ID_MAX_LEN
    );
    if (!taskId || !driveFileId) {
      res.status(400).json({ error: 'Metadati foto Google Drive incompleti.' });
      return;
    }

    const techEmail = normalizeEmail(asg.technicianEmail || user.email);
    const techCanon = canonicalTechnicianKey(techEmail, directory);
    const rawSquad: string[] = Array.isArray(body.squadEmails)
      ? body.squadEmails.map(String)
      : Array.isArray(asg.squadEmails)
      ? asg.squadEmails.map(String)
      : [techEmail];
    const squadEmails = expandSquadAclEmails([...rawSquad, techEmail], directory);
    const adminUids = Array.isArray(asg.adminUids)
      ? asg.adminUids.map(String).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY)
      : [];

    const photoId = makeSafeId('photo');

    try {
      let resolvedAssignmentId = rawAssignmentId;
      let resolvedCommessa = clampStr(
        asg.commessa,
        VALIDATION_LIMITS.COMMESSA_MAX_LEN
      );

      const liveAsgsRes = await pool.query(
        `SELECT assignment_id, technician_email, stato, commessa
         FROM site_assignments
         WHERE task_id = $1`,
        [taskId]
      );
      if (liveAsgsRes.rowCount && liveAsgsRes.rows.length > 0) {
        const exactMatch = liveAsgsRes.rows.find(
          (r) => String(r.assignment_id || '') === rawAssignmentId
        );
        if (exactMatch) {
          resolvedAssignmentId = String(exactMatch.assignment_id);
          if (!resolvedCommessa && exactMatch.commessa) {
            resolvedCommessa = clampStr(
              exactMatch.commessa,
              VALIDATION_LIMITS.COMMESSA_MAX_LEN
            );
          }
        } else {
          const activeRows = liveAsgsRes.rows.filter(
            (r) => String(r.stato || '') !== 'Annullato'
          );
          const canonMatch =
            activeRows.find(
              (r) =>
                canonicalTechnicianKey(
                  String(r.technician_email || ''),
                  directory
                ) === techCanon
            ) || activeRows[0];
          if (canonMatch) {
            resolvedAssignmentId = String(canonMatch.assignment_id);
            if (!resolvedCommessa && canonMatch.commessa) {
              resolvedCommessa = clampStr(
                canonMatch.commessa,
                VALIDATION_LIMITS.COMMESSA_MAX_LEN
              );
            }
          }
        }
      }
      if (!resolvedAssignmentId) {
        resolvedAssignmentId = makeSafeId('asg_pho');
      }

      await pool.query(
        `INSERT INTO site_intervention_photos
           (photo_id, assignment_id, task_id, commessa, technician_email, technician_name,
            technician_uid, file_name, drive_file_id, drive_web_view_link, drive_thumbnail_link,
            folder_path, caption, admin_uids, squad_emails, drive_subfolder_id,
            owner_consolidated, pending_cleanup_file_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,'',NOW(),NOW())`,
        [
          photoId,
          resolvedAssignmentId,
          taskId,
          resolvedCommessa,
          techEmail,
          clampStr(
            asg.technicianName,
            VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
            techEmail
          ),
          user.uid,
          clampStr(body.fileName, VALIDATION_LIMITS.FILE_NAME_MAX_LEN, 'foto.jpg'),
          driveFileId,
          clampStr(body.driveWebViewLink, VALIDATION_LIMITS.URL_MAX_LEN),
          String(body.driveThumbnailLink || '').slice(
            0,
            VALIDATION_LIMITS.URL_MAX_LEN
          ),
          clampStr(body.folderPath, VALIDATION_LIMITS.FOLDER_PATH_MAX_LEN),
          clampStr(body.caption, VALIDATION_LIMITS.CAPTION_MAX_LEN),
          JSON.stringify(adminUids),
          JSON.stringify(squadEmails),
          clampStr(body.driveSubfolderId, VALIDATION_LIMITS.DRIVE_ID_MAX_LEN),
          Boolean(body.ownerConsolidated),
        ]
      );

      broadcastSync(['photos'], user.uid);
      res.json({ photoId });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore registrazione foto intervento.',
      });
    }
  });

  router.post('/photos/consolidate', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const photoId = clampStr(req.body?.photoId, VALIDATION_LIMITS.ID_MAX_LEN);
    const outcome = req.body?.outcome || {};
    if (!photoId || !outcome.newDriveFileId) {
      res.status(400).json({ error: 'Dati consolidamento foto mancanti.' });
      return;
    }

    try {
      await pool.query(
        `UPDATE site_intervention_photos
         SET file_name = $2,
             drive_file_id = $3,
             drive_web_view_link = $4,
             drive_thumbnail_link = $5,
             drive_subfolder_id = $6,
             folder_path = $7,
             owner_consolidated = TRUE,
             pending_cleanup_file_id = $8,
             updated_at = NOW()
         WHERE photo_id = $1`,
        [
          photoId,
          clampStr(
            outcome.newFileName,
            VALIDATION_LIMITS.FILE_NAME_MAX_LEN,
            'foto.jpg'
          ),
          clampStr(outcome.newDriveFileId, VALIDATION_LIMITS.DRIVE_ID_MAX_LEN),
          clampStr(outcome.newWebViewLink, VALIDATION_LIMITS.URL_MAX_LEN),
          String(outcome.newThumbnailLink || '').slice(
            0,
            VALIDATION_LIMITS.URL_MAX_LEN
          ),
          clampStr(outcome.subfolderId, VALIDATION_LIMITS.DRIVE_ID_MAX_LEN),
          clampStr(outcome.folderPath, VALIDATION_LIMITS.FOLDER_PATH_MAX_LEN),
          clampStr(outcome.supersededFileId, VALIDATION_LIMITS.DRIVE_ID_MAX_LEN),
        ]
      );
      broadcastSync(['photos'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore consolidamento proprietà foto.',
      });
    }
  });

  router.post('/photos/clear-cleanup', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const photoId = clampStr(req.body?.photoId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!photoId) {
      res.status(400).json({ error: 'photoId mancante.' });
      return;
    }

    try {
      await pool.query(
        `UPDATE site_intervention_photos
         SET pending_cleanup_file_id = '', updated_at = NOW()
         WHERE photo_id = $1`,
        [photoId]
      );
      broadcastSync(['photos'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore aggiornamento stato pulizia foto.',
      });
    }
  });

  router.post('/photos/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const photoId = clampStr(req.body?.photoId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!photoId) {
      res.status(400).json({ error: 'photoId mancante.' });
      return;
    }

    try {
      await pool.query(
        `DELETE FROM site_intervention_photos WHERE photo_id = $1`,
        [photoId]
      );
      broadcastSync(['photos'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore rimozione foto.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 10. Technician Absences (Upsert & Delete)
  // ---------------------------------------------------------------------------
  router.post('/absences/upsert', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    const body = req.body || {};
    const tipo = String(body.tipo || '') as AbsenceType;
    if (!ABSENCE_TYPES.includes(tipo)) {
      res
        .status(400)
        .json({ error: 'Selezionare una causale assenza valida.' });
      return;
    }

    const cleanEmail = normalizeEmail(body.technicianEmail || user.email);
    if (!cleanEmail || !VALIDATION_LIMITS.EMAIL_PATTERN.test(cleanEmail)) {
      res.status(400).json({ error: 'Selezionare un tecnico valido.' });
      return;
    }

    if (
      !isAdmin &&
      !areSameTechnicianEmails(cleanEmail, user.email, directory)
    ) {
      res.status(422).json({
        error: 'Puoi registrare o modificare solo le tue assenze personali.',
      });
      return;
    }

    const cleanName = clampStr(
      body.technicianName,
      VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
      cleanEmail
    );
    const cleanNote = clampStr(body.note, VALIDATION_LIMITS.ABSENCE_NOTE_MAX_LEN);
    const allDay = Boolean(body.allDay);
    const inizioFormatted = String(body.inizioFormatted || '');
    const fineFormatted = String(body.fineFormatted || '');
    const inizioMs = Number(body.inizioMs);
    const fineMs = Number(body.fineMs);

    if (
      !inizioFormatted ||
      !fineFormatted ||
      !Number.isFinite(inizioMs) ||
      !Number.isFinite(fineMs) ||
      fineMs < inizioMs + VALIDATION_LIMITS.MIN_ABSENCE_DURATION_MS
    ) {
      res
        .status(400)
        .json({ error: 'Inserire date o orari di assenza validi.' });
      return;
    }

    const boundedAdmins = Array.from(
      new Set(
        [
          ...(isAdmin ? [user.uid] : []),
          ...(Array.isArray(body.knownAdminUids)
            ? body.knownAdminUids.map(String)
            : []),
        ].filter(Boolean)
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const existingId = clampStr(
      body.existingAbsenceId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );

    try {
      if (existingId) {
        if (isAdmin) {
          await pool.query(
            `UPDATE site_absences
             SET technician_email = $2,
                 technician_name = $3,
                 technician_uid = $4,
                 tipo = $5,
                 all_day = $6,
                 inizio = $7,
                 inizio_ms = $8,
                 fine = $9,
                 fine_ms = $10,
                 note = $11,
                 admin_uids = $12::jsonb,
                 updated_at = NOW()
             WHERE absence_id = $1`,
            [
              existingId,
              cleanEmail,
              cleanName,
              String(body.technicianUid || ''),
              tipo,
              allDay,
              inizioFormatted,
              inizioMs,
              fineFormatted,
              fineMs,
              cleanNote,
              JSON.stringify(boundedAdmins),
            ]
          );
        } else {
          await pool.query(
            `UPDATE site_absences
             SET tipo = $2,
                 all_day = $3,
                 inizio = $4,
                 inizio_ms = $5,
                 fine = $6,
                 fine_ms = $7,
                 note = $8,
                 technician_uid = $9,
                 updated_at = NOW()
             WHERE absence_id = $1`,
            [
              existingId,
              tipo,
              allDay,
              inizioFormatted,
              inizioMs,
              fineFormatted,
              fineMs,
              cleanNote,
              user.uid,
            ]
          );
        }
        broadcastSync(['absences'], user.uid);
        res.json({ absenceId: existingId });
      } else {
        const absenceId = makeSafeId('abs');
        const createdByRole: UserRole = isAdmin ? 'admin' : 'technician';
        const techUid = isAdmin ? String(body.technicianUid || '') : user.uid;

        await pool.query(
          `INSERT INTO site_absences
             (absence_id, technician_email, technician_name, technician_uid, tipo, all_day,
              inizio, inizio_ms, fine, fine_ms, note, admin_uids, created_by_uid, created_by_role,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,NOW(),NOW())`,
          [
            absenceId,
            cleanEmail,
            cleanName,
            techUid,
            tipo,
            allDay,
            inizioFormatted,
            inizioMs,
            fineFormatted,
            fineMs,
            cleanNote,
            JSON.stringify(boundedAdmins),
            user.uid,
            createdByRole,
          ]
        );
        broadcastSync(['absences'], user.uid);
        res.json({ absenceId });
      }
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio assenza.',
      });
    }
  });

  router.post('/absences/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const absenceId = clampStr(req.body?.absenceId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!absenceId) {
      res.status(400).json({ error: 'absenceId mancante.' });
      return;
    }

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    try {
      if (!isAdmin) {
        const cur = await pool.query(
          `SELECT technician_email, technician_uid FROM site_absences WHERE absence_id = $1 LIMIT 1`,
          [absenceId]
        );
        if (cur.rowCount) {
          const row = cur.rows[0];
          const owned =
            String(row.technician_uid || '') === user.uid ||
            areSameTechnicianEmails(
              String(row.technician_email || ''),
              user.email,
              directory
            );
          if (!owned) {
            res.status(422).json({
              error: 'Puoi eliminare solo le tue assenze personali.',
            });
            return;
          }
        }
      }

      await pool.query(`DELETE FROM site_absences WHERE absence_id = $1`, [
        absenceId,
      ]);
      broadcastSync(['absences'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore rimozione assenza.',
      });
    }
  });
// ---------------------------------------------------------------------------
  // 10b. On-Call Schedule & Substitutions (Reperibilità)
  // ---------------------------------------------------------------------------
  router.post('/on-call/shifts/upsert', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(403).json({ error: 'Solo gli Admin possono modificare i turni base di reperibilità.' });
      return;
    }

    const body = req.body || {};
    const group = String(body.group || 'technicians') as OnCallGroup;
    if (!ON_CALL_GROUPS.includes(group)) {
      res.status(400).json({ error: 'Linea reperibilità non valida.' });
      return;
    }

    const rawWeekDate = String(body.weekStartDate || '').slice(0, 10);
    const startsAt0700 =
      typeof body.startsAt0700 === 'boolean' ? body.startsAt0700 : undefined;
    const win = computeOnCallWeekWindow(rawWeekDate, startsAt0700);
    if (!win) {
      res.status(400).json({ error: 'Data di inizio settimana (Lunedì) non valida.' });
      return;
    }

    const cleanEmail = normalizeEmail(body.technicianEmail);
    if (!cleanEmail || !VALIDATION_LIMITS.EMAIL_PATTERN.test(cleanEmail)) {
      res.status(400).json({ error: 'Selezionare un operatore valido.' });
      return;
    }
    if (group === 'coordinators') {
      const targetMember = findStaffMemberByAnyEmail(cleanEmail, directory);
      if (!targetMember || !isEligibleForOnCallGroup(targetMember, 'coordinators')) {
        res.status(400).json({
          error: 'Nella categoria Assistenti (AT) non possono essere inseriti tecnici.',
        });
        return;
      }
    }

    const cleanName = clampStr(
      body.technicianName,
      VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
      cleanEmail
    );
    const cleanUid = clampStr(body.technicianUid, VALIDATION_LIMITS.ID_MAX_LEN);
    const cleanNote = clampStr(body.note, VALIDATION_LIMITS.ABSENCE_NOTE_MAX_LEN);
    const boundedAdmins = Array.from(
      new Set(
        [
          user.uid,
          ...(Array.isArray(body.knownAdminUids) ? body.knownAdminUids.map(String) : []),
        ].filter(Boolean)
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const existingShiftId = clampStr(
      body.existingShiftId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );

    try {
      const targetShiftId = existingShiftId || makeSafeId('oc');
      const upsertRes = await pool.query(
        `INSERT INTO site_on_call_shifts
           (shift_id, group_name, week_start_date, starts_at_0700,
            inizio, inizio_ms, fine, fine_ms,
            technician_email, technician_name, technician_uid, note,
            admin_uids, created_by_uid, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,NOW(),NOW())
         ON CONFLICT (group_name, week_start_date) DO UPDATE SET
           starts_at_0700 = EXCLUDED.starts_at_0700,
           inizio = EXCLUDED.inizio,
           inizio_ms = EXCLUDED.inizio_ms,
           fine = EXCLUDED.fine,
           fine_ms = EXCLUDED.fine_ms,
           technician_email = EXCLUDED.technician_email,
           technician_name = EXCLUDED.technician_name,
           technician_uid = EXCLUDED.technician_uid,
           note = EXCLUDED.note,
           admin_uids = EXCLUDED.admin_uids,
           updated_at = NOW()
         RETURNING shift_id`,
        [
          targetShiftId,
          group,
          win.weekStartDate,
          win.startsAt0700,
          win.inizioIso,
          win.inizioMs,
          win.fineIso,
          win.fineMs,
          cleanEmail,
          cleanName,
          cleanUid,
          cleanNote,
          JSON.stringify(boundedAdmins),
          user.uid,
        ]
      );
      const finalShiftId = String(upsertRes.rows[0]?.shift_id || targetShiftId);
      broadcastSync(['onCall'], user.uid);
      res.json({ shiftId: finalShiftId });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore salvataggio turno reperibilità.',
      });
    }
  });

  router.post('/on-call/shifts/generate-rotation', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(403).json({ error: 'Solo gli Admin possono generare la rotazione reperibilità.' });
      return;
    }

    const body = req.body || {};
    const group = String(body.group || 'technicians') as OnCallGroup;
    if (!ON_CALL_GROUPS.includes(group)) {
      res.status(400).json({ error: 'Linea reperibilità non valida.' });
      return;
    }

    const startMondayStr = String(body.startWeekDate || '').slice(0, 10);
    const baseParts = startMondayStr.split('-').map(Number);
    if (baseParts.length !== 3 || baseParts.some((n) => !Number.isFinite(n))) {
      res.status(400).json({ error: 'Data Lunedì di partenza non valida.' });
      return;
    }

    const weeksCount = Math.min(104, Math.max(1, Number(body.weeksCount || 12)));
    const rawMembers = Array.isArray(body.members) ? body.members : [];
    const validMembers = rawMembers
      .map((m: Record<string, unknown>) => ({
        email: normalizeEmail(String(m?.email || '')),
        name: clampStr(m?.name, VALIDATION_LIMITS.FULL_NAME_MAX_LEN),
        uid: clampStr(m?.uid, VALIDATION_LIMITS.ID_MAX_LEN),
      }))
      .filter((m: { email: string }) => VALIDATION_LIMITS.EMAIL_PATTERN.test(m.email));

    if (validMembers.length === 0) {
      res.status(400).json({ error: 'Selezionare almeno un operatore per la rotazione.' });
      return;
    }
    if (group === 'coordinators') {
      const hasNonAssistant = validMembers.some((m: { email: string }) => {
        const staff = findStaffMemberByAnyEmail(m.email, directory);
        return !staff || !isEligibleForOnCallGroup(staff, 'coordinators');
      });
      if (hasNonAssistant) {
        res.status(400).json({
          error: 'Nella categoria Assistenti (AT) non possono essere inseriti tecnici.',
        });
        return;
      }
    }

    const boundedAdmins = Array.from(
      new Set(
        [
          user.uid,
          ...(Array.isArray(body.knownAdminUids) ? body.knownAdminUids.map(String) : []),
        ].filter(Boolean)
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const pad = (n: number) => String(n).padStart(2, '0');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let upsertedCount = 0;
      for (let w = 0; w < weeksCount; w += 1) {
        const d = new Date(baseParts[0], baseParts[1] - 1, baseParts[2] + w * 7, 12, 0, 0, 0);
        const weekStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const win = computeOnCallWeekWindow(weekStr);
        if (!win) continue;
        const member = validMembers[w % validMembers.length];
        const shiftId = makeSafeId('oc');
        await client.query(
          `INSERT INTO site_on_call_shifts
             (shift_id, group_name, week_start_date, starts_at_0700,
              inizio, inizio_ms, fine, fine_ms,
              technician_email, technician_name, technician_uid, note,
              admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'',$12::jsonb,$13,NOW(),NOW())
           ON CONFLICT (group_name, week_start_date) DO UPDATE SET
             starts_at_0700 = EXCLUDED.starts_at_0700,
             inizio = EXCLUDED.inizio,
             inizio_ms = EXCLUDED.inizio_ms,
             fine = EXCLUDED.fine,
             fine_ms = EXCLUDED.fine_ms,
             technician_email = EXCLUDED.technician_email,
             technician_name = EXCLUDED.technician_name,
             technician_uid = EXCLUDED.technician_uid,
             admin_uids = EXCLUDED.admin_uids,
             updated_at = NOW()`,
          [
            shiftId,
            group,
            win.weekStartDate,
            win.startsAt0700,
            win.inizioIso,
            win.inizioMs,
            win.fineIso,
            win.fineMs,
            member.email,
            member.name || member.email,
            member.uid,
            JSON.stringify(boundedAdmins),
            user.uid,
          ]
        );
        upsertedCount += 1;
      }
      await client.query('COMMIT');
      broadcastSync(['onCall'], user.uid);
      res.json({ imported: upsertedCount });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore generazione rotazione.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/on-call/shifts/import-preset', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(403).json({ error: 'Solo gli Admin possono importare il piano Excel.' });
      return;
    }

    const body = req.body || {};
    const boundedAdmins = Array.from(
      new Set(
        [
          user.uid,
          ...(Array.isArray(body.knownAdminUids) ? body.knownAdminUids.map(String) : []),
        ].filter(Boolean)
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const resolveMemberBySurname = (col: (typeof EXCEL_ON_CALL_PRESET_2025_2028)[number]) => {
      const target = col.surname.trim().toLowerCase();
      const matched = directory.find((m) => {
        const cog = (m.cognome || '').trim().toLowerCase();
        const emailLocal = (m.email || '').split('@')[0].toLowerCase();
        const secLocal = (m.secondaryEmail || '').split('@')[0].toLowerCase();
        return (
          cog === target ||
          cog.includes(target) ||
          emailLocal.includes(target) ||
          secLocal.includes(target)
        );
      });
      if (matched) {
        return {
          email: matched.email.trim().toLowerCase(),
          name: `${matched.nome} ${matched.cognome}`.trim() || col.defaultDisplayName,
          uid: matched.linkedUid || '',
        };
      }
      return {
        email: col.defaultEmail,
        name: col.defaultDisplayName,
        uid: '',
      };
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let count = 0;
      for (const col of EXCEL_ON_CALL_PRESET_2025_2028) {
        const resolved = resolveMemberBySurname(col);
        for (const mondayStr of col.mondays) {
          const win = computeOnCallWeekWindow(mondayStr);
          if (!win) continue;
          const shiftId = makeSafeId('oc');
          await client.query(
            `INSERT INTO site_on_call_shifts
               (shift_id, group_name, week_start_date, starts_at_0700,
                inizio, inizio_ms, fine, fine_ms,
                technician_email, technician_name, technician_uid, note,
                admin_uids, created_by_uid, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'',$12::jsonb,$13,NOW(),NOW())
             ON CONFLICT (group_name, week_start_date) DO UPDATE SET
               starts_at_0700 = EXCLUDED.starts_at_0700,
               inizio = EXCLUDED.inizio,
               inizio_ms = EXCLUDED.inizio_ms,
               fine = EXCLUDED.fine,
               fine_ms = EXCLUDED.fine_ms,
               technician_email = EXCLUDED.technician_email,
               technician_name = EXCLUDED.technician_name,
               technician_uid = EXCLUDED.technician_uid,
               admin_uids = EXCLUDED.admin_uids,
               updated_at = NOW()`,
            [
              shiftId,
              col.group,
              win.weekStartDate,
              win.startsAt0700,
              win.inizioIso,
              win.inizioMs,
              win.fineIso,
              win.fineMs,
              resolved.email,
              resolved.name,
              resolved.uid,
              JSON.stringify(boundedAdmins),
              user.uid,
            ]
          );
          count += 1;
        }
      }
      await client.query('COMMIT');
      broadcastSync(['onCall'], user.uid);
      res.json({ imported: count });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore importazione piano Excel.',
      });
    } finally {
      client.release();
    }
  });

  router.post('/on-call/shifts/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(403).json({ error: 'Solo gli Admin possono eliminare turni base di reperibilità.' });
      return;
    }

    const shiftId = clampStr(req.body?.shiftId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!shiftId) {
      res.status(400).json({ error: 'shiftId mancante.' });
      return;
    }

    try {
      await pool.query(`DELETE FROM site_on_call_overrides WHERE shift_id = $1`, [shiftId]);
      await pool.query(`DELETE FROM site_on_call_shifts WHERE shift_id = $1`, [shiftId]);
      broadcastSync(['onCall'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore eliminazione turno reperibilità.',
      });
    }
  });

  router.post('/on-call/overrides/upsert', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    const body = req.body || {};
    const shiftId = clampStr(body.shiftId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!shiftId) {
      res.status(400).json({ error: 'Selezionare la settimana di turno da sostituire.' });
      return;
    }

    const shiftRes = await pool.query(
      `SELECT * FROM site_on_call_shifts WHERE shift_id = $1 LIMIT 1`,
      [shiftId]
    );
    if (!shiftRes.rowCount) {
      res.status(404).json({ error: 'Turno settimanale non trovato.' });
      return;
    }
    const shiftRow = mapOnCallShiftRow(shiftRes.rows[0]);

    const scope = String(body.scope || 'daily') as OnCallOverrideScope;
    if (!ON_CALL_OVERRIDE_SCOPES.includes(scope)) {
      res.status(400).json({ error: 'Tipologia sostituzione non valida.' });
      return;
    }

    const subEmail = normalizeEmail(body.substituteTechnicianEmail);
    if (!subEmail || !VALIDATION_LIMITS.EMAIL_PATTERN.test(subEmail)) {
      res.status(400).json({ error: 'Selezionare un sostituto valido.' });
      return;
    }
    
    if (shiftRow.group === 'coordinators') {
      const subMemberCheck = findStaffMemberByAnyEmail(subEmail, directory);
      if (!subMemberCheck || !isEligibleForOnCallGroup(subMemberCheck, 'coordinators')) {
        res.status(400).json({
          error: 'Nella categoria Assistenti (AT) non possono essere inseriti tecnici come sostituti.',
        });
        return;
      }
    }

    if (!isAdmin) {
      const isShiftOwner =
        shiftRow.technicianUid === user.uid ||
        areSameTechnicianEmails(shiftRow.technicianEmail, user.email, directory);
      const isSelfTakingOver = areSameTechnicianEmails(subEmail, user.email, directory);
      if (!isShiftOwner && !isSelfTakingOver) {
        res.status(422).json({
          error:
            'Puoi registrare una sostituzione solo per un tuo turno oppure subentrando tu stesso come sostituto.',
        });
        return;
      }
    }

    const inizioMs = Number(body.inizioMs);
    const fineMs = Number(body.fineMs);
    const inizioIso = String(body.inizioFormatted || '');
    const fineIso = String(body.fineFormatted || '');
    if (
      !inizioIso ||
      !fineIso ||
      !Number.isFinite(inizioMs) ||
      !Number.isFinite(fineMs) ||
      fineMs <= inizioMs
    ) {
      res.status(400).json({ error: 'Inserire un intervallo valido per la sostituzione.' });
      return;
    }

    const subName = clampStr(
      body.substituteTechnicianName,
      VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
      subEmail
    );
    const subUid = clampStr(body.substituteTechnicianUid, VALIDATION_LIMITS.ID_MAX_LEN);
    const cleanNote = clampStr(body.note, VALIDATION_LIMITS.ABSENCE_NOTE_MAX_LEN);
    const actorMember = findStaffMemberByAnyEmail(user.email, directory);
    const actorName = actorMember
      ? `${actorMember.nome} ${actorMember.cognome}`.trim()
      : user.email;

    const boundedAdmins = Array.from(
      new Set(
        [
          ...(isAdmin ? [user.uid] : []),
          ...(Array.isArray(body.knownAdminUids) ? body.knownAdminUids.map(String) : []),
        ].filter(Boolean)
      )
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    const existingOverrideId = clampStr(
      body.existingOverrideId,
      VALIDATION_LIMITS.ID_MAX_LEN
    );

    try {
      if (existingOverrideId) {
        await pool.query(
          `UPDATE site_on_call_overrides
           SET scope = $2,
               inizio = $3,
               inizio_ms = $4,
               fine = $5,
               fine_ms = $6,
               substitute_technician_email = $7,
               substitute_technician_name = $8,
               substitute_technician_uid = $9,
               note = $10,
               updated_at = NOW()
           WHERE override_id = $1`,
          [
            existingOverrideId,
            scope,
            inizioIso,
            inizioMs,
            fineIso,
            fineMs,
            subEmail,
            subName,
            subUid,
            cleanNote,
          ]
        );
        broadcastSync(['onCall'], user.uid);
        res.json({ overrideId: existingOverrideId });
      } else {
        const overrideId = makeSafeId('ocsub');
        const createdByRole: UserRole = isAdmin ? 'admin' : 'technician';
        await pool.query(
          `INSERT INTO site_on_call_overrides
             (override_id, shift_id, group_name, scope,
              inizio, inizio_ms, fine, fine_ms,
              original_technician_email, original_technician_name,
              substitute_technician_email, substitute_technician_name, substitute_technician_uid,
              note, admin_uids, created_by_uid, created_by_name, created_by_role,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,NOW(),NOW())`,
          [
            overrideId,
            shiftId,
            shiftRow.group,
            scope,
            inizioIso,
            inizioMs,
            fineIso,
            fineMs,
            shiftRow.technicianEmail,
            shiftRow.technicianName,
            subEmail,
            subName,
            subUid,
            cleanNote,
            JSON.stringify(boundedAdmins),
            user.uid,
            actorName,
            createdByRole,
          ]
        );
        broadcastSync(['onCall'], user.uid);
        res.json({ overrideId });
      }
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore salvataggio sostituzione.',
      });
    }
  });

  router.post('/on-call/overrides/delete', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const overrideId = clampStr(req.body?.overrideId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!overrideId) {
      res.status(400).json({ error: 'overrideId mancante.' });
      return;
    }

    const { isAdmin, directory } = await resolveCallerRole(pool, user);
    try {
      if (!isAdmin) {
        const cur = await pool.query(
          `SELECT created_by_uid, original_technician_email, substitute_technician_email
           FROM site_on_call_overrides WHERE override_id = $1 LIMIT 1`,
          [overrideId]
        );
        if (cur.rowCount) {
          const r = cur.rows[0];
          const allowed =
            String(r.created_by_uid || '') === user.uid ||
            areSameTechnicianEmails(String(r.original_technician_email || ''), user.email, directory) ||
            areSameTechnicianEmails(String(r.substitute_technician_email || ''), user.email, directory);
          if (!allowed) {
            res.status(422).json({
              error: 'Puoi annullare solo le sostituzioni che ti riguardano.',
            });
            return;
          }
        }
      }

      await pool.query(`DELETE FROM site_on_call_overrides WHERE override_id = $1`, [
        overrideId,
      ]);
      broadcastSync(['onCall'], user.uid);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Errore rimozione sostituzione.',
      });
    }
  });
  // ---------------------------------------------------------------------------
  // 11. Web Push Subscriptions (Stored in Neon PostgreSQL)
  // ---------------------------------------------------------------------------
  router.post('/push-subscriptions/upsert', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const body = req.body || {};
    const cred = body.credentials || {};
    const subId = clampStr(cred.subId, VALIDATION_LIMITS.ID_MAX_LEN);
    const endpoint = clampStr(
      cred.endpoint,
      VALIDATION_LIMITS.PUSH_ENDPOINT_MAX_LEN
    );
    const p256dh = clampStr(cred.p256dh, VALIDATION_LIMITS.PUSH_P256DH_MAX_LEN);
    const authKey = clampStr(cred.auth, VALIDATION_LIMITS.PUSH_AUTH_MAX_LEN);
    const deviceLabel = clampStr(
      cred.deviceLabel,
      VALIDATION_LIMITS.PUSH_DEVICE_LABEL_MAX_LEN,
      'Dispositivo Admin'
    );
    if (!subId || !endpoint || !p256dh || !authKey) {
      res.status(400).json({ error: 'Credenziali Push incomplete.' });
      return;
    }

    const currentAdminUids = Array.isArray(body.currentAdminUids)
      ? body.currentAdminUids.map(String)
      : [];
    const boundedAdmins = Array.from(
      new Set([user.uid, ...currentAdminUids].filter(Boolean))
    ).slice(0, VALIDATION_LIMITS.MAX_BOUNDED_ARRAY);

    try {
      await pool.query(
        `INSERT INTO site_push_subscriptions
           (sub_id, owner_uid, endpoint, p256dh, auth, device_label, active, admin_uids, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7::jsonb,NOW(),NOW())
         ON CONFLICT (sub_id) DO UPDATE SET
           owner_uid = EXCLUDED.owner_uid,
           endpoint = EXCLUDED.endpoint,
           p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           device_label = EXCLUDED.device_label,
           active = TRUE,
           admin_uids = EXCLUDED.admin_uids,
           updated_at = NOW()`,
        [
          subId,
          user.uid,
          endpoint,
          p256dh,
          authKey,
          deviceLabel,
          JSON.stringify(boundedAdmins),
        ]
      );
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore salvataggio sottoscrizione Push.',
      });
    }
  });

  router.post('/push-subscriptions/deactivate', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool } = ctx;

    const subId = clampStr(req.body?.subId, VALIDATION_LIMITS.ID_MAX_LEN);
    if (!subId) {
      res.json({ ok: true });
      return;
    }

    try {
      await pool.query(
        `UPDATE site_push_subscriptions SET active = FALSE, updated_at = NOW() WHERE sub_id = $1`,
        [subId]
      );
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore disattivazione sottoscrizione Push.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 12. Optional One-Click Historical Import from Legacy Firestore (Admin)
  // ---------------------------------------------------------------------------
  router.post('/import-legacy', async (req, res) => {
    const ctx = await requireAuthAndDb(req, res);
    if (!ctx) return;
    const { pool, user } = ctx;

    const { isAdmin } = await resolveCallerRole(pool, user);
    if (!isAdmin) {
      res.status(422).json({ error: 'Operazione riservata agli Admin.' });
      return;
    }

    const payload = (req.body || {}) as {
      settings?: AppSettings | null;
      directory?: StaffMember[];
      articles?: Article[];
      tasks?: Task[];
      assignments?: Assignment[];
      usedMaterials?: UsedMaterial[];
      photos?: InterventionPhoto[];
      absences?: Absence[];
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const imported = {
        directory: 0,
        articles: 0,
        tasks: 0,
        assignments: 0,
        materials: 0,
        photos: 0,
        absences: 0,
      };

      if (payload.settings) {
        const s = payload.settings;
        await client.query(
          `INSERT INTO site_settings
             (config_id, exempt_commesse, drive_root_folder_name, drive_shared_folder_id, operator_color_labels, updated_by_uid, updated_at)
           VALUES ('general', $1::jsonb, $2, $3, $4::jsonb, $5, NOW())
           ON CONFLICT (config_id) DO UPDATE SET
             exempt_commesse = EXCLUDED.exempt_commesse,
             drive_root_folder_name = EXCLUDED.drive_root_folder_name,
             drive_shared_folder_id = EXCLUDED.drive_shared_folder_id,
             operator_color_labels = EXCLUDED.operator_color_labels,
             updated_by_uid = EXCLUDED.updated_by_uid,
             updated_at = NOW()`,
          [
            JSON.stringify(s.exemptCommesse || [...DEFAULT_EXEMPT_COMMESSE]),
            clampStr(
              s.driveRootFolderName,
              VALIDATION_LIMITS.DRIVE_FOLDER_MAX_LEN,
              'Gestione Commesse'
            ),
            extractDriveFolderId(
              s.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
            ),
            JSON.stringify(s.operatorColorLabels || {}),
            user.uid,
          ]
        );
      }

      for (const m of payload.directory || []) {
        if (!m?.memberId || !m?.email) continue;
        await client.query(
          `INSERT INTO site_directory
             (member_id, email, secondary_email, nome, cognome, role, active, linked_uid, admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,NOW(),NOW())
           ON CONFLICT (member_id) DO UPDATE SET
             email = EXCLUDED.email,
             secondary_email = CASE WHEN EXCLUDED.secondary_email <> '' THEN EXCLUDED.secondary_email ELSE site_directory.secondary_email END,
             nome = EXCLUDED.nome,
             cognome = EXCLUDED.cognome,
             role = EXCLUDED.role,
             active = EXCLUDED.active,
             linked_uid = CASE WHEN site_directory.linked_uid <> '' THEN site_directory.linked_uid ELSE EXCLUDED.linked_uid END,
             updated_at = NOW()`,
          [
            m.memberId,
            normalizeEmail(m.email),
            normalizeEmail(m.secondaryEmail || ''),
            clampStr(m.nome, VALIDATION_LIMITS.NAME_MAX_LEN, 'Operatore'),
            clampStr(m.cognome, VALIDATION_LIMITS.NAME_MAX_LEN, 'SITE'),
            m.role === 'admin' ? 'admin' : 'technician',
            m.active !== false,
            String(m.linkedUid || ''),
            JSON.stringify(m.adminUids || [user.uid]),
            String(m.createdByUid || user.uid),
          ]
        );
        imported.directory += 1;
      }

      for (const a of payload.articles || []) {
        if (!a?.articleId || !a?.codiceArticolo) continue;
        await client.query(
          `INSERT INTO site_articles
             (article_id, codice_articolo, descrizione, categoria, unita_misura, active, admin_uids, created_by_uid, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW(),NOW())
           ON CONFLICT (article_id) DO UPDATE SET
             codice_articolo = EXCLUDED.codice_articolo,
             descrizione = EXCLUDED.descrizione,
             categoria = EXCLUDED.categoria,
             unita_misura = EXCLUDED.unita_misura,
             active = EXCLUDED.active,
             updated_at = NOW()`,
          [
            a.articleId,
            clampStr(a.codiceArticolo, VALIDATION_LIMITS.CODE_MAX_LEN),
            clampStr(a.descrizione, VALIDATION_LIMITS.ARTICLE_DESC_MAX_LEN),
            clampStr(a.categoria, VALIDATION_LIMITS.CATEGORY_MAX_LEN, 'Generale'),
            clampStr(a.unitaMisura, VALIDATION_LIMITS.UNIT_MAX_LEN, 'pz'),
            a.active !== false,
            JSON.stringify(a.adminUids || [user.uid]),
            String(a.createdByUid || user.uid),
          ]
        );
        imported.articles += 1;
      }

      for (const t of payload.tasks || []) {
        if (!t?.taskId) continue;
        await client.query(
          `INSERT INTO site_tasks
             (task_id, task_code, commessa, descrizione, inizio, inizio_ms, fine, fine_ms,
              stato_prevalente, assigned_emails, assigned_acl_emails, assigned_names,
              assigned_deliverable_emails, assigned_statuses, assigned_notes,
              admin_uids, admin_emails, altro_reparto, pending_admin_review,
              color_id, created_by_role, created_by_uid, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,NOW(),NOW())
           ON CONFLICT (task_id) DO NOTHING`,
          [
            t.taskId,
            clampStr(t.taskCode, VALIDATION_LIMITS.CODE_MAX_LEN, 'T_IMP'),
            clampStr(t.commessa || '', VALIDATION_LIMITS.COMMESSA_MAX_LEN),
            clampStr(t.descrizione || '-', VALIDATION_LIMITS.TASK_DESC_MAX_LEN),
            String(t.inizio || new Date(Number(t.inizioMs || Date.now())).toISOString()),
            Number(t.inizioMs || Date.now()),
            String(t.fine || new Date(Number(t.fineMs || Date.now())).toISOString()),
            Number(t.fineMs || Date.now()),
            String(t.statoPrevalente || 'Assegnato'),
            JSON.stringify(t.assignedEmails || []),
            JSON.stringify(t.assignedAclEmails || []),
            JSON.stringify(t.assignedNames || []),
            JSON.stringify(t.assignedDeliverableEmails || []),
            JSON.stringify(t.assignedStatuses || []),
            JSON.stringify(t.assignedNotes || []),
            JSON.stringify(t.adminUids || [user.uid]),
            JSON.stringify(t.adminEmails || [...BOOTSTRAPPED_ADMIN_EMAILS]),
            Boolean(t.altroReparto),
            Boolean(t.pendingAdminReview),
            String(t.colorId || 'peacock'),
            t.createdByRole === 'technician' ? 'technician' : 'admin',
            String(t.createdByUid || user.uid),
          ]
        );
        imported.tasks += 1;
      }

      for (const asg of payload.assignments || []) {
        if (!asg?.assignmentId || !asg?.taskId) continue;
        await client.query(
          `INSERT INTO site_assignments
             (assignment_id, assignment_code, task_id, commessa, descrizione_task,
              inizio, inizio_ms, fine, fine_ms, technician_email, technician_name,
              technician_uid, technician_alias_emails, stato, note_tecnico,
              admin_uids, squad_emails, squad_names, squad_deliverable_emails,
              color_id, created_by_uid, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20,$21,NOW(),NOW())
           ON CONFLICT (assignment_id) DO NOTHING`,
          [
            asg.assignmentId,
            clampStr(asg.assignmentCode, VALIDATION_LIMITS.CODE_MAX_LEN, 'A_IMP'),
            asg.taskId,
            clampStr(asg.commessa || '', VALIDATION_LIMITS.COMMESSA_MAX_LEN),
            clampStr(
              asg.descrizioneTask || '-',
              VALIDATION_LIMITS.TASK_DESC_MAX_LEN
            ),
            String(asg.inizio || new Date(Number(asg.inizioMs || Date.now())).toISOString()),
            Number(asg.inizioMs || Date.now()),
            String(asg.fine || new Date(Number(asg.fineMs || Date.now())).toISOString()),
            Number(asg.fineMs || Date.now()),
            normalizeEmail(asg.technicianEmail),
            clampStr(
              asg.technicianName,
              VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
              asg.technicianEmail
            ),
            String(asg.technicianUid || ''),
            JSON.stringify(asg.technicianAliasEmails || []),
            String(asg.stato || 'Assegnato'),
            clampStr(asg.noteTecnico || '', VALIDATION_LIMITS.NOTE_MAX_LEN),
            JSON.stringify(asg.adminUids || [user.uid]),
            JSON.stringify(asg.squadEmails || []),
            JSON.stringify(asg.squadNames || []),
            JSON.stringify(asg.squadDeliverableEmails || []),
            String(asg.colorId || 'peacock'),
            String(asg.createdByUid || user.uid),
          ]
        );
        imported.assignments += 1;
      }

      for (const mat of payload.usedMaterials || []) {
        if (!mat?.usedId || !mat?.taskId) continue;
        await client.query(
          `INSERT INTO site_used_materials
             (used_id, assignment_id, task_id, commessa, technician_email, technician_name,
              technician_uid, article_id, codice_articolo, descrizione_articolo, categoria,
              unita_misura, quantita, admin_uids, squad_emails, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,NOW(),NOW())
           ON CONFLICT (used_id) DO NOTHING`,
          [
            mat.usedId,
            String(mat.assignmentId || ''),
            mat.taskId,
            clampStr(mat.commessa || '', VALIDATION_LIMITS.COMMESSA_MAX_LEN),
            normalizeEmail(mat.technicianEmail),
            clampStr(
              mat.technicianName,
              VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
              mat.technicianEmail
            ),
            String(mat.technicianUid || ''),
            String(mat.articleId || ''),
            clampStr(mat.codiceArticolo, VALIDATION_LIMITS.CODE_MAX_LEN),
            clampStr(
              mat.descrizioneArticolo,
              VALIDATION_LIMITS.ARTICLE_DESC_MAX_LEN
            ),
            clampStr(mat.categoria, VALIDATION_LIMITS.CATEGORY_MAX_LEN, 'Generale'),
            clampStr(mat.unitaMisura, VALIDATION_LIMITS.UNIT_MAX_LEN, 'pz'),
            Number(mat.quantita || 1),
            JSON.stringify(mat.adminUids || [user.uid]),
            JSON.stringify(mat.squadEmails || []),
          ]
        );
        imported.materials += 1;
      }

      for (const p of payload.photos || []) {
        if (!p?.photoId || !p?.taskId) continue;
        await client.query(
          `INSERT INTO site_intervention_photos
             (photo_id, assignment_id, task_id, commessa, technician_email, technician_name,
              technician_uid, file_name, drive_file_id, drive_web_view_link, drive_thumbnail_link,
              folder_path, caption, admin_uids, squad_emails, drive_subfolder_id,
              owner_consolidated, pending_cleanup_file_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,NOW(),NOW())
           ON CONFLICT (photo_id) DO NOTHING`,
          [
            p.photoId,
            String(p.assignmentId || ''),
            p.taskId,
            clampStr(p.commessa || '', VALIDATION_LIMITS.COMMESSA_MAX_LEN),
            normalizeEmail(p.technicianEmail),
            clampStr(
              p.technicianName,
              VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
              p.technicianEmail
            ),
            String(p.technicianUid || ''),
            clampStr(p.fileName, VALIDATION_LIMITS.FILE_NAME_MAX_LEN, 'foto.jpg'),
            clampStr(p.driveFileId, VALIDATION_LIMITS.DRIVE_ID_MAX_LEN),
            clampStr(p.driveWebViewLink, VALIDATION_LIMITS.URL_MAX_LEN),
            String(p.driveThumbnailLink || '').slice(
              0,
              VALIDATION_LIMITS.URL_MAX_LEN
            ),
            clampStr(p.folderPath || '', VALIDATION_LIMITS.FOLDER_PATH_MAX_LEN),
            clampStr(p.caption || '', VALIDATION_LIMITS.CAPTION_MAX_LEN),
            JSON.stringify(p.adminUids || [user.uid]),
            JSON.stringify(p.squadEmails || []),
            clampStr(
              p.driveSubfolderId || '',
              VALIDATION_LIMITS.DRIVE_ID_MAX_LEN
            ),
            Boolean(p.ownerConsolidated),
            clampStr(
              p.pendingCleanupFileId || '',
              VALIDATION_LIMITS.DRIVE_ID_MAX_LEN
            ),
          ]
        );
        imported.photos += 1;
      }

      for (const ab of payload.absences || []) {
        if (!ab?.absenceId) continue;
        await client.query(
          `INSERT INTO site_absences
             (absence_id, technician_email, technician_name, technician_uid, tipo, all_day,
              inizio, inizio_ms, fine, fine_ms, note, admin_uids, created_by_uid, created_by_role,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,NOW(),NOW())
           ON CONFLICT (absence_id) DO NOTHING`,
          [
            ab.absenceId,
            normalizeEmail(ab.technicianEmail),
            clampStr(
              ab.technicianName,
              VALIDATION_LIMITS.FULL_NAME_MAX_LEN,
              ab.technicianEmail
            ),
            String(ab.technicianUid || ''),
            String(ab.tipo || 'Altro'),
            Boolean(ab.allDay),
            String(ab.inizio || new Date(Number(ab.inizioMs || Date.now())).toISOString()),
            Number(ab.inizioMs || Date.now()),
            String(ab.fine || new Date(Number(ab.fineMs || Date.now())).toISOString()),
            Number(ab.fineMs || Date.now()),
            clampStr(ab.note || '', VALIDATION_LIMITS.ABSENCE_NOTE_MAX_LEN),
            JSON.stringify(ab.adminUids || [user.uid]),
            String(ab.createdByUid || user.uid),
            ab.createdByRole === 'admin' ? 'admin' : 'technician',
          ]
        );
        imported.absences += 1;
      }

      await client.query('COMMIT');
      broadcastSync(
        [
          'settings',
          'directory',
          'articles',
          'tasks',
          'assignments',
          'materials',
          'photos',
          'absences',
        ],
        user.uid
      );
      res.json({ ok: true, imported });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => undefined);
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Errore importazione dati storici su Neon.',
      });
    } finally {
      client.release();
    }
  });

  return honoRouter;
}
