import {
  Absence,
  AbsenceType,
  areSameTechnicianEmails,
  AssignmentStatus,
  DEFAULT_OPERATOR_COLOR_LABELS,
  DEFAULT_TASK_COLOR_ID,
  isNonAbsenceEntryType,
  StaffMember,
  TASK_COLOR_IDS,
  Task,
  TaskColorId,
  TaskStatus,
} from '../types/domain';
import { formatDateIt, formatTimeIt } from './exportUtils';

/**
 * Returns local midnight (00:00:00.000) timestamp in ms for the given epoch ms.
 */
export function startOfLocalDayMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/**
 * Adds calendar days safely across DST boundaries starting from a local timestamp.
 */
export function addLocalDaysMs(ms: number, days: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    0,
    0,
    0,
    0
  ).getTime();
}

/**
 * Computes the ISO-8601 week number (1..53, Monday as first day of week).
 */
export function getIsoWeekNumber(input: Date | number): number {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  const utc = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Formats an Italian ISO week label (e.g. "Sett. 44" or "Sett. 40–44") for a visible date span.
 */
export function formatCalendarWeekBadgeIt(dates: Array<Date | number>): string {
  if (!dates || dates.length === 0) {
    return `Sett. ${String(getIsoWeekNumber(Date.now())).padStart(2, '0')}`;
  }
  const firstWeek = getIsoWeekNumber(dates[0]);
  const lastWeek = getIsoWeekNumber(dates[dates.length - 1]);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (firstWeek === lastWeek) {
    return `Sett. ${pad(firstWeek)}`;
  }
  return `Sett. ${pad(firstWeek)}–${pad(lastWeek)}`;
}

/**
 * Counts how many distinct local solar calendar days an interval [inizioMs, fineMs) touches.
 * Uses `effectiveEndMs = Math.max(inizioMs, fineMs - 1)` so intervals ending at 00:00 sharp
 * do not spill into the following calendar day.
 */
export function countTouchedSolarDays(inizioMs: number, fineMs: number): number {
  if (!Number.isFinite(inizioMs) || !Number.isFinite(fineMs)) return 1;
  const effectiveEndMs = Math.max(inizioMs, fineMs - 1);
  const s = new Date(inizioMs);
  const e = new Date(effectiveEndMs);
  const startUtcDay = Date.UTC(s.getFullYear(), s.getMonth(), s.getDate());
  const endUtcDay = Date.UTC(e.getFullYear(), e.getMonth(), e.getDate());
  return Math.max(1, Math.round((endUtcDay - startUtcDay) / 86400000) + 1);
}

/**
 * Determines whether a Task belongs in the Google Calendar-style top horizontal strip
 * directly under the day date headers rather than the vertical 00:00–24:00 hourly grid:
 * - Tasks touching >= 3 solar days (e.g. Mon 09:00 -> Wed 17:00)
 * - Marginal tasks flagged as "Lavorazione altro AT" (`altroReparto === true`)
 * Overnight shifts touching only 2 solar days (e.g. 22:00 -> 06:00) return false and stay vertical.
 */
export function isTopStripTask(task: Pick<Task, 'inizioMs' | 'fineMs' | 'altroReparto'>): boolean {
  if (task.altroReparto) return true;
  return countTouchedSolarDays(task.inizioMs, task.fineMs) >= 3;
}

/**
 * Determines whether an Absence belongs in the top horizontal strip (`allDay` or `>= 3` solar days)
 * vs on the vertical hourly grid (short hourly `Permesso` / `Malattia` on 1–2 days).
 */
export function isTopStripAbsence(
  absence: Pick<Absence, 'inizioMs' | 'fineMs' | 'allDay'>
): boolean {
  if (absence.allDay) return true;
  return countTouchedSolarDays(absence.inizioMs, absence.fineMs) >= 3;
}

export interface HorizontalStripItem<T = Task | Absence> {
  id: string;
  kind: 'task' | 'absence';
  inizioMs: number;
  fineMs: number;
  payload: T;
}

export interface PackedStripSpan<T = Task | Absence> {
  item: HorizontalStripItem<T>;
  startCol: number; // inclusive index in visibleDayStartsMs
  endCol: number; // inclusive index in visibleDayStartsMs
  lane: number; // 0-indexed row in top strip
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Packs multi-day tasks, "Lavorazione altro AT" tasks, and all-day absences into compact
 * non-overlapping horizontal lanes across the visible calendar day columns (`visibleDayStartsMs`).
 */
export function packHorizontalStripSpans<T>(
  items: HorizontalStripItem<T>[],
  visibleDayStartsMs: number[]
): { spans: PackedStripSpan<T>[]; laneCount: number } {
  if (visibleDayStartsMs.length === 0 || items.length === 0) {
    return { spans: [], laneCount: 0 };
  }

  const colCount = visibleDayStartsMs.length;
  const firstWindowStart = visibleDayStartsMs[0];
  const lastWindowEnd = addLocalDaysMs(visibleDayStartsMs[colCount - 1], 1);

  const rawSpans: Omit<PackedStripSpan<T>, 'lane'>[] = [];

  for (const item of items) {
    const effectiveEndMs = Math.max(item.inizioMs, item.fineMs - 1);
    if (effectiveEndMs < firstWindowStart || item.inizioMs >= lastWindowEnd) {
      continue;
    }

    let startCol = -1;
    let endCol = -1;

    for (let c = 0; c < colCount; c++) {
      const colStart = visibleDayStartsMs[c];
      const colEnd = addLocalDaysMs(colStart, 1);
      if (item.inizioMs < colEnd && effectiveEndMs >= colStart) {
        if (startCol === -1) startCol = c;
        endCol = c;
      }
    }

    if (startCol === -1 || endCol === -1) continue;

    rawSpans.push({
      item,
      startCol,
      endCol,
      continuesBefore: item.inizioMs < firstWindowStart,
      continuesAfter: effectiveEndMs >= lastWindowEnd,
    });
  }

  rawSpans.sort((a, b) => {
    if (a.startCol !== b.startCol) return a.startCol - b.startCol;
    const spanA = a.endCol - a.startCol;
    const spanB = b.endCol - b.startCol;
    if (spanB !== spanA) return spanB - spanA;
    if (a.item.kind !== b.item.kind) {
      return a.item.kind === 'absence' ? -1 : 1;
    }
    return a.item.inizioMs - b.item.inizioMs;
  });

  const laneLastEndCol: number[] = [];
  const packed: PackedStripSpan<T>[] = [];

  for (const span of rawSpans) {
    let assignedLane = -1;
    for (let l = 0; l < laneLastEndCol.length; l++) {
      if (laneLastEndCol[l] < span.startCol) {
        assignedLane = l;
        laneLastEndCol[l] = span.endCol;
        break;
      }
    }
    if (assignedLane === -1) {
      assignedLane = laneLastEndCol.length;
      laneLastEndCol.push(span.endCol);
    }
    packed.push({ ...span, lane: assignedLane });
  }

  return {
    spans: packed,
    laneCount: laneLastEndCol.length,
  };
}

/**
 * Returns all absences for a given technician email that overlap `[inizioMs, fineMs)`.
 */
export function findOverlappingAbsencesForTech(
  absences: Absence[],
  technicianEmail: string,
  inizioMs: number,
  fineMs: number,
  directory?: StaffMember[]
): Absence[] {
  const cleanEmail = technicianEmail.trim().toLowerCase();
  if (!cleanEmail || !Number.isFinite(inizioMs) || !Number.isFinite(fineMs)) {
    return [];
  }
  return absences.filter(
    (abs) =>
      areSameTechnicianEmails(abs.technicianEmail, cleanEmail, directory) &&
      abs.inizioMs < fineMs &&
      abs.fineMs > inizioMs
  );
}

/**
 * Formats a clean unboxed commessa label for tasks, handling `altroReparto` and `pendingAdminReview`.
 */
export function formatTaskCommessaLabel(
  task: Pick<Task, 'commessa' | 'altroReparto' | 'pendingAdminReview'>
): string {
  const clean = (task.commessa || '').trim();
  if (task.altroReparto) {
    return clean ? `Altro AT · ${clean}` : 'Altro AT';
  }
  if (task.pendingAdminReview && !clean) {
    return 'Da revisionare';
  }
  return clean || 'Senza commessa';
}

export function formatAbsenceDateSummary(absence: Absence): string {
  if (absence.allDay) {
    const effectiveEndMs = Math.max(absence.inizioMs, absence.fineMs - 1);
    const days = countTouchedSolarDays(absence.inizioMs, absence.fineMs);
    if (days <= 1) {
      return `${formatDateIt(absence.inizioMs)} · Tutto il giorno`;
    }
    return `${formatDateIt(absence.inizioMs)} – ${formatDateIt(effectiveEndMs)} (${days}g)`;
  }
  const sameDay =
    startOfLocalDayMs(absence.inizioMs) ===
    startOfLocalDayMs(Math.max(absence.inizioMs, absence.fineMs - 1));
  if (sameDay) {
    return `${formatDateIt(absence.inizioMs)} · ${formatTimeIt(
      absence.inizioMs
    )}–${formatTimeIt(absence.fineMs)}`;
  }
  return `${formatDateIt(absence.inizioMs)} ${formatTimeIt(
    absence.inizioMs
  )} – ${formatDateIt(absence.fineMs)} ${formatTimeIt(absence.fineMs)}`;
}

export function formatAbsenceCalendarLabel(
  absence: Pick<Absence, 'tipo' | 'technicianName'>,
  options?: {
    shortTechName?: string;
    prefixAssenza?: boolean;
  }
): string {
  const isCommitment = isNonAbsenceEntryType(absence.tipo);
  if (options?.shortTechName) {
    if (isCommitment) {
      return `${options.shortTechName} · ${absence.tipo}`;
    }
    return options.prefixAssenza
      ? `Assenza · ${options.shortTechName} — ${absence.tipo}`
      : `${options.shortTechName} · ${absence.tipo}`;
  }
  if (isCommitment) {
    return absence.tipo;
  }
  return options?.prefixAssenza === false
    ? absence.tipo
    : `Assenza · ${absence.tipo}`;
}

export function getAbsenceToneClasses(tipo: AbsenceType): {
  bar: string;
  block: string;
  text: string;
} {
  if (tipo === 'Visita Medica') {
    return {
      bar: 'bg-sky-50/95 hover:bg-sky-100 border-sky-300 text-sky-950',
      block: 'bg-sky-50/95 hover:bg-sky-100 border-sky-300 text-sky-950',
      text: 'text-sky-800',
    };
  }
  if (tipo === 'Assemblea Sindacale') {
    return {
      bar: 'bg-violet-50/95 hover:bg-violet-100 border-violet-300 text-violet-950',
      block: 'bg-violet-50/95 hover:bg-violet-100 border-violet-300 text-violet-950',
      text: 'text-violet-800',
    };
  }
  return {
    bar: 'bg-slate-100/95 hover:bg-slate-200/95 border-slate-300 text-slate-900',
    block: 'bg-slate-100/95 hover:bg-slate-200/95 border-slate-300 text-slate-900',
    text: 'text-slate-700',
  };
}

export interface VerticalOverlapSlotInput<T = unknown> {
  id: string;
  startMin: number;
  endMin: number;
  priority: number; // 0 = operative task/assignment (foreground), 1 = absence/commitment (background lane)
  payload: T;
}

export interface PositionedVerticalOverlapSlot<T = unknown> {
  id: string;
  startMin: number;
  endMin: number;
  colIndex: number;
  totalCols: number;
  colSpan: number;
  priority: number;
  payload: T;
}

/**
 * Unified Google Calendar-style vertical column packing for tasks and hourly absences/commitments.
 * Ensures multiple overlapping absences OR absences overlapping operative tasks each receive an
 * accessible, visible, clickable lane (never buried 100% underneath each other).
 */
export function layoutOverlappingVerticalSlots<T>(
  rawItems: VerticalOverlapSlotInput<T>[]
): PositionedVerticalOverlapSlot<T>[] {
  if (rawItems.length === 0) return [];

  const items = [...rawItems].sort(
    (a, b) =>
      a.startMin - b.startMin ||
      a.priority - b.priority ||
      b.endMin - a.endMin ||
      a.id.localeCompare(b.id)
  );

  const results: PositionedVerticalOverlapSlot<T>[] = [];
  let cluster: VerticalOverlapSlotInput<T>[] = [];
  let clusterMaxEnd = -1;

  const flushCluster = (group: VerticalOverlapSlotInput<T>[]) => {
    if (group.length === 0) return;
    const colEnds: number[] = [];
    const assignedCols: number[] = [];

    for (const item of group) {
      let placedCol = -1;
      for (let c = 0; c < colEnds.length; c++) {
        if (colEnds[c] <= item.startMin) {
          placedCol = c;
          colEnds[c] = item.endMin;
          break;
        }
      }
      if (placedCol === -1) {
        placedCol = colEnds.length;
        colEnds.push(item.endMin);
      }
      assignedCols.push(placedCol);
    }

    const totalCols = Math.max(1, colEnds.length);
    group.forEach((item, idx) => {
      const itemCol = assignedCols[idx];

      const overlappingCols = new Set<number>();
      group.forEach((other, oIdx) => {
        if (oIdx !== idx) {
          const overlapsInTime =
            Math.max(item.startMin, other.startMin) <
            Math.min(item.endMin, other.endMin);
          if (overlapsInTime) {
            overlappingCols.add(assignedCols[oIdx]);
          }
        }
      });

      let colSpan = 1;
      for (let c = itemCol + 1; c < totalCols; c++) {
        if (overlappingCols.has(c)) {
          break;
        }
        colSpan += 1;
      }

      results.push({
        id: item.id,
        startMin: item.startMin,
        endMin: item.endMin,
        colIndex: itemCol,
        totalCols,
        colSpan,
        priority: item.priority,
        payload: item.payload,
      });
    });
  };

  for (const item of items) {
    if (cluster.length === 0 || item.startMin < clusterMaxEnd) {
      cluster.push(item);
      clusterMaxEnd = Math.max(clusterMaxEnd, item.endMin);
    } else {
      flushCluster(cluster);
      cluster = [item];
      clusterMaxEnd = item.endMin;
    }
  }
  flushCluster(cluster);

  return results;
}

export interface TaskColorPaletteEntry {
  id: TaskColorId;
  colorNameIt: string;
  themeClass: string;
  filledUsesLightText: boolean;
}

export const TASK_COLOR_PALETTE: Record<TaskColorId, TaskColorPaletteEntry> = {
  peacock: {
    id: 'peacock',
    colorNameIt: 'Pavone',
    themeClass: 'gcal-theme-peacock',
    filledUsesLightText: true,
  },
  cobalt: {
    id: 'cobalt',
    colorNameIt: 'Cobalto',
    themeClass: 'gcal-theme-cobalt',
    filledUsesLightText: true,
  },
  banana: {
    id: 'banana',
    colorNameIt: 'Banana',
    themeClass: 'gcal-theme-banana',
    filledUsesLightText: false,
  },
  tomato: {
    id: 'tomato',
    colorNameIt: 'Pomodoro',
    themeClass: 'gcal-theme-tomato',
    filledUsesLightText: true,
  },
  basil: {
    id: 'basil',
    colorNameIt: 'Basilico',
    themeClass: 'gcal-theme-basil',
    filledUsesLightText: true,
  },
  grape: {
    id: 'grape',
    colorNameIt: 'Uva',
    themeClass: 'gcal-theme-grape',
    filledUsesLightText: true,
  },
  flamingo: {
    id: 'flamingo',
    colorNameIt: 'Fenicottero',
    themeClass: 'gcal-theme-flamingo',
    filledUsesLightText: true,
  },
  tangerine: {
    id: 'tangerine',
    colorNameIt: 'Mandarino',
    themeClass: 'gcal-theme-tangerine',
    filledUsesLightText: true,
  },
  sage: {
    id: 'sage',
    colorNameIt: 'Salvia',
    themeClass: 'gcal-theme-sage',
    filledUsesLightText: true,
  },
  lavender: {
    id: 'lavender',
    colorNameIt: 'Lavanda',
    themeClass: 'gcal-theme-lavender',
    filledUsesLightText: true,
  },
  graphite: {
    id: 'graphite',
    colorNameIt: 'Grafite',
    themeClass: 'gcal-theme-graphite',
    filledUsesLightText: true,
  },
};

export function isValidTaskColorId(val: unknown): val is TaskColorId {
  return typeof val === 'string' && (TASK_COLOR_IDS as readonly string[]).includes(val);
}

export function resolveTaskColorId(
  task?: Pick<Task, 'colorId' | 'altroReparto'> | null,
  fallbackColorId?: TaskColorId | null
): TaskColorId {
  if (task?.colorId && isValidTaskColorId(task.colorId)) {
    return task.colorId;
  }
  if (fallbackColorId && isValidTaskColorId(fallbackColorId)) {
    return fallbackColorId;
  }
  if (task?.altroReparto) {
    return 'lavender';
  }
  return DEFAULT_TASK_COLOR_ID;
}

export function getOperatorColorLabel(
  colorId: TaskColorId,
  customLabels?: Partial<Record<TaskColorId, string>> | null
): string {
  const custom = customLabels?.[colorId]?.trim();
  if (custom) return custom;
  return DEFAULT_OPERATOR_COLOR_LABELS[colorId] || TASK_COLOR_PALETTE[colorId].colorNameIt;
}

export interface TaskEventVisualStyle {
  colorId: TaskColorId;
  operatorLabel: string;
  colorNameIt: string;
  cardClassName: string;
  swatchClassName: string;
  subtleMetaClassName: string;
  usesLightText: boolean;
  isCompleted: boolean;
  isUnassigned: boolean;
}

/**
 * Computes Google Calendar-style visual classes combining:
 * 1. Operator Hue (`task.colorId` or `fallbackColorId` replicated onto Assignment)
 * 2. Task / Assignment Status Motif:
 *    - `Non Assegnato`: light surface + `2px dashed` operator border ("Unanswered" + unassigned)
 *    - `Assegnato`: light surface + `2px solid` operator border (Google Calendar "Unanswered")
 *    - `Preso in Carico`: solid operator fill + high-contrast text (Google Calendar "Sì")
 *    - `Completato`: 135° diagonal stripes in operator hue + high-contrast bold text (Google Calendar "Forse")
 */
export function getTaskEventVisualStyle(
  task: Pick<Task, 'colorId' | 'statoPrevalente' | 'altroReparto' | 'pendingAdminReview'> | null | undefined,
  options?: {
    statusOverride?: TaskStatus | AssignmentStatus;
    operatorColorLabels?: Partial<Record<TaskColorId, string>> | null;
    fallbackColorId?: TaskColorId | null;
  }
): TaskEventVisualStyle {
  const colorId = resolveTaskColorId(task, options?.fallbackColorId);
  const entry = TASK_COLOR_PALETTE[colorId];
  const operatorLabel = getOperatorColorLabel(colorId, options?.operatorColorLabels);
  const effectiveStatus = options?.statusOverride || task?.statoPrevalente || 'Assegnato';

  if (effectiveStatus === 'Completato') {
    const usesLightText = entry.filledUsesLightText;
    return {
      colorId,
      operatorLabel,
      colorNameIt: entry.colorNameIt,
      cardClassName: `${entry.themeClass} gcal-motif-striped border`,
      swatchClassName: `${entry.themeClass} gcal-swatch-fill`,
      subtleMetaClassName: usesLightText ? 'text-white/90' : 'text-slate-900/80',
      usesLightText,
      isCompleted: true,
      isUnassigned: false,
    };
  }

  if (effectiveStatus === 'Preso in Carico') {
    const usesLightText = entry.filledUsesLightText;
    return {
      colorId,
      operatorLabel,
      colorNameIt: entry.colorNameIt,
      cardClassName: `${entry.themeClass} gcal-motif-solid border`,
      swatchClassName: `${entry.themeClass} gcal-swatch-fill`,
      subtleMetaClassName: usesLightText ? 'text-white/90' : 'text-slate-900/80',
      usesLightText,
      isCompleted: false,
      isUnassigned: false,
    };
  }

  const isUnassigned = effectiveStatus === 'Non Assegnato';
  const borderStyle = isUnassigned ? 'border-2 border-dashed' : 'border-2 border-solid';

  return {
    colorId,
    operatorLabel,
    colorNameIt: entry.colorNameIt,
    cardClassName: `${entry.themeClass} gcal-motif-outline ${borderStyle}`,
    swatchClassName: `${entry.themeClass} gcal-swatch-fill`,
    subtleMetaClassName: 'opacity-85',
    usesLightText: false,
    isCompleted: false,
    isUnassigned,
  };
}
