import {
  Absence,
  areSameTechnicianEmails,
  Assignment,
  AssignmentStatus,
  canonicalTechnicianKey,
  findStaffMemberByAnyEmail,
  StaffMember,
  Task,
} from '../types/domain';
import {
  addLocalDaysMs,
  layoutOverlappingVerticalSlots,
  VerticalOverlapSlotInput,
} from './calendarLayout';

export function isSameDay(a: Date | number, b: Date | number): boolean {
  const da = typeof a === 'number' ? new Date(a) : a;
  const db = typeof b === 'number' ? new Date(b) : b;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function startOfDayMs(d: Date | number): number {
  const dt = typeof d === 'number' ? new Date(d) : d;
  return new Date(
    dt.getFullYear(),
    dt.getMonth(),
    dt.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
}

export function getStartOfWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

export function getMonthCalendarDays(anchorDate: Date): Date[] {
  const firstOfMonth = new Date(
    anchorDate.getFullYear(),
    anchorDate.getMonth(),
    1,
    0,
    0,
    0,
    0
  );
  const gridStart = getStartOfWeek(firstOfMonth);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(addLocalDaysMs(gridStart.getTime(), i)));
  }
  return days;
}

export function assignmentOccursOnDay(
  asg: Pick<Assignment, 'inizioMs' | 'fineMs'>,
  dayStartMs: number
): boolean {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  const effectiveEndMs = Math.max(asg.inizioMs, asg.fineMs - 1);
  return asg.inizioMs < dayEndMs && effectiveEndMs >= dayStartMs;
}

export function formatMinutesAsHHMM(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, Math.round(totalMinutes)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function toLocalDateTimeInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export interface PositionedAssignment {
  asg: Assignment;
  topPx: number;
  heightPx: number;
  colIndex: number;
  totalCols: number;
  colSpan: number;
  startsBeforeDay: boolean;
  endsAfterDay: boolean;
  clippedStartMinutes: number;
  clippedEndMinutes: number;
}

export function layoutOverlappingAssignments(
  dayAssignments: Assignment[],
  dayStartMs: number,
  hourHeightPx: number,
  minHeightPx = 32
): PositionedAssignment[] {
  if (dayAssignments.length === 0) return [];
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);

  interface RawSlot {
    asg: Assignment;
    startsBeforeDay: boolean;
    endsAfterDay: boolean;
    startMin: number;
    endMin: number;
  }

  const rawSlots: RawSlot[] = dayAssignments
    .map((asg) => {
      const startsBeforeDay = asg.inizioMs < dayStartMs;
      const endsAfterDay = asg.fineMs > dayEndMs;

      const clippedStartMs = Math.max(dayStartMs, asg.inizioMs);
      const clippedEndMs = Math.min(dayEndMs, Math.max(asg.inizioMs + 1800000, asg.fineMs));

      const sDate = new Date(clippedStartMs);
      const startMin = startsBeforeDay
        ? 0
        : sDate.getHours() * 60 + sDate.getMinutes();

      let endMin = 24 * 60;
      if (!endsAfterDay) {
        const eDate = new Date(clippedEndMs);
        const rawEnd = eDate.getHours() * 60 + eDate.getMinutes();
        endMin =
          clippedEndMs >= dayEndMs && rawEnd === 0
            ? 24 * 60
            : Math.max(startMin + 30, rawEnd);
      }

      return {
        asg,
        startsBeforeDay,
        endsAfterDay,
        startMin,
        endMin: Math.min(24 * 60, Math.max(startMin + 30, endMin)),
      };
    })
    .sort((a, b) => {
      if (a.startMin !== b.startMin) return a.startMin - b.startMin;
      return b.endMin - a.endMin;
    });

  // Group into connected overlap clusters so totalCols applies cleanly per cluster
  const results: PositionedAssignment[] = [];
  let cluster: RawSlot[] = [];
  let clusterMaxEnd = -1;

  const flushCluster = (items: RawSlot[]) => {
    if (items.length === 0) return;
    const colEndMinutes: number[] = [];
    const assignedCols: number[] = [];

    for (const item of items) {
      let col = -1;
      for (let c = 0; c < colEndMinutes.length; c++) {
        if (colEndMinutes[c] <= item.startMin) {
          col = c;
          colEndMinutes[c] = item.endMin;
          break;
        }
      }
      if (col === -1) {
        col = colEndMinutes.length;
        colEndMinutes.push(item.endMin);
      }
      assignedCols.push(col);
    }

    const totalCols = Math.max(1, colEndMinutes.length);
    items.forEach((item, idx) => {
      const itemCol = assignedCols[idx];

      // Find all columns occupied by OTHER assignments in this cluster that overlap in time
      const overlappingCols = new Set<number>();
      items.forEach((other, oIdx) => {
        if (oIdx !== idx) {
          const overlapsInTime =
            Math.max(item.startMin, other.startMin) <
            Math.min(item.endMin, other.endMin);
          if (overlapsInTime) {
            overlappingCols.add(assignedCols[oIdx]);
          }
        }
      });

      // Expand column span to the right across any unoccupied columns in this time range
      let colSpan = 1;
      for (let c = itemCol + 1; c < totalCols; c++) {
        if (overlappingCols.has(c)) {
          break;
        }
        colSpan += 1;
      }

      const topPx = (item.startMin / 60) * hourHeightPx;
      const rawHeight = ((item.endMin - item.startMin) / 60) * hourHeightPx;
      results.push({
        asg: item.asg,
        topPx,
        heightPx: Math.max(minHeightPx, rawHeight),
        colIndex: itemCol,
        totalCols,
        colSpan,
        startsBeforeDay: item.startsBeforeDay,
        endsAfterDay: item.endsAfterDay,
        clippedStartMinutes: item.startMin,
        clippedEndMinutes: item.endMin,
      });
    });
  };

  for (const slot of rawSlots) {
    if (cluster.length === 0) {
      cluster = [slot];
      clusterMaxEnd = slot.endMin;
    } else if (slot.startMin < clusterMaxEnd) {
      cluster.push(slot);
      clusterMaxEnd = Math.max(clusterMaxEnd, slot.endMin);
    } else {
      flushCluster(cluster);
      cluster = [slot];
      clusterMaxEnd = slot.endMin;
    }
  }
  flushCluster(cluster);

  return results;
}

