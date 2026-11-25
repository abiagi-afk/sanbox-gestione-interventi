import { User } from 'firebase/auth';
import { auth, getLegacyFirestoreDbOnDemand } from './firebase';
import {
  Absence,
  ABSENCE_TYPES,
  AbsenceType,
  AppSettings,
  Article,
  Assignment,
  AssignmentStatus,
  canonicalTechnicianKey,
  computeTaskPrevalentStatus,
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
  VALIDATION_LIMITS,
} from '../types/domain';
import {
  ApiError,
  fetchApiJson,
  registerRecoverySyncCallback,
} from './apiClient';
import {
  BrowserPushCredentials,
  triggerTaskCompletedWebPush,
} from './notificationService';
import { ConsolidatedPhotoOutcome } from './workspaceApi';

export { computeTaskPrevalentStatus };

export class NeonNotConfiguredError extends Error {
  readonly code = 'NEON_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'NeonNotConfiguredError';
  }
}

export interface NeonDatabaseStatus {
  configured: boolean;
  connected: boolean;
  hostHint: string;
  error?: string;
  counts?: {
    directory: number;
    articles: number;
    tasks: number;
    assignments: number;
  };
}

export interface WorkspaceSnapshot {
  version?: string;
  settings: AppSettings;
  articles: Article[];
  directory: StaffMember[];
  tasks: Task[];
  assignments: Assignment[];
  usedMaterials: UsedMaterial[];
  photos: InterventionPhoto[];
  absences: Absence[];
  onCallShifts: OnCallShift[];
  onCallOverrides: OnCallOverride[];
}

const localSyncListeners = new Set<() => void>();

export function registerLocalSyncListener(cb: () => void): () => void {
  localSyncListeners.add(cb);
  return () => {
    localSyncListeners.delete(cb);
  };
}

function notifyLocalDataMutated(): void {
  for (const cb of localSyncListeners) {
    try {
      cb();
    } catch {
      // Ignore listener errors
    }
  }
}

registerRecoverySyncCallback(() => {
  notifyLocalDataMutated();
});

async function apiDataRequest<T>(
  path: string,
  options?: {
    method?: 'GET' | 'POST';
    body?: unknown;
    explicitUser?: User | null;
    optionalAuth?: boolean;
  }
): Promise<T> {
  try {
    return await fetchApiJson<T>(`/api/data${path}`, {
      method: options?.method || 'POST',
      body: options?.body,
      explicitUser: options?.explicitUser,
      optionalAuth: options?.optionalAuth,
    });
  } catch (err: unknown) {
    if (err instanceof ApiError && err.code === 'NEON_NOT_CONFIGURED') {
      throw new NeonNotConfiguredError(err.message);
    }
    throw err;
  }
}

export async function fetchNeonDatabaseStatus(
  withAuth = false
): Promise<NeonDatabaseStatus> {
  try {
    const data = await fetchApiJson<Partial<NeonDatabaseStatus>>(
      '/api/data/status',
      {
        method: 'GET',
        optionalAuth: !withAuth,
        maxRetries: 2,
        timeoutMs: 12_000,
      }
    );
    return {
      configured: Boolean(data.configured),
      connected: Boolean(data.connected),
      hostHint: String(data.hostHint || ''),
      error: data.error ? String(data.error) : undefined,
      counts: data.counts,
    };
  } catch (err: unknown) {
    return {
      configured: false,
      connected: false,
      hostHint: '',
      error:
        err instanceof Error
          ? err.message
          : 'Il server si sta riavviando. Riprova tra qualche secondo.',
    };
  }
}

export async function fetchWorkspaceVersion(
  explicitUser?: User | null
): Promise<string> {
  const res = await apiDataRequest<{ version?: string }>('/version', {
    method: 'GET',
    explicitUser,
  });
  return String(res?.version || '');
}

export async function fetchWorkspaceSnapshot(
  explicitUser?: User | null
): Promise<WorkspaceSnapshot> {
  return apiDataRequest<WorkspaceSnapshot>('/snapshot', {
    method: 'GET',
    explicitUser,
  });
}

export function makeSafeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  const raw = `${prefix}_${ts}_${rand}`.replace(/[^a-zA-Z0-9_-]/g, '');
  return raw.slice(0, VALIDATION_LIMITS.ID_MAX_LEN);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, VALIDATION_LIMITS.EMAIL_MAX_LEN);
}

export function clampStr(val: string, maxLen: number, fallback = ''): string {
  const trimmed = val.trim();
  if (!trimmed && fallback) return fallback.slice(0, maxLen);
  return trimmed.slice(0, maxLen);
}

function extractTimestampMs(raw: unknown): number {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const ms = new Date(raw).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof raw === 'object') {
    const maybe = raw as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') return maybe.toMillis();
    if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
  }
  return 0;
}

/**
 * Derives live `statoPrevalente`, `assignedStatuses`, and `assignedNotes` on Tasks
 * directly from `/assignments` so Admin & Technician UIs stay 100% consistent.
 */
