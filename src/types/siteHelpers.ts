/**
 * Shared SITE S.p.A. Domain Types, Constants, and Multi-Alias Email Helpers
 * Zero TypeScript `enum` declarations so this module runs natively in both
 * Vite/React frontend and Node.js (`node server.ts` / `tsx server.ts`).
 */

export type UserRole = 'admin' | 'technician';

export type TaskStatus =
  | 'Non Assegnato'
  | 'Assegnato'
  | 'Preso in Carico'
  | 'Completato';

export type AssignmentStatus =
  | 'Assegnato'
  | 'Preso in Carico'
  | 'Completato'
  | 'Annullato';

export type AbsenceType =
  | 'Ferie'
  | 'Permesso'
  | 'Malattia'
  | 'Visita Medica'
  | 'Assemblea Sindacale'
  | 'Altro';

export const ABSENCE_TYPES: readonly AbsenceType[] = [
  'Ferie',
  'Permesso',
  'Malattia',
  'Visita Medica',
  'Assemblea Sindacale',
  'Altro',
] as const;

export const TRUE_ABSENCE_TYPES: readonly AbsenceType[] = [
  'Ferie',
  'Permesso',
  'Malattia',
  'Altro',
] as const;

export const NON_ABSENCE_ENTRY_TYPES: readonly AbsenceType[] = [
  'Visita Medica',
  'Assemblea Sindacale',
] as const;

export function isNonAbsenceEntryType(tipo?: string | null): boolean {
  return tipo === 'Visita Medica' || tipo === 'Assemblea Sindacale';
}

export type TaskColorId =
  | 'peacock'
  | 'cobalt'
  | 'banana'
  | 'tomato'
  | 'basil'
  | 'grape'
  | 'flamingo'
  | 'tangerine'
  | 'sage'
  | 'lavender'
  | 'graphite';

export const TASK_COLOR_IDS: readonly TaskColorId[] = [
  'peacock',
  'cobalt',
  'banana',
  'tomato',
  'basil',
  'grape',
  'flamingo',
  'tangerine',
  'sage',
  'lavender',
  'graphite',
] as const;

export const DEFAULT_TASK_COLOR_ID: TaskColorId = 'peacock';

export const DEFAULT_OPERATOR_COLOR_LABELS: Record<TaskColorId, string> = {
  peacock: 'SITE / Generale',
  cobalt: 'TIM',
  banana: 'Fastweb',
  tomato: 'FiberCop',
  basil: 'Open Fiber',
  grape: 'Unilog',
  flamingo: 'Vodafone',
  tangerine: 'WindTre',
  sage: 'Iliad',
  lavender: 'Colt / B2B',
  graphite: 'Interno / Altro',
};

export const BOOTSTRAPPED_ADMIN_EMAILS = [
  'a.biagi@sitespa.it',
  's.pistacchio@sitespa.it',
] as const;

export const MASTER_DRIVE_OWNER_EMAIL = 'a.biagi@sitespa.it';
export const DEFAULT_DRIVE_SHARED_FOLDER_ID = '1Ckkh1FQlZqjB8I8Aq-4ahSjDAva1ghLf';
export const DEFAULT_DRIVE_SHARED_FOLDER_URL = `https://drive.google.com/drive/folders/${DEFAULT_DRIVE_SHARED_FOLDER_ID}`;

export function extractDriveFolderId(rawInput?: string | null): string {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return DEFAULT_DRIVE_SHARED_FOLDER_ID;
  const urlMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]{10,160})/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  if (/^[a-zA-Z0-9_-]{10,160}$/.test(trimmed)) {
    return trimmed;
  }
  return DEFAULT_DRIVE_SHARED_FOLDER_ID;
}

/**
 * Extracts a clean Google Sheets spreadsheetId from either a full docs.google.com/spreadsheets/d/<ID>/... URL
 * or a raw spreadsheet ID string. Returns '' when empty or invalid.
 */
export function extractGoogleSheetId(rawInput?: string | null): string {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) return '';
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,160})/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  if (/^[a-zA-Z0-9_-]{15,160}$/.test(trimmed)) {
    return trimmed;
  }
  return '';
}

export const DEFAULT_EXEMPT_COMMESSE = ['H265001', 'H264001'] as const;