export interface PositionedTechHourlyAbsence {
  absence: Absence;
  topPx: number;
  heightPx: number;
  colIndex: number;
  totalCols: number;
  colSpan: number;
  clippedStartMinutes: number;
  clippedEndMinutes: number;
}

export function layoutOverlappingAssignmentsAndAbsences(params: {
  dayAssignments: Assignment[];
  dayHourlyAbsences: Absence[];
  dayStartMs: number;
  hourHeightPx: number;
  minTaskHeightPx?: number;
  minAbsenceHeightPx?: number;
}): {
  positionedAssignments: PositionedAssignment[];
  positionedAbsences: PositionedTechHourlyAbsence[];
} {
  const {
    dayAssignments,
    dayHourlyAbsences,
    dayStartMs,
    hourHeightPx,
    minTaskHeightPx = 32,
    minAbsenceHeightPx = 26,
  } = params;
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);

  type UnifiedTechSlotPayload =
    | {
        kind: 'asg';
        asg: Assignment;
        startsBeforeDay: boolean;
        endsAfterDay: boolean;
      }
    | {
        kind: 'abs';
        absence: Absence;
      };

  const inputs: VerticalOverlapSlotInput<UnifiedTechSlotPayload>[] = [];

  for (const asg of dayAssignments) {
    const startsBeforeDay = asg.inizioMs < dayStartMs;
    const endsAfterDay = asg.fineMs > dayEndMs;

    const clippedStartMs = Math.max(dayStartMs, asg.inizioMs);
    const clippedEndMs = Math.min(
      dayEndMs,
      Math.max(asg.inizioMs + 1800000, asg.fineMs)
    );

    const sDate = new Date(clippedStartMs);
    const startMin = startsBeforeDay
      ? 0
      : sDate.getHours() * 60 + sDate.getMinutes();

    let endMin = 24 * 60;
    if (!endsAfterDay) {
      const eDate = new Date(clippedEndMs);
      const rawEnd = eDate.getHours() * 60 + eDate.getMinutes();
      endMin =
        clippedEndMs >= dayEndMs && rawEnd === 0
          ? 24 * 60
          : Math.max(startMin + 30, rawEnd);
    }

    inputs.push({
      id: `asg_${asg.assignmentId}`,
      startMin,
      endMin: Math.min(24 * 60, Math.max(startMin + 30, endMin)),
      priority: 0,
      payload: {
        kind: 'asg',
        asg,
        startsBeforeDay,
        endsAfterDay,
      },
    });
  }

  for (const absence of dayHourlyAbsences) {
    const clippedStartMs = Math.max(dayStartMs, absence.inizioMs);
    const clippedEndMs = Math.min(dayEndMs, absence.fineMs);
    const sDate = new Date(clippedStartMs);
    const startMin =
      absence.inizioMs < dayStartMs
        ? 0
        : sDate.getHours() * 60 + sDate.getMinutes();
    const eDate = new Date(clippedEndMs);
    const rawEnd =
      clippedEndMs >= dayEndMs
        ? 24 * 60
        : eDate.getHours() * 60 + eDate.getMinutes();
    const endMin = Math.min(24 * 60, Math.max(startMin + 30, rawEnd));

    inputs.push({
      id: `abs_${absence.absenceId}`,
      startMin,
      endMin,
      priority: 1,
      payload: {
        kind: 'abs',
        absence,
      },
    });
  }

  const packed = layoutOverlappingVerticalSlots(inputs);
  const positionedAssignments: PositionedAssignment[] = [];
  const positionedAbsences: PositionedTechHourlyAbsence[] = [];

  for (const slot of packed) {
    const topPx = (slot.startMin / 60) * hourHeightPx;
    const rawHeight = ((slot.endMin - slot.startMin) / 60) * hourHeightPx;

    if (slot.payload.kind === 'asg') {
      positionedAssignments.push({
        asg: slot.payload.asg,
        topPx,
        heightPx: Math.max(minTaskHeightPx, rawHeight),
        colIndex: slot.colIndex,
        totalCols: slot.totalCols,
        colSpan: slot.colSpan,
        startsBeforeDay: slot.payload.startsBeforeDay,
        endsAfterDay: slot.payload.endsAfterDay,
        clippedStartMinutes: slot.startMin,
        clippedEndMinutes: slot.endMin,
      });
    } else {
      positionedAbsences.push({
        absence: slot.payload.absence,
        topPx,
        heightPx: Math.max(minAbsenceHeightPx, rawHeight),
        colIndex: slot.colIndex,
        totalCols: slot.totalCols,
        colSpan: slot.colSpan,
        clippedStartMinutes: slot.startMin,
        clippedEndMinutes: slot.endMin,
      });
    }
  }

  return { positionedAssignments, positionedAbsences };
}