export function deriveLiveTasksFromAssignments(
  rawTasks: Task[],
  assignments: Assignment[],
  directory?: StaffMember[]
): Task[] {
  if (rawTasks.length === 0 || assignments.length === 0) {
    return rawTasks;
  }

  const rankOf = (s: AssignmentStatus): number => {
    if (s === 'Completato') return 3;
    if (s === 'Preso in Carico') return 2;
    if (s === 'Assegnato') return 1;
    return 0;
  };

  const liveByTaskAndCanon = new Map<string, Assignment>();
  const activeCountByTask = new Map<string, number>();

  for (const asg of assignments) {
    if (!asg.taskId || asg.stato === 'Annullato') continue;
    const canon = canonicalTechnicianKey(asg.technicianEmail, directory);
    if (!canon) continue;
    activeCountByTask.set(
      asg.taskId,
      (activeCountByTask.get(asg.taskId) || 0) + 1
    );
    const key = `${asg.taskId}:${canon}`;
    const prev = liveByTaskAndCanon.get(key);
    if (!prev) {
      liveByTaskAndCanon.set(key, asg);
    } else {
      const nextMs = extractTimestampMs(asg.updatedAt);
      const prevMs = extractTimestampMs(prev.updatedAt);
      if (
        nextMs > prevMs ||
        (nextMs === prevMs && rankOf(asg.stato) >= rankOf(prev.stato))
      ) {
        liveByTaskAndCanon.set(key, asg);
      }
    }
  }

  return rawTasks.map((t) => {
    if (!t.assignedEmails || t.assignedEmails.length === 0) {
      return t;
    }
    if (!activeCountByTask.get(t.taskId)) {
      return t;
    }

    const fallbackSingle: AssignmentStatus =
      t.statoPrevalente === 'Completato'
        ? 'Completato'
        : t.statoPrevalente === 'Preso in Carico' &&
          t.assignedEmails.length === 1
        ? 'Preso in Carico'
        : 'Assegnato';

    let hasAnyLiveMatch = false;
    const liveStatuses: AssignmentStatus[] = t.assignedEmails.map((em, idx) => {
      const canon = canonicalTechnicianKey(em, directory);
      const liveAsg = canon
        ? liveByTaskAndCanon.get(`${t.taskId}:${canon}`)
        : undefined;
      if (liveAsg) {
        hasAnyLiveMatch = true;
        return liveAsg.stato;
      }
      const slot = t.assignedStatuses?.[idx];
      if (
        slot === 'Assegnato' ||
        slot === 'Preso in Carico' ||
        slot === 'Completato'
      ) {
        return slot;
      }
      return fallbackSingle;
    });

    if (!hasAnyLiveMatch) {
      return t;
    }

    const liveNotes: string[] = t.assignedEmails.map((em, idx) => {
      const canon = canonicalTechnicianKey(em, directory);
      const liveAsg = canon
        ? liveByTaskAndCanon.get(`${t.taskId}:${canon}`)
        : undefined;
      if (liveAsg) {
        return clampStr(
          liveAsg.noteTecnico || t.assignedNotes?.[idx] || '',
          VALIDATION_LIMITS.NOTE_MAX_LEN
        );
      }
      return clampStr(
        t.assignedNotes?.[idx] || '',
        VALIDATION_LIMITS.NOTE_MAX_LEN
      );
    });

    const livePrevalent = computeTaskPrevalentStatus(liveStatuses);

    const statusesUnchanged =
      Array.isArray(t.assignedStatuses) &&
      t.assignedStatuses.length === liveStatuses.length &&
      t.assignedStatuses.every((v, i) => v === liveStatuses[i]);
    const notesUnchanged =
      Array.isArray(t.assignedNotes) &&
      t.assignedNotes.length === liveNotes.length &&
      t.assignedNotes.every((v, i) => v === liveNotes[i]);

    if (
      t.statoPrevalente === livePrevalent &&
      statusesUnchanged &&
      notesUnchanged
    ) {
      return t;
    }

    return {
      ...t,
      statoPrevalente: livePrevalent,
      assignedStatuses: liveStatuses,
      assignedNotes: liveNotes,
    };
  });
}

// ---------------------------------------------------------------------------
// 1. User Bootstrap (Neon PostgreSQL)
// ---------------------------------------------------------------------------
export async function bootstrapAuthenticatedUser(
  firebaseUser: User
): Promise<UserProfile> {
  const res = await apiDataRequest<{ profile: UserProfile }>('/bootstrap', {
    method: 'POST',
    explicitUser: firebaseUser,
    body: {
      displayName: firebaseUser.displayName || '',
    },
  });
  return res.profile;
}

