import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarOff,
  Headphones,
  PhoneCall,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileSpreadsheet,
  GripVertical,
  Image as ImageIcon,
  List,
  Mail,
  PackagePlus,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  addUsedMaterialToAssignment,
  adminUpdateEntireTaskStatus,
  deleteTaskCascade,
  recordInterventionPhoto,
  removeInterventionPhoto,
  removeUsedMaterial,
  saveTaskAndAssignments,
  SelectedAssignee,
  updateAssignmentStatusAndNotes,
  updateTaskColorId,
} from '../../lib/firestoreService';
import {
  BatchPhotoUploadProgress,
  buildTaskCompletionEmailSummary,
  formatTaskDriveSubfolderName,
  uploadMultipleInterventionPhotosToDrive,
} from '../../lib/workspaceApi';
import {
  exportTasksSummaryCsv,
  formatCalendarEventTitle,
  formatCompactTechNames,
  formatDateIt,
  formatDateTimeIt,
  formatTimeIt,
} from '../../lib/exportUtils';
import {
  addLocalDaysMs,
  findOverlappingAbsencesForTech,
  formatAbsenceCalendarLabel,
  formatAbsenceDateSummary,
  formatCalendarWeekBadgeIt,
  formatTaskCommessaLabel,
  getAbsenceToneClasses,
  getTaskEventVisualStyle,
  HorizontalStripItem,
  isTopStripAbsence,
  isTopStripTask,
  layoutOverlappingVerticalSlots,
  packHorizontalStripSpans,
  resolveTaskColorId,
  startOfLocalDayMs,
  VerticalOverlapSlotInput,
} from '../../lib/calendarLayout';
import {
  Absence,
  areSameTechnicianEmails,
  Assignment,
  AssignmentStatus,
  BOOTSTRAPPED_ADMIN_EMAILS,
  canonicalTechnicianKey,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_TASK_COLOR_ID,
  extractDriveFolderId,
  extractGoogleSheetId,
  findStaffMemberByAnyEmail,
  getDeliverableEmail,
  isLoginOnlyIdEmail,
  isNonAbsenceEntryType,
  OnCallGroup,
  resolveOnCallSummaryForDate,
  Task,
  TaskColorId,
  TaskStatus,
} from '../../types/domain';
import {
  collectImpactedWeekCodes,
  enumerateCoveredLocalDaysMs,
  formatIsoWeekCode,
  formatSheetSyncToastSummary,
  reconcileAbsenceMutationOnGoogleSheet,
  reconcileTaskMutationOnGoogleSheet,
  syncFullWeekToGoogleSheet,
} from '../../lib/googleSheetsSync';
import { StatusIndicator } from '../StatusIndicator';
import { ConfirmModal } from '../ConfirmModal';
import { EmailDraftConfig } from '../EmailNotificationModal';
import { MultiPhotoUploadModal } from '../MultiPhotoUploadModal';
import { AbsenceModal, AbsenceMutationSheetPayload } from '../AbsenceModal';
import {
  AdminTaskReviewModal,
  ReviewCompletedPayload,
} from '../AdminTaskReviewModal';
import { TaskColorPicker } from '../TaskColorPicker';
import { OnCallDayModal } from '../OnCallDayModal';

interface AdminCalendarTasksViewProps {
  onOpenEmailModal: (draft: EmailDraftConfig) => void;
}

type CalendarDisplayMode = 'week' | 'day' | 'month' | 'list';

interface FloatingAnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

interface DraftCreateSlot {
  colKey: string;
  dayMs: number;
}
type StatusFilterMode = 'ALL' | 'PENDING_REVIEW' | TaskStatus;
type KpiQueueFilter =
  | 'ALL'
  | 'TODAY'
  | 'PENDING_REVIEW'
  | 'UNASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED';

const HOUR_HEIGHT = 52; // Compact 52px/h -> ~18 hours visible on 1080p zero-scroll while keeping 00:00–24:00 fluid
const TOTAL_GRID_HEIGHT = 24 * HOUR_HEIGHT;
const SNAP_MINUTES = 30;
const MIN_DURATION_MINUTES = 60;
const UNASSIGNED_COL_ID = '__UNASSIGNED__';
const TECH_DRAG_MIME = 'application/x-site-tech';
const MONTH_TASK_DRAG_MIME = 'application/x-site-month-task';

interface DraggedTechPayload {
  email: string;
  fullName: string;
  linkedUid: string;
}

interface PositionedTask {
  task: Task;
  startMin: number;
  endMin: number;
  colIndex: number;
  totalCols: number;
  colSpan: number;
}

interface PositionedHourlyAbsence {
  absence: Absence;
  startMin: number;
  endMin: number;
  colIndex: number;
  totalCols: number;
  colSpan: number;
}

interface ForcedAssignmentPrompt {
  title: string;
  description: string;
  onConfirm: () => Promise<void> | void;
}

interface PendingDirectSheetPrompt {
  prevTask: Task;
  nextTask: Task;
  allTasksPostMutation: Task[];
  weekCodesLabel: string;
  summaryText: string;
}

type GridPointerState =
  | {
    kind: 'create';
    colKey: string;
    dayMs: number;
    techEmail?: string;
    anchorMin: number;
    currentMin: number;
    startY: number;
    hasDragged: boolean;
  }
  | {
    kind: 'move';
    task: Task;
    originColKey: string;
    originTechEmail?: string;
    targetColKey: string;
    targetDayMs: number;
    targetTechEmail?: string;
    durationMin: number;
    grabOffsetMin: number;
    newStartMin: number;
    startX: number;
    startY: number;
    moved: boolean;
  }
  | {
    kind: 'resize';
    task: Task;
    colKey: string;
    dayMs: number;
    startMin: number;
    newEndMin: number;
    startY: number;
    moved: boolean;
  };