export interface SquadMemberInfo {
  email: string;
  name: string;
  status: AssignmentStatus;
  isViewer: boolean;
  assignmentId?: string;
}

export interface ResolvedSquadDetails {
  members: SquadMemberInfo[];
  colleagueNames: string[];
  allNames: string[];
  completedCount: number;
  totalCount: number;
  sharedCalendarStatus: AssignmentStatus;
}

export function resolveSquadDetailsForAssignment(params: {
  asg: Assignment;
  tasksById: Map<string, Task>;
  assignmentsByTaskId: Map<string, Assignment[]>;
  directoryByEmail: Map<string, StaffMember>;
  directory?: StaffMember[];
  viewerEmail?: string;
}): ResolvedSquadDetails {
  const { asg, tasksById, assignmentsByTaskId, directoryByEmail } = params;
  const dirList =
    params.directory || Array.from(new Set(directoryByEmail.values()));
  const cleanViewer = (params.viewerEmail || asg.technicianEmail || '')
    .trim()
    .toLowerCase();

  const parentTask = tasksById.get(asg.taskId);
  const siblings = (assignmentsByTaskId.get(asg.taskId) || []).filter(
    (s) => s.stato !== 'Annullato'
  );

  const byCanon = new Map<string, SquadMemberInfo>();

  const isViewerEmail = (email: string): boolean =>
    Boolean(cleanViewer && areSameTechnicianEmails(email, cleanViewer, dirList));

  const pickBestName = (email: string, candidate?: string): string => {
    const dir =
      directoryByEmail.get(email) || findStaffMemberByAnyEmail(email, dirList);
    if (dir) {
      const full = `${dir.nome} ${dir.cognome}`.trim();
      if (full) return full;
    }
    const cleanCand = (candidate || '').trim();
    if (cleanCand && !cleanCand.includes('@')) {
      return cleanCand;
    }
    return cleanCand || email;
  };

  const extractUpdatedMs = (raw: unknown): number => {
    if (!raw || typeof raw !== 'object') return 0;
    const maybe = raw as { toMillis?: () => number; seconds?: number };
    if (typeof maybe.toMillis === 'function') return maybe.toMillis();
    if (typeof maybe.seconds === 'number') return maybe.seconds * 1000;
    return 0;
  };

  const sibUpdatedAtByCanon = new Map<string, number>();
  for (const sib of siblings) {
    if (sib.stato === 'Annullato') continue;
    const em = sib.technicianEmail.trim().toLowerCase();
    const canon = canonicalTechnicianKey(em, dirList);
    if (!em || !canon) continue;
    const updMs = extractUpdatedMs(sib.updatedAt);
    const prevMs = sibUpdatedAtByCanon.get(canon) ?? -1;
    if (updMs >= prevMs) {
      sibUpdatedAtByCanon.set(canon, updMs);
      byCanon.set(canon, {
        email: em,
        name: pickBestName(em, sib.technicianName),
        status: sib.stato,
        isViewer: isViewerEmail(em),
        assignmentId: sib.assignmentId,
      });
    }
  }

  const selfEmail = asg.technicianEmail.trim().toLowerCase();
  const selfCanon = canonicalTechnicianKey(selfEmail, dirList);
  if (selfEmail && selfCanon && !byCanon.has(selfCanon) && asg.stato !== 'Annullato') {
    byCanon.set(selfCanon, {
      email: selfEmail,
      name: pickBestName(selfEmail, asg.technicianName),
      status: asg.stato,
      isViewer: isViewerEmail(selfEmail),
      assignmentId: asg.assignmentId,
    });
  }

  if (parentTask) {
    const maxLen = Math.max(
      parentTask.assignedEmails.length,
      parentTask.assignedNames.length
    );
    for (let i = 0; i < maxLen; i++) {
      const em = (parentTask.assignedEmails[i] || '').trim().toLowerCase();
      const nm = parentTask.assignedNames[i];
      const canon = canonicalTechnicianKey(em, dirList);
      if (!em || !canon) continue;
      const rawTaskStatus = parentTask.assignedStatuses?.[i];
      const hasExplicitSlotStatus =
        rawTaskStatus === 'Assegnato' ||
        rawTaskStatus === 'Preso in Carico' ||
        rawTaskStatus === 'Completato' ||
        rawTaskStatus === 'Annullato';
      const validTaskStatus: AssignmentStatus = hasExplicitSlotStatus
        ? rawTaskStatus
        : parentTask.statoPrevalente === 'Completato'
        ? 'Completato'
        : 'Assegnato';
      const existing = byCanon.get(canon);
      if (!existing) {
        byCanon.set(canon, {
          email: em,
          name: pickBestName(em, nm),
          status: validTaskStatus,
          isViewer: isViewerEmail(em),
        });
      } else {
        if ((existing.name === existing.email || existing.name.includes('@')) && nm) {
          existing.name = pickBestName(em, nm);
        }
        existing.isViewer = existing.isViewer || isViewerEmail(em);
        // Live Assignment document (`existing.assignmentId`) is unconditionally authoritative
        if (!existing.assignmentId) {
          existing.status = validTaskStatus;
        }
      }
    }
  }

  // Only fall back to `asg.squadEmails` when `parentTask` is absent AND `squadEmails` is 1:1 with `squadNames`
  const sqEmails = asg.squadEmails || [];
  const sqNames = asg.squadNames || [];
  if (!parentTask && sqEmails.length > 0 && sqEmails.length === sqNames.length) {
    for (let i = 0; i < sqEmails.length; i++) {
      const em = (sqEmails[i] || '').trim().toLowerCase();
      const nm = sqNames[i];
      const canon = canonicalTechnicianKey(em, dirList);
      if (!em || !canon) continue;
      const existing = byCanon.get(canon);
      if (!existing) {
        byCanon.set(canon, {
          email: em,
          name: pickBestName(em, nm),
          status: 'Assegnato',
          isViewer: isViewerEmail(em),
        });
      } else if ((existing.name === existing.email || existing.name.includes('@')) && nm) {
        existing.name = pickBestName(em, nm);
      }
    }
  }

  const members = Array.from(byCanon.values()).sort((a, b) => {
    if (a.isViewer !== b.isViewer) return a.isViewer ? -1 : 1;
    return a.name.localeCompare(b.name, 'it');
  });

  const allNames = members.map((m) => m.name);
  const colleagueNames = members
    .filter((m) => !m.isViewer)
    .map((m) => m.name);
  const completedCount = members.filter((m) => m.status === 'Completato').length;
  const totalCount = members.length;

  const sharedCalendarStatus: AssignmentStatus =
    totalCount > 0
      ? completedCount === totalCount
        ? 'Completato'
        : members.some(
            (m) => m.status === 'Preso in Carico' || m.status === 'Completato'
          )
        ? 'Preso in Carico'
        : 'Assegnato'
      : parentTask?.statoPrevalente === 'Completato'
      ? 'Completato'
      : parentTask?.statoPrevalente === 'Preso in Carico'
      ? 'Preso in Carico'
      : 'Assegnato';

  return {
    members,
    colleagueNames,
    allNames: allNames.length > 0 ? allNames : [asg.technicianName],
    completedCount,
    totalCount,
    sharedCalendarStatus,
  };
}

export function getWeekdayShortIt(date: Date): string {
  const map = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  return map[date.getDay()] || '';
}