// ---------------------------------------------------------------------------
// 2. App Settings
// ---------------------------------------------------------------------------
export async function saveAppSettings(params: {
  exemptCommesse: string[];
  driveRootFolderName: string;
  driveSharedFolderId?: string;
  googleSheetId?: string;
  operatorColorLabels?: Partial<Record<TaskColorId, string>>;
  adminUid: string;
}): Promise<void> {
  await apiDataRequest('/settings', {
    method: 'POST',
    body: params,
  });
  notifyLocalDataMutated();
}

// ---------------------------------------------------------------------------
// 3. Directory / Team Management
// ---------------------------------------------------------------------------
export async function upsertStaffMember(params: {
  existingMember?: StaffMember;
  email: string;
  secondaryEmail?: string;
  nome: string;
  cognome: string;
  role: UserRole;
  active: boolean;
  adminUid: string;
  currentAdminUids: string[];
}): Promise<void> {
  await apiDataRequest('/staff/upsert', {
    method: 'POST',
    body: params,
  });
  notifyLocalDataMutated();
}

export async function deleteStaffMember(
  member: StaffMember,
  actorEmail?: string
): Promise<void> {
  if (
    actorEmail &&
    normalizeEmail(member.email) === normalizeEmail(actorEmail)
  ) {
    throw new Error(
      'Non puoi eliminare il tuo stesso profilo mentre sei connesso.'
    );
  }
  await apiDataRequest('/staff/delete', {
    method: 'POST',
    body: { memberId: member.memberId },
  });
  notifyLocalDataMutated();
}

// ---------------------------------------------------------------------------
// 4. Articles Catalog
// ---------------------------------------------------------------------------
export async function upsertArticle(params: {
  existingArticle?: Article;
  codiceArticolo: string;
  descrizione: string;
  categoria: string;
  unitaMisura: string;
  active: boolean;
  adminUid: string;
  currentAdminUids: string[];
}): Promise<void> {
  await apiDataRequest('/articles/upsert', {
    method: 'POST',
    body: params,
  });
  notifyLocalDataMutated();
}

export async function bulkImportArticlesCsv(params: {
  csvText: string;
  adminUid: string;
  currentAdminUids: string[];
}): Promise<number> {
  const lines = params.csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('Nessuna riga trovata nel testo incollato.');
  }

  const parsedItems: {
    codiceArticolo: string;
    descrizione: string;
    categoria: string;
    unitaMisura: string;
  }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sep = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
    const cols = line
      .split(sep)
      .map((c) => c.replace(/^"|"$/g, '').trim());

    if (cols.length < 2) continue;

    const firstLower = cols[0].toLowerCase();
    if (
      i === 0 &&
      (firstLower.includes('cod') ||
        firstLower.includes('id_articolo') ||
        firstLower === 'articolo')
    ) {
      continue;
    }

    const codiceArticolo = clampStr(cols[0], VALIDATION_LIMITS.CODE_MAX_LEN);
    const descrizione = clampStr(
      cols[1],
      VALIDATION_LIMITS.ARTICLE_DESC_MAX_LEN
    );
    const categoria = clampStr(
      cols[2] || 'Generale',
      VALIDATION_LIMITS.CATEGORY_MAX_LEN,
      'Generale'
    );
    const unitaMisura = clampStr(
      cols[3] || 'pz',
      VALIDATION_LIMITS.UNIT_MAX_LEN,
      'pz'
    );

    if (codiceArticolo && descrizione) {
      parsedItems.push({ codiceArticolo, descrizione, categoria, unitaMisura });
    }
  }

  if (parsedItems.length === 0) {
    throw new Error(
      'Formato non riconosciuto. Usa il formato: Codice;Descrizione;Categoria;UM'
    );
  }

  const res = await apiDataRequest<{ imported: number }>(
    '/articles/bulk-import',
    {
      method: 'POST',
      body: {
        items: parsedItems,
        currentAdminUids: params.currentAdminUids,
      },
    }
  );
  notifyLocalDataMutated();
  return res.imported;
}

export async function seedStarterArticles(params: {
  adminUid: string;
  currentAdminUids: string[];
}): Promise<number> {
  const starterCsv = [
    'APP-ONT-01;ONT Fibra Ottica GPON Gigabit;Apparati Attivi;pz',
    'APP-RTR-02;Router Enterprise Dual-WAN Rack;Apparati Attivi;pz',
    'APP-SW24-POE;Switch Managed 24 Porte PoE+;Apparati Attivi;pz',
    'FIB-PATCH-LC;Bretella Ottica Monomodale LC-SC 3m;Ottica e Cablaggio;pz',
    'FIB-BOX-8FO;Box Terminazione Ottica 8 Fibre da Parete;Ottica e Cablaggio;pz',
    'CAB-CAT6-UTP;Cavo Rete UTP Cat.6 LSZH Grigio;Ottica e Cablaggio;mt',
    'ALIM-48V-DIN;Alimentatore Switching 48V Barra DIN;Energia e Quadri;pz',
    'BATT-12V-9AH;Batteria Tampone Ermetica 12V 9Ah;Energia e Quadri;pz',
    'MIN-PLUG-RJ45;Connettore RJ45 Schermato Cat.6;Minuteria Tecnica;pz',
    'MIN-FASC-200;Confezione Fascette Cablaggio 200x3.6mm;Minuteria Tecnica;cf',
  ].join('\n');

  return bulkImportArticlesCsv({
    csvText: starterCsv,
    adminUid: params.adminUid,
    currentAdminUids: params.currentAdminUids,
  });
}