function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function isSameDay(msA: number, msB: number): boolean {
  const a = new Date(msA);
  const b = new Date(msB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDayMs(msOrDate: number | Date): number {
  const d = new Date(msOrDate);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function taskOccursOnDay(task: Task, dayStartMs: number): boolean {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  const effectiveEnd = Math.max(task.fineMs, task.inizioMs + 60000);
  return task.inizioMs < dayEndMs && effectiveEnd > dayStartMs;
}

function absenceOccursOnDay(absence: Absence, dayStartMs: number): boolean {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  return absence.inizioMs < dayEndMs && absence.fineMs > dayStartMs;
}

function getStartOfWeek(d: Date): Date {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = copy.getDate() - day + (day === 0 ? -6 : 1); // Monday start
  copy.setDate(diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function getMonthCalendarDays(anchor: Date): Date[] {
  const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const lastOfMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const gridStart = getStartOfWeek(firstOfMonth);
  const endWeekStart = getStartOfWeek(lastOfMonth);
  const gridEnd = new Date(endWeekStart);
  gridEnd.setDate(endWeekStart.getDate() + 6);

  const days: Date[] = [];
  const cursor = new Date(gridStart);
  while (cursor.getTime() <= gridEnd.getTime() && days.length < 42) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function snapMinutesToStep(rawMin: number): number {
  const clamped = Math.max(0, Math.min(24 * 60, rawMin));
  return Math.round(clamped / SNAP_MINUTES) * SNAP_MINUTES;
}

function formatMinutesAsHHMM(totalMin: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, totalMin));
  if (clamped === 24 * 60) return '24:00';
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getTaskMinutesOnDay(
  task: Task,
  dayStartMs: number
): { startMin: number; endMin: number } {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  const clampedStart = Math.max(dayStartMs, task.inizioMs);
  const clampedEnd = Math.min(
    dayEndMs,
    Math.max(task.fineMs, task.inizioMs + 3600000)
  );
  const startMin = Math.max(0, Math.round((clampedStart - dayStartMs) / 60000));
  const endMin = Math.min(
    24 * 60,
    Math.max(startMin + 30, Math.round((clampedEnd - dayStartMs) / 60000))
  );
  return { startMin, endMin };
}

function layoutColumnVerticalItems(
  dayTasks: Task[],
  dayAbsences: Absence[],
  dayStartMs: number
): {
  positioned: PositionedTask[];
  positionedAbsences: PositionedHourlyAbsence[];
} {
  if (dayTasks.length === 0 && dayAbsences.length === 0) {
    return { positioned: [], positionedAbsences: [] };
  }

  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  const slots: VerticalOverlapSlotInput<
    { kind: 'task'; task: Task } | { kind: 'absence'; absence: Absence }
  >[] = [];

  for (const task of dayTasks) {
    const { startMin, endMin } = getTaskMinutesOnDay(task, dayStartMs);
    slots.push({
      id: `task_${task.taskId}`,
      startMin,
      endMin,
      priority: 0,
      payload: { kind: 'task', task },
    });
  }

  for (const absence of dayAbsences) {
    const clampedStart = Math.max(dayStartMs, absence.inizioMs);
    const clampedEnd = Math.min(
      dayEndMs,
      Math.max(absence.fineMs, absence.inizioMs + 1800000)
    );
    const startMin = Math.max(
      0,
      Math.round((clampedStart - dayStartMs) / 60000)
    );
    const endMin = Math.min(
      24 * 60,
      Math.max(startMin + 30, Math.round((clampedEnd - dayStartMs) / 60000))
    );
    slots.push({
      id: `abs_${absence.absenceId}`,
      startMin,
      endMin,
      priority: 1,
      payload: { kind: 'absence', absence },
    });
  }

  const packed = layoutOverlappingVerticalSlots(slots);
  const positioned: PositionedTask[] = [];
  const positionedAbsences: PositionedHourlyAbsence[] = [];

  for (const slot of packed) {
    if (slot.payload.kind === 'task') {
      positioned.push({
        task: slot.payload.task,
        startMin: slot.startMin,
        endMin: slot.endMin,
        colIndex: slot.colIndex,
        totalCols: slot.totalCols,
        colSpan: slot.colSpan,
      });
    } else {
      positionedAbsences.push({
        absence: slot.payload.absence,
        startMin: slot.startMin,
        endMin: slot.endMin,
        colIndex: slot.colIndex,
        totalCols: slot.totalCols,
        colSpan: slot.colSpan,
      });
    }
  }

  return { positioned, positionedAbsences };
}

export const AdminCalendarTasksView: React.FC<AdminCalendarTasksViewProps> = ({
  onOpenEmailModal,
}) => {
  const {
    profile,
    tasks,
    assignments,
    absences,
    onCallShifts,
    onCallOverrides,
    usedMaterials,
    photos,
    articles,
    directory,
    settings,
    currentAdminUids,
    activeAdminEmails,
    currentUserReplyToEmail,
    resolveDeliverableEmail,
    pendingReviewTasksCount,
    pendingOpenTaskId,
    clearPendingOpenTask,
    driveSyncStatus,
    syncMasterDrivePermissionsAndOwnership,
    connectGoogleWorkspace,
    showToast,
  } = useApp();

  const [displayMode, setDisplayMode] = useState<CalendarDisplayMode>('week');
  const [showKpiQueueDrawer, setShowKpiQueueDrawer] = useState(false);
  const [kpiQueueFilter, setKpiQueueFilter] = useState<KpiQueueFilter>('TODAY');

  const [anchorDate, setAnchorDate] = useState<Date>(() => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilterMode>('ALL');

  // Current clock minute for Google Calendar live indicator line
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  // Viewport size & layout refs for Google Calendar-style floating modal positioning
  const calendarContainerRef = useRef<HTMLDivElement | null>(null);
  const floatingModalRef = useRef<HTMLDivElement | null>(null);
  const [floatingAnchorRect, setFloatingAnchorRect] =
    useState<FloatingAnchorRect | null>(null);
  const [draftCreateSlot, setDraftCreateSlot] =
    useState<DraftCreateSlot | null>(null);
  const [floatingDropActive, setFloatingDropActive] = useState(false);
  const [floatingModalHeight, setFloatingModalHeight] = useState<number>(520);
  const [viewportSize, setViewportSize] = useState<{
    width: number;
    height: number;
  }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1440,
    height: typeof window !== 'undefined' ? window.innerHeight : 900,
  }));

  useEffect(() => {
    const onResize = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Scroll container ref for 00:00–24:00 grid (auto-scrolls to 07:30 on open)
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (displayMode === 'week' || displayMode === 'day') {
      const el = gridScrollRef.current;
      if (el) {
        el.scrollTop = Math.round(7.5 * HOUR_HEIGHT);
      }
    }
  }, [displayMode]);

  // Interactive Pointer State (create / move / resize on 24h grid)
  const [pointerOp, setPointerOp] = useState<GridPointerState | null>(null);

  // Drag-over highlight state when dragging a Free Technician onto slots or tasks
  const [techDropHoverSlot, setTechDropHoverSlot] = useState<{
    colKey: string;
    startMin: number;
  } | null>(null);
  const [techDropHoverTaskId, setTechDropHoverTaskId] = useState<string | null>(
    null
  );
  const [monthHoverDayMs, setMonthHoverDayMs] = useState<number | null>(null);
  const [hoveredDayMs, setHoveredDayMs] = useState<number | null>(null);

  // Selected Task in Floating Modal
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Admin Task Status & Notes Controls inside Floating Modal
  const [updatingTaskStatus, setUpdatingTaskStatus] = useState(false);
  const [adminBatchNote, setAdminBatchNote] = useState('');
  const [editingNoteAsgId, setEditingNoteAsgId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');

  // Absence Create / Edit Modal
  const [absenceModalOpen, setAbsenceModalOpen] = useState(false);
  const [onCallModalState, setOnCallModalState] = useState<{
    dayMs: number | null;
    group: OnCallGroup;
  }>({ dayMs: null, group: 'technicians' });
  const [editingAbsence, setEditingAbsence] = useState<Absence | null>(null);
  const [preselectedAbsenceEmail, setPreselectedAbsenceEmail] = useState<
    string | undefined
  >(undefined);
  const [initialAbsenceDateMs, setInitialAbsenceDateMs] = useState<
    number | undefined
  >(undefined);

  // Autonomous Task Review Modal
  const [reviewingTask, setReviewingTask] = useState<Task | null>(null);

  // Explicit Force-Override Confirmation Modal for Drag & Drop / Quick-Assign Conflicts
  const [forcedAssignPrompt, setForcedAssignPrompt] =
    useState<ForcedAssignmentPrompt | null>(null);
  const [executingForcedAssign, setExecutingForcedAssign] = useState(false);

  // Google Sheets Sync States (Explicit Confirmation + Manual Full-Week Alignment)
  const hasConfiguredSheet = useMemo(
    () => Boolean(extractGoogleSheetId(settings.googleSheetId)),
    [settings.googleSheetId]
  );
  const visibleWeekCode = useMemo(
    () => formatIsoWeekCode(anchorDate),
    [anchorDate]
  );
  const [syncSheetOnTaskForm, setSyncSheetOnTaskForm] = useState(true);
  const [pendingDirectSheetPrompt, setPendingDirectSheetPrompt] =
    useState<PendingDirectSheetPrompt | null>(null);
  const [syncingDirectSheet, setSyncingDirectSheet] = useState(false);
  const [confirmWeekSyncOpen, setConfirmWeekSyncOpen] = useState(false);
  const [syncingFullWeek, setSyncingFullWeek] = useState(false);

  // Task Form Mode inside Floating Modal
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [copiedFromTaskCode, setCopiedFromTaskCode] = useState<string | null>(
    null
  );
  const [commessa, setCommessa] = useState('');
  const [altroReparto, setAltroReparto] = useState(false);
  const [taskColorId, setTaskColorId] =
    useState<TaskColorId>(DEFAULT_TASK_COLOR_ID);
  const [descrizione, setDescrizione] = useState('');
  const [inizioInput, setInizioInput] = useState('');
  const [fineInput, setFineInput] = useState('');
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [forceAbsentOverride, setForceAbsentOverride] = useState(false);
  const [savingTask, setSavingTask] = useState(false);

  // Delete confirmation
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);

  // Admin quick material add Modal
  const [addingMatForAsg, setAddingMatForAsg] = useState<Assignment | null>(null);
  const [matCategory, setMatCategory] = useState('');
  const [matArticleId, setMatArticleId] = useState('');
  const [matQty, setMatQty] = useState('1');
  const [savingMat, setSavingMat] = useState(false);

  // Admin Multi-Photo upload confirmation
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingPhotoTarget, setPendingPhotoTarget] = useState<Assignment | null>(
    null
  );
  const [pendingPhotoFiles, setPendingPhotoFiles] = useState<File[]>([]);
  const [photoCaption, setPhotoCaption] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploadProgress, setPhotoUploadProgress] =
    useState<BatchPhotoUploadProgress | null>(null);

  const measureTaskCardAnchor = useCallback(
    (taskId: string): FloatingAnchorRect | null => {
      if (typeof document === 'undefined') return null;
      const el = document.querySelector<HTMLElement>(
        `[data-task-card-id="${CSS.escape(taskId)}"]`
      );
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return null;
      return {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      };
    },
    []
  );

  const computeSlotAnchorRect = useCallback(
    (
      colKey: string,
      startMin: number,
      endMin: number
    ): FloatingAnchorRect | null => {
      if (typeof document === 'undefined') return null;
      const colEl = document.querySelector<HTMLElement>(
        `[data-cal-col-key="${CSS.escape(colKey)}"]`
      );
      if (!colEl) return null;
      const colRect = colEl.getBoundingClientRect();
      const rawTop = colRect.top + (startMin / 60) * HOUR_HEIGHT;
      const rawBottom = colRect.top + (endMin / 60) * HOUR_HEIGHT;
      const scrollRect = gridScrollRef.current?.getBoundingClientRect() || null;
      const clampedTop = scrollRect
        ? Math.max(scrollRect.top + 40, Math.min(rawTop, scrollRect.bottom - 48))
        : rawTop;
      const clampedBottom = scrollRect
        ? Math.max(clampedTop + 24, Math.min(rawBottom, scrollRect.bottom - 16))
        : rawBottom;
      return {
        top: clampedTop,
        left: colRect.left,
        right: colRect.right,
        bottom: clampedBottom,
      };
    },
    []
  );

  const closeFloatingModal = useCallback(() => {
    setTaskModalOpen(false);
    setEditingTask(null);
    setCopiedFromTaskCode(null);
    setDraftCreateSlot(null);
    setSelectedTaskId(null);
    setFloatingAnchorRect(null);
    setEditingNoteAsgId(null);
    setAdminBatchNote('');
  }, []);

  const selectAndInspectTask = useCallback(
    (taskId: string, explicitRect?: DOMRect | FloatingAnchorRect | null) => {
      setTaskModalOpen(false);
      setEditingTask(null);
      setDraftCreateSlot(null);
      setSelectedTaskId(taskId);
      setEditingNoteAsgId(null);
      setAdminBatchNote('');

      if (explicitRect) {
        setFloatingAnchorRect({
          top: explicitRect.top,
          left: explicitRect.left,
          right: explicitRect.right,
          bottom: explicitRect.bottom,
        });
        return;
      }

      const immediate = measureTaskCardAnchor(taskId);
      if (immediate) {
        setFloatingAnchorRect(immediate);
      } else if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
          const deferred = measureTaskCardAnchor(taskId);
          if (deferred) {
            setFloatingAnchorRect(deferred);
          }
        });
      }
    },
    [measureTaskCardAnchor]
  );

  // Close floating modal on Escape when no child confirmation/upload modal is open
  useEffect(() => {
    if (!taskModalOpen && !selectedTaskId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (
        confirmDeleteTask ||
        forcedAssignPrompt ||
        pendingDirectSheetPrompt ||
        confirmWeekSyncOpen ||
        reviewingTask ||
        absenceModalOpen ||
        addingMatForAsg ||
        pendingPhotoFiles.length > 0
      ) {
        return;
      }
      closeFloatingModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    taskModalOpen,
    selectedTaskId,
    confirmDeleteTask,
    forcedAssignPrompt,
    pendingDirectSheetPrompt,
    confirmWeekSyncOpen,
    reviewingTask,
    absenceModalOpen,
    addingMatForAsg,
    pendingPhotoFiles.length,
    closeFloatingModal,
  ]);

  // Open task from Push / Desktop / Toast notification click
  useEffect(() => {
    if (!pendingOpenTaskId) return;
    const target = tasks.find((t) => t.taskId === pendingOpenTaskId);
    if (!target) return;
    const targetDay = new Date(target.inizioMs);
    targetDay.setHours(0, 0, 0, 0);
    setAnchorDate(targetDay);
    selectAndInspectTask(target.taskId);
    if (target.pendingAdminReview && !target.commessa) {
      setReviewingTask(target);
    }
    clearPendingOpenTask();
  }, [pendingOpenTaskId, tasks, selectAndInspectTask, clearPendingOpenTask]);

  const openNewAbsenceModal = useCallback(
    (techEmail?: string, dateMs?: number) => {
      setEditingAbsence(null);
      setPreselectedAbsenceEmail(techEmail);
      setInitialAbsenceDateMs(dateMs ?? startOfDayMs(anchorDate));
      setAbsenceModalOpen(true);
    },
    [anchorDate]
  );

  const openEditAbsenceModal = useCallback((absence: Absence) => {
    setEditingAbsence(absence);
    setPreselectedAbsenceEmail(absence.technicianEmail);
    setInitialAbsenceDateMs(absence.inizioMs);
    setAbsenceModalOpen(true);
  }, []);

  const assignmentsByTask = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of assignments) {
      if (a.stato === 'Annullato') continue;
      const arr = map.get(a.taskId) || [];
      arr.push(a);
      map.set(a.taskId, arr);
    }
    return map;
  }, [assignments]);

  const materialsByTask = useMemo(() => {
    const map = new Map<string, typeof usedMaterials>();
    for (const m of usedMaterials) {
      const arr = map.get(m.taskId) || [];
      arr.push(m);
      map.set(m.taskId, arr);
    }
    return map;
  }, [usedMaterials]);

  const photosByTask = useMemo(() => {
    const map = new Map<string, typeof photos>();
    for (const p of photos) {
      const arr = map.get(p.taskId) || [];
      arr.push(p);
      map.set(p.taskId, arr);
    }
    return map;
  }, [photos]);

  const activeTechnicians = useMemo(
    () => directory.filter((m) => m.active),
    [directory]
  );

  // Active day inspected by the "Tecnici Liberi" tab: follows mouse hover in Week/Month views
  const inspectedDayMs = useMemo(() => {
    if (
      (displayMode === 'week' || displayMode === 'month') &&
      hoveredDayMs !== null
    ) {
      return hoveredDayMs;
    }
    return startOfDayMs(anchorDate);
  }, [displayMode, hoveredDayMs, anchorDate]);

  const inspectedDayLabel = useMemo(() => {
    const d = new Date(inspectedDayMs);
    const weekday = new Intl.DateTimeFormat('it-IT', {
      weekday: 'short',
    }).format(d);
    const capWeekday =
      weekday.charAt(0).toUpperCase() + weekday.slice(1).replace('.', '');
    return `${capWeekday} ${formatDateIt(inspectedDayMs)}`;
  }, [inspectedDayMs]);

  const {
    freeTechniciansOnInspectedDate,
    busyTechniciansOnInspectedDate,
    absentTechniciansOnInspectedDate,
    commitmentsOnInspectedDate,
    partialAbsencesOnInspectedDate,
  } = useMemo(() => {
    const tasksPerTech = new Map<string, Task[]>();
    const dayEndMs = addLocalDaysMs(inspectedDayMs, 1);

    for (const t of tasks) {
      if (taskOccursOnDay(t, inspectedDayMs)) {
        for (const em of t.assignedEmails) {
          const canon = canonicalTechnicianKey(em, directory);
          if (!canon) continue;
          const arr = tasksPerTech.get(canon) || [];
          arr.push(t);
          tasksPerTech.set(canon, arr);
        }
      }
    }

    const absentAllDaySet = new Set<string>();
    const absentAllList: {
      tech: (typeof activeTechnicians)[number];
      overlaps: Absence[];
    }[] = [];
    const commitmentAllList: {
      tech: (typeof activeTechnicians)[number];
      overlaps: Absence[];
    }[] = [];
    const partialMap = new Map<string, Absence[]>();

    for (const tech of activeTechnicians) {
      const norm = tech.email.toLowerCase();
      const canon = canonicalTechnicianKey(norm, directory);
      const overlaps = findOverlappingAbsencesForTech(
        absences,
        norm,
        inspectedDayMs,
        dayEndMs,
        directory
      );
      if (overlaps.length > 0) {
        const trueAbsOverlaps = overlaps.filter(
          (a) => !isNonAbsenceEntryType(a.tipo)
        );
        const commitmentOverlaps = overlaps.filter((a) =>
          isNonAbsenceEntryType(a.tipo)
        );
        if (trueAbsOverlaps.length > 0) {
          absentAllList.push({ tech, overlaps: trueAbsOverlaps });
        }
        if (commitmentOverlaps.length > 0) {
          commitmentAllList.push({ tech, overlaps: commitmentOverlaps });
        }
        if (overlaps.some((a) => isTopStripAbsence(a))) {
          absentAllDaySet.add(canon);
        } else {
          partialMap.set(norm, overlaps);
        }
      }
    }

    const free = activeTechnicians.filter((tech) => {
      const canon = canonicalTechnicianKey(tech.email, directory);
      return !tasksPerTech.has(canon) && !absentAllDaySet.has(canon);
    });

    const busy = activeTechnicians
      .filter((tech) =>
        tasksPerTech.has(canonicalTechnicianKey(tech.email, directory))
      )
      .map((tech) => ({
        tech,
        dayTasks:
          tasksPerTech.get(canonicalTechnicianKey(tech.email, directory)) || [],
      }));

    return {
      freeTechniciansOnInspectedDate: free,
      busyTechniciansOnInspectedDate: busy,
      absentTechniciansOnInspectedDate: absentAllList,
      commitmentsOnInspectedDate: commitmentAllList,
      partialAbsencesOnInspectedDate: partialMap,
    };
  }, [activeTechnicians, tasks, absences, inspectedDayMs, directory]);

  const filteredTasks = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return tasks.filter((t) => {
      if (statusFilter === 'PENDING_REVIEW') {
        if (!t.pendingAdminReview) return false;
      } else if (
        statusFilter !== 'ALL' &&
        t.statoPrevalente !== statusFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        t.taskCode.toLowerCase().includes(q) ||
        t.commessa.toLowerCase().includes(q) ||
        formatTaskCommessaLabel(t).toLowerCase().includes(q) ||
        t.descrizione.toLowerCase().includes(q) ||
        t.assignedNames.some((n) => n.toLowerCase().includes(q)) ||
        t.assignedEmails.some((e) => e.toLowerCase().includes(q))
      );
    });
  }, [tasks, statusFilter, searchTerm]);

  const filteredAbsences = useMemo(() => {
    if (statusFilter !== 'ALL') return [];
    const q = searchTerm.trim().toLowerCase();
    if (!q) return absences;
    return absences.filter(
      (a) =>
        a.technicianName.toLowerCase().includes(q) ||
        a.technicianEmail.toLowerCase().includes(q) ||
        a.tipo.toLowerCase().includes(q) ||
        (a.note || '').toLowerCase().includes(q)
    );
  }, [absences, statusFilter, searchTerm]);

  const weekDays = useMemo(() => {
    const start = getStartOfWeek(anchorDate);
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(start);
      d.setDate(start.getDate() + idx);
      return d;
    });
  }, [anchorDate]);

  const weekDayStartsMs = useMemo(
    () => weekDays.map((d) => startOfLocalDayMs(d.getTime())),
    [weekDays]
  );

  // Google Calendar Top Horizontal Strip Spans for Week View
  const weekTopStripPacked = useMemo(() => {
    const items: HorizontalStripItem<Task | Absence>[] = [];
    for (const t of filteredTasks) {
      if (isTopStripTask(t)) {
        items.push({
          id: `task_${t.taskId}`,
          kind: 'task',
          inizioMs: t.inizioMs,
          fineMs: t.fineMs,
          payload: t,
        });
      }
    }
    for (const a of filteredAbsences) {
      if (isTopStripAbsence(a)) {
        items.push({
          id: `abs_${a.absenceId}`,
          kind: 'absence',
          inizioMs: a.inizioMs,
          fineMs: a.fineMs,
          payload: a,
        });
      }
    }
    return packHorizontalStripSpans(items, weekDayStartsMs);
  }, [filteredTasks, filteredAbsences, weekDayStartsMs]);

  const monthDays = useMemo(() => getMonthCalendarDays(anchorDate), [anchorDate]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.taskId === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  const buildAssigneesFromEmails = useCallback(
    (emails: string[]): SelectedAssignee[] =>
      emails.map((em) => {
        const norm = em.toLowerCase();
        const staff = findStaffMemberByAnyEmail(norm, directory);
        const primaryEmail = staff ? staff.email.trim().toLowerCase() : norm;
        return {
          email: primaryEmail,
          fullName: staff ? `${staff.nome} ${staff.cognome}`.trim() : norm,
          linkedUid: staff?.linkedUid || '',
          deliverableEmail: staff
            ? getDeliverableEmail(staff)
            : isLoginOnlyIdEmail(norm)
              ? ''
              : norm,
        };
      }),
    [directory]
  );

  // Helper to collect absence conflicts for a list of emails over [startMs, endMs)
  const getAbsenceConflictSummary = useCallback(
    (emails: string[], startMs: number, endMs: number): string[] => {
      const details: string[] = [];
      for (const em of emails) {
        if (!em || em === UNASSIGNED_COL_ID) continue;
        const overlaps = findOverlappingAbsencesForTech(
          absences,
          em,
          startMs,
          endMs,
          directory
        );
        if (overlaps.length > 0) {
          const staff = findStaffMemberByAnyEmail(em, directory);
          const name = staff
            ? `${staff.nome} ${staff.cognome}`.trim()
            : overlaps[0].technicianName || em;
          details.push(
            `${name}: ${overlaps[0].tipo} (${formatAbsenceDateSummary(
              overlaps[0]
            )})`
          );
        }
      }
      return details;
    },
    [absences, directory]
  );

  const openNewTaskModal = useCallback(
    (options?: {
      preselectedEmails?: string[];
      startMs?: number;
      endMs?: number;
      customDate?: Date;
      forceOverride?: boolean;
      anchorRect?: FloatingAnchorRect | null;
      draftSlot?: DraftCreateSlot | null;
    }) => {
      let sMs = options?.startMs;
      let eMs = options?.endMs;

      if (!sMs) {
        const base = options?.customDate
          ? new Date(options.customDate)
          : new Date(anchorDate);
        const now = new Date();
        base.setHours(Math.max(8, Math.min(18, now.getHours() + 1)), 0, 0, 0);
        sMs = base.getTime();
      }
      if (!eMs || eMs < sMs + 3600000) {
        eMs = sMs + 2 * 3600000;
      }

      const preEmails = (options?.preselectedEmails || []).map((em) =>
        em.toLowerCase()
      );

      // Guard preselected technicians if absent and not explicitly forced yet
      if (!options?.forceOverride && preEmails.length > 0) {
        const conflicts = getAbsenceConflictSummary(preEmails, sMs, eMs);
        if (conflicts.length > 0) {
          setForcedAssignPrompt({
            title: 'Tecnico segnato assente o con impegno nella fascia selezionata',
            description: `${conflicts.join(
              ' · '
            )}. Vuoi forzare comunque l'apertura e l'assegnazione del task a questo tecnico?`,
            onConfirm: () => {
              setForcedAssignPrompt(null);
              openNewTaskModal({ ...options, forceOverride: true });
            },
          });
          return;
        }
      }

      const dayStart = startOfDayMs(sMs);
      const startMin = Math.max(0, Math.round((sMs - dayStart) / 60000));
      const endMin = Math.min(
        24 * 60,
        Math.max(startMin + 60, Math.round((eMs - dayStart) / 60000))
      );

      let resolvedDraftSlot = options?.draftSlot || null;
      let resolvedAnchor = options?.anchorRect || null;

      if (!resolvedDraftSlot && displayMode === 'week') {
        const autoColKey = `week_${dayStart}`;
        const autoRect = computeSlotAnchorRect(autoColKey, startMin, endMin);
        if (autoRect) {
          resolvedDraftSlot = { colKey: autoColKey, dayMs: dayStart };
          if (!resolvedAnchor) {
            resolvedAnchor = autoRect;
          }
        }
      } else if (!resolvedDraftSlot && displayMode === 'day') {
        const targetTech =
          preEmails.length > 0 ? preEmails[0] : UNASSIGNED_COL_ID;
        const autoColKey = `day_tech_${targetTech}`;
        const autoRect = computeSlotAnchorRect(autoColKey, startMin, endMin);
        if (autoRect) {
          resolvedDraftSlot = { colKey: autoColKey, dayMs: dayStart };
          if (!resolvedAnchor) {
            resolvedAnchor = autoRect;
          }
        }
      }

      setSelectedTaskId(null);
      setEditingTask(null);
      setCopiedFromTaskCode(null);
      setCommessa('');
      setAltroReparto(false);
      setTaskColorId(DEFAULT_TASK_COLOR_ID);
      setDescrizione('');
      setInizioInput(toLocalDateTimeInput(sMs));
      setFineInput(toLocalDateTimeInput(eMs));
      setSelectedEmails(preEmails);
      setForceAbsentOverride(Boolean(options?.forceOverride));
      setSyncSheetOnTaskForm(true);
      setDraftCreateSlot(resolvedDraftSlot);
      setFloatingAnchorRect(resolvedAnchor);
      setTaskModalOpen(true);
    },
    [anchorDate, computeSlotAnchorRect, displayMode, getAbsenceConflictSummary]
  );

  const openEditTaskModal = (
    task: Task,
    explicitRect?: DOMRect | FloatingAnchorRect | null
  ) => {
    setDraftCreateSlot(null);
    setSelectedTaskId(task.taskId);
    setCopiedFromTaskCode(null);
    if (explicitRect) {
      setFloatingAnchorRect({
        top: explicitRect.top,
        left: explicitRect.left,
        right: explicitRect.right,
        bottom: explicitRect.bottom,
      });
    } else if (!floatingAnchorRect) {
      const measured = measureTaskCardAnchor(task.taskId);
      if (measured) {
        setFloatingAnchorRect(measured);
      }
    }
    setEditingTask(task);
    setCommessa(task.commessa);
    setAltroReparto(Boolean(task.altroReparto));
    setTaskColorId(resolveTaskColorId(task));
    setDescrizione(task.descrizione);
    setInizioInput(toLocalDateTimeInput(task.inizioMs));
    setFineInput(toLocalDateTimeInput(task.fineMs));
    const mappedSelectedEmails = Array.from(
      new Set(
        task.assignedEmails.map((em) => {
          const staff = findStaffMemberByAnyEmail(em, directory);
          return (staff ? staff.email : em).trim().toLowerCase();
        })
      )
    );
    setSelectedEmails(mappedSelectedEmails);
    setForceAbsentOverride(false);
    setSyncSheetOnTaskForm(true);
    setTaskModalOpen(true);
  };

  const openDuplicateTaskModal = (
    task: Task,
    explicitRect?: DOMRect | FloatingAnchorRect | null
  ) => {
    setDraftCreateSlot(null);
    setSelectedTaskId(null);
    if (explicitRect) {
      setFloatingAnchorRect({
        top: explicitRect.top,
        left: explicitRect.left,
        right: explicitRect.right,
        bottom: explicitRect.bottom,
      });
    } else if (!floatingAnchorRect) {
      const measured = measureTaskCardAnchor(task.taskId);
      if (measured) {
        setFloatingAnchorRect(measured);
      }
    }
    // Set editingTask to null so saving creates a brand new task
    setEditingTask(null);
    setCopiedFromTaskCode(task.taskCode);
    setCommessa(task.commessa);
    setAltroReparto(Boolean(task.altroReparto));
    setTaskColorId(resolveTaskColorId(task));
    setDescrizione(task.descrizione);
    setInizioInput(toLocalDateTimeInput(task.inizioMs));
    setFineInput(toLocalDateTimeInput(task.fineMs));
    const mappedSelectedEmails = Array.from(
      new Set(
        task.assignedEmails.map((em) => {
          const staff = findStaffMemberByAnyEmail(em, directory);
          return (staff ? staff.email : em).trim().toLowerCase();
        })
      )
    );
    setSelectedEmails(mappedSelectedEmails);
    setForceAbsentOverride(false);
    setSyncSheetOnTaskForm(true);
    setTaskModalOpen(true);
    showToast(
      `Bozza creata da ${task.taskCode}. Modifica orari o dettagli e clicca Crea Task.`,
      'info'
    );
  };

  const persistDirectTaskUpdate = useCallback(
    async (params: {
      task: Task;
      newInizioMs: number;
      newFineMs: number;
      newEmails?: string[];
      successMessage: string;
      bypassAbsenceCheck?: boolean;
    }) => {
      if (!profile) return;
      const {
        task,
        newInizioMs,
        newFineMs,
        newEmails,
        successMessage,
        bypassAbsenceCheck,
      } = params;
      const safeFineMs = Math.max(newInizioMs + 3600000, newFineMs);
      const targetEmails = newEmails ?? task.assignedEmails;

      if (!bypassAbsenceCheck && targetEmails.length > 0) {
        const conflicts = getAbsenceConflictSummary(
          targetEmails,
          newInizioMs,
          safeFineMs
        );
        if (conflicts.length > 0) {
          setForcedAssignPrompt({
            title: 'Conflitto con assenza registrata',
            description: `${conflicts.join(
              ' · '
            )}. Vuoi forzare comunque l'assegnazione su ${task.taskCode}?`,
            onConfirm: async () => {
              await persistDirectTaskUpdate({
                ...params,
                bypassAbsenceCheck: true,
              });
              setForcedAssignPrompt(null);
            },
          });
          return;
        }
      }

      try {
        const assignees = buildAssigneesFromEmails(targetEmails);
        await saveTaskAndAssignments({
          existingTask: task,
          existingTaskAssignments: assignmentsByTask.get(task.taskId) || [],
          existingTaskMaterials: materialsByTask.get(task.taskId) || [],
          existingTaskPhotos: photosByTask.get(task.taskId) || [],
          allTasksForCommessaCount: tasks,
          commessa: task.commessa,
          altroReparto: Boolean(task.altroReparto),
          colorId: resolveTaskColorId(task),
          descrizione: task.descrizione,
          inizioIso: new Date(newInizioMs).toISOString(),
          fineIso: new Date(safeFineMs).toISOString(),
          assignees,
          adminUid: profile.uid,
          currentAdminUids,
          activeAdminEmails,
          directory,
        });
        showToast(successMessage, 'success');

        if (
          hasConfiguredSheet &&
          !task.pendingAdminReview &&
          (task.assignedEmails.length > 0 || assignees.length > 0)
        ) {
          const prevDaysKey = enumerateCoveredLocalDaysMs(
            task.inizioMs,
            task.fineMs
          ).join(',');
          const nextDaysKey = enumerateCoveredLocalDaysMs(
            newInizioMs,
            safeFineMs
          ).join(',');
          const prevTechKey = task.assignedEmails
            .map((em) => canonicalTechnicianKey(em, directory))
            .filter(Boolean)
            .sort()
            .join(',');
          const nextTechKey = assignees
            .map((a) => canonicalTechnicianKey(a.email, directory))
            .filter(Boolean)
            .sort()
            .join(',');

          if (prevDaysKey !== nextDaysKey || prevTechKey !== nextTechKey) {
            const nextTaskObj: Task = {
              ...task,
              inizio: new Date(newInizioMs).toISOString(),
              fine: new Date(safeFineMs).toISOString(),
              inizioMs: newInizioMs,
              fineMs: safeFineMs,
              assignedEmails: assignees.map((a) => a.email),
              assignedNames: assignees.map((a) => a.fullName),
              assignedDeliverableEmails: assignees.map(
                (a) => a.deliverableEmail || a.email
              ),
              statoPrevalente:
                assignees.length === 0
                  ? 'Non Assegnato'
                  : task.statoPrevalente === 'Non Assegnato'
                    ? 'Assegnato'
                    : task.statoPrevalente,
            };
            const allTasksPostMutation = tasks.map((t) =>
              t.taskId === task.taskId ? nextTaskObj : t
            );
            const weekCodesLabel = collectImpactedWeekCodes([
              task,
              nextTaskObj,
            ]).join(', ');
            setPendingDirectSheetPrompt({
              prevTask: task,
              nextTask: nextTaskObj,
              allTasksPostMutation,
              weekCodesLabel,
              summaryText: `Hai modificato giorni o squadra del task ${task.taskCode
                } ("${task.descrizione}").\n\nVuoi aggiornare subito anche le relative celle su Google Sheets (${weekCodesLabel}) mantenendo intatte eventuali note manuali?`,
            });
          }
        }
      } catch (err) {
        showToast(
          err instanceof Error
            ? err.message
            : 'Errore aggiornamento calendario.',
          'error'
        );
      }
    },
    [
      profile,
      getAbsenceConflictSummary,
      assignmentsByTask,
      materialsByTask,
      photosByTask,
      tasks,
      buildAssigneesFromEmails,
      currentAdminUids,
      activeAdminEmails,
      directory,
      hasConfiguredSheet,
      showToast,
    ]
  );

  // Global window pointermove / pointerup listener for 24h calendar drag & resize
  useEffect(() => {
    if (!pointerOp) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (pointerOp.kind === 'create') {
        const colEl = document.querySelector<HTMLElement>(
          `[data-cal-col-key="${CSS.escape(pointerOp.colKey)}"]`
        );
        if (!colEl) return;
        const rect = colEl.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const rawMin = (relY / HOUR_HEIGHT) * 60;
        const snapped = Math.max(
          0,
          Math.min(23 * 60 + 30, snapMinutesToStep(rawMin))
        );
        const dragged =
          pointerOp.hasDragged || Math.abs(e.clientY - pointerOp.startY) >= 6;
        setPointerOp((prev) =>
          prev && prev.kind === 'create'
            ? { ...prev, currentMin: snapped, hasDragged: dragged }
            : prev
        );
      } else if (pointerOp.kind === 'resize') {
        const colEl = document.querySelector<HTMLElement>(
          `[data-cal-col-key="${CSS.escape(pointerOp.colKey)}"]`
        );
        if (!colEl) return;
        const rect = colEl.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const rawMin = (relY / HOUR_HEIGHT) * 60;
        const snappedEnd = Math.max(
          pointerOp.startMin + MIN_DURATION_MINUTES,
          Math.min(24 * 60, snapMinutesToStep(rawMin))
        );
        const moved =
          pointerOp.moved || Math.abs(e.clientY - pointerOp.startY) >= 4;
        setPointerOp((prev) =>
          prev && prev.kind === 'resize'
            ? { ...prev, newEndMin: snappedEnd, moved }
            : prev
        );
      } else if (pointerOp.kind === 'move') {
        const dist = Math.hypot(
          e.clientX - pointerOp.startX,
          e.clientY - pointerOp.startY
        );
        if (!pointerOp.moved && dist < 6) {
          return;
        }

        const hitElements = document.elementsFromPoint(e.clientX, e.clientY);
        const hitCol = hitElements.find((el) =>
          el.hasAttribute('data-cal-col-key')
        ) as HTMLElement | undefined;

        const activeCol =
          hitCol ||
          document.querySelector<HTMLElement>(
            `[data-cal-col-key="${CSS.escape(pointerOp.targetColKey)}"]`
          );
        if (!activeCol) return;

        const colKey =
          activeCol.getAttribute('data-cal-col-key') || pointerOp.targetColKey;
        const colDayMs = Number(
          activeCol.getAttribute('data-cal-day-ms') || pointerOp.targetDayMs
        );
        const colTechAttr =
          activeCol.getAttribute('data-cal-tech-email') || undefined;

        const rect = activeCol.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const rawCursorMin = (relY / HOUR_HEIGHT) * 60;
        const maxStart = Math.max(0, 24 * 60 - pointerOp.durationMin);
        const newStartMin = Math.max(
          0,
          Math.min(
            maxStart,
            snapMinutesToStep(rawCursorMin - pointerOp.grabOffsetMin)
          )
        );

        setPointerOp((prev) =>
          prev && prev.kind === 'move'
            ? {
              ...prev,
              moved: true,
              targetColKey: colKey,
              targetDayMs: colDayMs,
              targetTechEmail: colTechAttr,
              newStartMin,
            }
            : prev
        );
      }
    };

    const handlePointerUp = () => {
      const current = pointerOp;
      setPointerOp(null);

      if (current.kind === 'create') {
        const minSlot = Math.min(current.anchorMin, current.currentMin);
        const rawMaxSlot = current.hasDragged
          ? Math.max(current.anchorMin, current.currentMin) + SNAP_MINUTES
          : current.anchorMin + 60;
        const clampedStartMin = Math.min(23 * 60, minSlot);
        const clampedEndMin = Math.min(
          24 * 60,
          Math.max(clampedStartMin + MIN_DURATION_MINUTES, rawMaxSlot)
        );

        const sMs = current.dayMs + clampedStartMin * 60000;
        const eMs = current.dayMs + clampedEndMin * 60000;
        const preselected =
          current.techEmail && current.techEmail !== UNASSIGNED_COL_ID
            ? [current.techEmail]
            : [];
        const slotAnchor = computeSlotAnchorRect(
          current.colKey,
          clampedStartMin,
          clampedEndMin
        );

        openNewTaskModal({
          preselectedEmails: preselected,
          startMs: sMs,
          endMs: eMs,
          anchorRect: slotAnchor,
          draftSlot: {
            colKey: current.colKey,
            dayMs: current.dayMs,
          },
        });
      } else if (current.kind === 'resize') {
        if (!current.moved) return;
        const newFineMs = current.dayMs + current.newEndMin * 60000;
        const origStartMs = current.dayMs + current.startMin * 60000;
        if (Math.abs(newFineMs - current.task.fineMs) >= 60000) {
          persistDirectTaskUpdate({
            task: current.task,
            newInizioMs: origStartMs,
            newFineMs,
            successMessage: `Durata aggiornata (${formatMinutesAsHHMM(
              current.startMin
            )}–${formatMinutesAsHHMM(current.newEndMin)}).`,
          });
        }
      } else if (current.kind === 'move') {
        if (!current.moved) {
          selectAndInspectTask(current.task.taskId);
          return;
        }

        const origDurationMs = Math.max(
          3600000,
          current.task.fineMs - current.task.inizioMs
        );
        const newInizioMs = current.targetDayMs + current.newStartMin * 60000;
        const newFineMs = newInizioMs + origDurationMs;

        let updatedEmails: string[] | undefined;
        if (
          current.originTechEmail !== undefined &&
          current.targetTechEmail !== undefined &&
          current.originTechEmail !== current.targetTechEmail
        ) {
          const withoutOrigin = current.task.assignedEmails.filter(
            (em) =>
              !areSameTechnicianEmails(
                em,
                current.originTechEmail || '',
                directory
              )
          );
          if (current.targetTechEmail === UNASSIGNED_COL_ID) {
            updatedEmails = withoutOrigin;
          } else if (
            !withoutOrigin.some((em) =>
              areSameTechnicianEmails(
                em,
                current.targetTechEmail || '',
                directory
              )
            )
          ) {
            updatedEmails = [
              ...withoutOrigin,
              current.targetTechEmail.toLowerCase(),
            ].slice(0, 10);
          } else {
            updatedEmails = withoutOrigin;
          }
        }

        const timeChanged =
          Math.abs(newInizioMs - current.task.inizioMs) >= 60000;
        const techChanged = updatedEmails !== undefined;

        if (timeChanged || techChanged) {
          persistDirectTaskUpdate({
            task: current.task,
            newInizioMs,
            newFineMs,
            newEmails: updatedEmails,
            successMessage: techChanged
              ? `Task ${current.task.taskCode} ripianificato e riassegnato.`
              : `Task ${current.task.taskCode} spostato alle ${formatTimeIt(
                newInizioMs
              )}.`,
          });
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [
    pointerOp,
    computeSlotAnchorRect,
    openNewTaskModal,
    persistDirectTaskUpdate,
    selectAndInspectTask,
    directory,
  ]);

  // Drop Free Technician onto an existing Task block
  const handleDropTechOnTask = async (
    e: React.DragEvent,
    targetTask: Task
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setTechDropHoverTaskId(null);
    setTechDropHoverSlot(null);

    const raw = e.dataTransfer.getData(TECH_DRAG_MIME);
    if (!raw) return;

    try {
      const tech = JSON.parse(raw) as DraggedTechPayload;
      const normEmail = tech.email.toLowerCase();
      if (
        targetTask.assignedEmails.some((em) =>
          areSameTechnicianEmails(em, normEmail, directory)
        )
      ) {
        showToast(
          `${tech.fullName} fa già parte della squadra di ${targetTask.taskCode}.`,
          'info'
        );
        return;
      }
      if (targetTask.assignedEmails.length >= 10) {
        showToast(
          'Limite massimo di 10 tecnici raggiunto per questo task.',
          'error'
        );
        return;
      }
      const nextEmails = [...targetTask.assignedEmails, normEmail];
      await persistDirectTaskUpdate({
        task: targetTask,
        newInizioMs: targetTask.inizioMs,
        newFineMs: targetTask.fineMs,
        newEmails: nextEmails,
        successMessage: `${tech.fullName} aggiunto alla squadra di ${targetTask.taskCode}.`,
      });
    } catch {
      // Ignore malformed drag payload
    }
  };

  // Drop Free Technician onto an empty 24h Calendar Column slot
  const handleDropTechOnColumnSlot = (
    e: React.DragEvent<HTMLDivElement>,
    dayMs: number,
    colTechEmail?: string
  ) => {
    e.preventDefault();
    setTechDropHoverSlot(null);

    const raw = e.dataTransfer.getData(TECH_DRAG_MIME);
    if (!raw) return;

    try {
      const tech = JSON.parse(raw) as DraggedTechPayload;
      const rect = e.currentTarget.getBoundingClientRect();
      const relY = e.clientY - rect.top;
      const startMin = Math.max(
        0,
        Math.min(22 * 60, snapMinutesToStep((relY / HOUR_HEIGHT) * 60))
      );
      const sMs = dayMs + startMin * 60000;
      const eMs = sMs + 2 * 3600000;

      const preselected = new Set<string>([tech.email.toLowerCase()]);
      if (colTechEmail && colTechEmail !== UNASSIGNED_COL_ID) {
        preselected.add(colTechEmail.toLowerCase());
      }
      const colKey = e.currentTarget.getAttribute('data-cal-col-key') || '';
      const slotAnchor = colKey
        ? computeSlotAnchorRect(
          colKey,
          startMin,
          Math.min(24 * 60, startMin + 120)
        )
        : null;

      openNewTaskModal({
        preselectedEmails: Array.from(preselected),
        startMs: sMs,
        endMs: eMs,
        anchorRect: slotAnchor,
        draftSlot: colKey ? { colKey, dayMs } : null,
      });
    } catch {
      // Ignore invalid payload
    }
  };

  // Task Modal absence conflict calculation
  const taskModalWindow = useMemo(() => {
    const s = new Date(inizioInput).getTime();
    const e = new Date(fineInput).getTime();
    return {
      inizioMs: Number.isNaN(s) ? 0 : s,
      fineMs: Number.isNaN(e) ? 0 : e,
    };
  }, [inizioInput, fineInput]);

  const modalAbsentConflictsByEmail = useMemo(() => {
    const map = new Map<string, Absence[]>();
    if (!taskModalWindow.inizioMs || !taskModalWindow.fineMs) return map;
    for (const tech of activeTechnicians) {
      const overlaps = findOverlappingAbsencesForTech(
        absences,
        tech.email,
        taskModalWindow.inizioMs,
        taskModalWindow.fineMs,
        directory
      );
      if (overlaps.length > 0) {
        map.set(tech.email.toLowerCase(), overlaps);
      }
    }
    return map;
  }, [activeTechnicians, absences, taskModalWindow, directory]);

  const toggleTechnicianSelection = (email: string) => {
    const norm = email.toLowerCase();
    const isChecked = selectedEmails.includes(norm);
    if (!isChecked && modalAbsentConflictsByEmail.has(norm) && !forceAbsentOverride) {
      showToast(
        'Tecnico assente o con impegno nella fascia oraria. Attiva "Forza su assente / impegno" per selezionarlo.',
        'info'
      );
      return;
    }
    setSelectedEmails((prev) =>
      prev.includes(norm) ? prev.filter((e) => e !== norm) : [...prev, norm]
    );
  };

  const handleInizioChange = (val: string) => {
    setInizioInput(val);
    const startMs = new Date(val).getTime();
    const currentEndMs = new Date(fineInput).getTime();
    if (
      !Number.isNaN(startMs) &&
      (Number.isNaN(currentEndMs) || currentEndMs < startMs + 3600000)
    ) {
      setFineInput(toLocalDateTimeInput(startMs + 2 * 3600000));
    }
  };

  const durationError = useMemo(() => {
    const s = new Date(inizioInput).getTime();
    const e = new Date(fineInput).getTime();
    if (!Number.isNaN(s) && !Number.isNaN(e) && e < s + 3600000) {
      return "L'orario di fine deve essere ad almeno un'ora di distanza dall'orario di inizio.";
    }
    return null;
  }, [inizioInput, fineInput]);

  const taskFormWeekCodesLabel = useMemo(() => {
    const intervals: Array<{ inizioMs: number; fineMs: number }> = [];
    if (editingTask && !editingTask.pendingAdminReview) {
      intervals.push({
        inizioMs: editingTask.inizioMs,
        fineMs: editingTask.fineMs,
      });
    }
    if (taskModalWindow.inizioMs > 0 && taskModalWindow.fineMs > 0) {
      intervals.push(taskModalWindow);
    }
    return collectImpactedWeekCodes(intervals).join(', ');
  }, [editingTask, taskModalWindow]);

  const showTaskFormSheetCheckbox =
    hasConfiguredSheet &&
    (selectedEmails.length > 0 ||
      Boolean(
        editingTask &&
        !editingTask.pendingAdminReview &&
        editingTask.assignedEmails.length > 0
      ));

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    if (durationError) {
      showToast(durationError, 'error');
      return;
    }

    const selectedAbsent = selectedEmails.filter((em) =>
      modalAbsentConflictsByEmail.has(em)
    );
    if (selectedAbsent.length > 0 && !forceAbsentOverride) {
      showToast(
        'Conferma la forzatura per assegnare tecnici segnati assenti o con impegni in questa fascia.',
        'error'
      );
      return;
    }

    setSavingTask(true);
    try {
      const assignees = buildAssigneesFromEmails(selectedEmails);
      const parsedStartMs = new Date(inizioInput).getTime();
      const parsedEndMs = new Date(fineInput).getTime();
      const prevTaskSnapshot = editingTask;

      const savedId = await saveTaskAndAssignments({
        existingTask: editingTask || undefined,
        existingTaskAssignments: editingTask
          ? assignmentsByTask.get(editingTask.taskId) || []
          : [],
        existingTaskMaterials: editingTask
          ? materialsByTask.get(editingTask.taskId) || []
          : [],
        existingTaskPhotos: editingTask
          ? photosByTask.get(editingTask.taskId) || []
          : [],
        allTasksForCommessaCount: tasks,
        commessa: altroReparto ? commessa.trim() : commessa,
        altroReparto,
        colorId: taskColorId,
        descrizione,
        inizioIso: new Date(parsedStartMs).toISOString(),
        fineIso: new Date(parsedEndMs).toISOString(),
        assignees,
        adminUid: profile.uid,
        currentAdminUids,
        activeAdminEmails,
        directory,
      });

      showToast(
        editingTask
          ? 'Intervento aggiornato correttamente.'
          : copiedFromTaskCode
            ? `Nuovo intervento creato (copia di ${copiedFromTaskCode}).`
            : altroReparto
              ? 'Lavorazione altro AT pianificata a margine.'
              : 'Nuovo intervento pianificato.',
        'success'
      );

      if (showTaskFormSheetCheckbox && syncSheetOnTaskForm) {
        const cleanCommessaUpper = (
          altroReparto ? commessa.trim() : commessa
        )
          .trim()
          .toUpperCase();
        const optimisticSavedTask: Task = {
          taskId: savedId,
          taskCode: prevTaskSnapshot?.taskCode || savedId,
          commessa: cleanCommessaUpper,
          altroReparto,
          colorId: taskColorId,
          descrizione: descrizione.trim(),
          inizio: new Date(parsedStartMs).toISOString(),
          fine: new Date(parsedEndMs).toISOString(),
          inizioMs: parsedStartMs,
          fineMs: parsedEndMs,
          assignedEmails: assignees.map((a) => a.email),
          assignedNames: assignees.map((a) => a.fullName),
          assignedDeliverableEmails: assignees.map(
            (a) => a.deliverableEmail || a.email
          ),
          statoPrevalente:
            assignees.length === 0
              ? 'Non Assegnato'
              : prevTaskSnapshot &&
                prevTaskSnapshot.statoPrevalente !== 'Non Assegnato'
                ? prevTaskSnapshot.statoPrevalente
                : 'Assegnato',
          pendingAdminReview: false,
          adminUids: currentAdminUids,
          createdByUid: prevTaskSnapshot?.createdByUid || profile.uid,
        };

        const allTasksPostMutation = prevTaskSnapshot
          ? tasks.map((t) =>
            t.taskId === prevTaskSnapshot.taskId ? optimisticSavedTask : t
          )
          : [
            ...tasks.filter((t) => t.taskId !== savedId),
            optimisticSavedTask,
          ];

        try {
          const outcome = await reconcileTaskMutationOnGoogleSheet({
            rawGoogleSheetId: settings.googleSheetId,
            connectGoogleWorkspace,
            prevTask: prevTaskSnapshot || null,
            nextTask: optimisticSavedTask,
            allTasksPostMutation,
            allAbsences: absences,
            directory,
          });
          const summaryToast = formatSheetSyncToastSummary(outcome);
          if (summaryToast) {
            showToast(summaryToast.message, summaryToast.tone);
          }
        } catch (sheetErr) {
          showToast(
            sheetErr instanceof Error
              ? `Task salvato nell'app, ma Google Sheet non aggiornato: ${sheetErr.message}`
              : "Task salvato nell'app, ma aggiornamento Google Sheet non riuscito.",
            'error'
          );
        }
      }

      setTaskModalOpen(false);
      setEditingTask(null);
      setDraftCreateSlot(null);
      selectAndInspectTask(savedId);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio task.',
        'error'
      );
    } finally {
      setSavingTask(false);
    }
  };

  const handleReviewCompleted = async (payload: ReviewCompletedPayload) => {
    selectAndInspectTask(payload.task.taskId);

    if (payload.syncGoogleSheet && hasConfiguredSheet) {
      const allTasksPostMutation = tasks.some(
        (t) => t.taskId === payload.task.taskId
      )
        ? tasks.map((t) =>
          t.taskId === payload.task.taskId ? payload.task : t
        )
        : [...tasks, payload.task];
      try {
        const outcome = await reconcileTaskMutationOnGoogleSheet({
          rawGoogleSheetId: settings.googleSheetId,
          connectGoogleWorkspace,
          prevTask: null,
          nextTask: payload.task,
          allTasksPostMutation,
          allAbsences: absences,
          directory,
        });
        const summaryToast = formatSheetSyncToastSummary(outcome);
        if (summaryToast) {
          showToast(summaryToast.message, summaryToast.tone);
        }
      } catch (sheetErr) {
        showToast(
          sheetErr instanceof Error
            ? `Task approvato nell'app, ma Google Sheet non aggiornato: ${sheetErr.message}`
            : "Task approvato nell'app, ma aggiornamento Google Sheet non riuscito.",
          'error'
        );
      }
    }

    if (
      payload.resultingTaskStatus === 'Completato' &&
      !payload.task.altroReparto
    ) {
      const summary = buildTaskCompletionEmailSummary({
        task: payload.task,
        completedByName:
          `${profile?.nome || ''} ${profile?.cognome || ''}`.trim() ||
          profile?.email ||
          'Admin',
        completedByReplyToEmail: currentUserReplyToEmail,
        commessa: payload.commessa,
        taskCode: payload.task.taskCode,
        descrizioneTask: payload.descrizione,
        inizioMs: payload.inizioMs,
        fineMs: payload.fineMs,
        squadAssignments: payload.updatedAssignments,
        taskMaterials: materialsByTask.get(payload.task.taskId) || [],
        taskPhotos: photosByTask.get(payload.task.taskId) || [],
        activeAdminEmails,
        resolveDeliverableEmail,
        directory,
        masterFolderId: settings.driveSharedFolderId,
      });
      onOpenEmailModal({
        ...summary,
        modalTitle: 'Revisione completata — Invia riepilogo',
      });
    }
  };

  const handleDeleteTaskConfirmed = async () => {
    if (!confirmDeleteTask) return;
    setDeletingTask(true);
    const deletedSnapshot = confirmDeleteTask;
    try {
      const tId = deletedSnapshot.taskId;
      await deleteTaskCascade({
        taskId: tId,
        assignments: assignments.filter((a) => a.taskId === tId),
        usedMaterials: materialsByTask.get(tId) || [],
        photos: photosByTask.get(tId) || [],
      });
      if (selectedTaskId === tId) {
        setSelectedTaskId(null);
        setFloatingAnchorRect(null);
      }
      setConfirmDeleteTask(null);
      showToast('Intervento eliminato.', 'success');

      if (
        hasConfiguredSheet &&
        !deletedSnapshot.pendingAdminReview &&
        deletedSnapshot.assignedEmails.length > 0
      ) {
        const remainingTasks = tasks.filter((t) => t.taskId !== tId);
        try {
          const outcome = await reconcileTaskMutationOnGoogleSheet({
            rawGoogleSheetId: settings.googleSheetId,
            connectGoogleWorkspace,
            prevTask: deletedSnapshot,
            nextTask: null,
            allTasksPostMutation: remainingTasks,
            allAbsences: absences,
            directory,
          });
          const summaryToast = formatSheetSyncToastSummary(outcome);
          if (summaryToast) {
            showToast(summaryToast.message, summaryToast.tone);
          }
        } catch (sheetErr) {
          showToast(
            sheetErr instanceof Error
              ? `Task eliminato nell'app, ma Google Sheet non aggiornato: ${sheetErr.message}`
              : "Task eliminato nell'app, ma rimozione dal Google Sheet non riuscita.",
            'error'
          );
        }
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore eliminazione intervento.',
        'error'
      );
    } finally {
      setDeletingTask(false);
    }
  };

  const handleAdminAbsenceSheetSync = async (
    payload: AbsenceMutationSheetPayload
  ) => {
    if (!payload.syncGoogleSheet || !hasConfiguredSheet) return;
    const { prevAbsence, nextAbsence } = payload;

    const allAbsencesPostMutation =
      nextAbsence === null
        ? absences.filter((a) => a.absenceId !== prevAbsence?.absenceId)
        : absences.some((a) => a.absenceId === nextAbsence.absenceId)
          ? absences.map((a) =>
            a.absenceId === nextAbsence.absenceId ? nextAbsence : a
          )
          : [
            ...absences.filter((a) => a.absenceId !== nextAbsence.absenceId),
            nextAbsence,
          ];

    try {
      const outcome = await reconcileAbsenceMutationOnGoogleSheet({
        rawGoogleSheetId: settings.googleSheetId,
        connectGoogleWorkspace,
        prevAbsence,
        nextAbsence,
        allTasks: tasks,
        allAbsencesPostMutation,
        directory,
      });
      const summaryToast = formatSheetSyncToastSummary(outcome);
      if (summaryToast) {
        showToast(summaryToast.message, summaryToast.tone);
      }
    } catch (sheetErr) {
      showToast(
        sheetErr instanceof Error
          ? `Assenza salvata nell'app, ma Google Sheet non aggiornato: ${sheetErr.message}`
          : "Assenza salvata nell'app, ma aggiornamento Google Sheet non riuscito.",
        'error'
      );
    }
  };

  const handleConfirmDirectSheetSync = async () => {
    if (!pendingDirectSheetPrompt) return;
    setSyncingDirectSheet(true);
    try {
      const outcome = await reconcileTaskMutationOnGoogleSheet({
        rawGoogleSheetId: settings.googleSheetId,
        connectGoogleWorkspace,
        prevTask: pendingDirectSheetPrompt.prevTask,
        nextTask: pendingDirectSheetPrompt.nextTask,
        allTasksPostMutation: pendingDirectSheetPrompt.allTasksPostMutation,
        allAbsences: absences,
        directory,
      });
      const summaryToast = formatSheetSyncToastSummary(outcome);
      if (summaryToast) {
        showToast(summaryToast.message, summaryToast.tone);
      } else {
        showToast('Foglio Google Sheet verificato e già allineato.', 'info');
      }
      setPendingDirectSheetPrompt(null);
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore sincronizzazione Google Sheet.',
        'error'
      );
    } finally {
      setSyncingDirectSheet(false);
    }
  };

  const handleConfirmFullWeekSheetSync = async () => {
    setSyncingFullWeek(true);
    try {
      const outcome = await syncFullWeekToGoogleSheet({
        rawGoogleSheetId: settings.googleSheetId,
        connectGoogleWorkspace,
        weekAnchorMs: anchorDate.getTime(),
        allTasks: tasks,
        allAbsences: absences,
        directory,
      });
      setConfirmWeekSyncOpen(false);
      if (outcome.updatedCellsCount > 0) {
        const tabsStr = outcome.touchedTabs.join(', ') || visibleWeekCode;
        const cellWord = outcome.updatedCellsCount === 1 ? 'cella' : 'celle';
        showToast(
          `Settimana sincronizzata su Google Sheets (${tabsStr}) · ${outcome.updatedCellsCount} ${cellWord} aggiornate.`,
          'success'
        );
      } else {
        showToast(
          `La scheda ${visibleWeekCode} su Google Sheets è già allineata con task e assenze.`,
          'info'
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore sincronizzazione settimanale Google Sheet.',
        'error'
      );
    } finally {
      setSyncingFullWeek(false);
    }
  };

  // Admin: Advance or change ENTIRE Task status (all assigned technicians together, no note block)
  const handleAdminBatchTaskStatus = async (
    task: Task,
    newStatus: TaskStatus
  ) => {
    if (!profile) return;
    setUpdatingTaskStatus(true);
    const wasAlreadyCompleted = task.statoPrevalente === 'Completato';
    const batchNoteUsed = adminBatchNote.trim();
    try {
      const taskAsgs = assignmentsByTask.get(task.taskId) || [];
      await adminUpdateEntireTaskStatus({
        task,
        taskAssignments: taskAsgs,
        newStatus,
        adminNoteOptional: batchNoteUsed,
        actorName:
          `${profile.nome} ${profile.cognome}`.trim() || profile.email,
        directory,
      });
      if (batchNoteUsed) {
        setAdminBatchNote('');
      }
      showToast(
        taskAsgs.length > 0
          ? `Intero task (${taskAsgs.length} tecnici) impostato a "${newStatus}".`
          : `Stato task impostato a "${newStatus}".`,
        'success'
      );

      if (!wasAlreadyCompleted && newStatus === 'Completato') {
        if (task.altroReparto) {
          return;
        }
        if (task.pendingAdminReview) {
          showToast(
            'Task completato · Completa prima la revisione commessa per inviare il riepilogo email Admin.',
            'info'
          );
          return;
        }
        const overrideNotes: Record<string, string> = {};
        if (batchNoteUsed) {
          for (const asg of taskAsgs) {
            overrideNotes[asg.assignmentId] = asg.noteTecnico.trim()
              ? `${asg.noteTecnico.trim()}\n[Admin]: ${batchNoteUsed}`
              : batchNoteUsed;
          }
        }
        const summary = buildTaskCompletionEmailSummary({
          task,
          completedByName:
            `${profile.nome} ${profile.cognome}`.trim() || profile.email,
          completedByReplyToEmail: currentUserReplyToEmail,
          commessa: task.commessa,
          taskCode: task.taskCode,
          descrizioneTask: task.descrizione,
          inizioMs: task.inizioMs,
          fineMs: task.fineMs,
          squadAssignments: taskAsgs,
          overrideNoteByAssignmentId: overrideNotes,
          taskMaterials: materialsByTask.get(task.taskId) || [],
          taskPhotos: photosByTask.get(task.taskId) || [],
          activeAdminEmails,
          resolveDeliverableEmail,
          directory,
          masterFolderId: settings.driveSharedFolderId,
        });
        onOpenEmailModal({
          ...summary,
          modalTitle: 'Task completato — Invia riepilogo',
        });
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore aggiornamento stato task.',
        'error'
      );
    } finally {
      setUpdatingTaskStatus(false);
    }
  };

  // Admin: Advance or change SINGLE Technician assignment status (or save note) without note block
  const handleAdminSingleAssignmentUpdate = async (
    asg: Assignment,
    newStatus: AssignmentStatus,
    customNote?: string
  ) => {
    if (!profile) return;
    setUpdatingTaskStatus(true);
    try {
      const parentTask = tasks.find((t) => t.taskId === asg.taskId) || null;
      const siblings = assignmentsByTask.get(asg.taskId) || [];
      const effectiveNote =
        customNote !== undefined ? customNote : asg.noteTecnico;
      const res = await updateAssignmentStatusAndNotes({
        assignment: asg,
        parentTask: parentTask || undefined,
        siblingAssignments: siblings,
        newStatus,
        noteTecnico: effectiveNote,
        exemptCommesse: settings.exemptCommesse,
        isAltroReparto: Boolean(parentTask?.altroReparto),
        actorUid: profile.uid,
        actorEmail: profile.email,
        isAdminActor: true,
        directory,
      });
      if (customNote !== undefined) {
        setEditingNoteAsgId(null);
        showToast(`Nota di ${asg.technicianName} salvata.`, 'success');
      } else {
        showToast(
          `Stato di ${asg.technicianName} aggiornato a "${newStatus}".`,
          'success'
        );
        if (res.taskBecameCompleted) {
          if (parentTask?.altroReparto) {
            return;
          }
          if (parentTask?.pendingAdminReview) {
            showToast(
              'Intervento completato · Revisiona la commessa per inviare il riepilogo email Admin.',
              'info'
            );
            return;
          }
          const summary = buildTaskCompletionEmailSummary({
            task: parentTask,
            completedByName:
              `${profile.nome} ${profile.cognome}`.trim() || profile.email,
            completedByReplyToEmail: currentUserReplyToEmail,
            commessa: asg.commessa,
            taskCode: parentTask?.taskCode || asg.assignmentCode,
            descrizioneTask: parentTask?.descrizione || asg.descrizioneTask,
            inizioMs: parentTask?.inizioMs || asg.inizioMs,
            fineMs: parentTask?.fineMs || asg.fineMs,
            squadAssignments: siblings.length > 0 ? siblings : [asg],
            overrideNoteByAssignmentId: {
              [asg.assignmentId]: effectiveNote,
            },
            taskMaterials: materialsByTask.get(asg.taskId) || [],
            taskPhotos: photosByTask.get(asg.taskId) || [],
            activeAdminEmails,
            resolveDeliverableEmail,
            directory,
            masterFolderId: settings.driveSharedFolderId,
          });
          onOpenEmailModal({
            ...summary,
            modalTitle: 'Task completato — Invia riepilogo',
          });
        }
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore modifica assegnazione.',
        'error'
      );
    } finally {
      setUpdatingTaskStatus(false);
    }
  };

  const handleAdminAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || !addingMatForAsg) return;
    const article = articles.find((a) => a.articleId === matArticleId);
    if (!article) {
      showToast('Seleziona un articolo dal catalogo.', 'error');
      return;
    }
    setSavingMat(true);
    try {
      await addUsedMaterialToAssignment({
        assignment: addingMatForAsg,
        article,
        quantita: Number(matQty.replace(',', '.')),
        actorUid: profile.uid,
        squadEmails: selectedTask?.assignedEmails,
        directory,
      });
      showToast('Materiale aggiunto al task.', 'success');
      setAddingMatForAsg(null);
      setMatArticleId('');
      setMatQty('1');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore inserimento materiale.',
        'error'
      );
    } finally {
      setSavingMat(false);
    }
  };

  const handleAdminPhotoConfirmUpload = async () => {
    if (
      !profile ||
      !pendingPhotoTarget ||
      pendingPhotoFiles.length === 0 ||
      !selectedTask
    ) {
      return;
    }
    setUploadingPhoto(true);
    setPhotoUploadProgress({
      current: 1,
      total: pendingPhotoFiles.length,
      fileName: pendingPhotoFiles[0].name,
    });
    try {
      const accessToken = await connectGoogleWorkspace();
      const { uploadedCount, failedFiles } =
        await uploadMultipleInterventionPhotosToDrive({
          accessToken,
          files: pendingPhotoFiles,
          masterFolderId: settings.driveSharedFolderId,
          commessa: selectedTask.commessa,
          taskCode: selectedTask.taskCode,
          uploaderEmail: profile.email,
          onProgress: (prog) => setPhotoUploadProgress(prog),
          onFileUploaded: async (uploaded) => {
            await recordInterventionPhoto({
              assignment: pendingPhotoTarget,
              actorUid: profile.uid,
              fileName: uploaded.fileName,
              driveFileId: uploaded.driveFileId,
              driveWebViewLink: uploaded.driveWebViewLink,
              driveThumbnailLink: uploaded.driveThumbnailLink,
              folderPath: uploaded.folderPath,
              driveSubfolderId: uploaded.driveSubfolderId,
              ownerConsolidated: uploaded.ownerConsolidated,
              squadEmails: selectedTask.assignedEmails,
              directory,
              caption: photoCaption,
            });
          },
        });

      if (failedFiles.length === 0) {
        showToast(
          uploadedCount === 1
            ? 'Foto archiviata nella cartella centrale Google Drive SITE.'
            : `${uploadedCount} foto archiviate nella cartella centrale Google Drive SITE.`,
          'success'
        );
        setPendingPhotoFiles([]);
        setPendingPhotoTarget(null);
        setPhotoCaption('');
      } else {
        showToast(
          `Caricate ${uploadedCount} foto su ${pendingPhotoFiles.length}. ${failedFiles.length} non riuscite.`,
          'error'
        );
        const failedNames = new Set(failedFiles.map((f) => f.fileName));
        setPendingPhotoFiles((prev) =>
          prev.filter((file) => failedNames.has(file.name))
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore caricamento foto.',
        'error'
      );
    } finally {
      setUploadingPhoto(false);
      setPhotoUploadProgress(null);
    }
  };

  const shiftPeriod = (direction: -1 | 1) => {
    setHoveredDayMs(null);
    setAnchorDate((prev) => {
      const next = new Date(prev);
      if (displayMode === 'month') {
        next.setMonth(prev.getMonth() + direction, 1);
      } else if (displayMode === 'week') {
        next.setDate(prev.getDate() + direction * 7);
      } else {
        next.setDate(prev.getDate() + direction);
      }
      next.setHours(0, 0, 0, 0);
      return next;
    });
  };

  const activeCategories = useMemo(
    () =>
      Array.from(
        new Set(articles.filter((a) => a.active).map((a) => a.categoria))
      ),
    [articles]
  );

  const filteredCatalogForModal = useMemo(
    () =>
      articles.filter(
        (a) => a.active && (!matCategory || a.categoria === matCategory)
      ),
    [articles, matCategory]
  );

  const unassignedCount = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.statoPrevalente === 'Non Assegnato' || t.assignedEmails.length === 0
      ).length,
    [tasks]
  );
  const inProgressCount = useMemo(
    () => tasks.filter((t) => t.statoPrevalente === 'Preso in Carico').length,
    [tasks]
  );
  const completedCount = useMemo(
    () => tasks.filter((t) => t.statoPrevalente === 'Completato').length,
    [tasks]
  );

  const kpiQueueTasks = useMemo(() => {
    const todayMs = startOfDayMs(nowTick);
    return tasks.filter((t) => {
      if (kpiQueueFilter === 'PENDING_REVIEW') return Boolean(t.pendingAdminReview);
      if (kpiQueueFilter === 'TODAY') return taskOccursOnDay(t, todayMs);
      if (kpiQueueFilter === 'UNASSIGNED') {
        return (
          t.statoPrevalente === 'Non Assegnato' || t.assignedEmails.length === 0
        );
      }
      if (kpiQueueFilter === 'IN_PROGRESS') {
        return t.statoPrevalente === 'Preso in Carico';
      }
      if (kpiQueueFilter === 'COMPLETED') {
        return t.statoPrevalente === 'Completato';
      }
      return true;
    });
  }, [tasks, kpiQueueFilter, nowTick]);

  const draftSyntheticTask = useMemo<Task | null>(() => {
    if (
      !taskModalOpen ||
      editingTask ||
      altroReparto ||
      !taskModalWindow.inizioMs ||
      taskModalWindow.fineMs < taskModalWindow.inizioMs + 1800000
    ) {
      return null;
    }
    return {
      taskId: '__DRAFT__',
      taskCode: 'NUOVO',
      commessa: commessa.trim(),
      altroReparto,
      colorId: taskColorId,
      descrizione: descrizione.trim() || 'Nuovo intervento',
      inizio: '',
      fine: '',
      inizioMs: taskModalWindow.inizioMs,
      fineMs: taskModalWindow.fineMs,
      assignedEmails: selectedEmails,
      assignedNames: buildAssigneesFromEmails(selectedEmails).map(
        (a) => a.fullName
      ),
      statoPrevalente:
        selectedEmails.length > 0 ? 'Assegnato' : 'Non Assegnato',
      adminUids: currentAdminUids,
      createdByUid: profile?.uid || '',
    };
  }, [
    taskModalOpen,
    editingTask,
    altroReparto,
    taskModalWindow,
    commessa,
    taskColorId,
    descrizione,
    selectedEmails,
    buildAssigneesFromEmails,
    currentAdminUids,
    profile?.uid,
  ]);

  // Columns definition for 24h Interactive Grid
  const gridColumns = useMemo(() => {
    if (displayMode === 'week') {
      return weekDays.map((day) => {
        const dMs = startOfDayMs(day);
        const allDayTasksCount = filteredTasks.filter((t) =>
          taskOccursOnDay(t, dMs)
        ).length;
        // Vertical 24h grid only renders classic 1–2 day tasks (multi-day >=3d & Altro AT sit in top strip)
        const verticalTasks = filteredTasks.filter(
          (t) => !isTopStripTask(t) && taskOccursOnDay(t, dMs)
        );
        const hourlyAbsences = filteredAbsences.filter(
          (a) => !isTopStripAbsence(a) && absenceOccursOnDay(a, dMs)
        );
        const weekdayShort = new Intl.DateTimeFormat('it-IT', {
          weekday: 'short',
        }).format(day);
        return {
          colKey: `week_${dMs}`,
          dayMs: dMs,
          techEmail: undefined as string | undefined,
          headerKicker: weekdayShort,
          headerTitle: `${day.getDate()}/${day.getMonth() + 1}`,
          headerSub: `${allDayTasksCount} task`,
          isAbsentHeader: false,
          isTodayCol: isSameDay(dMs, nowTick),
          isSelectedCol: isSameDay(dMs, anchorDate.getTime()),
          isInspectedCol: isSameDay(dMs, inspectedDayMs),
          tasks: verticalTasks,
          hourlyAbsences,
          topMarginalTasks: [] as Task[],
          topMarginalAbsences: [] as Absence[],
        };
      });
    }

    const dayMs = startOfDayMs(anchorDate);
    const dayTasksAll = filteredTasks.filter((t) => taskOccursOnDay(t, dayMs));
    const dayAbsencesAll = filteredAbsences.filter((a) =>
      absenceOccursOnDay(a, dayMs)
    );

    const techCols = activeTechnicians.map((tech) => {
      const emailLower = tech.email.toLowerCase();
      const techAllTasks = dayTasksAll.filter((t) =>
        t.assignedEmails.some((em) =>
          areSameTechnicianEmails(em, emailLower, directory)
        )
      );
      const verticalTasks = techAllTasks.filter((t) => !isTopStripTask(t));
      const topMarginalTasks = techAllTasks.filter((t) => isTopStripTask(t));

      const techAbsences = dayAbsencesAll.filter((a) =>
        areSameTechnicianEmails(a.technicianEmail, emailLower, directory)
      );
      const topMarginalAbsences = techAbsences.filter((a) =>
        isTopStripAbsence(a)
      );
      const hourlyAbsences = techAbsences.filter((a) => !isTopStripAbsence(a));

      const topAbs = topMarginalAbsences[0];
      const headerSub =
        topAbs
          ? isNonAbsenceEntryType(topAbs.tipo)
            ? topAbs.tipo
            : `Assente (${topAbs.tipo})`
          : techAllTasks.length === 0
            ? hourlyAbsences.length > 0
              ? isNonAbsenceEntryType(hourlyAbsences[0].tipo)
                ? hourlyAbsences[0].tipo
                : `${hourlyAbsences[0].tipo} orario`
              : 'Libero'
            : `${techAllTasks.length} interventi`;

      return {
        colKey: `day_tech_${emailLower}`,
        dayMs,
        techEmail: emailLower,
        headerKicker: tech.role === 'admin' ? 'Admin' : 'Tecnico',
        headerTitle: `${tech.nome} ${tech.cognome}`,
        headerSub,
        isAbsentHeader: topMarginalAbsences.some(
          (a) => !isNonAbsenceEntryType(a.tipo)
        ),
        isTodayCol: isSameDay(dayMs, nowTick),
        isSelectedCol: false,
        isInspectedCol: false,
        tasks: verticalTasks,
        hourlyAbsences,
        topMarginalTasks,
        topMarginalAbsences,
      };
    });

    const unassignedAll = dayTasksAll.filter(
      (t) => t.assignedEmails.length === 0
    );

    techCols.push({
      colKey: `day_tech_${UNASSIGNED_COL_ID}`,
      dayMs,
      techEmail: UNASSIGNED_COL_ID,
      headerKicker: 'Coda',
      headerTitle: 'Da Assegnare',
      headerSub: `${unassignedAll.length} task`,
      isAbsentHeader: false,
      isTodayCol: isSameDay(dayMs, nowTick),
      isSelectedCol: false,
      isInspectedCol: false,
      tasks: unassignedAll.filter((t) => !isTopStripTask(t)),
      hourlyAbsences: [],
      topMarginalTasks: unassignedAll.filter((t) => isTopStripTask(t)),
      topMarginalAbsences: [],
    });

    return techCols;
  }, [
    displayMode,
    weekDays,
    anchorDate,
    filteredTasks,
    filteredAbsences,
    activeTechnicians,
    nowTick,
    inspectedDayMs,
    directory,
  ]);

  const hasDayModeTopMarginalItems = useMemo(
    () =>
      displayMode === 'day' &&
      gridColumns.some(
        (c) => c.topMarginalTasks.length > 0 || c.topMarginalAbsences.length > 0
      ),
    [displayMode, gridColumns]
  );

  const hours24 = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const nowDate = new Date(nowTick);
  const nowMinutesOfDay = nowDate.getHours() * 60 + nowDate.getMinutes();

  const periodLabel = useMemo(() => {
    if (displayMode === 'week') {
      return `${formatDateIt(weekDays[0].getTime())} – ${formatDateIt(
        weekDays[6].getTime()
      )}`;
    }
    if (displayMode === 'month') {
      return new Intl.DateTimeFormat('it-IT', {
        month: 'long',
        year: 'numeric',
      }).format(anchorDate);
    }
    return formatDateIt(anchorDate.getTime());
  }, [displayMode, weekDays, anchorDate]);

  const weekBadgeLabel = useMemo(() => {
    if (displayMode === 'week') {
      return formatCalendarWeekBadgeIt(weekDays);
    }
    if (displayMode === 'month') {
      const firstOfMonth = new Date(
        anchorDate.getFullYear(),
        anchorDate.getMonth(),
        1
      );
      const lastOfMonth = new Date(
        anchorDate.getFullYear(),
        anchorDate.getMonth() + 1,
        0
      );
      return formatCalendarWeekBadgeIt([firstOfMonth, lastOfMonth]);
    }
    return formatCalendarWeekBadgeIt([anchorDate]);
  }, [displayMode, weekDays, anchorDate]);

  const selectedTaskAssignments = useMemo(
    () =>
      selectedTask ? assignmentsByTask.get(selectedTask.taskId) || [] : [],
    [selectedTask, assignmentsByTask]
  );

  const selectedTaskMaterials = useMemo(
    () => (selectedTask ? materialsByTask.get(selectedTask.taskId) || [] : []),
    [selectedTask, materialsByTask]
  );

  const selectedTaskPhotos = useMemo(
    () => (selectedTask ? photosByTask.get(selectedTask.taskId) || [] : []),
    [selectedTask, photosByTask]
  );

  const selectedTaskDriveFolderUrl = useMemo(() => {
    const subId = selectedTaskPhotos.find(
      (p) => p.driveSubfolderId
    )?.driveSubfolderId;
    if (subId) {
      return `https://drive.google.com/drive/folders/${subId}`;
    }
    const masterId = extractDriveFolderId(
      settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
    );
    return `https://drive.google.com/drive/folders/${masterId}`;
  }, [selectedTaskPhotos, settings.driveSharedFolderId]);

  useEffect(() => {
    const el = floatingModalRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const h = el.offsetHeight;
      if (h > 0) {
        setFloatingModalHeight(h);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    taskModalOpen,
    selectedTaskId,
    selectedTaskAssignments.length,
    selectedTaskMaterials.length,
    selectedTaskPhotos.length,
  ]);

  const floatingModalStyle = useMemo<React.CSSProperties>(() => {
    const MODAL_W = 408;
    const MARGIN = 16;
    const GAP = 8;
    const vw = viewportSize.width;
    const vh = viewportSize.height;
    const effectiveW = Math.min(MODAL_W, vw - MARGIN * 2);
    const calRect =
      calendarContainerRef.current?.getBoundingClientRect() || null;

    if (!floatingAnchorRect) {
      const fallbackLeft = calRect
        ? calRect.left + Math.max(MARGIN, (calRect.width - effectiveW) / 2)
        : (vw - effectiveW) / 2;
      return {
        left: `${Math.round(
          Math.max(MARGIN, Math.min(vw - effectiveW - MARGIN, fallbackLeft))
        )}px`,
        top: `${Math.round(
          Math.max(
            MARGIN,
            Math.min(
              72,
              vh - Math.min(floatingModalHeight, vh - MARGIN * 2) - MARGIN
            )
          )
        )}px`,
      };
    }

    const canvasLeft = calRect ? Math.max(MARGIN, calRect.left + 8) : MARGIN;
    const canvasRight = calRect
      ? Math.min(vw - MARGIN, calRect.right - 8)
      : vw - MARGIN;

    const rightCandidate = floatingAnchorRect.right + GAP;
    const leftCandidate = floatingAnchorRect.left - GAP - effectiveW;

    let chosenLeft: number;
    if (rightCandidate + effectiveW <= canvasRight) {
      chosenLeft = rightCandidate;
    } else if (leftCandidate >= canvasLeft) {
      chosenLeft = leftCandidate;
    } else if (leftCandidate >= MARGIN) {
      chosenLeft = leftCandidate;
    } else if (rightCandidate + effectiveW <= vw - MARGIN) {
      chosenLeft = rightCandidate;
    } else {
      chosenLeft = Math.max(
        MARGIN,
        Math.min(vw - effectiveW - MARGIN, rightCandidate)
      );
    }

    const boundedModalH = Math.min(floatingModalHeight, vh - MARGIN * 2);
    const idealTop = floatingAnchorRect.top - 8;
    const chosenTop = Math.max(
      MARGIN,
      Math.min(idealTop, vh - boundedModalH - MARGIN)
    );

    return {
      left: `${Math.round(chosenLeft)}px`,
      top: `${Math.round(chosenTop)}px`,
    };
  }, [floatingAnchorRect, viewportSize, floatingModalHeight]);

  const handleDropTechOnFormModal = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setFloatingDropActive(false);

    const raw = e.dataTransfer.getData(TECH_DRAG_MIME);
    if (!raw) return;
    try {
      const tech = JSON.parse(raw) as DraggedTechPayload;
      const norm = tech.email.toLowerCase();
      if (selectedEmails.includes(norm)) {
        showToast(`${tech.fullName} è già selezionato nella squadra.`, 'info');
        return;
      }
      if (selectedEmails.length >= 10) {
        showToast('Limite massimo di 10 tecnici raggiunto.', 'error');
        return;
      }
      if (modalAbsentConflictsByEmail.has(norm) && !forceAbsentOverride) {
        setForceAbsentOverride(true);
      }
      setSelectedEmails((prev) =>
        prev.includes(norm) ? prev : [...prev, norm]
      );
      showToast(`${tech.fullName} aggiunto alla squadra.`, 'success');
    } catch {
      // Ignore malformed drag payload
    }
  };

  const prepareGmailForTask = (task: Task) => {
    const taskAsgs = assignmentsByTask.get(task.taskId) || [];
    const taskMats = materialsByTask.get(task.taskId) || [];
    const taskPhotos = photosByTask.get(task.taskId) || [];
    const commessaDisplay = formatTaskCommessaLabel(task);

    if (task.statoPrevalente === 'Completato') {
      const summary = buildTaskCompletionEmailSummary({
        task,
        completedByName:
          `${profile?.nome || ''} ${profile?.cognome || ''}`.trim() ||
          profile?.email ||
          'Admin',
        completedByReplyToEmail: currentUserReplyToEmail,
        commessa: task.commessa,
        taskCode: task.taskCode,
        descrizioneTask: task.descrizione,
        inizioMs: task.inizioMs,
        fineMs: task.fineMs,
        squadAssignments: taskAsgs,
        taskMaterials: taskMats,
        taskPhotos,
        activeAdminEmails,
        resolveDeliverableEmail,
        masterFolderId: settings.driveSharedFolderId,
      });
      onOpenEmailModal(summary);
      return;
    }

    const adminRecipients =
      activeAdminEmails.length > 0
        ? activeAdminEmails.join(', ')
        : BOOTSTRAPPED_ADMIN_EMAILS.join(', ');

    const squadEntries = task.assignedEmails.map((loginEm, idx) => {
      const cleanLogin = loginEm.trim().toLowerCase();
      const resolved = resolveDeliverableEmail(cleanLogin);
      const stored = (task.assignedDeliverableEmails?.[idx] || '')
        .trim()
        .toLowerCase();
      const deliverable =
        resolved && !isLoginOnlyIdEmail(resolved)
          ? resolved
          : stored && !isLoginOnlyIdEmail(stored)
            ? stored
            : resolved || cleanLogin;
      return {
        loginEmail: cleanLogin,
        name: task.assignedNames[idx] || cleanLogin,
        deliverable,
      };
    });

    const deliverableSquadEmails = Array.from(
      new Set(squadEntries.map((s) => s.deliverable).filter(Boolean))
    );
    const unconfiguredIdMembers = squadEntries
      .filter((s) => isLoginOnlyIdEmail(s.deliverable))
      .map((s) => ({ name: s.name, loginEmail: s.loginEmail }));

    const matLines =
      taskMats.length > 0
        ? taskMats
          .map(
            (m) =>
              `- ${m.quantita} ${m.unitaMisura} x ${m.codiceArticolo} (${m.descrizioneArticolo}) [${m.technicianName}]`
          )
          .join('\n')
        : 'Nessun materiale registrato.';
    const noteLines =
      taskAsgs.filter((a) => a.noteTecnico.trim()).length > 0
        ? taskAsgs
          .filter((a) => a.noteTecnico.trim())
          .map((a) => `- ${a.technicianName}: ${a.noteTecnico}`)
          .join('\n')
        : 'Nessuna nota presente.';

    onOpenEmailModal({
      to: adminRecipients,
      cc: deliverableSquadEmails.join(', '),
      requiredCcCount: deliverableSquadEmails.length,
      unconfiguredIdMembers,
      subject: `[SITE Interventi] ${task.taskCode} - ${commessaDisplay} (${task.statoPrevalente})`,
      contextTitle: `${task.taskCode} · ${commessaDisplay}`,
      bodyText: `Riepilogo Intervento ${task.taskCode}\nCommessa: ${commessaDisplay}\nDescrizione: ${task.descrizione}\nOrario: ${formatDateTimeIt(
        task.inizioMs
      )} - ${formatDateTimeIt(task.fineMs)}\nStato: ${task.statoPrevalente
        }\nSquadra: ${task.assignedNames.join(', ') || 'Non assegnata'
        }\n\nNote Tecnici:\n${noteLines}\n\nMateriali Utilizzati:\n${matLines}`,
    });
  };

  return (
    <div className="h-full min-h-0 flex flex-col lg:flex-row gap-4">
      {/* =====================================================================
          LEFT PRIMARY COLUMN: COMPACT TOOLBAR + FULL-HEIGHT CALENDAR (100% H)
         ===================================================================== */}
      <div
        ref={calendarContainerRef}
        className="flex-1 min-w-0 min-h-0 h-full flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden"
      >
        {/* Compact Calendar Control Bar */}
        <div className="shrink-0 px-4 py-2 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-white">
          <div className="flex flex-wrap items-center gap-2">
            {/* Segmented View Switcher */}
            <div className="inline-flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setHoveredDayMs(null);
                  setDisplayMode('day');
                }}
                className={`min-h-[32px] px-2 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${displayMode === 'day'
                    ? 'bg-slate-900 text-white border-slate-950'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                Giorno · Tecnici
              </button>
              <button
                type="button"
                onClick={() => {
                  setHoveredDayMs(null);
                  setDisplayMode('week');
                }}
                className={`min-h-[32px] px-2 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${displayMode === 'week'
                    ? 'bg-slate-900 text-white border-slate-950'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                Settimana
              </button>
              <button
                type="button"
                onClick={() => {
                  setHoveredDayMs(null);
                  setDisplayMode('month');
                }}
                className={`min-h-[32px] px-2 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${displayMode === 'month'
                    ? 'bg-slate-900 text-white border-slate-950'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                Mese
              </button>
              <button
                type="button"
                onClick={() => {
                  setHoveredDayMs(null);
                  setDisplayMode('list');
                }}
                className={`inline-flex items-center gap-2 min-h-[32px] px-2 py-2 text-xs font-semibold rounded-lg border transition-colors whitespace-nowrap cursor-pointer ${displayMode === 'list'
                    ? 'bg-slate-900 text-white border-slate-950'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                <List className="w-3.5 h-3.5" />
                <span>Elenco</span>
              </button>
            </div>

            {displayMode !== 'list' && (
              <div className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => shiftPeriod(-1)}
                  className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-slate-800 cursor-pointer"
                  aria-label="Periodo precedente"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    setHoveredDayMs(null);
                    setAnchorDate(today);
                  }}
                  className="min-h-[32px] px-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 whitespace-nowrap cursor-pointer"
                >
                  Oggi
                </button>
                <button
                  type="button"
                  onClick={() => shiftPeriod(1)}
                  className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-slate-800 cursor-pointer"
                  aria-label="Periodo successivo"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                <span className="font-mono text-xs font-semibold text-slate-800 capitalize tabular-nums whitespace-nowrap">
                  {periodLabel}
                </span>
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
                <span className="font-mono text-xs font-semibold text-slate-600 tabular-nums whitespace-nowrap">
                  {weekBadgeLabel}
                </span>
                {(() => {
                  const targetMs =
                    displayMode === 'week' && hoveredDayMs !== null
                      ? hoveredDayMs
                      : anchorDate.getTime();
                  const oc = resolveOnCallSummaryForDate(
                    onCallShifts,
                    onCallOverrides,
                    targetMs
                  );
                  const techShort = oc.techEffectiveName
                    ? formatCompactTechNames([oc.techEffectiveName]) ||
                    oc.techEffectiveName
                    : '';
                  const asstShort = oc.assistantEffectiveName
                    ? formatCompactTechNames([oc.assistantEffectiveName]) ||
                    oc.assistantEffectiveName
                    : '';

                  return (
                    <div className="inline-flex items-center gap-1.5 ml-1">
                      <button
                        type="button"
                        onClick={() =>
                          setOnCallModalState({
                            dayMs: targetMs,
                            group: 'technicians',
                          })
                        }
                        title={
                          oc.techShift
                            ? `Reperibile Tecnico: ${oc.techEffectiveName}${oc.techIsSubstituted
                              ? ` (sostituisce ${oc.techShift.technicianName})`
                              : ''
                            }\nClicca per modificare o inserire sostituzione`
                            : 'Clicca per assegnare il Tecnico reperibile di questa settimana'
                        }
                        className={`inline-flex items-center gap-1.5 min-h-[28px] px-2.5 py-1 rounded-lg border text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${oc.techIsSubstituted
                            ? 'bg-amber-50 text-amber-950 border-amber-300 hover:bg-amber-100'
                            : techShort
                              ? 'bg-sky-50 text-sky-950 border-sky-200 hover:bg-sky-100'
                              : 'bg-white text-slate-600 border-dashed border-slate-300 hover:bg-slate-50'
                          }`}
                      >
                        <PhoneCall className="w-3.5 h-3.5 shrink-0 opacity-80" />
                        <span>
                          {techShort
                            ? `Reperibile: ${oc.techIsSubstituted ? '↻ ' : ''}${techShort}`
                            : '+ Reperibile'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          setOnCallModalState({
                            dayMs: targetMs,
                            group: 'coordinators',
                          })
                        }
                        title={
                          oc.assistantShift
                            ? `Assistente (AT): ${oc.assistantEffectiveName}${oc.assistantIsSubstituted
                              ? ` (sostituisce ${oc.assistantShift.technicianName})`
                              : ''
                            }\nClicca per modificare o inserire sostituzione`
                            : 'Clicca per assegnare l’Assistente (AT) di questa settimana'
                        }
                        className={`inline-flex items-center gap-1.5 min-h-[28px] px-2.5 py-1 rounded-lg border text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${oc.assistantIsSubstituted
                            ? 'bg-amber-50 text-amber-950 border-amber-300 hover:bg-amber-100'
                            : asstShort
                              ? 'bg-violet-50 text-violet-950 border-violet-200 hover:bg-violet-100'
                              : 'bg-white text-slate-600 border-dashed border-slate-300 hover:bg-slate-50'
                          }`}
                      >
                        <Headphones className="w-3.5 h-3.5 shrink-0 opacity-80" />
                        <span>
                          {asstShort
                            ? `AT: ${oc.assistantIsSubstituted ? '↻ ' : ''}${asstShort}`
                            : '+ AT'}
                        </span>
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {pendingReviewTasksCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  setKpiQueueFilter('PENDING_REVIEW');
                  setShowKpiQueueDrawer(true);
                }}
                className="inline-flex items-center gap-2 min-h-[32px] px-2 py-2 rounded-lg border border-slate-400 bg-slate-100 text-xs font-semibold text-slate-900 hover:bg-slate-200 transition-colors whitespace-nowrap cursor-pointer"
                title="Task inseriti in autonomia dai tecnici in attesa di commessa"
              >
                <ClipboardCheck className="w-3.5 h-3.5 text-slate-700" />
                <span>Da revisionare · {pendingReviewTasksCount}</span>
              </button>
            )}

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Cerca commessa, tecnico..."
                className="w-36 xl:w-44 min-h-[32px] pl-8 pr-2 py-2 rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as StatusFilterMode)
              }
              aria-label="Filtra stato task"
              className="min-h-[32px] px-2 py-2 rounded-lg border border-slate-300 text-xs font-normal text-slate-800 bg-white focus:outline-none focus:border-slate-900"
            >
              <option value="ALL">Tutti gli stati</option>
              <option value="PENDING_REVIEW">
                Da revisionare ({pendingReviewTasksCount})
              </option>
              <option value="Non Assegnato">Non Assegnato</option>
              <option value="Assegnato">Assegnato</option>
              <option value="Preso in Carico">Preso in Carico</option>
              <option value="Completato">Completato</option>
            </select>

            <button
              type="button"
              onClick={() =>
                exportTasksSummaryCsv(
                  filteredTasks,
                  assignmentsByTask,
                  materialsByTask
                )
              }
              className="inline-flex items-center gap-2 min-h-[32px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors whitespace-nowrap cursor-pointer"
              title="Esporta elenco CSV"
            >
              <Download className="w-3.5 h-3.5" />
              <span>CSV</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (!hasConfiguredSheet) {
                  showToast(
                    'Configura prima il link del foglio Google Sheet nella scheda Tecnici & Impostazioni.',
                    'info'
                  );
                  return;
                }
                setConfirmWeekSyncOpen(true);
              }}
              className="inline-flex items-center gap-2 min-h-[32px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors whitespace-nowrap cursor-pointer shrink-0"
              title={`Sincronizza task approvati e assenze della settimana ${visibleWeekCode} sul foglio Google Sheet`}
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>Foglio {visibleWeekCode}</span>
            </button>

            <button
              type="button"
              onClick={() => openNewAbsenceModal()}
              className="inline-flex items-center gap-2 min-h-[32px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors whitespace-nowrap cursor-pointer shrink-0"
              title="Segna ferie, permesso o malattia per un tecnico"
            >
              <CalendarOff className="w-3.5 h-3.5" />
              <span>Assenza</span>
            </button>

            <button
              type="button"
              onClick={() => openNewTaskModal()}
              className="inline-flex items-center gap-2 min-h-[32px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Nuovo Task</span>
            </button>
          </div>
        </div>

        {/* ===================================================================
            WEEK & DAY·TECHNICIANS 00:00–24:00 SCROLLABLE GRID
           =================================================================== */}
        {(displayMode === 'week' || displayMode === 'day') && (
          <div className="flex-1 min-h-0 flex flex-col select-none overflow-hidden">
            <div
              ref={gridScrollRef}
              className="flex-1 min-h-0 overflow-auto relative"
            >
              <div
                style={{
                  minWidth:
                    displayMode === 'day'
                      ? `${Math.max(760, 56 + gridColumns.length * 175)}px`
                      : '760px',
                }}
              >
                {/* Sticky Column Headers + Continuous Horizontal Bars Directly Below Date Headers */}
                <div className="sticky top-0 z-30 bg-white border-b border-slate-200">
                  <div className="flex">
                    <div className="w-14 shrink-0 border-r border-slate-200 px-2 py-2 flex items-center justify-center text-[10px] font-mono text-slate-400">
                      Ora
                    </div>

                    <div
                      className="flex-1 grid"
                      style={{
                        gridTemplateColumns: `repeat(${gridColumns.length}, minmax(0, 1fr))`,
                      }}
                    >
                      {gridColumns.map((col) => (
                        <div
                          key={col.colKey}
                          onMouseEnter={() => {
                            if (displayMode === 'week') {
                              setHoveredDayMs(col.dayMs);
                            }
                          }}
                          onMouseMove={() => {
                            if (
                              displayMode === 'week' &&
                              hoveredDayMs !== col.dayMs
                            ) {
                              setHoveredDayMs(col.dayMs);
                            }
                          }}
                          onClick={() => {
                            if (displayMode === 'week') {
                              setHoveredDayMs(col.dayMs);
                              setAnchorDate(new Date(col.dayMs));
                            }
                          }}
                          onDoubleClick={() => {
                            if (displayMode === 'week') {
                              setHoveredDayMs(null);
                              setAnchorDate(new Date(col.dayMs));
                              setDisplayMode('day');
                            }
                          }}
                          className={`px-2 py-2 border-r last:border-r-0 border-slate-200 flex items-center justify-between gap-2 transition-colors ${displayMode === 'week'
                              ? 'cursor-pointer hover:bg-slate-50'
                              : ''
                            } ${col.isInspectedCol
                              ? 'bg-slate-100/70'
                              : col.isSelectedCol
                                ? 'bg-slate-50'
                                : col.isAbsentHeader
                                  ? 'bg-slate-100/50'
                                  : ''
                            }`}
                        >
                          <div className="min-w-0">
                            <p className="text-[10px] font-semibold text-slate-500 capitalize truncate">
                              {col.headerKicker}
                            </p>
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-xs font-semibold truncate ${col.isTodayCol && displayMode === 'week'
                                    ? 'inline-flex items-center justify-center px-2 py-0 rounded-md bg-slate-900 text-white font-mono tabular-nums'
                                    : 'text-slate-900'
                                  }`}
                              >
                                {col.headerTitle}
                              </span>
                              <span
                                className={`text-[10px] font-mono tabular-nums truncate ${col.isAbsentHeader
                                    ? 'text-slate-700 font-semibold'
                                    : 'text-slate-400'
                                  }`}
                              >
                                · {col.headerSub}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const defaultStartMin = 9 * 60;
                              const slotRect = computeSlotAnchorRect(
                                col.colKey,
                                defaultStartMin,
                                defaultStartMin + 120
                              );
                              openNewTaskModal({
                                preselectedEmails:
                                  col.techEmail &&
                                    col.techEmail !== UNASSIGNED_COL_ID
                                    ? [col.techEmail]
                                    : [],
                                startMs: col.dayMs + defaultStartMin * 60000,
                                endMs:
                                  col.dayMs + (defaultStartMin + 120) * 60000,
                                anchorRect: slotRect,
                                draftSlot: {
                                  colKey: col.colKey,
                                  dayMs: col.dayMs,
                                },
                              });
                            }}
                            className="w-6 h-6 rounded-md border border-slate-300 bg-white flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 shrink-0 cursor-pointer"
                            title="Nuovo task in questa colonna"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* WEEK MODE: Continuous Horizontal Bars Directly Underneath Day Dates */}
                  {displayMode === 'week' && weekTopStripPacked.laneCount > 0 && (
                    <div className="flex bg-white max-h-[108px] overflow-y-auto">
                      <div className="w-14 shrink-0 border-r border-slate-200" />
                      <div
                        className="flex-1 relative"
                        style={{
                          height: `${weekTopStripPacked.laneCount * 24 + 4}px`,
                        }}
                      >
                        <div
                          className="absolute inset-0 grid pointer-events-none"
                          style={{
                            gridTemplateColumns: `repeat(${gridColumns.length}, minmax(0, 1fr))`,
                          }}
                        >
                          {gridColumns.map((col) => (
                            <div
                              key={`bg_${col.colKey}`}
                              className="border-r last:border-r-0 border-slate-200"
                            />
                          ))}
                        </div>

                        {weekTopStripPacked.spans.map((span) => {
                          const colCount = gridColumns.length;
                          const leftPct = (span.startCol / colCount) * 100;
                          const widthPct =
                            ((span.endCol - span.startCol + 1) / colCount) * 100;
                          const topPx = span.lane * 24 + 1;

                          if (span.item.kind === 'absence') {
                            const abs = span.item.payload as Absence;
                            const shortName =
                              formatCompactTechNames([abs.technicianName]) ||
                              abs.technicianName;
                            return (
                              <button
                                key={span.item.id}
                                type="button"
                                onClick={() => openEditAbsenceModal(abs)}
                                style={{
                                  top: `${topPx}px`,
                                  left: `calc(${leftPct}% + 2px)`,
                                  width: `calc(${widthPct}% - 4px)`,
                                  height: '21px',
                                }}
                                title={`${formatAbsenceCalendarLabel(abs, {
                                  shortTechName: abs.technicianName,
                                  prefixAssenza: true,
                                })} (${formatAbsenceDateSummary(abs)})${abs.note ? `\nNote: ${abs.note}` : ''
                                  }`}
                                className={`absolute z-10 px-2 border text-[10px] font-semibold truncate flex items-center justify-between gap-2 cursor-pointer transition-colors ${span.continuesBefore
                                    ? 'rounded-l-none'
                                    : 'rounded-l-md'
                                  } ${span.continuesAfter
                                    ? 'rounded-r-none'
                                    : 'rounded-r-md'
                                  } ${getAbsenceToneClasses(abs.tipo).bar}`}
                              >
                                <span className="truncate">
                                  {formatAbsenceCalendarLabel(abs, {
                                    shortTechName: shortName,
                                    prefixAssenza: true,
                                  })}
                                  {abs.note ? ` (${abs.note})` : ''}
                                </span>
                                <span className="font-mono text-[9px] opacity-80 shrink-0 tabular-nums">
                                  {formatDateIt(abs.inizioMs)}
                                </span>
                              </button>
                            );
                          }

                          const t = span.item.payload as Task;
                          const isTechDropHighlighted =
                            techDropHoverTaskId === t.taskId;
                          const isSelectedActive = selectedTaskId === t.taskId;
                          const visual = getTaskEventVisualStyle(t, {
                            operatorColorLabels: settings.operatorColorLabels,
                          });

                          return (
                            <div
                              key={span.item.id}
                              data-task-card-id={t.taskId}
                              onClick={(e) =>
                                selectAndInspectTask(
                                  t.taskId,
                                  e.currentTarget.getBoundingClientRect()
                                )
                              }
                              onDoubleClick={(e) =>
                                t.pendingAdminReview
                                  ? setReviewingTask(t)
                                  : openEditTaskModal(
                                    t,
                                    e.currentTarget.getBoundingClientRect()
                                  )
                              }
                              onDragOver={(e) => {
                                if (
                                  Array.from(e.dataTransfer.types).includes(
                                    TECH_DRAG_MIME
                                  )
                                ) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  e.dataTransfer.dropEffect = 'copy';
                                  setTechDropHoverTaskId(t.taskId);
                                }
                              }}
                              onDragLeave={() => {
                                setTechDropHoverTaskId((prev) =>
                                  prev === t.taskId ? null : prev
                                );
                              }}
                              onDrop={(e) => handleDropTechOnTask(e, t)}
                              style={{
                                top: `${topPx}px`,
                                left: `calc(${leftPct}% + 2px)`,
                                width: `calc(${widthPct}% - 4px)`,
                                height: '21px',
                              }}
                              title={`${formatCalendarEventTitle(
                                t.assignedNames,
                                t.descrizione
                              )}\n${visual.operatorLabel} · ${formatTaskCommessaLabel(
                                t
                              )}\n${formatDateTimeIt(
                                t.inizioMs
                              )} – ${formatDateTimeIt(t.fineMs)}`}
                              className={`absolute z-10 px-2 text-[10px] font-semibold truncate flex items-center justify-between gap-2 cursor-pointer transition-colors ${span.continuesBefore
                                  ? 'rounded-l-none'
                                  : 'rounded-l-md'
                                } ${span.continuesAfter
                                  ? 'rounded-r-none'
                                  : 'rounded-r-md'
                                } ${visual.cardClassName} ${isTechDropHighlighted || isSelectedActive
                                  ? 'ring-2 ring-slate-900 z-20'
                                  : ''
                                }`}
                            >
                              <span className="truncate min-w-0">
                                {formatCalendarEventTitle(
                                  t.assignedNames,
                                  t.descrizione
                                )}
                              </span>
                              <span
                                className={`font-mono text-[9px] font-semibold shrink-0 ${visual.subtleMetaClassName}`}
                              >
                                {formatTaskCommessaLabel(t)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* DAY MODE: Per-Technician Top Items Directly Underneath Technician Headers */}
                  {hasDayModeTopMarginalItems && (
                    <div className="flex bg-white">
                      <div className="w-14 shrink-0 border-r border-slate-200" />
                      <div
                        className="flex-1 grid"
                        style={{
                          gridTemplateColumns: `repeat(${gridColumns.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {gridColumns.map((col) => (
                          <div
                            key={`marginal_${col.colKey}`}
                            className="px-2 pb-2 border-r last:border-r-0 border-slate-200 space-y-2"
                          >
                            {col.topMarginalAbsences.map((abs) => (
                              <button
                                key={abs.absenceId}
                                type="button"
                                onClick={() => openEditAbsenceModal(abs)}
                                className={`w-full px-2 py-0 rounded border text-[9.5px] font-semibold truncate text-left cursor-pointer ${getAbsenceToneClasses(abs.tipo).bar
                                  }`}
                                title={formatAbsenceDateSummary(abs)}
                              >
                                {formatAbsenceCalendarLabel(abs, {
                                  prefixAssenza: true,
                                })}
                                {abs.note ? ` (${abs.note})` : ''}
                              </button>
                            ))}

                            {col.topMarginalTasks.map((t) => {
                              const visual = getTaskEventVisualStyle(t, {
                                operatorColorLabels:
                                  settings.operatorColorLabels,
                              });
                              return (
                                <button
                                  key={t.taskId}
                                  type="button"
                                  data-task-card-id={t.taskId}
                                  onClick={(e) =>
                                    selectAndInspectTask(
                                      t.taskId,
                                      e.currentTarget.getBoundingClientRect()
                                    )
                                  }
                                  className={`w-full px-2 py-0 rounded text-[9.5px] font-semibold truncate text-left flex items-center justify-between gap-2 cursor-pointer ${visual.cardClassName} ${selectedTaskId === t.taskId
                                      ? 'ring-2 ring-slate-900'
                                      : ''
                                    }`}
                                  title={`${t.descrizione} (${visual.operatorLabel} · ${formatTaskCommessaLabel(
                                    t
                                  )})`}
                                >
                                  <span className="truncate min-w-0">
                                    {t.descrizione}
                                  </span>
                                  <span
                                    className={`font-mono text-[8.5px] font-semibold shrink-0 ${visual.subtleMetaClassName}`}
                                  >
                                    {formatTaskCommessaLabel(t)}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* 24-Hour Body Canvas */}
                <div
                  className="flex relative"
                  style={{ height: `${TOTAL_GRID_HEIGHT}px` }}
                >
                  <div className="w-14 shrink-0 border-r border-slate-200 bg-white relative">
                    {hours24.map((h) => (
                      <div
                        key={h}
                        className="relative border-b border-slate-100 pr-2 text-right"
                        style={{ height: `${HOUR_HEIGHT}px` }}
                      >
                        <span className="inline-block -translate-y-2 text-[10px] font-mono text-slate-400 tabular-nums">
                          {h === 0 ? '00:00' : `${String(h).padStart(2, '0')}:00`}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div
                    className="flex-1 grid relative"
                    style={{
                      gridTemplateColumns: `repeat(${gridColumns.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {gridColumns.map((col) => {
                      const { positioned, positionedAbsences } =
                        layoutColumnVerticalItems(
                          col.tasks,
                          col.hourlyAbsences,
                          col.dayMs
                        );

                      const isCreatingHere =
                        pointerOp?.kind === 'create' &&
                        pointerOp.colKey === col.colKey;
                      let createStartMin = 0;
                      let createEndMin = 60;
                      if (isCreatingHere) {
                        const rawMin = Math.min(
                          pointerOp.anchorMin,
                          pointerOp.currentMin
                        );
                        const rawMax =
                          Math.max(pointerOp.anchorMin, pointerOp.currentMin) +
                          SNAP_MINUTES;
                        createStartMin = Math.min(23 * 60, rawMin);
                        createEndMin = Math.min(
                          24 * 60,
                          Math.max(
                            createStartMin + MIN_DURATION_MINUTES,
                            rawMax
                          )
                        );
                      }

                      const isMoveTargetHere =
                        pointerOp?.kind === 'move' &&
                        pointerOp.moved &&
                        pointerOp.targetColKey === col.colKey;

                      const isTechHoverHere =
                        techDropHoverSlot?.colKey === col.colKey;

                      const showDraftHere =
                        !isCreatingHere &&
                        Boolean(draftSyntheticTask) &&
                        !isTopStripTask(draftSyntheticTask!) &&
                        taskOccursOnDay(draftSyntheticTask!, col.dayMs) &&
                        (displayMode === 'week' ||
                          (draftCreateSlot
                            ? draftCreateSlot.colKey === col.colKey
                            : col.techEmail === UNASSIGNED_COL_ID
                              ? selectedEmails.length === 0
                              : Boolean(
                                col.techEmail &&
                                selectedEmails.includes(col.techEmail)
                              )));

                      return (
                        <div
                          key={col.colKey}
                          data-cal-col-key={col.colKey}
                          data-cal-day-ms={col.dayMs}
                          data-cal-tech-email={col.techEmail || ''}
                          onMouseEnter={() => {
                            if (displayMode === 'week') {
                              setHoveredDayMs(col.dayMs);
                            }
                          }}
                          onMouseMove={() => {
                            if (
                              displayMode === 'week' &&
                              hoveredDayMs !== col.dayMs
                            ) {
                              setHoveredDayMs(col.dayMs);
                            }
                          }}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            if (displayMode === 'week') {
                              setHoveredDayMs(col.dayMs);
                            }
                            if (
                              (e.target as HTMLElement).closest(
                                '[data-cal-event-card="true"]'
                              )
                            ) {
                              return;
                            }
                            e.preventDefault();
                            const rect =
                              e.currentTarget.getBoundingClientRect();
                            const relY = e.clientY - rect.top;
                            const startSlot = Math.max(
                              0,
                              Math.min(
                                23 * 60,
                                Math.floor(
                                  ((relY / HOUR_HEIGHT) * 60) / SNAP_MINUTES
                                ) * SNAP_MINUTES
                              )
                            );
                            setPointerOp({
                              kind: 'create',
                              colKey: col.colKey,
                              dayMs: col.dayMs,
                              techEmail: col.techEmail,
                              anchorMin: startSlot,
                              currentMin: startSlot,
                              startY: e.clientY,
                              hasDragged: false,
                            });
                          }}
                          onDragOver={(e) => {
                            if (
                              displayMode === 'week' &&
                              hoveredDayMs !== col.dayMs
                            ) {
                              setHoveredDayMs(col.dayMs);
                            }
                            if (
                              Array.from(e.dataTransfer.types).includes(
                                TECH_DRAG_MIME
                              )
                            ) {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = 'copy';
                              const rect =
                                e.currentTarget.getBoundingClientRect();
                              const relY = e.clientY - rect.top;
                              const slotMin = Math.max(
                                0,
                                Math.min(
                                  22 * 60,
                                  snapMinutesToStep((relY / HOUR_HEIGHT) * 60)
                                )
                              );
                              setTechDropHoverSlot({
                                colKey: col.colKey,
                                startMin: slotMin,
                              });
                            }
                          }}
                          onDragLeave={(e) => {
                            if (
                              !e.currentTarget.contains(
                                e.relatedTarget as Node | null
                              )
                            ) {
                              setTechDropHoverSlot((prev) =>
                                prev?.colKey === col.colKey ? null : prev
                              );
                            }
                          }}
                          onDrop={(e) =>
                            handleDropTechOnColumnSlot(
                              e,
                              col.dayMs,
                              col.techEmail
                            )
                          }
                          className={`relative border-r last:border-r-0 border-slate-200 cursor-crosshair transition-colors ${col.isAbsentHeader
                              ? 'bg-slate-50/60'
                              : col.isTodayCol
                                ? 'bg-slate-50/40'
                                : col.isInspectedCol
                                  ? 'bg-slate-50/60'
                                  : ''
                            }`}
                          style={{ height: `${TOTAL_GRID_HEIGHT}px` }}
                        >
                          {hours24.map((h) => (
                            <div
                              key={h}
                              className="border-b border-slate-200/80 pointer-events-none relative"
                              style={{ height: `${HOUR_HEIGHT}px` }}
                            >
                              <div
                                className="w-full border-b border-dashed border-slate-100 absolute left-0"
                                style={{ top: `${HOUR_HEIGHT / 2}px` }}
                              />
                            </div>
                          ))}

                          {col.isTodayCol && (
                            <div
                              className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                              style={{
                                top: `${(nowMinutesOfDay / 60) * HOUR_HEIGHT}px`,
                              }}
                            >
                              <span className="w-2 h-2 rounded-full bg-slate-900 -translate-x-1/2 shrink-0" />
                              <div className="h-[2px] bg-slate-900 flex-1" />
                            </div>
                          )}

                          {/* Hourly Absences, Visite Mediche & Assemblee (shared resizable lanes in second plane) */}
                          {positionedAbsences.map((ha) => {
                            const { absence, colIndex, totalCols, colSpan } = ha;
                            const topPx =
                              (ha.startMin / 60) * HOUR_HEIGHT + 1;
                            const heightPx = Math.max(
                              24,
                              ((ha.endMin - ha.startMin) / 60) * HOUR_HEIGHT - 2
                            );
                            const isAtRightEdge =
                              colIndex + colSpan >= totalCols;
                            let leftPct: number;
                            let widthPct: number;
                            if (totalCols <= 1) {
                              leftPct = 0;
                              widthPct = 100;
                            } else {
                              const unitPct = 100 / totalCols;
                              leftPct = colIndex * unitPct;
                              const overlapBonusPct = isAtRightEdge
                                ? 0
                                : Math.min(12, unitPct * 0.3);
                              widthPct = Math.min(
                                100 - leftPct,
                                colSpan * unitPct + overlapBonusPct
                              );
                            }
                            const shortTech =
                              formatCompactTechNames([
                                absence.technicianName,
                              ]) || absence.technicianName;
                            const headerLabel =
                              displayMode === 'week'
                                ? formatAbsenceCalendarLabel(absence, {
                                  shortTechName: shortTech,
                                  prefixAssenza: false,
                                })
                                : formatAbsenceCalendarLabel(absence, {
                                  prefixAssenza: true,
                                });
                            return (
                              <button
                                key={absence.absenceId}
                                type="button"
                                data-cal-event-card="true"
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  openEditAbsenceModal(absence);
                                }}
                                style={{
                                  top: `${topPx}px`,
                                  height: `${heightPx}px`,
                                  left: `calc(${leftPct}% + 1px)`,
                                  width: `calc(${widthPct}% - 2px)`,
                                  zIndex: 8 + colIndex,
                                  transition:
                                    'transform 140ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                                }}
                                title={`${formatAbsenceCalendarLabel(absence, {
                                  shortTechName: absence.technicianName,
                                  prefixAssenza: true,
                                })} (${formatMinutesAsHHMM(
                                  ha.startMin
                                )} – ${formatMinutesAsHHMM(ha.endMin)})`}
                                className={`absolute rounded-lg border border-dashed px-2 py-0.5 text-left overflow-hidden cursor-pointer ring-1 ring-white/90 shadow-xs hover:shadow-md active:scale-[0.985] ${getAbsenceToneClasses(absence.tipo).block
                                  }`}
                              >
                                <p className="text-[9.5px] font-semibold leading-tight truncate">
                                  {headerLabel}
                                </p>
                                <p className="font-mono text-[8.5px] tabular-nums opacity-85 truncate">
                                  {formatMinutesAsHHMM(ha.startMin)} –{' '}
                                  {formatMinutesAsHHMM(ha.endMin)}
                                  {absence.note ? ` · ${absence.note}` : ''}
                                </p>
                              </button>
                            );
                          })}

                          {positioned.map((pos) => {
                            const { task, colIndex, totalCols, colSpan = 1 } =
                              pos;
                            const isBeingResized =
                              pointerOp?.kind === 'resize' &&
                              pointerOp.task.taskId === task.taskId &&
                              pointerOp.colKey === col.colKey;
                            const isBeingMovedAway =
                              pointerOp?.kind === 'move' &&
                              pointerOp.moved &&
                              pointerOp.task.taskId === task.taskId;

                            const effectiveStartMin = pos.startMin;
                            const effectiveEndMin = isBeingResized
                              ? pointerOp.newEndMin
                              : pos.endMin;

                            const topPx =
                              (effectiveStartMin / 60) * HOUR_HEIGHT + 1;
                            const heightPx = Math.max(
                              24,
                              ((effectiveEndMin - effectiveStartMin) / 60) *
                              HOUR_HEIGHT -
                              2
                            );

                            const isAtRightEdge =
                              colIndex + colSpan >= totalCols;
                            let leftPct: number;
                            let widthPct: number;

                            if (totalCols <= 1) {
                              leftPct = 0;
                              widthPct = 100;
                            } else {
                              const unitPct = 100 / totalCols;
                              leftPct = colIndex * unitPct;
                              const overlapBonusPct = isAtRightEdge
                                ? 0
                                : Math.min(14, unitPct * 0.35);
                              widthPct = Math.min(
                                100 - leftPct,
                                colSpan * unitPct + overlapBonusPct
                              );
                            }

                            const isTechDropHighlighted =
                              techDropHoverTaskId === task.taskId;
                            const isSelectedActive =
                              selectedTaskId === task.taskId;
                            const visual = getTaskEventVisualStyle(task, {
                              operatorColorLabels: settings.operatorColorLabels,
                            });

                            return (
                              <div
                                key={`${col.colKey}_${task.taskId}`}
                                data-cal-event-card="true"
                                data-task-card-id={task.taskId}
                                onPointerDown={(e) => {
                                  if (e.button !== 0) return;
                                  e.stopPropagation();
                                  const colRect = (
                                    e.currentTarget
                                      .parentElement as HTMLElement
                                  ).getBoundingClientRect();
                                  const cursorMin =
                                    ((e.clientY - colRect.top) / HOUR_HEIGHT) *
                                    60;
                                  const grabOffsetMin = Math.max(
                                    0,
                                    cursorMin - pos.startMin
                                  );
                                  const durationMin = Math.max(
                                    MIN_DURATION_MINUTES,
                                    Math.round(
                                      (task.fineMs - task.inizioMs) / 60000
                                    )
                                  );
                                  setPointerOp({
                                    kind: 'move',
                                    task,
                                    originColKey: col.colKey,
                                    originTechEmail: col.techEmail,
                                    targetColKey: col.colKey,
                                    targetDayMs: col.dayMs,
                                    targetTechEmail: col.techEmail,
                                    durationMin,
                                    grabOffsetMin,
                                    newStartMin: pos.startMin,
                                    startX: e.clientX,
                                    startY: e.clientY,
                                    moved: false,
                                  });
                                }}
                                onDragOver={(e) => {
                                  if (
                                    Array.from(e.dataTransfer.types).includes(
                                      TECH_DRAG_MIME
                                    )
                                  ) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    e.dataTransfer.dropEffect = 'copy';
                                    setTechDropHoverTaskId(task.taskId);
                                  }
                                }}
                                onDragLeave={() => {
                                  setTechDropHoverTaskId((prev) =>
                                    prev === task.taskId ? null : prev
                                  );
                                }}
                                onDrop={(e) => handleDropTechOnTask(e, task)}
                                className={`group absolute rounded-lg px-2 py-2 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden transition-all cursor-grab active:cursor-grabbing flex flex-col justify-start ring-1 ring-white/90 dark:ring-slate-900/90 ${visual.cardClassName
                                  } ${isBeingMovedAway ? 'opacity-35' : 'opacity-100'
                                  } ${isSelectedActive
                                    ? 'ring-2 ring-slate-900 shadow-xl'
                                    : isTechDropHighlighted
                                      ? 'ring-2 ring-indigo-500 shadow-md'
                                      : 'shadow-xs'
                                  }`}
                                title={`${formatCalendarEventTitle(
                                  task.assignedNames,
                                  task.descrizione
                                )}\n${visual.operatorLabel} · ${formatTaskCommessaLabel(
                                  task
                                )}\n${formatMinutesAsHHMM(
                                  effectiveStartMin
                                )} – ${formatMinutesAsHHMM(effectiveEndMin)}`}
                                style={{
                                  top: `${topPx}px`,
                                  height: `${heightPx}px`,
                                  left: `calc(${leftPct}% + 1px)`,
                                  width: `calc(${widthPct}% - 2px)`,
                                  zIndex: isSelectedActive
                                    ? 35
                                    : isTechDropHighlighted
                                      ? 25
                                      : 15 + colIndex,
                                }}
                              >
                                <div className="min-w-0 space-y-0 pointer-events-none pr-5">
                                  <p className="text-[10px] leading-[1.2] font-semibold whitespace-normal break-words">
                                    {formatCalendarEventTitle(
                                      task.assignedNames,
                                      task.descrizione
                                    )}
                                  </p>
                                  <p
                                    className={`font-mono text-[9px] tabular-nums leading-[1.2] ${visual.subtleMetaClassName}`}
                                  >
                                    {formatMinutesAsHHMM(effectiveStartMin)} –{' '}
                                    {formatMinutesAsHHMM(effectiveEndMin)}
                                  </p>
                                  <p
                                    className={`font-mono text-[9px] font-semibold leading-[1.2] whitespace-normal break-words ${visual.subtleMetaClassName}`}
                                  >
                                    {visual.operatorLabel} ·{' '}
                                    {formatTaskCommessaLabel(task)}
                                  </p>
                                </div>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    openDuplicateTaskModal(
                                      task,
                                      e.currentTarget.parentElement?.getBoundingClientRect()
                                    );
                                  }}
                                  onPointerDown={(e) => {
                                    e.stopPropagation();
                                  }}
                                  className="absolute top-1 right-1 w-5 h-5 rounded flex items-center justify-center bg-white/90 hover:bg-white text-slate-700 shadow-xs opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-20 pointer-events-auto"
                                  title="Copia questo evento in una nuova bozza"
                                >
                                  <Copy className="w-3 h-3 text-slate-700" />
                                </button>

                                <div
                                  onPointerDown={(e) => {
                                    if (e.button !== 0) return;
                                    e.stopPropagation();
                                    e.preventDefault();
                                    setPointerOp({
                                      kind: 'resize',
                                      task,
                                      colKey: col.colKey,
                                      dayMs: col.dayMs,
                                      startMin: pos.startMin,
                                      newEndMin: pos.endMin,
                                      startY: e.clientY,
                                      moved: false,
                                    });
                                  }}
                                  className="absolute bottom-0 left-0 right-0 h-2.5 cursor-ns-resize flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                  title="Trascina per modificare la durata"
                                >
                                  <span className="w-6 h-[3px] rounded-full bg-current opacity-40" />
                                </div>
                              </div>
                            );
                          })}

                          {isCreatingHere && (
                            <div
                              className="absolute left-1 right-1 z-20 rounded-lg border border-slate-900 bg-slate-900/10 px-2 py-2 pointer-events-none"
                              style={{
                                top: `${(createStartMin / 60) * HOUR_HEIGHT}px`,
                                height: `${Math.max(
                                  HOUR_HEIGHT,
                                  ((createEndMin - createStartMin) / 60) *
                                  HOUR_HEIGHT
                                )}px`,
                              }}
                            >
                              <p className="font-mono text-[11px] font-semibold text-slate-900 tabular-nums">
                                {formatMinutesAsHHMM(createStartMin)} –{' '}
                                {formatMinutesAsHHMM(createEndMin)}
                              </p>
                              <p className="text-[11px] font-semibold text-slate-800 truncate">
                                Nuovo task
                              </p>
                            </div>
                          )}

                          {showDraftHere &&
                            draftSyntheticTask &&
                            (() => {
                              const draftMins = getTaskMinutesOnDay(
                                draftSyntheticTask,
                                col.dayMs
                              );
                              const draftVis = getTaskEventVisualStyle(
                                draftSyntheticTask,
                                {
                                  operatorColorLabels:
                                    settings.operatorColorLabels,
                                }
                              );
                              return (
                                <div
                                  className={`absolute left-1 right-1 z-20 rounded-lg px-2 py-2 pointer-events-none overflow-hidden ring-2 ring-slate-900 ${draftVis.cardClassName}`}
                                  style={{
                                    top: `${(draftMins.startMin / 60) * HOUR_HEIGHT +
                                      1
                                      }px`,
                                    height: `${Math.max(
                                      28,
                                      ((draftMins.endMin - draftMins.startMin) /
                                        60) *
                                      HOUR_HEIGHT -
                                      2
                                    )}px`,
                                  }}
                                >
                                  <p className="text-[10px] leading-[1.2] font-semibold whitespace-normal break-words">
                                    {formatCalendarEventTitle(
                                      draftSyntheticTask.assignedNames,
                                      draftSyntheticTask.descrizione
                                    )}
                                  </p>
                                  <p
                                    className={`font-mono text-[9px] tabular-nums leading-[1.2] ${draftVis.subtleMetaClassName}`}
                                  >
                                    {formatMinutesAsHHMM(draftMins.startMin)} –{' '}
                                    {formatMinutesAsHHMM(draftMins.endMin)}
                                  </p>
                                  <p
                                    className={`font-mono text-[9px] font-semibold leading-[1.2] truncate ${draftVis.subtleMetaClassName}`}
                                  >
                                    {draftVis.operatorLabel}
                                    {draftSyntheticTask.commessa
                                      ? ` · ${draftSyntheticTask.commessa}`
                                      : ''}
                                  </p>
                                </div>
                              );
                            })()}

                          {isMoveTargetHere && pointerOp?.kind === 'move' && (
                            <div
                              className="absolute left-1 right-1 z-30 rounded-lg border border-slate-950 bg-slate-900/95 text-white px-2 py-2 pointer-events-none overflow-hidden space-y-0"
                              style={{
                                top: `${(pointerOp.newStartMin / 60) * HOUR_HEIGHT
                                  }px`,
                                height: `${Math.max(
                                  28,
                                  (pointerOp.durationMin / 60) * HOUR_HEIGHT
                                )}px`,
                              }}
                            >
                              <p className="text-[10px] font-semibold leading-[1.2] whitespace-normal break-words">
                                {formatCalendarEventTitle(
                                  pointerOp.task.assignedNames,
                                  pointerOp.task.descrizione
                                )}
                              </p>
                              <p className="font-mono text-[9px] tabular-nums leading-[1.2] opacity-85">
                                {formatMinutesAsHHMM(pointerOp.newStartMin)} –{' '}
                                {formatMinutesAsHHMM(
                                  Math.min(
                                    24 * 60,
                                    pointerOp.newStartMin +
                                    pointerOp.durationMin
                                  )
                                )}
                              </p>
                              <p className="font-mono text-[9px] font-semibold leading-[1.2] opacity-90">
                                {formatTaskCommessaLabel(pointerOp.task)}
                              </p>
                            </div>
                          )}

                          {isTechHoverHere && techDropHoverSlot && (
                            <div
                              className="absolute left-1 right-1 z-20 rounded-lg border border-dashed border-slate-600 bg-slate-100/90 px-2 py-2 pointer-events-none"
                              style={{
                                top: `${(techDropHoverSlot.startMin / 60) *
                                  HOUR_HEIGHT
                                  }px`,
                                height: `${2 * HOUR_HEIGHT}px`,
                              }}
                            >
                              <p className="font-mono text-[11px] font-semibold text-slate-900 tabular-nums">
                                {formatMinutesAsHHMM(
                                  techDropHoverSlot.startMin
                                )}{' '}
                                –{' '}
                                {formatMinutesAsHHMM(
                                  Math.min(
                                    24 * 60,
                                    techDropHoverSlot.startMin + 120
                                  )
                                )}
                              </p>
                              <p className="text-[11px] font-semibold text-slate-800 truncate">
                                Rilascia per assegnare
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ===================================================================
            MONTH VIEW (INTERNAL SCROLLABLE 7-COL GRID)
           =================================================================== */}
        {displayMode === 'month' && (
          <div className="flex-1 min-h-0 flex flex-col select-none overflow-hidden">
            <div className="shrink-0 grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-500">
              {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map((w) => (
                <div
                  key={w}
                  className="py-2 px-2 border-r last:border-r-0 border-slate-200 text-center"
                >
                  {w}
                </div>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-7 auto-rows-[minmax(112px,1fr)]">
              {monthDays.map((day) => {
                const dMs = startOfDayMs(day);
                const inCurrentMonth = day.getMonth() === anchorDate.getMonth();
                const isTodayCell = isSameDay(dMs, nowTick);
                const isSelectedCell = isSameDay(dMs, anchorDate.getTime());
                const isInspectedCell = isSameDay(dMs, inspectedDayMs);
                const dayTasks = filteredTasks.filter((t) =>
                  taskOccursOnDay(t, dMs)
                );
                const dayAbsences = filteredAbsences.filter((a) =>
                  absenceOccursOnDay(a, dMs)
                );

                return (
                  <div
                    key={day.toISOString()}
                    onMouseEnter={() => setHoveredDayMs(dMs)}
                    onMouseMove={() => {
                      if (hoveredDayMs !== dMs) {
                        setHoveredDayMs(dMs);
                      }
                    }}
                    onClick={() => {
                      setHoveredDayMs(dMs);
                      setAnchorDate(new Date(day));
                    }}
                    onDoubleClick={() => {
                      setHoveredDayMs(null);
                      setAnchorDate(new Date(day));
                      setDisplayMode('day');
                    }}
                    onDragOver={(e) => {
                      if (hoveredDayMs !== dMs) {
                        setHoveredDayMs(dMs);
                      }
                      const types = Array.from(e.dataTransfer.types);
                      if (
                        types.includes(TECH_DRAG_MIME) ||
                        types.includes(MONTH_TASK_DRAG_MIME)
                      ) {
                        e.preventDefault();
                        setMonthHoverDayMs(dMs);
                      }
                    }}
                    onDragLeave={() => {
                      setMonthHoverDayMs((prev) =>
                        prev === dMs ? null : prev
                      );
                    }}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setMonthHoverDayMs(null);

                      const techRaw = e.dataTransfer.getData(TECH_DRAG_MIME);
                      if (techRaw) {
                        try {
                          const tech = JSON.parse(
                            techRaw
                          ) as DraggedTechPayload;
                          openNewTaskModal({
                            preselectedEmails: [tech.email],
                            customDate: new Date(day),
                          });
                        } catch {
                          // ignore
                        }
                        return;
                      }

                      const taskIdRaw = e.dataTransfer.getData(
                        MONTH_TASK_DRAG_MIME
                      );
                      if (taskIdRaw) {
                        const movedTask = tasks.find(
                          (t) => t.taskId === taskIdRaw
                        );
                        if (movedTask && !isSameDay(movedTask.inizioMs, dMs)) {
                          const oldStart = new Date(movedTask.inizioMs);
                          const durationMs = Math.max(
                            3600000,
                            movedTask.fineMs - movedTask.inizioMs
                          );
                          const newStart = new Date(dMs);
                          newStart.setHours(
                            oldStart.getHours(),
                            oldStart.getMinutes(),
                            0,
                            0
                          );
                          await persistDirectTaskUpdate({
                            task: movedTask,
                            newInizioMs: newStart.getTime(),
                            newFineMs: newStart.getTime() + durationMs,
                            successMessage: `Task ${movedTask.taskCode
                              } spostato al ${formatDateIt(dMs)}.`,
                          });
                        }
                      }
                    }}
                    className={`p-2 border-b border-r border-slate-200 flex flex-col gap-2 transition-colors cursor-pointer ${inCurrentMonth
                        ? 'bg-white'
                        : 'bg-slate-50/60 text-slate-400'
                      } ${isInspectedCell
                        ? 'bg-slate-100/70 ring-1 ring-inset ring-slate-400'
                        : isSelectedCell
                          ? 'ring-1 ring-inset ring-slate-900'
                          : ''
                      } ${monthHoverDayMs === dMs ? 'bg-slate-100' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-xs font-mono font-semibold tabular-nums ${isTodayCell
                            ? 'w-5 h-5 rounded-full bg-slate-900 text-white inline-flex items-center justify-center'
                            : inCurrentMonth
                              ? 'text-slate-900'
                              : 'text-slate-400'
                          }`}
                      >
                        {day.getDate()}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openNewTaskModal({ customDate: new Date(day) });
                        }}
                        className="w-5 h-5 rounded border border-slate-300 bg-white flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                        title="Nuovo task in questa data"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>

                    <div className="space-y-2">
                      {dayAbsences.slice(0, 2).map((abs) => {
                        const shortTech =
                          formatCompactTechNames([abs.technicianName]) ||
                          abs.technicianName;
                        return (
                          <button
                            key={abs.absenceId}
                            type="button"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              openEditAbsenceModal(abs);
                            }}
                            className={`w-full text-left px-2 py-0 rounded border text-[9px] font-semibold truncate cursor-pointer ${getAbsenceToneClasses(abs.tipo).bar
                              }`}
                          >
                            {shortTech} · {abs.tipo}
                          </button>
                        );
                      })}

                      {dayTasks.slice(0, 3).map((t) => (
                        <div
                          key={t.taskId}
                          data-task-card-id={t.taskId}
                          draggable
                          onDragStart={(e) => {
                            e.stopPropagation();
                            e.dataTransfer.setData(
                              MONTH_TASK_DRAG_MIME,
                              t.taskId
                            );
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onDragOver={(e) => {
                            if (
                              Array.from(e.dataTransfer.types).includes(
                                TECH_DRAG_MIME
                              )
                            ) {
                              e.preventDefault();
                              e.stopPropagation();
                              setTechDropHoverTaskId(t.taskId);
                            }
                          }}
                          onDragLeave={() =>
                            setTechDropHoverTaskId((prev) =>
                              prev === t.taskId ? null : prev
                            )
                          }
                          onDrop={(e) => handleDropTechOnTask(e, t)}
                          onClick={(e) => {
                            e.stopPropagation();
                            selectAndInspectTask(
                              t.taskId,
                              e.currentTarget.getBoundingClientRect()
                            );
                          }}
                          className={`px-2 py-2 rounded text-[9.5px] cursor-grab active:cursor-grabbing space-y-0 ${getTaskEventVisualStyle(t, {
                            operatorColorLabels: settings.operatorColorLabels,
                          }).cardClassName
                            } ${techDropHoverTaskId === t.taskId ||
                              selectedTaskId === t.taskId
                              ? 'ring-2 ring-slate-900'
                              : ''
                            }`}
                        >
                          <p className="leading-[1.2] font-semibold whitespace-normal break-words">
                            {formatCalendarEventTitle(
                              t.assignedNames,
                              t.descrizione
                            )}
                          </p>
                          <p className="font-mono text-[8.5px] tabular-nums leading-tight opacity-85">
                            {formatTimeIt(t.inizioMs)} – {formatTimeIt(t.fineMs)}
                          </p>
                          <p className="font-mono text-[8.5px] font-semibold leading-tight opacity-90">
                            {formatTaskCommessaLabel(t)}
                          </p>
                        </div>
                      ))}
                      {dayTasks.length + dayAbsences.length > 5 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setAnchorDate(new Date(day));
                            setDisplayMode('day');
                          }}
                          className="w-full py-0 px-2 rounded border border-slate-300 bg-white text-[10px] font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                        >
                          +{dayTasks.length + dayAbsences.length - 5} altri
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ===================================================================
            LIST VIEW (INTERNAL SCROLLABLE TABLE)
           =================================================================== */}
        {displayMode === 'list' && (
          <div className="flex-1 min-h-0 overflow-auto">
            {filteredTasks.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-sm font-semibold text-slate-800">
                  Nessun intervento trovato con i filtri attuali.
                </p>
                <button
                  type="button"
                  onClick={() => openNewTaskModal()}
                  className="mt-4 inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Nuovo Task</span>
                </button>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                  <tr className="text-[11px] font-semibold text-slate-500">
                    <th className="py-2 px-4">Codice</th>
                    <th className="py-2 px-4">Commessa</th>
                    <th className="py-2 px-4">Data e Orario</th>
                    <th className="py-2 px-4">Descrizione</th>
                    <th className="py-2 px-4">Squadra</th>
                    <th className="py-2 px-4 text-right">Mat.</th>
                    <th className="py-2 px-4">Stato</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredTasks.map((t) => {
                    const matsCount = (materialsByTask.get(t.taskId) || [])
                      .length;
                    const activeRow = selectedTaskId === t.taskId;
                    const visual = getTaskEventVisualStyle(t, {
                      operatorColorLabels: settings.operatorColorLabels,
                    });
                    return (
                      <tr
                        key={t.taskId}
                        data-task-card-id={t.taskId}
                        onClick={() => selectAndInspectTask(t.taskId, null)}
                        className={`cursor-pointer transition-colors ${activeRow ? 'bg-slate-100' : 'hover:bg-slate-50'
                          }`}
                      >
                        <td className="py-2 px-4 font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <span
                              className={`w-2.5 h-2.5 rounded-full shrink-0 ${visual.swatchClassName}`}
                              title={visual.operatorLabel}
                            />
                            <span>{t.taskCode}</span>
                          </div>
                        </td>
                        <td className="py-2 px-4 font-mono text-slate-700 tabular-nums whitespace-nowrap">
                          {t.pendingAdminReview ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setReviewingTask(t);
                              }}
                              className="px-2 py-0 rounded border border-slate-300 bg-white text-slate-900 font-semibold hover:bg-slate-50 cursor-pointer"
                            >
                              Revisiona commessa
                            </button>
                          ) : (
                            <span>
                              {visual.operatorLabel} ·{' '}
                              {formatTaskCommessaLabel(t)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-4 font-mono text-slate-600 tabular-nums whitespace-nowrap">
                          {formatDateIt(t.inizioMs)} · {formatTimeIt(t.inizioMs)}
                          –{formatTimeIt(t.fineMs)}
                        </td>
                        <td className="py-2 px-4 text-slate-900 font-normal max-w-xs truncate">
                          {t.descrizione}
                        </td>
                        <td className="py-2 px-4 text-slate-600 max-w-xs truncate">
                          {t.assignedNames.length > 0
                            ? t.assignedNames.join(', ')
                            : '—'}
                        </td>
                        <td className="py-2 px-4 text-right font-mono text-slate-700 tabular-nums">
                          {matsCount}
                        </td>
                        <td className="py-2 px-4 whitespace-nowrap">
                          <StatusIndicator status={t.statoPrevalente} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* =====================================================================
          RIGHT PERMANENT AVAILABILITY COLUMN:
          Compact Top KPIs + Review Alert + Reactive Free Technicians by Day
         ===================================================================== */}
      <aside className="w-full lg:w-[352px] xl:w-[376px] shrink-0 h-full min-h-0 flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
        {/* Compact Top KPI Counters + Pending Review Alert */}
        <div className="shrink-0 p-4 bg-slate-50 border-b border-slate-200 space-y-2">
          <div className="grid grid-cols-4 gap-2 text-center">
            <button
              type="button"
              onClick={() => {
                if (showKpiQueueDrawer && kpiQueueFilter === 'ALL') {
                  setShowKpiQueueDrawer(false);
                } else {
                  setKpiQueueFilter('ALL');
                  setShowKpiQueueDrawer(true);
                }
              }}
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${showKpiQueueDrawer && kpiQueueFilter === 'ALL'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                }`}
            >
              <p
                className={`text-[11px] truncate ${showKpiQueueDrawer && kpiQueueFilter === 'ALL'
                    ? 'text-slate-300'
                    : 'text-slate-500'
                  }`}
              >
                Task
              </p>
              <p className="font-mono text-sm font-semibold tabular-nums">
                {tasks.length}
              </p>
            </button>

            <button
              type="button"
              onClick={() => {
                if (showKpiQueueDrawer && kpiQueueFilter === 'IN_PROGRESS') {
                  setShowKpiQueueDrawer(false);
                } else {
                  setKpiQueueFilter('IN_PROGRESS');
                  setShowKpiQueueDrawer(true);
                }
              }}
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${showKpiQueueDrawer && kpiQueueFilter === 'IN_PROGRESS'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                }`}
            >
              <p
                className={`text-[11px] truncate ${showKpiQueueDrawer && kpiQueueFilter === 'IN_PROGRESS'
                    ? 'text-slate-300'
                    : 'text-slate-500'
                  }`}
              >
                In corso
              </p>
              <p className="font-mono text-sm font-semibold tabular-nums">
                {inProgressCount}
              </p>
            </button>

            <button
              type="button"
              onClick={() => {
                if (showKpiQueueDrawer && kpiQueueFilter === 'COMPLETED') {
                  setShowKpiQueueDrawer(false);
                } else {
                  setKpiQueueFilter('COMPLETED');
                  setShowKpiQueueDrawer(true);
                }
              }}
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${showKpiQueueDrawer && kpiQueueFilter === 'COMPLETED'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                }`}
            >
              <p
                className={`text-[11px] truncate ${showKpiQueueDrawer && kpiQueueFilter === 'COMPLETED'
                    ? 'text-slate-300'
                    : 'text-slate-500'
                  }`}
              >
                Chiusi
              </p>
              <p className="font-mono text-sm font-semibold tabular-nums">
                {completedCount}
              </p>
            </button>

            <button
              type="button"
              onClick={() => setShowKpiQueueDrawer(false)}
              className={`p-2 rounded-lg border transition-colors cursor-pointer ${!showKpiQueueDrawer
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                }`}
            >
              <p
                className={`text-[11px] truncate ${!showKpiQueueDrawer ? 'text-slate-300' : 'text-slate-500'
                  }`}
              >
                Liberi
              </p>
              <p className="font-mono text-sm font-semibold tabular-nums">
                {freeTechniciansOnInspectedDate.length}
                <span
                  className={`text-[10px] font-normal ${!showKpiQueueDrawer ? 'text-slate-300' : 'text-slate-400'
                    }`}
                >
                  /{activeTechnicians.length}
                </span>
              </p>
            </button>
          </div>

          {pendingReviewTasksCount > 0 && (
            <button
              type="button"
              onClick={() => {
                if (
                  showKpiQueueDrawer &&
                  kpiQueueFilter === 'PENDING_REVIEW'
                ) {
                  setShowKpiQueueDrawer(false);
                } else {
                  setKpiQueueFilter('PENDING_REVIEW');
                  setShowKpiQueueDrawer(true);
                }
              }}
              className={`w-full min-h-[36px] px-4 py-2 rounded-lg border text-xs font-semibold flex items-center justify-between gap-2 transition-colors cursor-pointer ${showKpiQueueDrawer && kpiQueueFilter === 'PENDING_REVIEW'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-900 border-slate-400 hover:bg-slate-100'
                }`}
            >
              <span className="inline-flex items-center gap-2 truncate">
                <ClipboardCheck className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">Task autonomi da revisionare</span>
              </span>
              <span className="font-mono tabular-nums shrink-0">
                {pendingReviewTasksCount}
              </span>
            </button>
          )}
        </div>

        {/* Collapsible Compact Operational Queue (keeps Free Technicians visible below) */}
        {showKpiQueueDrawer && (
          <div className="shrink-0 p-4 border-b border-slate-200 bg-slate-50/70 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setKpiQueueFilter('TODAY')}
                  className={`min-h-[28px] px-2 py-0 rounded-md border text-[11px] font-semibold cursor-pointer whitespace-nowrap ${kpiQueueFilter === 'TODAY'
                      ? 'bg-slate-900 text-white border-slate-950'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  Oggi
                </button>
                <button
                  type="button"
                  onClick={() => setKpiQueueFilter('UNASSIGNED')}
                  className={`min-h-[28px] px-2 py-0 rounded-md border text-[11px] font-semibold cursor-pointer whitespace-nowrap tabular-nums ${kpiQueueFilter === 'UNASSIGNED'
                      ? 'bg-slate-900 text-white border-slate-950'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  Da assegnare · {unassignedCount}
                </button>
                <button
                  type="button"
                  onClick={() => setKpiQueueFilter('ALL')}
                  className={`min-h-[28px] px-2 py-0 rounded-md border text-[11px] font-semibold cursor-pointer whitespace-nowrap ${kpiQueueFilter === 'ALL'
                      ? 'bg-slate-900 text-white border-slate-950'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  Tutti
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowKpiQueueDrawer(false)}
                className="w-7 h-7 rounded-md border border-slate-300 bg-white flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-slate-50 cursor-pointer shrink-0"
                title="Chiudi coda"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {kpiQueueTasks.length === 0 ? (
              <p className="text-xs text-slate-500 border border-slate-200 rounded-lg bg-white p-2 text-center">
                Nessun intervento in questa coda.
              </p>
            ) : (
              <div className="max-h-56 overflow-y-auto space-y-2">
                {kpiQueueTasks.slice(0, 25).map((t) => (
                  <div
                    key={t.taskId}
                    className="p-2 rounded-lg border border-slate-200 bg-white flex items-center justify-between gap-2"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setAnchorDate(new Date(t.inizioMs));
                        selectAndInspectTask(t.taskId);
                      }}
                      className="min-w-0 flex-1 px-2 py-2 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-left cursor-pointer"
                    >
                      <p className="font-mono text-xs font-semibold text-slate-900 tabular-nums truncate">
                        {formatTaskCommessaLabel(t)} ·{' '}
                        {formatDateIt(t.inizioMs)} {formatTimeIt(t.inizioMs)}
                      </p>
                      <p className="text-xs text-slate-600 truncate">
                        {t.descrizione}
                      </p>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      {t.pendingAdminReview && (
                        <button
                          type="button"
                          onClick={() => setReviewingTask(t)}
                          className="min-h-[32px] px-2 py-0 rounded-lg bg-slate-900 border border-slate-950 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                        >
                          Revisiona
                        </button>
                      )}
                      {t.statoPrevalente === 'Assegnato' && (
                        <button
                          type="button"
                          disabled={updatingTaskStatus}
                          onClick={() =>
                            handleAdminBatchTaskStatus(t, 'Preso in Carico')
                          }
                          className="w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 flex items-center justify-center cursor-pointer"
                          title="Avvia"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {t.statoPrevalente === 'Preso in Carico' && (
                        <button
                          type="button"
                          disabled={updatingTaskStatus}
                          onClick={() =>
                            handleAdminBatchTaskStatus(t, 'Completato')
                          }
                          className="w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 flex items-center justify-center cursor-pointer"
                          title="Segna completato"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Permanently Visible Reactive Daily Staff Availability */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
            <div className="min-w-0">
              <h2 className="text-xs font-semibold text-slate-900 truncate">
                Tecnici liberi · {inspectedDayLabel}
              </h2>
              <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                {freeTechniciansOnInspectedDate.length} disponibili su{' '}
                {activeTechnicians.length}
              </p>
            </div>
            <button
              type="button"
              onClick={() => openNewAbsenceModal(undefined, inspectedDayMs)}
              className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <CalendarOff className="w-3.5 h-3.5" />
              <span>Assenza</span>
            </button>
          </div>

          {freeTechniciansOnInspectedDate.length === 0 ? (
            <div className="border border-slate-200 rounded-xl p-4 text-xs text-slate-500">
              {activeTechnicians.length === 0
                ? 'Nessun operatore attivo in organico.'
                : `Tutti gli operatori risultano impegnati o assenti il ${inspectedDayLabel}.`}
            </div>
          ) : (
            <div className="space-y-2">
              {freeTechniciansOnInspectedDate.map((tech) => {
                const fullName = `${tech.nome} ${tech.cognome}`.trim();
                const lowerEmail = tech.email.toLowerCase();
                const partialAbs =
                  partialAbsencesOnInspectedDate.get(lowerEmail);
                const canAddToDraftForm =
                  taskModalOpen && !selectedEmails.includes(lowerEmail);
                const canQuickAddToSelected =
                  !taskModalOpen &&
                  Boolean(selectedTask) &&
                  !selectedTask!.assignedEmails.some((em) =>
                    areSameTechnicianEmails(em, lowerEmail, directory)
                  );

                return (
                  <div
                    key={tech.memberId}
                    draggable
                    onDragStart={(e) => {
                      const payload: DraggedTechPayload = {
                        email: lowerEmail,
                        fullName,
                        linkedUid: tech.linkedUid || '',
                      };
                      e.dataTransfer.setData(
                        TECH_DRAG_MIME,
                        JSON.stringify(payload)
                      );
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onDragEnd={() => {
                      setTechDropHoverSlot(null);
                      setTechDropHoverTaskId(null);
                      setMonthHoverDayMs(null);
                      setFloatingDropActive(false);
                    }}
                    className="group flex items-center justify-between gap-2 px-4 py-2 rounded-xl border border-slate-200 bg-slate-50 hover:bg-white hover:border-slate-400 transition-colors cursor-grab active:cursor-grabbing"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <GripVertical className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-900 truncate">
                          {fullName}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500 truncate">
                          {tech.email}
                        </p>
                        {partialAbs && partialAbs.length > 0 && (
                          <p className="text-[11px] font-normal text-slate-600 truncate">
                            {partialAbs[0].tipo}{' '}
                            {formatTimeIt(partialAbs[0].inizioMs)}–
                            {formatTimeIt(partialAbs[0].fineMs)}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {canAddToDraftForm && (
                        <button
                          type="button"
                          onClick={() => toggleTechnicianSelection(tech.email)}
                          className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-[11px] font-semibold text-slate-800 transition-colors cursor-pointer whitespace-nowrap"
                          title="Aggiungi alla squadra nel modal attivo"
                        >
                          + Squadra
                        </button>
                      )}
                      {canQuickAddToSelected && selectedTask && (
                        <button
                          type="button"
                          onClick={() =>
                            persistDirectTaskUpdate({
                              task: selectedTask,
                              newInizioMs: selectedTask.inizioMs,
                              newFineMs: selectedTask.fineMs,
                              newEmails: [
                                ...selectedTask.assignedEmails,
                                lowerEmail,
                              ],
                              successMessage: `${fullName} aggiunto a ${formatTaskCommessaLabel(
                                selectedTask
                              )}.`,
                            })
                          }
                          className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-[11px] font-semibold text-slate-800 transition-colors cursor-pointer whitespace-nowrap max-w-[104px] truncate"
                          title={`Aggiungi a ${selectedTask.taskCode}`}
                        >
                          +{formatTaskCommessaLabel(selectedTask)}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          openNewTaskModal({
                            preselectedEmails: [tech.email],
                            customDate: new Date(inspectedDayMs),
                          })
                        }
                        className="min-h-[32px] px-2 py-0 rounded-lg bg-slate-900 border border-slate-950 text-white hover:bg-slate-800 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer whitespace-nowrap"
                        title={`Crea nuovo task il ${inspectedDayLabel} per ${fullName}`}
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>Task</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Absent Technicians on Inspected Day (true absences only) */}
          {absentTechniciansOnInspectedDate.length > 0 && (
            <div className="pt-4 border-t border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">
                  Assenti / permessi il {inspectedDayLabel}
                </span>
                <span className="font-mono text-slate-600 tabular-nums">
                  {absentTechniciansOnInspectedDate.length}
                </span>
              </div>
              <div className="space-y-2">
                {absentTechniciansOnInspectedDate.map(({ tech, overlaps }) => (
                  <div
                    key={tech.memberId}
                    className="p-2 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-2 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => openEditAbsenceModal(overlaps[0])}
                      className="min-w-0 flex-1 px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-left cursor-pointer"
                      title="Modifica o rimuovi assenza"
                    >
                      <p className="font-semibold text-slate-900 truncate">
                        {tech.nome} {tech.cognome} ·{' '}
                        <span className="font-normal text-slate-600">
                          {overlaps[0].tipo}
                        </span>
                      </p>
                      <p className="font-mono text-[11px] text-slate-500 tabular-nums truncate">
                        {formatAbsenceDateSummary(overlaps[0])}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        openNewTaskModal({
                          preselectedEmails: [tech.email],
                          customDate: new Date(inspectedDayMs),
                        })
                      }
                      className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      Forza task
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Medical Visits & Union Assemblies (non-absences) */}
          {commitmentsOnInspectedDate.length > 0 && (
            <div className="pt-4 border-t border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">
                  Visite mediche e assemblee il {inspectedDayLabel}
                </span>
                <span className="font-mono text-slate-600 tabular-nums">
                  {commitmentsOnInspectedDate.length}
                </span>
              </div>
              <div className="space-y-2">
                {commitmentsOnInspectedDate.map(({ tech, overlaps }) => (
                  <div
                    key={`comm_${tech.memberId}`}
                    className="p-2 rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-between gap-2 text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => openEditAbsenceModal(overlaps[0])}
                      className="min-w-0 flex-1 px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-left cursor-pointer"
                      title="Modifica o rimuovi impegno"
                    >
                      <p className="font-semibold text-slate-900 truncate">
                        {tech.nome} {tech.cognome} ·{' '}
                        <span className="font-normal text-slate-600">
                          {overlaps[0].tipo}
                        </span>
                      </p>
                      <p className="font-mono text-[11px] text-slate-500 tabular-nums truncate">
                        {formatAbsenceDateSummary(overlaps[0])}
                      </p>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        openNewTaskModal({
                          preselectedEmails: [tech.email],
                          customDate: new Date(inspectedDayMs),
                        })
                      }
                      className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0 whitespace-nowrap"
                    >
                      Assegna task
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Busy Technicians on Inspected Day */}
          {busyTechniciansOnInspectedDate.length > 0 && (
            <div className="pt-4 border-t border-slate-200 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">
                  Già impegnati il {inspectedDayLabel}
                </span>
                <span className="font-mono text-slate-500 tabular-nums">
                  {busyTechniciansOnInspectedDate.length}
                </span>
              </div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                {busyTechniciansOnInspectedDate.map(({ tech, dayTasks }) => (
                  <div
                    key={tech.memberId}
                    className="px-4 py-2 bg-white flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="font-semibold text-slate-800 truncate">
                      {tech.nome} {tech.cognome}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums truncate">
                      {dayTasks
                        .map((t) => formatTaskCommessaLabel(t))
                        .join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Hidden Multi-File Input for Admin Photo Upload */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (selected.length > 0 && pendingPhotoTarget) {
            setPendingPhotoFiles((prev) => [...prev, ...selected]);
          }
        }}
      />

      {/* =====================================================================
          GOOGLE CALENDAR-STYLE FLOATING MODAL (INSPECT TASK & CREATE/EDIT TASK)
          Positioned to the left or right of the event/slot while keeping the
          calendar and right-hand Free Technicians column interactive.
         ===================================================================== */}
      {(taskModalOpen || selectedTask) && (
        <div
          ref={floatingModalRef}
          style={floatingModalStyle}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes(TECH_DRAG_MIME)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'copy';
              setFloatingDropActive(true);
            }
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setFloatingDropActive(false);
            }
          }}
          onDrop={(e) => {
            setFloatingDropActive(false);
            if (taskModalOpen) {
              handleDropTechOnFormModal(e);
            } else if (selectedTask) {
              handleDropTechOnTask(e, selectedTask);
            }
          }}
          className={`fixed z-40 w-[408px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-32px)] flex flex-col bg-white border rounded-xl overflow-hidden animate-fluid-pop shadow-2xl ${floatingDropActive
              ? 'border-slate-900 ring-2 ring-slate-900'
              : 'border-slate-400'
            }`}
        >
          {taskModalOpen ? (
            <form
              onSubmit={handleSaveTask}
              className="flex flex-col flex-1 min-h-0 overflow-hidden"
            >
              {/* Floating Form Header */}
              <div className="shrink-0 px-4 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900 truncate">
                    {editingTask
                      ? `Modifica ${editingTask.taskCode}`
                      : copiedFromTaskCode
                        ? `Nuovo Task (Copia di ${copiedFromTaskCode})`
                        : 'Pianifica nuovo task'}
                  </h3>
                  {taskModalWindow.inizioMs > 0 &&
                    taskModalWindow.fineMs > 0 && (
                      <p className="text-[11px] font-mono text-slate-500 tabular-nums truncate">
                        {formatDateTimeIt(taskModalWindow.inizioMs)} –{' '}
                        {formatTimeIt(taskModalWindow.fineMs)}
                      </p>
                    )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {editingTask && (
                    <>
                      <button
                        type="button"
                        onClick={() => openDuplicateTaskModal(editingTask)}
                        className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap inline-flex items-center gap-1.5"
                        title="Copia questo evento in una nuova bozza"
                      >
                        <Copy className="w-3.5 h-3.5 text-slate-500" />
                        <span>Copia</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setTaskModalOpen(false);
                          setEditingTask(null);
                          setSelectedTaskId(editingTask.taskId);
                        }}
                        className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                      >
                        Dettagli
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={closeFloatingModal}
                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 cursor-pointer"
                    title="Chiudi"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Scrollable Form Fields */}
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                {copiedFromTaskCode && (
                  <div className="flex items-center gap-2 rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-xs text-sky-800">
                    <Copy className="w-3.5 h-3.5 shrink-0 text-sky-600" />
                    <span>
                      Stai creando un <strong>nuovo evento</strong> (copia di{' '}
                      <strong>{copiedFromTaskCode}</strong>). Modifica data,
                      orari o tecnici prima di salvare.
                    </span>
                  </div>
                )}
                <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={altroReparto}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setAltroReparto(checked);
                      if (!editingTask) {
                        if (checked && taskColorId === DEFAULT_TASK_COLOR_ID) {
                          setTaskColorId('lavender');
                        } else if (!checked && taskColorId === 'lavender') {
                          setTaskColorId(DEFAULT_TASK_COLOR_ID);
                        }
                      }
                    }}
                    className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span className="text-xs font-semibold text-slate-900">
                    Lavorazione altro AT (senza commessa)
                  </span>
                </label>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-slate-700">
                    Codice commessa {altroReparto ? '(opzionale)' : '*'}
                  </label>
                  <input
                    type="text"
                    required={!altroReparto}
                    autoFocus={!altroReparto}
                    value={commessa}
                    onChange={(e) => setCommessa(e.target.value.toUpperCase())}
                    placeholder={
                      altroReparto
                        ? 'Opzionale per lavorazione altro AT'
                        : 'Es. H265001'
                    }
                    className="w-full min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div>
                  <TaskColorPicker
                    compact
                    value={taskColorId}
                    onChange={setTaskColorId}
                    operatorColorLabels={settings.operatorColorLabels}
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-slate-700">
                    Descrizione lavoro *
                  </label>
                  <textarea
                    rows={2}
                    required
                    value={descrizione}
                    onChange={(e) => setDescrizione(e.target.value)}
                    placeholder="Descrivi l'attività tecnica..."
                    className="w-full px-4 py-2 rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-700 shrink-0">
                      Inizio *
                    </label>
                    <input
                      type="datetime-local"
                      required
                      value={inizioInput}
                      onChange={(e) => handleInizioChange(e.target.value)}
                      className="w-[248px] max-w-full min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900 tabular-nums focus:outline-none focus:border-slate-900"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-700 shrink-0">
                      Fine * (min +1h)
                    </label>
                    <input
                      type="datetime-local"
                      required
                      value={fineInput}
                      onChange={(e) => setFineInput(e.target.value)}
                      className="w-[248px] max-w-full min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900 tabular-nums focus:outline-none focus:border-slate-900"
                    />
                  </div>
                </div>

                {durationError && (
                  <p className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">
                    {durationError}
                  </p>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <label className="block text-xs font-semibold text-slate-700 tabular-nums">
                      Squadra tecnici ({selectedEmails.length}/10)
                    </label>
                    {modalAbsentConflictsByEmail.size > 0 && (
                      <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={forceAbsentOverride}
                          onChange={(e) =>
                            setForceAbsentOverride(e.target.checked)
                          }
                          className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                        />
                        <span>Forza su assente / impegno</span>
                      </label>
                    )}
                  </div>

                  {activeTechnicians.length === 0 ? (
                    <p className="text-xs text-slate-500 border border-slate-200 rounded-lg p-4">
                      Nessun tecnico registrato in anagrafica.
                    </p>
                  ) : (
                    <div className="max-h-40 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                      {activeTechnicians.map((tech) => {
                        const lower = tech.email.toLowerCase();
                        const checked = selectedEmails.includes(lower);
                        const overlaps = modalAbsentConflictsByEmail.get(lower);
                        const isAbsent = Boolean(
                          overlaps && overlaps.length > 0
                        );
                        const blocked =
                          isAbsent && !forceAbsentOverride && !checked;

                        return (
                          <label
                            key={tech.memberId}
                            className={`flex items-center justify-between gap-2 px-4 py-2 ${blocked
                                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                : 'hover:bg-slate-50 cursor-pointer'
                              }`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={blocked}
                                onChange={() =>
                                  toggleTechnicianSelection(tech.email)
                                }
                                className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 shrink-0"
                              />
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-900 truncate">
                                  {tech.nome} {tech.cognome}
                                </p>
                                <p className="text-[11px] text-slate-500 font-mono truncate">
                                  {tech.email}
                                </p>
                              </div>
                            </div>

                            {isAbsent && overlaps ? (
                              <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-slate-700 shrink-0">
                                <AlertTriangle className="w-3.5 h-3.5" />
                                <span>{overlaps[0].tipo}</span>
                              </span>
                            ) : (
                              <span className="text-[11px] text-slate-500 shrink-0">
                                {tech.role === 'admin' ? 'Admin' : 'Tecnico'}
                              </span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                {showTaskFormSheetCheckbox && (
                  <label className="flex items-start gap-2.5 rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={syncSheetOnTaskForm}
                      onChange={(e) => setSyncSheetOnTaskForm(e.target.checked)}
                      className="mt-0.5 w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 shrink-0"
                    />
                    <div className="min-w-0 space-y-0.5">
                      <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                        <FileSpreadsheet className="w-3.5 h-3.5 text-slate-700 shrink-0" />
                        <span>
                          Aggiorna anche foglio Google Sheet
                          {taskFormWeekCodesLabel
                            ? ` (${taskFormWeekCodesLabel})`
                            : ''}
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-500 leading-relaxed">
                        Allinea descrizione e tecnici sulle celle settimanali conservando colori e note manuali.
                      </p>
                    </div>
                  </label>
                )}
              </div>

              {/* Sticky Form Footer */}
              <div className="shrink-0 px-4 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (editingTask) {
                      setTaskModalOpen(false);
                      setEditingTask(null);
                      setSelectedTaskId(editingTask.taskId);
                    } else {
                      closeFloatingModal();
                    }
                  }}
                  disabled={savingTask}
                  className="min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={savingTask || Boolean(durationError)}
                  className="min-h-[36px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {savingTask
                    ? 'Salvataggio...'
                    : editingTask
                      ? 'Salva modifiche'
                      : copiedFromTaskCode
                        ? 'Crea task (copia)'
                        : 'Crea task'}
                </button>
              </div>
            </form>
          ) : (
            selectedTask && (
              <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
                {/* Floating Task Detail Header */}
                <div className="shrink-0 px-4 py-4 bg-slate-50 border-b border-slate-200 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-500 tabular-nums">
                        <span className="font-semibold text-slate-900">
                          {selectedTask.taskCode}
                        </span>
                        <span>·</span>
                        <span>{formatTaskCommessaLabel(selectedTask)}</span>
                        {selectedTask.altroReparto && (
                          <>
                            <span>·</span>
                            <span>Altro AT</span>
                          </>
                        )}
                      </div>
                      <h3 className="text-sm font-semibold text-slate-900 leading-snug">
                        {selectedTask.descrizione}
                      </h3>
                      <p className="text-[11px] font-mono text-slate-600 tabular-nums inline-flex items-center gap-2 flex-wrap">
                        <span>{formatDateTimeIt(selectedTask.inizioMs)}</span>
                        <ArrowRight className="w-3 h-3 shrink-0" />
                        <span>{formatDateTimeIt(selectedTask.fineMs)}</span>
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={closeFloatingModal}
                      className="w-8 h-8 rounded-lg border border-slate-300 bg-white flex items-center justify-center text-slate-600 hover:text-slate-900 hover:bg-slate-50 cursor-pointer shrink-0"
                      title="Chiudi dettaglio task"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                    <StatusIndicator status={selectedTask.statoPrevalente} />
                    <div className="flex items-center gap-2">
                      {selectedTask.pendingAdminReview && (
                        <button
                          type="button"
                          onClick={() => setReviewingTask(selectedTask)}
                          className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                        >
                          <ClipboardCheck className="w-3.5 h-3.5" />
                          <span>Revisiona</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openEditTaskModal(selectedTask)}
                        className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>Modifica</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => openDuplicateTaskModal(selectedTask)}
                        className="inline-flex items-center gap-1.5 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer whitespace-nowrap"
                        title="Copia questo evento in una nuova bozza"
                      >
                        <Copy className="w-3.5 h-3.5 text-slate-600" />
                        <span>Copia</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => prepareGmailForTask(selectedTask)}
                        className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer whitespace-nowrap"
                        title="Invia riepilogo Gmail"
                      >
                        <Mail className="w-3.5 h-3.5" />
                        <span>Gmail</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteTask(selectedTask)}
                        className="min-h-[32px] min-w-[32px] inline-flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer"
                        title="Elimina task"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Scrollable Operational Controls */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                  {/* Operator Color */}
                  <section>
                    <TaskColorPicker
                      compact
                      value={resolveTaskColorId(selectedTask)}
                      operatorColorLabels={settings.operatorColorLabels}
                      onChange={(nextColor) => {
                        updateTaskColorId(
                          selectedTask.taskId,
                          nextColor
                        ).catch((err) =>
                          showToast(
                            err instanceof Error
                              ? err.message
                              : 'Errore cambio colore evento.',
                            'error'
                          )
                        );
                      }}
                    />
                  </section>

                  {/* Entire Task Status */}
                  <section className="pt-4 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-900">
                        Stato intero task
                      </h4>
                      <span className="text-[11px] text-slate-500">
                        Regia Admin
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      {(
                        [
                          'Assegnato',
                          'Preso in Carico',
                          'Completato',
                        ] as TaskStatus[]
                      ).map((st) => {
                        const isCurrent = selectedTask.statoPrevalente === st;
                        return (
                          <button
                            key={st}
                            type="button"
                            disabled={updatingTaskStatus}
                            onClick={() =>
                              handleAdminBatchTaskStatus(selectedTask, st)
                            }
                            className={`min-h-[36px] px-2 py-2 rounded-lg text-xs font-semibold border transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap truncate ${isCurrent
                                ? 'bg-slate-900 text-white border-slate-950'
                                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                              }`}
                          >
                            {st === 'Preso in Carico' ? 'In carico' : st}
                          </button>
                        );
                      })}
                    </div>

                    <input
                      type="text"
                      value={adminBatchNote}
                      onChange={(e) => setAdminBatchNote(e.target.value)}
                      placeholder="Nota rapida Admin opzionale..."
                      className="w-full min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 focus:outline-none focus:border-slate-900"
                    />
                  </section>

                  {/* Squad & Single Technician Status */}
                  <section className="pt-4 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-900">
                        Squadra e stato singolo tecnico
                      </h4>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {selectedTaskAssignments.length} tecnici
                      </span>
                    </div>

                    {selectedTaskAssignments.length === 0 ? (
                      <div className="border border-slate-200 rounded-xl p-4 text-xs text-slate-500 flex items-center justify-between gap-2">
                        <span>
                          Trascina un tecnico libero qui o modifica squadra.
                        </span>
                        <button
                          type="button"
                          onClick={() => openEditTaskModal(selectedTask)}
                          className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer shrink-0 whitespace-nowrap"
                        >
                          Squadra
                        </button>
                      </div>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                        {selectedTaskAssignments.map((asg) => {
                          const isEditingNote =
                            editingNoteAsgId === asg.assignmentId;
                          return (
                            <div
                              key={asg.assignmentId}
                              className="p-4 space-y-2 bg-white"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-slate-900 truncate">
                                    {asg.technicianName}
                                  </p>
                                  <p className="text-[11px] font-mono text-slate-500 truncate">
                                    {asg.technicianEmail}
                                  </p>
                                </div>

                                <select
                                  value={asg.stato}
                                  disabled={updatingTaskStatus}
                                  onChange={(e) =>
                                    handleAdminSingleAssignmentUpdate(
                                      asg,
                                      e.target.value as AssignmentStatus
                                    )
                                  }
                                  aria-label={`Stato di ${asg.technicianName}`}
                                  className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 focus:outline-none focus:border-slate-900 cursor-pointer"
                                >
                                  <option value="Assegnato">Assegnato</option>
                                  <option value="Preso in Carico">
                                    Preso in Carico
                                  </option>
                                  <option value="Completato">Completato</option>
                                </select>
                              </div>

                              {isEditingNote ? (
                                <div className="space-y-2">
                                  <textarea
                                    rows={2}
                                    value={editingNoteText}
                                    onChange={(e) =>
                                      setEditingNoteText(e.target.value)
                                    }
                                    placeholder="Inserisci o aggiorna nota attività..."
                                    className="w-full p-2 rounded-lg border border-slate-300 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                                  />
                                  <div className="flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setEditingNoteAsgId(null)}
                                      className="min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                                    >
                                      Annulla
                                    </button>
                                    <button
                                      type="button"
                                      disabled={updatingTaskStatus}
                                      onClick={() =>
                                        handleAdminSingleAssignmentUpdate(
                                          asg,
                                          asg.stato,
                                          editingNoteText
                                        )
                                      }
                                      className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer"
                                    >
                                      <Save className="w-3.5 h-3.5" />
                                      <span>Salva nota</span>
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start justify-between gap-2 bg-slate-50 rounded-lg p-2">
                                  <p className="text-xs text-slate-600 whitespace-pre-line flex-1">
                                    {asg.noteTecnico || (
                                      <span className="text-slate-400">
                                        Nessuna nota attività
                                      </span>
                                    )}
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingNoteAsgId(asg.assignmentId);
                                      setEditingNoteText(asg.noteTecnico || '');
                                    }}
                                    className="px-2 py-0 rounded border border-slate-300 bg-white text-[11px] font-semibold text-slate-700 hover:bg-slate-50 shrink-0 cursor-pointer"
                                  >
                                    Nota
                                  </button>
                                </div>
                              )}

                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAddingMatForAsg(asg);
                                    setMatCategory('');
                                    setMatArticleId('');
                                    setMatQty('1');
                                  }}
                                  className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                                >
                                  <PackagePlus className="w-3.5 h-3.5" />
                                  <span>Materiale</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPendingPhotoTarget(asg);
                                    photoInputRef.current?.click();
                                  }}
                                  className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                                >
                                  <Camera className="w-3.5 h-3.5" />
                                  <span>Foto</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Used Materials */}
                  <section className="pt-4 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-xs font-semibold text-slate-900 tabular-nums">
                        Materiali utilizzati ({selectedTaskMaterials.length})
                      </h4>
                      {selectedTaskAssignments.length > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setAddingMatForAsg(selectedTaskAssignments[0]);
                            setMatCategory('');
                            setMatArticleId('');
                            setMatQty('1');
                          }}
                          className="min-h-[28px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                        >
                          Aggiungi
                        </button>
                      )}
                    </div>

                    {selectedTaskMaterials.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Nessun materiale registrato.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                        {selectedTaskMaterials.map((m) => (
                          <div
                            key={m.usedId}
                            className="px-4 py-2 flex items-center justify-between gap-2 text-xs bg-white"
                          >
                            <div className="min-w-0">
                              <p className="font-mono font-semibold text-slate-900 truncate">
                                {m.codiceArticolo}{' '}
                                <span className="font-normal text-slate-500">
                                  · {m.technicianName}
                                </span>
                              </p>
                              <p className="text-[11px] text-slate-600 truncate">
                                {m.descrizioneArticolo}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                {m.quantita} {m.unitaMisura}
                              </span>
                              <button
                                type="button"
                                onClick={async () => {
                                  await removeUsedMaterial(m.usedId);
                                  showToast('Materiale rimosso.', 'info');
                                }}
                                className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 cursor-pointer"
                                aria-label="Rimuovi materiale"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Google Drive Photos */}
                  <section className="pt-4 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <h4 className="text-xs font-semibold text-slate-900 tabular-nums">
                        Foto Google Drive ({selectedTaskPhotos.length})
                      </h4>
                      <div className="flex items-center gap-2">
                        <a
                          href={selectedTaskDriveFolderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 whitespace-nowrap"
                        >
                          <span>Cartella</span>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                        {selectedTaskAssignments.length > 0 && (
                          <button
                            type="button"
                            onClick={() => {
                              setPendingPhotoTarget(selectedTaskAssignments[0]);
                              photoInputRef.current?.click();
                            }}
                            className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                          >
                            <ImageIcon className="w-3.5 h-3.5" />
                            <span>Carica foto</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {selectedTaskPhotos.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Nessuna foto allegata su Google Drive.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {selectedTaskPhotos.map((p) => (
                          <div
                            key={p.photoId}
                            className="px-4 py-2 border border-slate-200 rounded-xl bg-white flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-slate-900 truncate">
                                {p.fileName}
                              </p>
                              <p className="text-[11px] text-slate-500 truncate">
                                {p.technicianName}
                                {p.caption ? ` · ${p.caption}` : ''}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <a
                                href={p.driveWebViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 min-h-[32px] px-2 py-0 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400"
                              >
                                <span>Drive</span>
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                              <button
                                type="button"
                                onClick={async () => {
                                  await removeInterventionPhoto(p.photoId);
                                  showToast('Foto rimossa.', 'info');
                                }}
                                className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 cursor-pointer"
                                aria-label="Rimuovi foto"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* Admin Add Material Modal */}
      {addingMatForAsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4">
          <form
            onSubmit={handleAdminAddMaterial}
            className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6"
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Aggiungi materiale
                </h3>
                <p className="text-xs text-slate-500">
                  {addingMatForAsg.technicianName} ·{' '}
                  {addingMatForAsg.commessa || 'Senza commessa'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAddingMatForAsg(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Filtra categoria
                </label>
                <select
                  value={matCategory}
                  onChange={(e) => {
                    setMatCategory(e.target.value);
                    setMatArticleId('');
                  }}
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                >
                  <option value="">Tutte le categorie</option>
                  {activeCategories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Articolo *
                </label>
                <select
                  required
                  value={matArticleId}
                  onChange={(e) => setMatArticleId(e.target.value)}
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                >
                  <option value="">Seleziona articolo...</option>
                  {filteredCatalogForModal.map((a) => (
                    <option key={a.articleId} value={a.articleId}>
                      {a.codiceArticolo} — {a.descrizione} ({a.unitaMisura})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Quantità utilizzata *
                </label>
                <input
                  type="number"
                  step="any"
                  min="0.01"
                  required
                  value={matQty}
                  onChange={(e) => setMatQty(e.target.value)}
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-sm tabular-nums"
                />
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setAddingMatForAsg(null)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={savingMat}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {savingMat ? 'Salvataggio...' : 'Registra materiale'}
              </button>
            </div>
          </form>
        </div>
      )}
      <OnCallDayModal
        open={onCallModalState.dayMs !== null}
        dayMs={onCallModalState.dayMs}
        initialGroup={onCallModalState.group}
        onClose={() =>
          setOnCallModalState((prev) => ({ ...prev, dayMs: null }))
        }
      />
      {/* Absence Create / Edit Modal */}
      {profile && (
        <AbsenceModal
          open={absenceModalOpen}
          existingAbsence={editingAbsence}
          isAdminActor={true}
          actorUid={profile.uid}
          availableTechnicians={directory}
          preselectedTechEmail={preselectedAbsenceEmail}
          initialDateMs={initialAbsenceDateMs}
          knownAdminUids={currentAdminUids}
          googleSheetId={settings.googleSheetId}
          onAbsenceMutated={handleAdminAbsenceSheetSync}
          onClose={() => {
            setAbsenceModalOpen(false);
            setEditingAbsence(null);
          }}
          onSaved={(msg) => showToast(msg, 'success')}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      {/* Admin Autonomous Task Review Modal */}
      {profile && (
        <AdminTaskReviewModal
          open={Boolean(reviewingTask)}
          task={reviewingTask}
          taskAssignments={
            reviewingTask
              ? assignmentsByTask.get(reviewingTask.taskId) || []
              : []
          }
          taskMaterials={
            reviewingTask
              ? materialsByTask.get(reviewingTask.taskId) || []
              : []
          }
          taskPhotos={
            reviewingTask ? photosByTask.get(reviewingTask.taskId) || [] : []
          }
          directory={directory}
          absences={absences}
          adminUid={profile.uid}
          currentAdminUids={currentAdminUids}
          activeAdminEmails={activeAdminEmails}
          masterDriveFolderId={settings.driveSharedFolderId}
          googleSheetId={settings.googleSheetId}
          operatorColorLabels={settings.operatorColorLabels}
          connectGoogleWorkspace={connectGoogleWorkspace}
          onClose={() => setReviewingTask(null)}
          onReviewCompleted={handleReviewCompleted}
          onToast={showToast}
        />
      )}

      {/* Explicit Force-Override Confirmation Modal for Absent Technician Assignments */}
      <ConfirmModal
        open={Boolean(forcedAssignPrompt)}
        title={forcedAssignPrompt?.title || 'Conflitto assenza tecnico'}
        description={forcedAssignPrompt?.description || ''}
        confirmLabel="Forza Assegnazione"
        loading={executingForcedAssign}
        onConfirm={async () => {
          if (!forcedAssignPrompt) return;
          setExecutingForcedAssign(true);
          try {
            await forcedAssignPrompt.onConfirm();
          } finally {
            setExecutingForcedAssign(false);
          }
        }}
        onCancel={() => setForcedAssignPrompt(null)}
      />

      {/* Explicit Confirmation Modal for Direct Calendar Drag / Reassign Google Sheet Update */}
      <ConfirmModal
        open={Boolean(pendingDirectSheetPrompt)}
        title={
          pendingDirectSheetPrompt
            ? `Aggiornare anche il foglio Google Sheet (${pendingDirectSheetPrompt.weekCodesLabel})?`
            : 'Aggiornare il foglio Google Sheet?'
        }
        description={pendingDirectSheetPrompt?.summaryText || ''}
        confirmLabel="Aggiorna foglio"
        cancelLabel="Solo nell'app"
        loading={syncingDirectSheet}
        onConfirm={handleConfirmDirectSheetSync}
        onCancel={() => setPendingDirectSheetPrompt(null)}
      />

      {/* Explicit Confirmation Modal for Manual Full-Week Google Sheet Alignment */}
      <ConfirmModal
        open={confirmWeekSyncOpen}
        title={`Sincronizzare la settimana ${visibleWeekCode} su Google Sheets?`}
        description={`Allinea tutte le celle dei tecnici attivi da lunedì ${formatDateIt(
          weekDays[0].getTime()
        )} a domenica ${formatDateIt(
          weekDays[6].getTime()
        )} sulla scheda "${visibleWeekCode}" con i task approvati e le assenze registrate nell'app.\n\nEventuali note scritte a mano e i colori delle celle sul foglio verranno conservati.`}
        confirmLabel={`Sincronizza ${visibleWeekCode}`}
        loading={syncingFullWeek}
        onConfirm={handleConfirmFullWeekSheetSync}
        onCancel={() => setConfirmWeekSyncOpen(false)}
      />

      {/* Confirm Delete Task Modal */}
      <ConfirmModal
        open={Boolean(confirmDeleteTask)}
        title="Eliminare questo intervento?"
        description={
          confirmDeleteTask
            ? `Verranno eliminati definitivamente il task ${confirmDeleteTask.taskCode} (${formatTaskCommessaLabel(
              confirmDeleteTask
            )}), le assegnazioni collegate e le voci materiali associate.${hasConfiguredSheet &&
              !confirmDeleteTask.pendingAdminReview &&
              confirmDeleteTask.assignedEmails.length > 0
              ? `\n\nVerrà rimossa anche la relativa descrizione dal foglio Google Sheet (${collectImpactedWeekCodes(
                [confirmDeleteTask]
              ).join(', ')}) conservando le altre note nella cella.`
              : ''
            }`
            : ''
        }
        confirmLabel="Elimina Task"
        destructive
        loading={deletingTask}
        onConfirm={handleDeleteTaskConfirmed}
        onCancel={() => setConfirmDeleteTask(null)}
      />

      {/* Multi-Photo Upload Confirmation Modal */}
      <MultiPhotoUploadModal
        open={pendingPhotoFiles.length > 0 && Boolean(pendingPhotoTarget)}
        files={pendingPhotoFiles}
        driveFolderPath={
          selectedTask
            ? formatTaskDriveSubfolderName(
              selectedTask.commessa,
              selectedTask.taskCode
            )
            : 'Archivio Centrale SITE'
        }
        caption={photoCaption}
        onCaptionChange={setPhotoCaption}
        onRemoveFile={(idx) =>
          setPendingPhotoFiles((prev) => prev.filter((_, i) => i !== idx))
        }
        onAppendFiles={(extra) =>
          setPendingPhotoFiles((prev) => [...prev, ...extra])
        }
        onConfirm={handleAdminPhotoConfirmUpload}
        onCancel={() => {
          setPendingPhotoFiles([]);
          setPendingPhotoTarget(null);
          setPhotoCaption('');
        }}
        uploading={uploadingPhoto}
        progress={photoUploadProgress}
        technicianLabel={pendingPhotoTarget?.technicianName}
      />
    </div>
  );
};
