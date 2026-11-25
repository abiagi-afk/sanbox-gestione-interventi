/**
 * Google Sheets Weekly Bureaucratic Schedule Sync Engine (`WK_XX`)
 * - Strictly client-side OAuth Bearer token authentication via Google Sheets API v4
 * - Matches weekly tabs (`WK_45`, `WK_01` / `WK_1`) using ISO-8601 week numbers
 * - Matches technician rows starting at Row 2 via normalized `COGNOME` (Col A) + `NOME` (Col B),
 *   skipping blank gray separator rows and disambiguating homonyms
 * - Matches daily columns starting at Col D across Monday–Sunday (multi-day & weekend coverage)
 * - Surgically updates app-managed blocks (approved Task descriptions + Absences) separated by `\n\n`
 *   while preserving manual notes typed directly on the sheet and keeping cell background colors intact (`RAW` values update)
 */

import {
  Absence,
  areSameTechnicianEmails,
  canonicalTechnicianKey,
  extractGoogleSheetId,
  findStaffMemberByAnyEmail,
  StaffMember,
  Task,
} from '../types/domain';
import {
  addLocalDaysMs,
  findOverlappingAbsencesForTech,
  getIsoWeekNumber,
  startOfLocalDayMs,
} from './calendarLayout';

const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

const ITALIAN_WEEKDAYS_BY_ISO: Record<number, string> = {
  1: 'lunedi',
  2: 'martedi',
  3: 'mercoledi',
  4: 'giovedi',
  5: 'venerdi',
  6: 'sabato',
  7: 'domenica',
};

interface SheetTabMetadata {
  sheetId: number;
  title: string;
  rowCount: number;
  columnCount: number;
}

interface SpreadsheetMetadata {
  spreadsheetId: string;
  title: string;
  sheets: SheetTabMetadata[];
}

export interface GoogleSheetDiagnosticResult {
  spreadsheetId: string;
  spreadsheetTitle: string;
  spreadsheetUrl: string;
  wkTabs: string[];
  currentWeekCode: string;
  matchedCurrentTab: string | null;
  matchedTechniciansCount: number;
  totalActiveTechniciansCount: number;
  unmatchedTechnicianNames: string[];
}

export interface SheetSyncOutcome {
  updatedCellsCount: number;
  touchedTabs: string[];
  missingTabs: string[];
  unmatchedTechnicianNames: string[];
}

export type ConnectWorkspaceTokenFn = (options?: {
  forceConsent?: boolean;
}) => Promise<string>;