export async function deleteArticleById(articleId: string): Promise<void> {
  await apiDataRequest('/articles/delete', {
    method: 'POST',
    body: { articleId },
  });
  notifyLocalDataMutated();
}

export async function bulkUpdateArticlesActive(params: {
  articleIds: string[];
  active: boolean;
  adminUid: string;
  currentAdminUids: string[];
}): Promise<number> {
  const uniqueIds = Array.from(new Set(params.articleIds.filter(Boolean)));
  if (uniqueIds.length === 0) return 0;

  const res = await apiDataRequest<{ updated: number }>(
    '/articles/bulk-active',
    {
      method: 'POST',
      body: {
        articleIds: uniqueIds,
        active: params.active,
      },
    }
  );
  notifyLocalDataMutated();
  return res.updated;
}

export async function bulkDeleteArticles(articleIds: string[]): Promise<number> {
  const uniqueIds = Array.from(new Set(articleIds.filter(Boolean)));
  if (uniqueIds.length === 0) return 0;

  const res = await apiDataRequest<{ deleted: number }>(
    '/articles/bulk-delete',
    {
      method: 'POST',
      body: { articleIds: uniqueIds },
    }
  );
  notifyLocalDataMutated();
  return res.deleted;
}

// ---------------------------------------------------------------------------
// 5. Tasks & Squad Assignments
// ---------------------------------------------------------------------------
export interface SelectedAssignee {
  email: string;
  fullName: string;
  linkedUid: string;
  deliverableEmail?: string;
}

export async function saveTaskAndAssignments(params: {
  existingTask?: Task;
  existingTaskAssignments: Assignment[];
  existingTaskMaterials?: UsedMaterial[];
  existingTaskPhotos?: InterventionPhoto[];
  allTasksForCommessaCount: Task[];
  commessa: string;
  descrizione: string;
  inizioIso: string;
  fineIso: string;
  altroReparto?: boolean;
  colorId?: TaskColorId;
  assignees: SelectedAssignee[];
  adminUid: string;
  currentAdminUids: string[];
  activeAdminEmails?: string[];
  directory?: StaffMember[];
}): Promise<string> {
  const res = await apiDataRequest<{
    taskId: string;
    becameCompleted?: boolean;
    nextPendingReview?: boolean;
  }>('/tasks/save', {
    method: 'POST',
    body: {
      existingTaskId: params.existingTask?.taskId || '',
      commessa: params.commessa,
      descrizione: params.descrizione,
      inizioIso: params.inizioIso,
      fineIso: params.fineIso,
      altroReparto: Boolean(params.altroReparto),
      colorId: params.colorId,
      assignees: params.assignees,
      currentAdminUids: params.currentAdminUids,
      activeAdminEmails: params.activeAdminEmails || [],
    },
  });

  notifyLocalDataMutated();

  if (res.becameCompleted) {
    void triggerTaskCompletedWebPush({
      taskId: res.taskId,
      commessa: params.commessa.trim().toUpperCase(),
      descrizione: params.descrizione,
      completedByName:
        params.assignees.map((a) => a.fullName).join(', ') || 'Admin SITE',
      pendingAdminReview: Boolean(res.nextPendingReview),
    });
  }

  return res.taskId;
}

export async function updateTaskColorId(
  taskId: string,
  colorId: TaskColorId
): Promise<void> {
  await apiDataRequest('/tasks/color', {
    method: 'POST',
    body: { taskId, colorId },
  });
  notifyLocalDataMutated();
}

export async function createAutonomousTechnicianTask(params: {
  descrizione: string;
  inizioIso: string;
  fineIso: string;
  technicianUid: string;
  technicianEmail: string;
  technicianDeliverableEmail?: string;
  technicianFullName: string;
  knownAdminUids: string[];
  activeAdminEmails: string[];
  existingAutonomousCount: number;
  directory?: StaffMember[];
}): Promise<{ taskId: string; assignmentId: string; taskCode: string }> {
  const res = await apiDataRequest<{
    taskId: string;
    assignmentId: string;
    taskCode: string;
  }>('/tasks/autonomous', {
    method: 'POST',
    body: {
      descrizione: params.descrizione,
      inizioIso: params.inizioIso,
      fineIso: params.fineIso,
      technicianEmail: params.technicianEmail,
      technicianDeliverableEmail: params.technicianDeliverableEmail,
      technicianFullName: params.technicianFullName,
      knownAdminUids: params.knownAdminUids,
      activeAdminEmails: params.activeAdminEmails,
    },
  });
  notifyLocalDataMutated();
  return res;
}