export const VALIDATION_LIMITS = {
  ID_MAX_LEN: 128,
  ID_PATTERN: /^[a-zA-Z0-9_-]+$/,
  EMAIL_MAX_LEN: 254,
  EMAIL_PATTERN: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  NAME_MAX_LEN: 80,
  FULL_NAME_MAX_LEN: 160,
  CODE_MAX_LEN: 80,
  COMMESSA_MAX_LEN: 80,
  CATEGORY_MAX_LEN: 100,
  UNIT_MAX_LEN: 20,
  ARTICLE_DESC_MAX_LEN: 300,
  TASK_DESC_MAX_LEN: 1000,
  NOTE_MAX_LEN: 4000,
  ABSENCE_NOTE_MAX_LEN: 1000,
  DRIVE_FOLDER_MAX_LEN: 120,
  FOLDER_PATH_MAX_LEN: 300,
  FILE_NAME_MAX_LEN: 200,
  DRIVE_ID_MAX_LEN: 200,
  URL_MAX_LEN: 1000,
  CAPTION_MAX_LEN: 500,
  COLOR_ID_MAX_LEN: 20,
  OPERATOR_LABEL_MAX_LEN: 40,
  PUSH_ENDPOINT_MAX_LEN: 1500,
  PUSH_P256DH_MAX_LEN: 256,
  PUSH_AUTH_MAX_LEN: 128,
  PUSH_DEVICE_LABEL_MAX_LEN: 120,
  MAX_BOUNDED_ARRAY: 10,
  MAX_SQUAD_ACL_EMAILS: 60,
  MAX_TECH_ALIAS_EMAILS: 10,
  MAX_EXEMPT_COMMESSE: 50,
  MIN_TASK_DURATION_MS: 3600000, // 1 hour
  MIN_ABSENCE_DURATION_MS: 1800000, // 30 minutes
  MAX_MATERIAL_QTY: 100000,
  FIRESTORE_BATCH_CHUNK: 400,
} as const;