function stripAccentsAndNormalize(raw: string): string {
  return (raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function normalizePersonToken(raw: string): string {
  return stripAccentsAndNormalize(raw)
    .replace(/['’`]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBlockForCompare(block: string): string {
  return (block || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

export function parseSheetCellBlocks(cellValue: string): string[] {
  const normalized = (cellValue || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/\n[ \t]*\n+/)
    .map((b) =>
      b
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .trim()
    )
    .filter(Boolean);
}

export function formatTaskSheetBlock(
  task: Pick<Task, 'descrizione'>
): string {
  const raw = (task.descrizione || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  // Collapse internal blank lines inside a single task so `\n\n` remains the strict inter-task separator
  return raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function formatTwoDigits(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatAbsenceSheetBlock(
  absence: Pick<Absence, 'tipo' | 'allDay' | 'inizioMs' | 'fineMs' | 'note'>,
  dayStartMs?: number
): string {
  const baseLabel =
    absence.tipo === 'Malattia'
      ? 'MALATTIA'
      : absence.tipo === 'Ferie'
      ? 'FERIE'
      : absence.tipo === 'Permesso'
      ? 'PERMESSO'
      : absence.tipo === 'Visita Medica'
      ? 'VISITA MEDICA'
      : absence.tipo === 'Assemblea Sindacale'
      ? 'ASSEMBLEA SINDACALE'
      : 'ASSENZA';

  let label = baseLabel;

  if (!absence.allDay && dayStartMs !== undefined) {
    const dayEndMs = addLocalDaysMs(dayStartMs, 1);
    const clippedStart = Math.max(dayStartMs, absence.inizioMs);
    const clippedEnd = Math.min(dayEndMs, absence.fineMs);
    const coveredHours = (clippedEnd - clippedStart) / 3600000;
    if (coveredHours > 0 && coveredHours < 20) {
      const s = new Date(clippedStart);
      const e = new Date(clippedEnd);
      const startStr = `${formatTwoDigits(s.getHours())}:${formatTwoDigits(
        s.getMinutes()
      )}`;
      const endStr =
        clippedEnd >= dayEndMs && e.getHours() === 0 && e.getMinutes() === 0
          ? '24:00'
          : `${formatTwoDigits(e.getHours())}:${formatTwoDigits(
              e.getMinutes()
            )}`;
      label = `${baseLabel} ${startStr}-${endStr}`;
    }
  }

  if (absence.tipo === 'Altro' && (absence.note || '').trim()) {
    const cleanNote = absence.note
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleanNote) {
      label = `${label} - ${cleanNote}`;
    }
  }

  return label;
}

export function enumerateCoveredLocalDaysMs(
  inizioMs: number,
  fineMs: number
): number[] {
  if (!Number.isFinite(inizioMs) || !Number.isFinite(fineMs)) return [];
  const effectiveEndMs = Math.max(inizioMs, fineMs - 1);
  const firstDay = startOfLocalDayMs(inizioMs);
  const lastDay = startOfLocalDayMs(effectiveEndMs);
  const days: number[] = [];
  let cursor = firstDay;
  let guard = 0;
  while (cursor <= lastDay && guard < 120) {
    days.push(cursor);
    cursor = addLocalDaysMs(cursor, 1);
    guard += 1;
  }
  return days;
}

export function formatIsoWeekCode(dayOrMs: Date | number): string {
  const wk = getIsoWeekNumber(dayOrMs);
  return `WK_${String(wk).padStart(2, '0')}`;
}

export function collectImpactedWeekCodes(
  intervals: Array<{ inizioMs: number; fineMs: number }>
): string[] {
  const set = new Set<string>();
  for (const iv of intervals) {
    for (const dayMs of enumerateCoveredLocalDaysMs(iv.inizioMs, iv.fineMs)) {
      set.add(formatIsoWeekCode(dayMs));
    }
  }
  return Array.from(set);
}

function columnIndexToLetter(colIdxZeroBased: number): string {
  let n = colIdxZeroBased + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function escapeA1SheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

async function fetchSheetsApi<T>(
  path: string,
  connectGoogleWorkspace: ConnectWorkspaceTokenFn,
  init?: RequestInit
): Promise<T> {
  let token = await connectGoogleWorkspace();
  const doRequest = (bearer: string) =>
    fetch(`${SHEETS_API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${bearer}`,
      },
    });

  let res = await doRequest(token);

  if (res.status === 401 || res.status === 403) {
    const errBody = await res.clone().text().catch(() => '');
    const needsScopeOrFreshToken =
      res.status === 401 ||
      errBody.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') ||
      errBody.toLowerCase().includes('insufficient authentication scopes');

    if (needsScopeOrFreshToken) {
      token = await connectGoogleWorkspace({ forceConsent: true });
      res = await doRequest(token);
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 404) {
      throw new Error(
        "Foglio Google Sheet non trovato. Controlla l'URL o l'ID salvato in Tecnici & Impostazioni."
      );
    }
    if (res.status === 403) {
      throw new Error(
        'Il tuo account Google non dispone dei permessi di modifica sul foglio Google Sheet configurato.'
      );
    }
    throw new Error(
      `Errore comunicazione Google Sheets (${res.status}): ${
        errText.slice(0, 180) || res.statusText
      }`
    );
  }

  return (await res.json()) as T;
}

async function fetchSpreadsheetMetadata(
  spreadsheetId: string,
  connectGoogleWorkspace: ConnectWorkspaceTokenFn
): Promise<SpreadsheetMetadata> {
  const raw = await fetchSheetsApi<{
    spreadsheetId?: string;
    properties?: { title?: string };
    sheets?: Array<{
      properties?: {
        sheetId?: number;
        title?: string;
        gridProperties?: { rowCount?: number; columnCount?: number };
      };
    }>;
  }>(
    `/${encodeURIComponent(
      spreadsheetId
    )}?fields=spreadsheetId,properties.title,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`,
    connectGoogleWorkspace
  );

  return {
    spreadsheetId: raw.spreadsheetId || spreadsheetId,
    title: raw.properties?.title || 'Foglio Google Sheets',
    sheets: (raw.sheets || []).map((s) => ({
      sheetId: Number(s.properties?.sheetId ?? 0),
      title: String(s.properties?.title || ''),
      rowCount: Number(s.properties?.gridProperties?.rowCount ?? 150),
      columnCount: Number(s.properties?.gridProperties?.columnCount ?? 12),
    })),
  };
}

function findMatchingWeekTab(
  sheets: SheetTabMetadata[],
  weekNumber: number
): SheetTabMetadata | null {
  const padded = String(weekNumber).padStart(2, '0');
  const unpadded = String(weekNumber);
  const candidates = new Set([
    `WK_${padded}`,
    `WK_${unpadded}`,
    `WK ${padded}`,
    `WK ${unpadded}`,
    `WK-${padded}`,
    `WK-${unpadded}`,
  ]);

  // Prefer exact WK_XX first
  for (const s of sheets) {
    const upper = s.title.trim().toUpperCase();
    if (upper === `WK_${padded}` || upper === `WK_${unpadded}`) {
      return s;
    }
  }

  for (const s of sheets) {
    const upper = s.title.trim().toUpperCase();
    if (candidates.has(upper)) {
      return s;
    }
  }

  return null;
}

async function readSheetValuesGrid(
  spreadsheetId: string,
  tabTitle: string,
  connectGoogleWorkspace: ConnectWorkspaceTokenFn
): Promise<string[][]> {
  const range = `${escapeA1SheetTitle(tabTitle)}!A1:Z200`;
  const data = await fetchSheetsApi<{ values?: unknown[][] }>(
    `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    connectGoogleWorkspace
  );
  return (data.values || []).map((row) =>
    Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []
  );
}

function matchStaffRowZeroBasedIndex(params: {
  grid: string[][];
  cognome: string;
  nome: string;
}): number {
  const { grid } = params;
  const targetCognome = normalizePersonToken(params.cognome);
  const targetNome = normalizePersonToken(params.nome);
  if (!targetCognome && !targetNome) return -1;

  // Pass 1: Strict COGNOME (Col A) + NOME (Col B) starting at Row 2 (index 1)
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const colCognome = normalizePersonToken(row[0] || '');
    const colNome = normalizePersonToken(row[1] || '');
    if (!colCognome && !colNome) continue;
    if (colCognome === targetCognome && colNome === targetNome) {
      return r;
    }
  }

  // Pass 2: Unambiguous first-token match when middle names exist (e.g. MARCO ANTONIO vs MARCO)
  const partialMatches: number[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const colCognome = normalizePersonToken(row[0] || '');
    const colNome = normalizePersonToken(row[1] || '');
    if (!colCognome && !colNome) continue;
    const cognomeMatches =
      colCognome === targetCognome ||
      (targetCognome.length >= 3 && colCognome.startsWith(`${targetCognome} `)) ||
      (colCognome.length >= 3 && targetCognome.startsWith(`${colCognome} `));
    const nomeMatches =
      colNome === targetNome ||
      (targetNome.length >= 3 && colNome.startsWith(`${targetNome} `)) ||
      (colNome.length >= 3 && targetNome.startsWith(`${colNome} `));
    if (cognomeMatches && nomeMatches) {
      partialMatches.push(r);
    }
  }
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }

  // Pass 3: Unambiguous swapped Nome/Cognome fallback
  const swappedMatches: number[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const colCognome = normalizePersonToken(row[0] || '');
    const colNome = normalizePersonToken(row[1] || '');
    if (!colCognome && !colNome) continue;
    if (colCognome === targetNome && colNome === targetCognome) {
      swappedMatches.push(r);
    }
  }
  if (swappedMatches.length === 1) {
    return swappedMatches[0];
  }

  return -1;
}

function resolveTechnicianIdentity(
  emailOrRaw: string,
  directory: StaffMember[],
  fallbackFullName?: string
): {
  canonKey: string;
  cognome: string;
  nome: string;
  displayLabel: string;
  isTechnicianEligible: boolean;
} | null {
  const cleanEmail = (emailOrRaw || '').trim().toLowerCase();
  if (!cleanEmail) return null;

  const staff = findStaffMemberByAnyEmail(cleanEmail, directory);
  if (staff) {
    return {
      canonKey: canonicalTechnicianKey(staff.email, directory),
      cognome: staff.cognome,
      nome: staff.nome,
      displayLabel: `${staff.cognome} ${staff.nome}`.trim(),
      isTechnicianEligible: true,
    };
  }

  if (fallbackFullName && fallbackFullName.trim()) {
    const parts = fallbackFullName.trim().split(/\s+/);
    if (parts.length >= 2) {
      const nome = parts[0];
      const cognome = parts.slice(1).join(' ');
      return {
        canonKey: canonicalTechnicianKey(cleanEmail, directory),
        cognome,
        nome,
        displayLabel: `${cognome} ${nome}`.trim(),
        isTechnicianEligible: true,
      };
    }
  }

  return null;
}

function resolveDayColumnZeroBasedIndex(params: {
  headerRow: string[];
  dayStartMs: number;
  sheetColumnCount: number;
}): number {
  const { headerRow, dayStartMs, sheetColumnCount } = params;
  const d = new Date(dayStartMs);
  const isoWeekday = d.getDay() === 0 ? 7 : d.getDay(); // 1=Mon .. 7=Sun
  const dayOfMonth = d.getDate();
  const targetWeekdayWord = ITALIAN_WEEKDAYS_BY_ISO[isoWeekday];

  const maxScan = Math.max(headerRow.length, Math.min(sheetColumnCount, 14));

  // Pass 1: Header from Col D (index 3) onwards matching BOTH weekday name and day-of-month number
  for (let c = 3; c < maxScan; c++) {
    const rawHeader = stripAccentsAndNormalize(headerRow[c] || '').toLowerCase();
    if (!rawHeader) continue;
    const numberTokens = rawHeader.match(/\b\d{1,2}\b/g) || [];
    const hasExactDayNumber = numberTokens.some(
      (numStr) => Number(numStr) === dayOfMonth
    );
    if (rawHeader.includes(targetWeekdayWord) && hasExactDayNumber) {
      return c;
    }
  }

  // Pass 2: Header matching day-of-month number on expected positional column or matching weekday word
  for (let c = 3; c < maxScan; c++) {
    const rawHeader = stripAccentsAndNormalize(headerRow[c] || '').toLowerCase();
    if (!rawHeader) continue;
    if (rawHeader.includes(targetWeekdayWord)) {
      return c;
    }
  }

  // Pass 3: Positional Monday=Col D (index 3) .. Sunday=Col J (index 9) when within grid bounds
  // (Supports blank gray Saturday/Sunday headers in Columns I & J right after Friday Col H)
  const positionalIdx = 3 + (isoWeekday - 1);
  if (positionalIdx < sheetColumnCount) {
    const existingPosHeader = stripAccentsAndNormalize(
      headerRow[positionalIdx] || ''
    ).toLowerCase();
    // Only use positional fallback if header is blank or doesn't explicitly belong to a different weekday
    const belongsToOtherWeekday = Object.entries(ITALIAN_WEEKDAYS_BY_ISO).some(
      ([isoStr, word]) =>
        Number(isoStr) !== isoWeekday && existingPosHeader.includes(word)
    );
    if (!belongsToOtherWeekday) {
      return positionalIdx;
    }
  }

  return -1;
}

function buildAuthoritativeAppBlocksForCell(params: {
  techEmail: string;
  dayStartMs: number;
  allTasks: Task[];
  allAbsences: Absence[];
  directory: StaffMember[];
}): string[] {
  const { techEmail, dayStartMs, allTasks, allAbsences, directory } = params;
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);

  const blocks: string[] = [];
  const seenNormalized = new Set<string>();

  const pushUnique = (text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    const norm = normalizeBlockForCompare(cleaned);
    if (!norm || seenNormalized.has(norm)) return;
    seenNormalized.add(norm);
    blocks.push(cleaned);
  };

  // 1. Overlapping Absences for this technician on this day
  const techAbsences = findOverlappingAbsencesForTech(
    allAbsences,
    techEmail,
    dayStartMs,
    dayEndMs,
    directory
  ).sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return a.inizioMs - b.inizioMs;
  });

  for (const abs of techAbsences) {
    pushUnique(formatAbsenceSheetBlock(abs, dayStartMs));
  }

  // 2. Approved Tasks (`!pendingAdminReview`) overlapping this day and assigned to this technician
  const techTasks = allTasks
    .filter((t) => {
      if (t.pendingAdminReview) return false;
      const effectiveEnd = Math.max(t.inizioMs, t.fineMs - 1);
      const overlapsDay = t.inizioMs < dayEndMs && effectiveEnd >= dayStartMs;
      if (!overlapsDay) return false;
      return t.assignedEmails.some((em) =>
        areSameTechnicianEmails(em, techEmail, directory)
      );
    })
    .sort((a, b) => {
      if (a.inizioMs !== b.inizioMs) return a.inizioMs - b.inizioMs;
      return a.taskCode.localeCompare(b.taskCode);
    });

  for (const t of techTasks) {
    pushUnique(formatTaskSheetBlock(t));
  }

  return blocks;
}

interface ImpactedCellSpec {
  canonKey: string;
  techEmail: string;
  fallbackName?: string;
  dayStartMs: number;
  removedBlocks: string[];
}

async function applyCellSpecsToSpreadsheet(params: {
  spreadsheetId: string;
  connectGoogleWorkspace: ConnectWorkspaceTokenFn;
  cellSpecs: ImpactedCellSpec[];
  allTasks: Task[];
  allAbsences: Absence[];
  directory: StaffMember[];
  requireWeekTabExists?: boolean;
}): Promise<SheetSyncOutcome> {
  const {
    spreadsheetId,
    connectGoogleWorkspace,
    cellSpecs,
    allTasks,
    allAbsences,
    directory,
    requireWeekTabExists = false,
  } = params;

  if (cellSpecs.length === 0) {
    return {
      updatedCellsCount: 0,
      touchedTabs: [],
      missingTabs: [],
      unmatchedTechnicianNames: [],
    };
  }

  // Deduplicate cellSpecs by `(canonKey, dayStartMs)` merging removedBlocks
  const mergedMap = new Map<string, ImpactedCellSpec>();
  for (const spec of cellSpecs) {
    const key = `${spec.canonKey}::${spec.dayStartMs}`;
    const existing = mergedMap.get(key);
    if (!existing) {
      mergedMap.set(key, {
        ...spec,
        removedBlocks: [...spec.removedBlocks],
      });
    } else {
      existing.removedBlocks.push(...spec.removedBlocks);
    }
  }

  // Group by ISO week number
  const byWeek = new Map<number, ImpactedCellSpec[]>();
  for (const spec of mergedMap.values()) {
    const wk = getIsoWeekNumber(spec.dayStartMs);
    const list = byWeek.get(wk) || [];
    list.push(spec);
    byWeek.set(wk, list);
  }

  const metadata = await fetchSpreadsheetMetadata(
    spreadsheetId,
    connectGoogleWorkspace
  );

  const batchData: Array<{ range: string; values: string[][] }> = [];
  const touchedTabsSet = new Set<string>();
  const missingTabsSet = new Set<string>();
  const unmatchedNamesSet = new Set<string>();

  for (const [weekNum, weekSpecs] of byWeek.entries()) {
    const tab = findMatchingWeekTab(metadata.sheets, weekNum);
    const wkLabel = `WK_${String(weekNum).padStart(2, '0')}`;
    if (!tab) {
      if (requireWeekTabExists) {
        throw new Error(
          `La scheda settimanale "${wkLabel}" non è presente nel foglio Google Sheet "${metadata.title}".`
        );
      }
      missingTabsSet.add(wkLabel);
      continue;
    }

    const grid = await readSheetValuesGrid(
      spreadsheetId,
      tab.title,
      connectGoogleWorkspace
    );
    const headerRow = grid[0] || [];

    for (const spec of weekSpecs) {
      const identity = resolveTechnicianIdentity(
        spec.techEmail,
        directory,
        spec.fallbackName
      );
      if (!identity) continue;

      const rowIdx = matchStaffRowZeroBasedIndex({
        grid,
        cognome: identity.cognome,
        nome: identity.nome,
      });
      if (rowIdx < 0) {
        unmatchedNamesSet.add(identity.displayLabel);
        continue;
      }

      const colIdx = resolveDayColumnZeroBasedIndex({
        headerRow,
        dayStartMs: spec.dayStartMs,
        sheetColumnCount: tab.columnCount,
      });
      if (colIdx < 0) {
        continue;
      }

      const currentCellRaw = String(grid[rowIdx]?.[colIdx] ?? '');
      const existingBlocks = parseSheetCellBlocks(currentCellRaw);

      const authoritativeAppBlocks = buildAuthoritativeAppBlocksForCell({
        techEmail: spec.techEmail,
        dayStartMs: spec.dayStartMs,
        allTasks,
        allAbsences,
        directory,
      });

      const knownAppNormSet = new Set<string>();
      for (const b of authoritativeAppBlocks) {
        const n = normalizeBlockForCompare(b);
        if (n) knownAppNormSet.add(n);
      }
      for (const b of spec.removedBlocks) {
        const n = normalizeBlockForCompare(b);
        if (n) knownAppNormSet.add(n);
      }

      // Preserve manual notes written directly on the sheet in their relative order
      const preservedManualBlocks = existingBlocks.filter(
        (b) => !knownAppNormSet.has(normalizeBlockForCompare(b))
      );

      const finalBlocks = [
        ...preservedManualBlocks,
        ...authoritativeAppBlocks,
      ];
      const nextCellText = finalBlocks.join('\n\n');
      const normalizedCurrentRaw = currentCellRaw
        .replace(/\r\n/g, '\n')
        .trim();

      if (nextCellText !== normalizedCurrentRaw) {
        const colLetter = columnIndexToLetter(colIdx);
        const sheetRowNumber = rowIdx + 1;
        batchData.push({
          range: `${escapeA1SheetTitle(tab.title)}!${colLetter}${sheetRowNumber}`,
          values: [[nextCellText]],
        });
        touchedTabsSet.add(tab.title);
      }
    }
  }

  if (batchData.length > 0) {
    await fetchSheetsApi(
      `/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
      connectGoogleWorkspace,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: batchData,
        }),
      }
    );
  }

  return {
    updatedCellsCount: batchData.length,
    touchedTabs: Array.from(touchedTabsSet),
    missingTabs: Array.from(missingTabsSet),
    unmatchedTechnicianNames: Array.from(unmatchedNamesSet),
  };
}

/**
 * Reconciles Google Sheet cells when an Admin creates, edits, moves, approves, or deletes a Task.
 */
export async function reconcileTaskMutationOnGoogleSheet(params: {
  rawGoogleSheetId?: string | null;
  connectGoogleWorkspace: ConnectWorkspaceTokenFn;
  prevTask: Task | null;
  nextTask: Task | null;
  allTasksPostMutation: Task[];
  allAbsences: Absence[];
  directory: StaffMember[];
}): Promise<SheetSyncOutcome | null> {
  const spreadsheetId = extractGoogleSheetId(params.rawGoogleSheetId);
  if (!spreadsheetId) return null;

  const effectivePrev =
    params.prevTask && !params.prevTask.pendingAdminReview
      ? params.prevTask
      : null;
  const effectiveNext =
    params.nextTask && !params.nextTask.pendingAdminReview
      ? params.nextTask
      : null;

  if (!effectivePrev && !effectiveNext) {
    return null;
  }

  const specs: ImpactedCellSpec[] = [];

  if (effectivePrev) {
    const prevBlock = formatTaskSheetBlock(effectivePrev);
    const prevDays = enumerateCoveredLocalDaysMs(
      effectivePrev.inizioMs,
      effectivePrev.fineMs
    );
    effectivePrev.assignedEmails.forEach((em, idx) => {
      const canon = canonicalTechnicianKey(em, params.directory);
      if (!canon) return;
      for (const dayStartMs of prevDays) {
        specs.push({
          canonKey: canon,
          techEmail: em,
          fallbackName: effectivePrev.assignedNames[idx],
          dayStartMs,
          removedBlocks: prevBlock ? [prevBlock] : [],
        });
      }
    });
  }

  if (effectiveNext) {
    const nextDays = enumerateCoveredLocalDaysMs(
      effectiveNext.inizioMs,
      effectiveNext.fineMs
    );
    effectiveNext.assignedEmails.forEach((em, idx) => {
      const canon = canonicalTechnicianKey(em, params.directory);
      if (!canon) return;
      for (const dayStartMs of nextDays) {
        specs.push({
          canonKey: canon,
          techEmail: em,
          fallbackName: effectiveNext.assignedNames[idx],
          dayStartMs,
          removedBlocks: [],
        });
      }
    });
  }

  return applyCellSpecsToSpreadsheet({
    spreadsheetId,
    connectGoogleWorkspace: params.connectGoogleWorkspace,
    cellSpecs: specs,
    allTasks: params.allTasksPostMutation,
    allAbsences: params.allAbsences,
    directory: params.directory,
  });
}

/**
 * Reconciles Google Sheet cells when an Admin creates, edits, or deletes an Absence.
 */
export async function reconcileAbsenceMutationOnGoogleSheet(params: {
  rawGoogleSheetId?: string | null;
  connectGoogleWorkspace: ConnectWorkspaceTokenFn;
  prevAbsence: Absence | null;
  nextAbsence: Absence | null;
  allTasks: Task[];
  allAbsencesPostMutation: Absence[];
  directory: StaffMember[];
}): Promise<SheetSyncOutcome | null> {
  const spreadsheetId = extractGoogleSheetId(params.rawGoogleSheetId);
  if (!spreadsheetId) return null;

  const { prevAbsence, nextAbsence } = params;
  if (!prevAbsence && !nextAbsence) return null;

  const specs: ImpactedCellSpec[] = [];

  if (prevAbsence) {
    const prevDays = enumerateCoveredLocalDaysMs(
      prevAbsence.inizioMs,
      prevAbsence.fineMs
    );
    const canon = canonicalTechnicianKey(
      prevAbsence.technicianEmail,
      params.directory
    );
    if (canon) {
      for (const dayStartMs of prevDays) {
        const formattedPrev = formatAbsenceSheetBlock(prevAbsence, dayStartMs);
        const basePrev = formatAbsenceSheetBlock(
          { ...prevAbsence, allDay: true },
          dayStartMs
        );
        specs.push({
          canonKey: canon,
          techEmail: prevAbsence.technicianEmail,
          fallbackName: prevAbsence.technicianName,
          dayStartMs,
          removedBlocks: Array.from(new Set([formattedPrev, basePrev])),
        });
      }
    }
  }

  if (nextAbsence) {
    const nextDays = enumerateCoveredLocalDaysMs(
      nextAbsence.inizioMs,
      nextAbsence.fineMs
    );
    const canon = canonicalTechnicianKey(
      nextAbsence.technicianEmail,
      params.directory
    );
    if (canon) {
      for (const dayStartMs of nextDays) {
        specs.push({
          canonKey: canon,
          techEmail: nextAbsence.technicianEmail,
          fallbackName: nextAbsence.technicianName,
          dayStartMs,
          removedBlocks: [],
        });
      }
    }
  }

  return applyCellSpecsToSpreadsheet({
    spreadsheetId,
    connectGoogleWorkspace: params.connectGoogleWorkspace,
    cellSpecs: specs,
    allTasks: params.allTasks,
    allAbsences: params.allAbsencesPostMutation,
    directory: params.directory,
  });
}

/**
 * Full-week alignment (`Sincronizza WK_XX`): reconciles all active operators in Organico
 * across Monday..Sunday of the target ISO week while preserving manual notes and cell colors.
 */
export async function syncFullWeekToGoogleSheet(params: {
  rawGoogleSheetId?: string | null;
  connectGoogleWorkspace: ConnectWorkspaceTokenFn;
  weekAnchorMs: number;
  allTasks: Task[];
  allAbsences: Absence[];
  directory: StaffMember[];
}): Promise<SheetSyncOutcome> {
  const spreadsheetId = extractGoogleSheetId(params.rawGoogleSheetId);
  if (!spreadsheetId) {
    throw new Error(
      "Configura prima il link del foglio Google Sheet nella scheda Tecnici & Impostazioni."
    );
  }

  const anchor = new Date(params.weekAnchorMs);
  const day = anchor.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate() + diffToMonday,
    0,
    0,
    0,
    0
  );
  const weekDaysMs = Array.from({ length: 7 }, (_, idx) =>
    addLocalDaysMs(monday.getTime(), idx)
  );

  const activeStaff = params.directory.filter((m) => m.active);
  const specs: ImpactedCellSpec[] = [];

  for (const member of activeStaff) {
    const canon = canonicalTechnicianKey(member.email, params.directory);
    if (!canon) continue;
    for (const dayStartMs of weekDaysMs) {
      specs.push({
        canonKey: canon,
        techEmail: member.email,
        fallbackName: `${member.nome} ${member.cognome}`.trim(),
        dayStartMs,
        removedBlocks: [],
      });
    }
  }

  return applyCellSpecsToSpreadsheet({
    spreadsheetId,
    connectGoogleWorkspace: params.connectGoogleWorkspace,
    cellSpecs: specs,
    allTasks: params.allTasks,
    allAbsences: params.allAbsences,
    directory: params.directory,
    requireWeekTabExists: true,
  });
}

/**
 * Verifies connection to the configured Google Sheet and inspects `WK_XX` tabs + `COGNOME` / `NOME` matching.
 */
export async function verifyGoogleSheetConnection(params: {
  rawGoogleSheetId: string;
  connectGoogleWorkspace: ConnectWorkspaceTokenFn;
  directory: StaffMember[];
}): Promise<GoogleSheetDiagnosticResult> {
  const spreadsheetId = extractGoogleSheetId(params.rawGoogleSheetId);
  if (!spreadsheetId) {
    throw new Error(
      'Inserisci un URL o un ID valido di Google Sheets (es. https://docs.google.com/spreadsheets/d/...).'
    );
  }

  const metadata = await fetchSpreadsheetMetadata(
    spreadsheetId,
    params.connectGoogleWorkspace
  );

  const wkTabs = metadata.sheets
    .map((s) => s.title)
    .filter((t) => /^wk[\s_-]*\d+/i.test(t.trim()));

  const currentWeekNum = getIsoWeekNumber(Date.now());
  const currentWeekCode = `WK_${String(currentWeekNum).padStart(2, '0')}`;
  const currentTab = findMatchingWeekTab(metadata.sheets, currentWeekNum);

  const tabToInspect =
    currentTab ||
    (wkTabs.length > 0
      ? metadata.sheets.find((s) => s.title === wkTabs[wkTabs.length - 1]) ||
        null
      : metadata.sheets[0] || null);

  const activeTechs = params.directory.filter(
    (m) => m.active && m.role === 'technician'
  );
  const unmatchedTechnicianNames: string[] = [];
  let matchedTechniciansCount = 0;

  if (tabToInspect) {
    const grid = await readSheetValuesGrid(
      spreadsheetId,
      tabToInspect.title,
      params.connectGoogleWorkspace
    );
    for (const tech of activeTechs) {
      const idx = matchStaffRowZeroBasedIndex({
        grid,
        cognome: tech.cognome,
        nome: tech.nome,
      });
      if (idx >= 0) {
        matchedTechniciansCount += 1;
      } else {
        unmatchedTechnicianNames.push(`${tech.cognome} ${tech.nome}`.trim());
      }
    }
  }

  return {
    spreadsheetId,
    spreadsheetTitle: metadata.title,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    wkTabs,
    currentWeekCode,
    matchedCurrentTab: currentTab ? currentTab.title : null,
    matchedTechniciansCount,
    totalActiveTechniciansCount: activeTechs.length,
    unmatchedTechnicianNames,
  };
}

export function formatSheetSyncToastSummary(
  outcome: SheetSyncOutcome | null
): { message: string; tone: 'success' | 'info' } | null {
  if (!outcome) return null;
  if (outcome.missingTabs.length > 0 && outcome.updatedCellsCount === 0) {
    return {
      message: `Foglio ${outcome.missingTabs.join(
        ', '
      )} non presente nel Google Sheet: salvataggio completato solo nell'app.`,
      tone: 'info',
    };
  }
  if (outcome.updatedCellsCount > 0) {
    const tabsLabel = outcome.touchedTabs.join(', ');
    const cellWord = outcome.updatedCellsCount === 1 ? 'cella' : 'celle';
    return {
      message: `Google Sheet (${tabsLabel}) aggiornato · ${outcome.updatedCellsCount} ${cellWord}.`,
      tone: 'success',
    };
  }
  return null;
}