export async function reviewAutonomousTaskByAdmin(params: {
  task: Task;
  existingTaskAssignments: Assignment[];
  existingTaskMaterials: UsedMaterial[];
  existingTaskPhotos: InterventionPhoto[];
  commessa: string;
  descrizione: string;
  inizioIso: string;
  fineIso: string;
  colorId?: TaskColorId;
  assignees: SelectedAssignee[];
  markAddedColleaguesCompleted?: boolean;
  newFolderPath?: string;
  resolvedSubfolderId?: string;
  adminUid: string;
  currentAdminUids: string[];
  activeAdminEmails: string[];
  directory?: StaffMember[];
}): Promise<{
  resultingTaskStatus: TaskStatus;
  updatedAssignments: Assignment[];
}> {
  const res = await apiDataRequest<{
    resultingTaskStatus: TaskStatus;
    updatedAssignments: Assignment[];
    becameCompleted?: boolean;
  }>('/tasks/review', {
    method: 'POST',
    body: {
      taskId: params.task.taskId,
      commessa: params.commessa,
      descrizione: params.descrizione,
      inizioIso: params.inizioIso,
      fineIso: params.fineIso,
      colorId: params.colorId,
      assignees: params.assignees,
      markAddedColleaguesCompleted: params.markAddedColleaguesCompleted,
      newFolderPath: params.newFolderPath,
      resolvedSubfolderId: params.resolvedSubfolderId,
      currentAdminUids: params.currentAdminUids,
      activeAdminEmails: params.activeAdminEmails,
    },
  });

  notifyLocalDataMutated();

  if (res.becameCompleted) {
    void triggerTaskCompletedWebPush({
      taskId: params.task.taskId,
      commessa: params.commessa.trim().toUpperCase(),
      descrizione: params.descrizione,
      completedByName:
        params.assignees.map((a) => a.fullName).join(', ') || 'Squadra SITE',
      pendingAdminReview: false,
    });
  }

  return {
    resultingTaskStatus: res.resultingTaskStatus,
    updatedAssignments: res.updatedAssignments,
  };
}

export async function deleteTaskCascade(params: {
  taskId: string;
  assignments: Assignment[];
  usedMaterials: UsedMaterial[];
  photos: InterventionPhoto[];
}): Promise<void> {
  await apiDataRequest('/tasks/delete', {
    method: 'POST',
    body: { taskId: params.taskId },
  });
  notifyLocalDataMutated();
}

export async function syncTasksAdminAndSquadMetadata(_params: {
  tasks: Task[];
  assignments: Assignment[];
  usedMaterials: UsedMaterial[];
  photos: InterventionPhoto[];
  absences?: Absence[];
  directory?: StaffMember[];
  activeAdminEmails: string[];
  currentAdminUids?: string[];
  resolveDeliverableEmail?: (email: string) => string;
}): Promise<void> {
  // Multi-alias squad & admin visibility is enforced directly in SQL on the server.
}

// ---------------------------------------------------------------------------
// 6. Technician & Admin Assignment Status / Notes Updates
// ---------------------------------------------------------------------------
export async function updateAssignmentStatusAndNotes(params: {
  assignment: Assignment;
  siblingAssignments: Assignment[];
  parentTask?: Task;
  newStatus: AssignmentStatus;
  noteTecnico: string;
  exemptCommesse: string[];
  isAltroReparto?: boolean;
  actorUid: string;
  actorEmail?: string;
  isAdminActor: boolean;
  directory?: StaffMember[];
}): Promise<{
  taskBecameCompleted: boolean;
  nextTaskStatus: TaskStatus;
  completedCount: number;
  totalSquadCount: number;
  authoritativeTask?: Task;
  squadNotesByEmail: Record<string, string>;
}> {
  const res = await apiDataRequest<{
    taskBecameCompleted: boolean;
    nextTaskStatus: TaskStatus;
    completedCount: number;
    totalSquadCount: number;
    authoritativeTask?: Task;
    squadNotesByEmail: Record<string, string>;
  }>('/assignments/status', {
    method: 'POST',
    body: {
      assignmentId: params.assignment.assignmentId,
      taskId: params.assignment.taskId || params.parentTask?.taskId || '',
      technicianEmail:
        params.assignment.technicianEmail || params.actorEmail || '',
      technicianName: params.assignment.technicianName || '',
      newStatus: params.newStatus,
      noteTecnico: params.noteTecnico,
      exemptCommesse: params.exemptCommesse,
      isAltroReparto: Boolean(params.isAltroReparto),
    },
  });

  notifyLocalDataMutated();

  if (res.taskBecameCompleted) {
    void triggerTaskCompletedWebPush({
      taskId: params.assignment.taskId,
      commessa: params.assignment.commessa,
      descrizione: params.assignment.descrizioneTask,
      completedByName: params.assignment.technicianName,
      pendingAdminReview:
        !params.assignment.commessa.trim() && !params.isAltroReparto,
      noteSummary: params.noteTecnico.trim(),
    });
  }

  return res;
}