export interface UserProfile {
  uid: string;
  email: string;
  nome: string;
  cognome: string;
  role: UserRole;
  active: boolean;
  directoryMemberId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface StaffMember {
  memberId: string;
  email: string;
  secondaryEmail?: string;
  nome: string;
  cognome: string;
  role: UserRole;
  active: boolean;
  linkedUid: string;
  adminUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface AppSettings {
  exemptCommesse: string[];
  driveRootFolderName: string;
  driveSharedFolderId?: string;
  googleSheetId?: string;
  operatorColorLabels?: Partial<Record<TaskColorId, string>>;
  updatedByUid: string;
  updatedAt?: unknown;
}

export interface Article {
  articleId: string;
  codiceArticolo: string;
  descrizione: string;
  categoria: string;
  unitaMisura: string;
  active: boolean;
  adminUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Task {
  taskId: string;
  taskCode: string;
  commessa: string;
  descrizione: string;
  inizio: string;
  inizioMs: number;
  fine: string;
  fineMs: number;
  statoPrevalente: TaskStatus;
  assignedEmails: string[];
  assignedAclEmails?: string[];
  assignedNames: string[];
  assignedDeliverableEmails?: string[];
  assignedStatuses?: AssignmentStatus[];
  assignedNotes?: string[];
  adminUids: string[];
  adminEmails?: string[];
  altroReparto?: boolean;
  pendingAdminReview?: boolean;
  colorId?: TaskColorId;
  createdByRole?: UserRole;
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Assignment {
  assignmentId: string;
  assignmentCode: string;
  taskId: string;
  commessa: string;
  descrizioneTask: string;
  inizio: string;
  inizioMs: number;
  fine: string;
  fineMs: number;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  technicianAliasEmails?: string[];
  stato: AssignmentStatus;
  noteTecnico: string;
  adminUids: string[];
  squadEmails?: string[];
  squadNames?: string[];
  squadDeliverableEmails?: string[];
  colorId?: TaskColorId;
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface UsedMaterial {
  usedId: string;
  assignmentId: string;
  taskId: string;
  commessa: string;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  articleId: string;
  codiceArticolo: string;
  descrizioneArticolo: string;
  categoria: string;
  unitaMisura: string;
  quantita: number;
  adminUids: string[];
  squadEmails?: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface InterventionPhoto {
  photoId: string;
  assignmentId: string;
  taskId: string;
  commessa: string;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  fileName: string;
  driveFileId: string;
  driveWebViewLink: string;
  driveThumbnailLink: string;
  folderPath: string;
  caption: string;
  adminUids: string[];
  squadEmails?: string[];
  driveSubfolderId?: string;
  ownerConsolidated?: boolean;
  pendingCleanupFileId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface Absence {
  absenceId: string;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  tipo: AbsenceType;
  allDay: boolean;
  inizio: string;
  inizioMs: number;
  fine: string;
  fineMs: number;
  note: string;
  adminUids: string[];
  createdByUid: string;
  createdByRole: UserRole;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PushSubscriptionDoc {
  subId: string;
  ownerUid: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string;
  active: boolean;
  adminUids: string[];
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function isLoginOnlyIdEmail(email?: string | null): boolean {
  const clean = (email || '').trim().toLowerCase();
  return clean.endsWith('.id@sitespa.it');
}

/**
 * Returns true ONLY for legitimate SITE Google Workspace accounts eligible for
 * Google Sign-In and Google Drive sharing:
 * - Full corporate account (Admin or Technician): `utente@sitespa.it`
 * - Workspace login/Drive-only technician account: `nome.cognome.id@sitespa.it`
 * Explicitly excludes mail-only `@tecnicositespa.it` and any external domain.
 */
export function isWorkspaceDriveEmail(email?: string | null): boolean {
  const clean = (email || '').trim().toLowerCase();
  if (
    !clean ||
    clean.includes(' ') ||
    !VALIDATION_LIMITS.EMAIL_PATTERN.test(clean)
  ) {
    return false;
  }
  if (!clean.endsWith('@sitespa.it')) {
    return false;
  }
  const local = clean.slice(0, -'@sitespa.it'.length);
  return Boolean(local && !local.includes('@') && !local.startsWith('.'));
}

/**
 * Resolves the single Google Workspace / Google Drive account configured in Anagrafica
 * for an operator (`@sitespa.it` or `nome.cognome.id@sitespa.it`), NEVER inventing
 * `.id` / non-`.id` variants and NEVER returning `@tecnicositespa.it`.
 */
export function getWorkspaceDriveEmail(
  member: Pick<StaffMember, 'email' | 'secondaryEmail'>
): string {
  const pri = (member.email || '').trim().toLowerCase();
  if (isWorkspaceDriveEmail(pri)) {
    return pri;
  }
  const sec = (member.secondaryEmail || '').trim().toLowerCase();
  if (isWorkspaceDriveEmail(sec)) {
    return sec;
  }
  return '';
}

/**
 * Suggests the standard `nome.cognome@tecnicositespa.it` mail-only address when
 * an operator's Workspace login is `nome.cognome.id@sitespa.it`.
 */
export function suggestTecnicoMailFromIdEmail(email?: string | null): string {
  const clean = (email || '').trim().toLowerCase();
  if (!isLoginOnlyIdEmail(clean)) return '';
  const local = clean.slice(0, -'.id@sitespa.it'.length).trim();
  if (!local || local.includes('@') || local.includes(' ')) return '';
  return `${local}@tecnicositespa.it`;
}

/**
 * Builds the exact list of Google Drive Editor emails strictly from active operators
 * in Anagrafica (`directory`), excluding `a.biagi@sitespa.it` (folder owner),
 * excluding `@tecnicositespa.it` mail-only boxes, and never synthesizing `.id` variants.
 */
export function resolveAnagraficaDriveShareEmails(
  directory: readonly StaffMember[],
  extraAnagraficaCandidates?: readonly string[]
): string[] {
  const masterLower = MASTER_DRIVE_OWNER_EMAIL.toLowerCase();
  const result = new Set<string>();

  for (const m of directory) {
    if (!m.active) continue;
    const wsEmail = getWorkspaceDriveEmail(m);
    if (wsEmail && wsEmail !== masterLower) {
      result.add(wsEmail);
    }
  }

  if (extraAnagraficaCandidates && extraAnagraficaCandidates.length > 0) {
    for (const raw of extraAnagraficaCandidates) {
      const clean = (raw || '').trim().toLowerCase();
      if (!clean || clean === masterLower) continue;
      const matched = findStaffMemberByAnyEmail(clean, directory);
      if (matched) {
        if (matched.active) {
          const wsEmail = getWorkspaceDriveEmail(matched);
          if (wsEmail && wsEmail !== masterLower) {
            result.add(wsEmail);
          }
        }
      } else if (isWorkspaceDriveEmail(clean)) {
        result.add(clean);
      }
    }
  }

  return Array.from(result);
}

/**
 * Resolves the deliverable email address for sending/receiving messages:
 * - Operators with `.id@sitespa.it` + `nome.cognome@tecnicositespa.it` -> `nome.cognome@tecnicositespa.it`
 * - Admins / Technicians with full `@sitespa.it` -> `@sitespa.it`
 * - Never returns `.id@sitespa.it` (which has no mailbox).
 */
export function getDeliverableEmail(
  member: Pick<StaffMember, 'email' | 'secondaryEmail'>
): string {
  const sec = (member.secondaryEmail || '').trim().toLowerCase();
  if (sec && !isLoginOnlyIdEmail(sec)) {
    return sec;
  }
  const pri = (member.email || '').trim().toLowerCase();
  if (pri && !isLoginOnlyIdEmail(pri)) {
    return pri;
  }
  return '';
}

const SITE_CORPORATE_SUFFIXES = [
  '.id@sitespa.it',
  '@sitespa.it',
  '@tecnicositepa.it',
  '@tecnicositespa.it',
] as const;

export function extractSiteBaseLocal(email?: string | null): string {
  const clean = (email || '').trim().toLowerCase();
  if (!clean || clean.includes(' ')) return '';
  for (const suffix of SITE_CORPORATE_SUFFIXES) {
    if (clean.endsWith(suffix)) {
      const local = clean.slice(0, -suffix.length);
      if (local && !local.includes('@')) {
        return local;
      }
      return '';
    }
  }
  return '';
}

function buildAllSiteVariantsFromLocal(baseLocal: string): string[] {
  if (!baseLocal) return [];
  return [
    `${baseLocal}@sitespa.it`,
    `${baseLocal}.id@sitespa.it`,
    `${baseLocal}@tecnicositepa.it`,
    `${baseLocal}@tecnicositespa.it`,
  ];
}

function sanitizeNameToken(raw?: string | null): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function toggleSiteIdEmailVariant(email?: string | null): string | null {
  const clean = (email || '').trim().toLowerCase();
  if (!clean) return null;
  if (clean.endsWith('.id@sitespa.it')) {
    const baseLocal = clean.slice(0, -'.id@sitespa.it'.length);
    return baseLocal.length > 0 ? `${baseLocal}@sitespa.it` : null;
  }
  const baseLocal = extractSiteBaseLocal(clean);
  if (baseLocal) {
    return `${baseLocal}.id@sitespa.it`;
  }
  return null;
}

export function canonicalSiteBaseEmail(email?: string | null): string {
  const clean = (email || '').trim().toLowerCase();
  if (!clean) return '';
  const baseLocal = extractSiteBaseLocal(clean);
  if (baseLocal) {
    return `${baseLocal}@sitespa.it`;
  }
  return clean;
}

export function buildAuthRuleEmailPair(email?: string | null): string[] {
  const clean = (email || '').trim().toLowerCase();
  if (!clean) return [];
  const baseLocal = extractSiteBaseLocal(clean);
  if (!baseLocal) {
    return [clean];
  }
  const result = [clean];
  for (const variant of buildAllSiteVariantsFromLocal(baseLocal)) {
    if (!result.includes(variant)) {
      result.push(variant);
    }
  }
  return result;
}

export type StaffEmailLike = Pick<StaffMember, 'email' | 'secondaryEmail'> & {
  nome?: string;
  cognome?: string;
};

export function findStaffMemberByAnyEmail<T extends StaffEmailLike>(
  email: string | null | undefined,
  directory?: readonly T[]
): T | undefined {
  const clean = (email || '').trim().toLowerCase();
  if (!clean || !directory || directory.length === 0) return undefined;
  const targetBase = canonicalSiteBaseEmail(clean);
  const direct = directory.find((m) => {
    const primaryClean = (m.email || '').trim().toLowerCase();
    const secondaryClean = (m.secondaryEmail || '').trim().toLowerCase();
    if (
      primaryClean &&
      (primaryClean === clean ||
        canonicalSiteBaseEmail(primaryClean) === targetBase)
    ) {
      return true;
    }
    if (
      secondaryClean &&
      (secondaryClean === clean ||
        canonicalSiteBaseEmail(secondaryClean) === targetBase)
    ) {
      return true;
    }
    return false;
  });
  if (direct) return direct;

  const targetLocal = extractSiteBaseLocal(clean);
  if (!targetLocal) return undefined;

  const fullMatches = directory.filter((m) => {
    const first = sanitizeNameToken(m.nome);
    const last = sanitizeNameToken(m.cognome);
    return Boolean(first && last && `${first}.${last}` === targetLocal);
  });
  if (fullMatches.length === 1) {
    return fullMatches[0];
  }

  const initialMatches = directory.filter((m) => {
    const first = sanitizeNameToken(m.nome);
    const last = sanitizeNameToken(m.cognome);
    return Boolean(
      first && last && `${first.charAt(0)}.${last}` === targetLocal
    );
  });
  if (initialMatches.length === 1) {
    return initialMatches[0];
  }

  return undefined;
}

export function canonicalTechnicianKey(
  email: string | null | undefined,
  directory?: readonly StaffEmailLike[]
): string {
  const clean = (email || '').trim().toLowerCase();
  if (!clean) return '';
  const member = findStaffMemberByAnyEmail(clean, directory);
  if (member) {
    return canonicalSiteBaseEmail(member.email);
  }
  return canonicalSiteBaseEmail(clean);
}

export function areSameTechnicianEmails(
  emailA: string | null | undefined,
  emailB: string | null | undefined,
  directory?: readonly StaffEmailLike[]
): boolean {
  const keyA = canonicalTechnicianKey(emailA, directory);
  const keyB = canonicalTechnicianKey(emailB, directory);
  return Boolean(keyA && keyB && keyA === keyB);
}

export function isAssignmentOwnedByViewer(
  asg: Pick<
    Assignment,
    'technicianEmail' | 'technicianUid' | 'technicianAliasEmails'
  >,
  viewerEmail: string | null | undefined,
  viewerUid?: string | null,
  directory?: readonly StaffEmailLike[]
): boolean {
  if (viewerUid && asg.technicianUid && asg.technicianUid === viewerUid) {
    return true;
  }
  if (areSameTechnicianEmails(asg.technicianEmail, viewerEmail, directory)) {
    return true;
  }
  if (
    viewerEmail &&
    Array.isArray(asg.technicianAliasEmails) &&
    asg.technicianAliasEmails.some((alias) =>
      areSameTechnicianEmails(alias, viewerEmail, directory)
    )
  ) {
    return true;
  }
  return false;
}

export function buildTechnicianEmailAliases(
  email: string | null | undefined,
  directory?: readonly StaffEmailLike[]
): string[] {
  const clean = (email || '').trim().toLowerCase();
  if (!clean) return [];
  const candidates: Array<string | null | undefined> = [
    ...buildAuthRuleEmailPair(clean),
  ];
  const member = findStaffMemberByAnyEmail(clean, directory);
  if (member) {
    const primary = (member.email || '').trim().toLowerCase();
    const secondary = (member.secondaryEmail || '').trim().toLowerCase();
    candidates.push(...buildAuthRuleEmailPair(primary));
    if (secondary) {
      candidates.push(...buildAuthRuleEmailPair(secondary));
    }
    const first = sanitizeNameToken(member.nome);
    const last = sanitizeNameToken(member.cognome);
    if (first && last) {
      const fullLocal = `${first}.${last}`;
      candidates.push(
        `${fullLocal}@sitespa.it`,
        `${fullLocal}.id@sitespa.it`,
        `${fullLocal}@tecnicositespa.it`,
        `${fullLocal}@tecnicositepa.it`
      );
      if (directory) {
        const initLocal = `${first.charAt(0)}.${last}`;
        const sameInitCount = directory.filter((m) => {
          const mf = sanitizeNameToken(m.nome);
          const ml = sanitizeNameToken(m.cognome);
          return Boolean(mf && ml && `${mf.charAt(0)}.${ml}` === initLocal);
        }).length;
        if (sameInitCount === 1) {
          candidates.push(
            `${initLocal}@sitespa.it`,
            `${initLocal}.id@sitespa.it`
          );
        }
      }
    }
  }
  const unique: string[] = [];
  for (const raw of candidates) {
    const candidate = (raw || '').trim().toLowerCase();
    if (
      candidate &&
      candidate.length <= VALIDATION_LIMITS.EMAIL_MAX_LEN &&
      VALIDATION_LIMITS.EMAIL_PATTERN.test(candidate) &&
      !unique.includes(candidate)
    ) {
      unique.push(candidate);
    }
    if (unique.length >= VALIDATION_LIMITS.MAX_TECH_ALIAS_EMAILS) {
      break;
    }
  }
  return unique;
}

export function expandSquadAclEmails(
  emails: readonly string[],
  directory?: readonly StaffEmailLike[]
): string[] {
  const unique: string[] = [];
  for (const rawEmail of emails) {
    const aliases = buildTechnicianEmailAliases(rawEmail, directory);
    for (const alias of aliases) {
      if (!unique.includes(alias)) {
        unique.push(alias);
      }
      if (unique.length >= VALIDATION_LIMITS.MAX_SQUAD_ACL_EMAILS) {
        return unique;
      }
    }
  }
  return unique;
}

export function computeTaskPrevalentStatus(
  statuses: readonly AssignmentStatus[]
): TaskStatus {
  const activeStatuses = statuses.filter((s) => s !== 'Annullato');
  if (activeStatuses.length === 0) {
    return 'Non Assegnato';
  }
  const allCompleted = activeStatuses.every((s) => s === 'Completato');
  if (allCompleted) {
    return 'Completato';
  }
  const anyInProgress = activeStatuses.some(
    (s) => s === 'Preso in Carico' || s === 'Completato'
  );
  if (anyInProgress) {
    return 'Preso in Carico';
  }
  return 'Assegnato';
}

// ---------------------------------------------------------------------------
// On-Call Schedule (Reperibilità Settimanale & Sostituzioni)
// ---------------------------------------------------------------------------

export type OnCallGroup = 'technicians' | 'coordinators';

export const ON_CALL_GROUPS: readonly OnCallGroup[] = [
  'technicians',
  'coordinators',
] as const;

export const ON_CALL_GROUP_LABELS: Record<OnCallGroup, string> = {
  technicians: 'Tecnici',
  coordinators: 'Assistenti (AT)',
};

export function isAssistantAtStaffMember(
  member: Pick<StaffMember, 'email' | 'secondaryEmail' | 'role'>
): boolean {
  const primaryBase = canonicalSiteBaseEmail(member.email);
  const secondaryBase = member.secondaryEmail
    ? canonicalSiteBaseEmail(member.secondaryEmail)
    : '';
  const isBootstrapped =
    (BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]).includes(primaryBase) ||
    (Boolean(secondaryBase) &&
      (BOOTSTRAPPED_ADMIN_EMAILS as readonly string[]).includes(secondaryBase));
  return member.role === 'admin' || isBootstrapped;
}

export function isEligibleForOnCallGroup(
  member: Pick<StaffMember, 'email' | 'secondaryEmail' | 'role'>,
  group: OnCallGroup
): boolean {
  const assistantAt = isAssistantAtStaffMember(member);
  if (group === 'coordinators') {
    return assistantAt;
  }
  return !assistantAt;
}

export type OnCallOverrideScope = 'full' | 'daily' | 'hourly';

export const ON_CALL_OVERRIDE_SCOPES: readonly OnCallOverrideScope[] = [
  'full',
  'daily',
  'hourly',
] as const;

export interface OnCallShift {
  shiftId: string;
  group: OnCallGroup;
  weekStartDate: string; // YYYY-MM-DD (Lunedì)
  startsAt0700: boolean; // false = Lunedì 17:00, true = Lunedì 07:00 (festivo)
  inizio: string;
  inizioMs: number;
  fine: string; // Lunedì successivo ore 07:00
  fineMs: number;
  technicianEmail: string;
  technicianName: string;
  technicianUid: string;
  note: string;
  adminUids: string[];
  createdByUid: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface OnCallOverride {
  overrideId: string;
  shiftId: string;
  group: OnCallGroup;
  scope: OnCallOverrideScope;
  inizio: string;
  inizioMs: number;
  fine: string;
  fineMs: number;
  originalTechnicianEmail: string;
  originalTechnicianName: string;
  substituteTechnicianEmail: string;
  substituteTechnicianName: string;
  substituteTechnicianUid: string;
  note: string;
  adminUids: string[];
  createdByUid: string;
  createdByName: string;
  createdByRole: UserRole;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function getGregorianEasterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

export function isItalianPublicHolidayDate(dateStr: string): boolean {
  const parts = dateStr.slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return false;
  const [year, month, day] = parts;
  const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const fixedHolidays = new Set([
    '01-01', // Capodanno
    '01-06', // Epifania
    '04-25', // Liberazione
    '05-01', // Festa dei Lavoratori
    '06-02', // Festa della Repubblica
    '08-15', // Ferragosto
    '11-01', // Ognissanti
    '12-08', // Immacolata
    '12-25', // Natale
    '12-26', // Santo Stefano
  ]);
  if (fixedHolidays.has(mmdd)) return true;

  const easter = getGregorianEasterSunday(year);
  const easterMonday = new Date(year, easter.month - 1, easter.day + 1);
  return (
    easterMonday.getFullYear() === year &&
    easterMonday.getMonth() + 1 === month &&
    easterMonday.getDate() === day
  );
}

export function computeOnCallWeekWindow(
  weekStartDate: string,
  startsAt0700?: boolean
): {
  weekStartDate: string;
  startsAt0700: boolean;
  inizioMs: number;
  fineMs: number;
  inizioIso: string;
  fineIso: string;
} | null {
  const parts = weekStartDate.slice(0, 10).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  const startDay = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (Number.isNaN(startDay.getTime())) return null;
  const effective0700 =
    typeof startsAt0700 === 'boolean'
      ? startsAt0700
      : isItalianPublicHolidayDate(weekStartDate);
  const startHour = effective0700 ? 7 : 17;
  const inizioDate = new Date(y, m - 1, d, startHour, 0, 0, 0);
  const fineDate = new Date(y, m - 1, d + 7, 7, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  const cleanDate = `${startDay.getFullYear()}-${pad(startDay.getMonth() + 1)}-${pad(
    startDay.getDate()
  )}`;
  return {
    weekStartDate: cleanDate,
    startsAt0700: effective0700,
    inizioMs: inizioDate.getTime(),
    fineMs: fineDate.getTime(),
    inizioIso: inizioDate.toISOString(),
    fineIso: fineDate.toISOString(),
  };
}

export interface ExcelOnCallPresetColumn {
  group: OnCallGroup;
  surname: string;
  defaultDisplayName: string;
  defaultEmail: string;
  mondays: readonly string[];
}

export const EXCEL_ON_CALL_PRESET_2025_2028: readonly ExcelOnCallPresetColumn[] = [
  {
    group: 'technicians',
    surname: 'LUCCI',
    defaultDisplayName: 'Lucci',
    defaultEmail: 'lucci@sitespa.it',
    mondays: [
      '2025-12-15', '2026-02-02', '2026-03-23', '2026-05-11', '2026-06-29',
      '2026-08-17', '2026-10-12', '2026-12-07', '2027-02-01', '2027-03-29',
      '2027-05-24', '2027-07-19', '2027-09-13', '2027-11-08', '2028-01-03',
    ],
  },
  {
    group: 'technicians',
    surname: 'CRESCIMONE',
    defaultDisplayName: 'Crescimone',
    defaultEmail: 'crescimone@sitespa.it',
    mondays: [
      '2025-12-22', '2026-02-09', '2026-03-30', '2026-05-18', '2026-07-06',
      '2026-08-24', '2026-10-19', '2026-12-14', '2027-02-08', '2027-04-05',
      '2027-05-31', '2027-07-26', '2027-09-20', '2027-11-15', '2028-01-10',
    ],
  },
  {
    group: 'technicians',
    surname: 'MAIORANO',
    defaultDisplayName: 'Maiorano',
    defaultEmail: 'maiorano@sitespa.it',
    mondays: [
      '2025-12-29', '2026-02-16', '2026-04-06', '2026-05-25', '2026-07-13',
      '2026-08-31', '2026-10-26', '2026-12-21', '2027-02-15', '2027-04-12',
      '2027-06-07', '2027-08-02', '2027-09-27', '2027-11-22', '2028-01-17',
    ],
  },
  {
    group: 'technicians',
    surname: 'RONDELLI',
    defaultDisplayName: 'Rondelli',
    defaultEmail: 'rondelli@sitespa.it',
    mondays: [
      '2026-09-07', '2026-11-02', '2026-12-28', '2027-02-22', '2027-04-19',
      '2027-06-14', '2027-08-09', '2027-10-04', '2027-11-29', '2028-01-24',
    ],
  },
  {
    group: 'technicians',
    surname: 'MORRA',
    defaultDisplayName: 'Morra',
    defaultEmail: 'morra@sitespa.it',
    mondays: [
      '2026-01-05', '2026-02-23', '2026-04-13', '2026-06-01', '2026-07-20',
      '2026-09-14', '2026-11-09', '2027-01-04', '2027-03-01', '2027-04-26',
      '2027-06-21', '2027-08-16', '2027-10-11', '2027-12-06', '2028-01-31',
    ],
  },
  {
    group: 'technicians',
    surname: 'GUGLIELMUCCI',
    defaultDisplayName: 'Guglielmucci',
    defaultEmail: 'guglielmucci@sitespa.it',
    mondays: [
      '2026-01-12', '2026-03-02', '2026-04-20', '2026-06-08', '2026-07-27',
      '2026-09-21', '2026-11-16', '2027-01-11', '2027-03-08', '2027-05-03',
      '2027-06-28', '2027-08-23', '2027-10-18', '2027-12-13', '2028-02-07',
    ],
  },
  {
    group: 'technicians',
    surname: 'FERRANDINO',
    defaultDisplayName: 'Ferrandino',
    defaultEmail: 'ferrandino@sitespa.it',
    mondays: [
      '2026-01-19', '2026-03-09', '2026-04-27', '2026-06-15', '2026-08-03',
      '2026-09-28', '2026-11-23', '2027-01-18', '2027-03-15', '2027-05-10',
      '2027-07-05', '2027-08-30', '2027-10-25', '2027-12-20', '2028-02-14',
    ],
  },
  {
    group: 'technicians',
    surname: 'DONDI',
    defaultDisplayName: 'Dondi',
    defaultEmail: 'dondi@sitespa.it',
    mondays: [
      '2026-01-26', '2026-03-16', '2026-05-04', '2026-06-22', '2026-08-10',
      '2026-10-05', '2026-11-30', '2027-01-25', '2027-03-22', '2027-05-17',
      '2027-07-12', '2027-09-06', '2027-11-01', '2027-12-27', '2028-02-21',
    ],
  },
  {
    group: 'coordinators',
    surname: 'PISTACCHIO',
    defaultDisplayName: 'Pistacchio',
    defaultEmail: 's.pistacchio@sitespa.it',
    mondays: [
      '2025-12-29', '2026-01-12', '2026-01-26', '2026-02-09', '2026-02-23',
      '2026-03-09', '2026-03-23', '2026-04-06', '2026-04-20', '2026-05-04',
      '2026-05-18', '2026-06-01', '2026-06-15', '2026-06-29', '2026-07-13',
      '2026-07-27', '2026-08-10', '2026-08-24', '2026-09-07', '2026-09-21',
      '2026-10-05', '2026-10-19', '2026-11-02', '2026-11-16', '2026-11-30',
      '2026-12-14', '2026-12-28', '2027-01-11',
    ],
  },
  {
    group: 'coordinators',
    surname: 'BIAGI',
    defaultDisplayName: 'Biagi',
    defaultEmail: 'a.biagi@sitespa.it',
    mondays: [
      '2026-01-05', '2026-01-19', '2026-02-02', '2026-02-16', '2026-03-02',
      '2026-03-16', '2026-03-30', '2026-04-13', '2026-04-27', '2026-05-11',
      '2026-05-25', '2026-06-08', '2026-06-22', '2026-07-06', '2026-07-20',
      '2026-08-03', '2026-08-17', '2026-08-31', '2026-09-14', '2026-09-28',
      '2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23', '2026-12-07',
      '2026-12-21', '2027-01-04', '2027-01-18',
    ],
  },
];
export interface ResolvedOnCallBannerSummary {
  weekStartDate: string;
  startsAt0700: boolean;
  techShift: OnCallShift | null;
  techEffectiveName: string;
  techIsSubstituted: boolean;
  techWeekOverridesCount: number;
  assistantShift: OnCallShift | null;
  assistantEffectiveName: string;
  assistantIsSubstituted: boolean;
  assistantWeekOverridesCount: number;
}

export function resolveOnCallSummaryForDate(
  onCallShifts: OnCallShift[],
  onCallOverrides: OnCallOverride[],
  targetMs: number
): ResolvedOnCallBannerSummary {
  const d = new Date(targetMs);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const dow = dayStart.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(
    dayStart.getFullYear(),
    dayStart.getMonth(),
    dayStart.getDate() + diffToMonday,
    0,
    0,
    0,
    0
  );
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekStartDate = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(
    monday.getDate()
  )}`;
  const isMonday = dayStart.getDay() === 1;

  const resolveLine = (group: OnCallGroup) => {
    const shift =
      onCallShifts.find(
        (s) => s.group === group && s.weekStartDate === weekStartDate
      ) || null;
    if (!shift) {
      return {
        shift: null,
        effectiveName: '',
        isSubstituted: false,
        weekOverridesCount: 0,
      };
    }

    const weekOverrides = onCallOverrides.filter(
      (ov) => ov.shiftId === shift.shiftId
    );
    const covStartMs =
      isMonday && !shift.startsAt0700
        ? new Date(
            dayStart.getFullYear(),
            dayStart.getMonth(),
            dayStart.getDate(),
            17,
            0
          ).getTime()
        : new Date(
            dayStart.getFullYear(),
            dayStart.getMonth(),
            dayStart.getDate(),
            7,
            0
          ).getTime();
    const covEndMs = new Date(
      dayStart.getFullYear(),
      dayStart.getMonth(),
      dayStart.getDate() + 1,
      7,
      0
    ).getTime();

    const dayOverrides = weekOverrides.filter(
      (ov) => ov.inizioMs < covEndMs && ov.fineMs > covStartMs
    );
    const activeOv =
      dayOverrides.length > 0 ? dayOverrides[dayOverrides.length - 1] : null;

    return {
      shift,
      effectiveName: activeOv
        ? activeOv.substituteTechnicianName
        : shift.technicianName,
      isSubstituted: Boolean(activeOv),
      weekOverridesCount: weekOverrides.length,
    };
  };

  const tech = resolveLine('technicians');
  const asst = resolveLine('coordinators');

  return {
    weekStartDate,
    startsAt0700: Boolean(
      tech.shift?.startsAt0700 ??
        asst.shift?.startsAt0700 ??
        isItalianPublicHolidayDate(weekStartDate)
    ),
    techShift: tech.shift,
    techEffectiveName: tech.effectiveName,
    techIsSubstituted: tech.isSubstituted,
    techWeekOverridesCount: tech.weekOverridesCount,
    assistantShift: asst.shift,
    assistantEffectiveName: asst.effectiveName,
    assistantIsSubstituted: asst.isSubstituted,
    assistantWeekOverridesCount: asst.weekOverridesCount,
  };
}