export async function adminUpdateEntireTaskStatus(params: {
  task: Task;
  taskAssignments: Assignment[];
  newStatus: TaskStatus;
  adminNoteOptional?: string;
  actorName?: string;
  directory?: StaffMember[];
}): Promise<void> {
  const res = await apiDataRequest<{ becameCompleted?: boolean }>(
    '/tasks/admin-status',
    {
      method: 'POST',
      body: {
        taskId: params.task.taskId,
        newStatus: params.newStatus,
        adminNoteOptional: params.adminNoteOptional || '',
      },
    }
  );

  notifyLocalDataMutated();

  if (res.becameCompleted) {
    void triggerTaskCompletedWebPush({
      taskId: params.task.taskId,
      commessa: params.task.commessa,
      descrizione: params.task.descrizione,
      completedByName:
        params.actorName ||
        params.task.assignedNames.join(', ') ||
        'Admin SITE',
      pendingAdminReview: Boolean(params.task.pendingAdminReview),
      noteSummary: (params.adminNoteOptional || '').trim(),
    });
  }
}

// ---------------------------------------------------------------------------
// 7. Used Materials on Task
// ---------------------------------------------------------------------------
export async function addUsedMaterialToAssignment(params: {
  assignment: Assignment;
  article: Article;
  quantita: number;
  actorUid: string;
  squadEmails?: string[];
  directory?: StaffMember[];
}): Promise<void> {
  await apiDataRequest('/materials/add', {
    method: 'POST',
    body: {
      assignment: params.assignment,
      article: params.article,
      quantita: params.quantita,
      squadEmails: params.squadEmails,
    },
  });
  notifyLocalDataMutated();
}

export async function updateUsedMaterialQty(
  usedId: string,
  quantita: number
): Promise<void> {
  await apiDataRequest('/materials/qty', {
    method: 'POST',
    body: { usedId, quantita },
  });
  notifyLocalDataMutated();
}

export async function removeUsedMaterial(usedId: string): Promise<void> {
  await apiDataRequest('/materials/delete', {
    method: 'POST',
    body: { usedId },
  });
  notifyLocalDataMutated();
}

// ---------------------------------------------------------------------------
// 8. Intervention Photos Metadata (Google Drive)
// ---------------------------------------------------------------------------
export async function recordInterventionPhoto(params: {
  assignment: Assignment;
  actorUid: string;
  fileName: string;
  driveFileId: string;
  driveWebViewLink: string;
  driveThumbnailLink: string;
  folderPath: string;
  driveSubfolderId?: string;
  ownerConsolidated?: boolean;
  squadEmails?: string[];
  directory?: StaffMember[];
  caption: string;
}): Promise<void> {
  await apiDataRequest('/photos/add', {
    method: 'POST',
    body: {
      assignment: params.assignment,
      fileName: params.fileName,
      driveFileId: params.driveFileId,
      driveWebViewLink: params.driveWebViewLink,
      driveThumbnailLink: params.driveThumbnailLink,
      folderPath: params.folderPath,
      driveSubfolderId: params.driveSubfolderId || '',
      ownerConsolidated: Boolean(params.ownerConsolidated),
      squadEmails: params.squadEmails,
      caption: params.caption,
    },
  });
  notifyLocalDataMutated();
}

export async function markPhotoOwnershipConsolidated(
  photo: InterventionPhoto,
  outcome: ConsolidatedPhotoOutcome
): Promise<void> {
  await apiDataRequest('/photos/consolidate', {
    method: 'POST',
    body: {
      photoId: photo.photoId,
      outcome,
    },
  });
  notifyLocalDataMutated();
}

export async function clearPhotoPendingCleanup(photoId: string): Promise<void> {
  await apiDataRequest('/photos/clear-cleanup', {
    method: 'POST',
    body: { photoId },
  });
  notifyLocalDataMutated();
}

export async function removeInterventionPhoto(photoId: string): Promise<void> {
  await apiDataRequest('/photos/delete', {
    method: 'POST',
    body: { photoId },
  });
  notifyLocalDataMutated();
}

// ---------------------------------------------------------------------------
// 9. Technician Absences
// ---------------------------------------------------------------------------
export async function upsertAbsence(params: {
  existingAbsence?: Absence;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  tipo: AbsenceType;
  allDay: boolean;
  startDateOrIso: string;
  endDateOrIso: string;
  note: string;
  actorUid: string;
  isAdminActor: boolean;
  knownAdminUids: string[];
}): Promise<string> {
  if (!ABSENCE_TYPES.includes(params.tipo)) {
    throw new Error('Selezionare una causale assenza valida.');
  }

  let inizioDate: Date;
  let fineDate: Date;

  if (params.allDay) {
    const startParts = params.startDateOrIso.slice(0, 10).split('-').map(Number);
    const endParts = params.endDateOrIso.slice(0, 10).split('-').map(Number);
    if (startParts.length !== 3 || endParts.length !== 3) {
      throw new Error('Inserire date di inizio e fine assenza valide.');
    }
    inizioDate = new Date(
      startParts[0],
      startParts[1] - 1,
      startParts[2],
      0,
      0,
      0,
      0
    );
    fineDate = new Date(
      endParts[0],
      endParts[1] - 1,
      endParts[2] + 1,
      0,
      0,
      0,
      0
    );
  } else {
    inizioDate = new Date(params.startDateOrIso);
    fineDate = new Date(params.endDateOrIso);
  }

  const inizioMs = inizioDate.getTime();
  const fineMs = fineDate.getTime();
  if (Number.isNaN(inizioMs) || Number.isNaN(fineMs)) {
    throw new Error('Inserire date o orari di assenza validi.');
  }
  if (fineMs < inizioMs + VALIDATION_LIMITS.MIN_ABSENCE_DURATION_MS) {
    throw new Error(
      params.allDay
        ? 'La data di fine assenza non può essere antecedente alla data di inizio.'
        : "La fine dell'assenza deve essere ad almeno 30 minuti dall'inizio."
    );
  }

  const res = await apiDataRequest<{ absenceId: string }>('/absences/upsert', {
    method: 'POST',
    body: {
      existingAbsenceId: params.existingAbsence?.absenceId || '',
      technicianEmail: params.technicianEmail,
      technicianName: params.technicianName,
      technicianUid: params.technicianUid,
      tipo: params.tipo,
      allDay: params.allDay,
      inizioFormatted: inizioDate.toISOString(),
      fineFormatted: fineDate.toISOString(),
      inizioMs,
      fineMs,
      note: params.note,
      knownAdminUids: params.knownAdminUids,
    },
  });

  notifyLocalDataMutated();
  return res.absenceId;
}

export async function deleteAbsenceById(absenceId: string): Promise<void> {
  await apiDataRequest('/absences/delete', {
    method: 'POST',
    body: { absenceId },
  });
  notifyLocalDataMutated();
}
// ---------------------------------------------------------------------------
// 9b. On-Call Schedule & Substitutions (Reperibilità)
// ---------------------------------------------------------------------------
export async function upsertOnCallShift(params: {
  existingShiftId?: string;
  group: OnCallGroup;
  weekStartDate: string;
  startsAt0700?: boolean;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  note?: string;
  knownAdminUids: string[];
}): Promise<string> {
  const res = await apiDataRequest<{ shiftId: string }>('/on-call/shifts/upsert', {
    method: 'POST',
    body: {
      existingShiftId: params.existingShiftId || '',
      group: params.group,
      weekStartDate: params.weekStartDate,
      startsAt0700: params.startsAt0700,
      technicianEmail: params.technicianEmail,
      technicianName: params.technicianName,
      technicianUid: params.technicianUid,
      note: params.note || '',
      knownAdminUids: params.knownAdminUids,
    },
  });
  notifyLocalDataMutated();
  return res.shiftId;
}

export async function generateOnCallRotation(params: {
  group: OnCallGroup;
  startWeekDate: string;
  weeksCount: number;
  members: Array<{ email: string; name: string; uid: string }>;
  knownAdminUids: string[];
}): Promise<number> {
  const res = await apiDataRequest<{ imported: number }>(
    '/on-call/shifts/generate-rotation',
    {
      method: 'POST',
      body: {
        group: params.group,
        startWeekDate: params.startWeekDate,
        weeksCount: params.weeksCount,
        members: params.members,
        knownAdminUids: params.knownAdminUids,
      },
    }
  );
  notifyLocalDataMutated();
  return Number(res.imported || 0);
}

export async function importExcelOnCallPreset(
  knownAdminUids: string[]
): Promise<number> {
  const res = await apiDataRequest<{ imported: number }>(
    '/on-call/shifts/import-preset',
    {
      method: 'POST',
      body: { knownAdminUids },
    }
  );
  notifyLocalDataMutated();
  return Number(res.imported || 0);
}

export async function deleteOnCallShiftById(shiftId: string): Promise<void> {
  await apiDataRequest('/on-call/shifts/delete', {
    method: 'POST',
    body: { shiftId },
  });
  notifyLocalDataMutated();
}

export async function upsertOnCallOverride(params: {
  existingOverrideId?: string;
  shiftId: string;
  scope: OnCallOverrideScope;
  inizioMs: number;
  fineMs: number;
  substituteTechnicianEmail: string;
  substituteTechnicianName: string;
  substituteTechnicianUid: string;
  note?: string;
  knownAdminUids: string[];
}): Promise<string> {
  const res = await apiDataRequest<{ overrideId: string }>(
    '/on-call/overrides/upsert',
    {
      method: 'POST',
      body: {
        existingOverrideId: params.existingOverrideId || '',
        shiftId: params.shiftId,
        scope: params.scope,
        inizioFormatted: new Date(params.inizioMs).toISOString(),
        fineFormatted: new Date(params.fineMs).toISOString(),
        inizioMs: params.inizioMs,
        fineMs: params.fineMs,
        substituteTechnicianEmail: params.substituteTechnicianEmail,
        substituteTechnicianName: params.substituteTechnicianName,
        substituteTechnicianUid: params.substituteTechnicianUid,
        note: params.note || '',
        knownAdminUids: params.knownAdminUids,
      },
    }
  );
  notifyLocalDataMutated();
  return res.overrideId;
}

export async function deleteOnCallOverrideById(
  overrideId: string
): Promise<void> {
  await apiDataRequest('/on-call/overrides/delete', {
    method: 'POST',
    body: { overrideId },
  });
  notifyLocalDataMutated();
}
// ---------------------------------------------------------------------------
// 10. Admin Device Web Push Subscriptions
// ---------------------------------------------------------------------------
export async function upsertPushSubscriptionRecord(params: {
  credentials: BrowserPushCredentials;
  adminUid: string;
  currentAdminUids: string[];
}): Promise<void> {
  await apiDataRequest('/push-subscriptions/upsert', {
    method: 'POST',
    body: {
      credentials: params.credentials,
      currentAdminUids: params.currentAdminUids,
    },
  });
}

export async function deactivatePushSubscriptionRecord(
  subId: string
): Promise<void> {
  if (!subId) return;
  await apiDataRequest('/push-subscriptions/deactivate', {
    method: 'POST',
    body: { subId },
  });
}

// ---------------------------------------------------------------------------
// 11. Optional One-Click Historical Data Import from Legacy Firestore to Neon
// ---------------------------------------------------------------------------
export async function importLegacyFirestoreToNeon(): Promise<{
  directory: number;
  articles: number;
  tasks: number;
  assignments: number;
  materials: number;
  photos: number;
  absences: number;
}> {
  const { legacyDb, firestoreMod } = await getLegacyFirestoreDbOnDemand();
  const { collection, doc, getDoc, getDocs } = firestoreMod;

  let settings: AppSettings | null = null;
  let directory: StaffMember[] = [];
  let articles: Article[] = [];
  let tasks: Task[] = [];
  let assignments: Assignment[] = [];
  let usedMaterials: UsedMaterial[] = [];
  let photos: InterventionPhoto[] = [];
  let absences: Absence[] = [];

  try {
    const [
      settingsSnap,
      dirSnap,
      artSnap,
      taskSnap,
      asgSnap,
      matSnap,
      photoSnap,
      absSnap,
    ] = await Promise.all([
      getDoc(doc(legacyDb, 'settings', 'general')),
      getDocs(collection(legacyDb, 'directory')),
      getDocs(collection(legacyDb, 'articles')),
      getDocs(collection(legacyDb, 'tasks')),
      getDocs(collection(legacyDb, 'assignments')),
      getDocs(collection(legacyDb, 'usedMaterials')),
      getDocs(collection(legacyDb, 'interventionPhotos')),
      getDocs(collection(legacyDb, 'absences')),
    ]);

    settings = settingsSnap.exists()
      ? (settingsSnap.data() as AppSettings)
      : null;
    directory = dirSnap.docs.map((d) => d.data() as StaffMember);
    articles = artSnap.docs.map((d) => d.data() as Article);
    tasks = taskSnap.docs.map((d) => d.data() as Task);
    assignments = asgSnap.docs.map((d) => d.data() as Assignment);
    usedMaterials = matSnap.docs.map((d) => d.data() as UsedMaterial);
    photos = photoSnap.docs.map((d) => d.data() as InterventionPhoto);
    absences = absSnap.docs.map((d) => d.data() as Absence);
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    if (
      rawMsg.toLowerCase().includes('quota') ||
      rawMsg.toLowerCase().includes('resource-exhausted')
    ) {
      throw new Error(
        'La quota giornaliera gratuita del vecchio database Firebase è ancora esaurita (si azzera ogni giorno intorno alle 09:00 ora italiana). Il nuovo database Neon è già attivo e pronto all’uso: potrai importare lo storico domani mattina con un clic.'
      );
    }
    throw new Error(`Impossibile leggere lo storico Firebase: ${rawMsg}`);
  }

  const res = await apiDataRequest<{
    imported: {
      directory: number;
      articles: number;
      tasks: number;
      assignments: number;
      materials: number;
      photos: number;
      absences: number;
    };
  }>('/import-legacy', {
    method: 'POST',
    body: {
      settings,
      directory,
      articles,
      tasks,
      assignments,
      usedMaterials,
      photos,
      absences,
    },
  });

  notifyLocalDataMutated();
  return res.imported;
}
