import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarOff,
  CalendarRange,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  ClipboardList,
  Copy,
  Edit3,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  LogOut,
  Mail,
  PackagePlus,
  PhoneCall,
  Play,
  Plus,
  Save,
  Search,
  Smartphone,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
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
  formatCalendarEventTitle,
  formatCompactTechNames,
  formatDateIt,
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
  Assignment,
  AssignmentStatus,
  BOOTSTRAPPED_ADMIN_EMAILS,
  DEFAULT_TASK_COLOR_ID,
  isNonAbsenceEntryType,
  Task,
  TaskColorId,
  TaskStatus,
} from '../../types/domain';
import { StatusIndicator } from '../StatusIndicator';
import { ConfirmModal } from '../ConfirmModal';
import {
  EmailDraftConfig,
  EmailNotificationModal,
} from '../EmailNotificationModal';
import { MultiPhotoUploadModal } from '../MultiPhotoUploadModal';
import { PWAInstallButton } from '../PWAInstallButton';
import { AbsenceModal } from '../AbsenceModal';
import {
  AdminTaskReviewModal,
  ReviewCompletedPayload,
} from '../AdminTaskReviewModal';
import { TaskColorPicker } from '../TaskColorPicker';
import { AdminNotificationControl } from '../AdminNotificationControl';
import { AdminMaterialsReportView } from '../admin/AdminMaterialsReportView';
import { AdminArticlesView } from '../admin/AdminArticlesView';
import { AdminTeamSettingsView } from '../admin/AdminTeamSettingsView';
import { OnCallCalendarView } from '../OnCallCalendarView';

type MobileAdminTab = 'calendar' | 'on_call' | 'free_kpi' | 'materials' | 'manage';
type SmartphoneAdminCalMode = '3days' | 'day' | 'week' | 'month';
type ManageSubSection = 'articles' | 'team';
type QueueFilter =
  | 'ALL'
  | 'PENDING_REVIEW'
  | 'UNASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED';

const PHONE_HOUR_HEIGHT = 48;
const PHONE_TOTAL_GRID_HEIGHT = 24 * PHONE_HOUR_HEIGHT;

interface PositionedAdminTask {
  task: Task;
  startMin: number;
  endMin: number;
  colIndex: number;
  totalCols: number;
  colSpan?: number;
}

interface PositionedHourlyAbsence {
  absence: Absence;
  startMin: number;
  endMin: number;
  colIndex: number;
  totalCols: number;
  colSpan?: number;
}

function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function formatMinutesAsHHMM(totalMin: number): string {
  const clamped = Math.max(0, Math.min(24 * 60, totalMin));
  if (clamped === 24 * 60) return '24:00';
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

function getStartOfWeek(d: Date): Date {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = copy.getDate() - day + (day === 0 ? -6 : 1);
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

function taskOccursOnDay(task: Task, dayStartMs: number): boolean {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  const effectiveEnd = Math.max(task.fineMs, task.inizioMs + 60000);
  return task.inizioMs < dayEndMs && effectiveEnd > dayStartMs;
}

function absenceOccursOnDay(absence: Absence, dayStartMs: number): boolean {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);
  return absence.inizioMs < dayEndMs && absence.fineMs > dayStartMs;
}

function layoutMobileAdminColumnItems(
  dayTasks: Task[],
  dayAbsences: Absence[],
  dayStartMs: number
): {
  positionedTasks: PositionedAdminTask[];
  positionedAbsences: PositionedHourlyAbsence[];
} {
  const dayEndMs = addLocalDaysMs(dayStartMs, 1);

  type UnifiedAdminMobilePayload =
    | { kind: 'task'; task: Task }
    | { kind: 'absence'; absence: Absence };

  const inputs: VerticalOverlapSlotInput<UnifiedAdminMobilePayload>[] = [];

  for (const task of dayTasks) {
    const clippedStart = Math.max(task.inizioMs, dayStartMs);
    const clippedEnd = Math.min(
      Math.max(task.fineMs, task.inizioMs + 3600000),
      dayEndMs
    );
    const startMin = Math.max(
      0,
      Math.round((clippedStart - dayStartMs) / 60000)
    );
    const endMin = Math.min(
      24 * 60,
      Math.max(startMin + 35, Math.round((clippedEnd - dayStartMs) / 60000))
    );
    inputs.push({
      id: `task_${task.taskId}`,
      startMin,
      endMin,
      priority: 0,
      payload: { kind: 'task', task },
    });
  }

  for (const absence of dayAbsences) {
    const clippedStart = Math.max(absence.inizioMs, dayStartMs);
    const clippedEnd = Math.min(
      Math.max(absence.fineMs, absence.inizioMs + 1800000),
      dayEndMs
    );
    const startMin = Math.max(
      0,
      Math.round((clippedStart - dayStartMs) / 60000)
    );
    const endMin = Math.min(
      24 * 60,
      Math.max(startMin + 30, Math.round((clippedEnd - dayStartMs) / 60000))
    );
    inputs.push({
      id: `abs_${absence.absenceId}`,
      startMin,
      endMin,
      priority: 1,
      payload: { kind: 'absence', absence },
    });
  }

  const packed = layoutOverlappingVerticalSlots(inputs);
  const positionedTasks: PositionedAdminTask[] = [];
  const positionedAbsences: PositionedHourlyAbsence[] = [];

  for (const slot of packed) {
    if (slot.payload.kind === 'task') {
      positionedTasks.push({
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

  return { positionedTasks, positionedAbsences };
}

export const MobileAdminPortal: React.FC = () => {
  const {
    profile,
    tasks,
    assignments,
    absences,
    onCallShifts,
    onCallOverrides,
    directory,
    articles,
    usedMaterials,
    photos,
    settings,
    currentAdminUids,
    activeAdminEmails,
    currentUserReplyToEmail,
    resolveDeliverableEmail,
    pendingReviewTasksCount,
    driveSyncStatus,
    syncMasterDrivePermissionsAndOwnership,
    setViewMode,
    signOutUser,
    connectGoogleWorkspace,
    showToast,
    pendingOpenTaskId,
    clearPendingOpenTask,
  } = useApp();

  // Navigation & View States
  const [activeTab, setActiveTab] = useState<MobileAdminTab>('calendar');
  const [manageSection, setManageSection] =
    useState<ManageSubSection>('articles');
  const [calMode, setCalMode] = useState<SmartphoneAdminCalMode>('3days');
  const [anchorDate, setAnchorDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [monthDrawerOpen, setMonthDrawerOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('ALL');
  const [queueSearch, setQueueSearch] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Email Notification Modal
  const [emailDraft, setEmailDraft] = useState<EmailDraftConfig | null>(null);


  // Absence Create / Edit Modal
  const [absenceModalOpen, setAbsenceModalOpen] = useState(false);
  const [editingAbsence, setEditingAbsence] = useState<Absence | null>(null);
  const [preselectedAbsenceEmail, setPreselectedAbsenceEmail] = useState<
    string | undefined
  >(undefined);

  // Autonomous Task Review Modal
  const [reviewingTask, setReviewingTask] = useState<Task | null>(null);

  // Task Create/Edit Form State
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [commessa, setCommessa] = useState('');
  const [altroReparto, setAltroReparto] = useState(false);
  const [taskColorId, setTaskColorId] = useState<TaskColorId>(
    DEFAULT_TASK_COLOR_ID
  );
  const [descrizione, setDescrizione] = useState('');
  const [inizioInput, setInizioInput] = useState('');
  const [fineInput, setFineInput] = useState('');
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [forceAbsentOverride, setForceAbsentOverride] = useState(false);
  const [savingTask, setSavingTask] = useState(false);

  // Deep-link from Web Push / OS Notification / Toast
  useEffect(() => {
    if (!pendingOpenTaskId) return;
    const target = tasks.find((t) => t.taskId === pendingOpenTaskId);
    if (!target) return;
    const targetDay = new Date(target.inizioMs);
    targetDay.setHours(0, 0, 0, 0);
    setAnchorDate(targetDay);
    setActiveTab('calendar');
    setSelectedTaskId(target.taskId);
    if (target.pendingAdminReview && !target.commessa.trim()) {
      setReviewingTask(target);
    }
    clearPendingOpenTask();
  }, [pendingOpenTaskId, tasks, clearPendingOpenTask]);

  // Delete Task Confirmation
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<Task | null>(null);
  const [deletingTask, setDeletingTask] = useState(false);

  // Admin Status & Notes Override State
  const [updatingTaskStatus, setUpdatingTaskStatus] = useState(false);
  const [updatingAsgId, setUpdatingAsgId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [savingNoteAsgId, setSavingNoteAsgId] = useState<string | null>(null);

  // Admin Add Material Sheet
  const [addingMatForAsg, setAddingMatForAsg] = useState<Assignment | null>(
    null
  );
  const [matCategory, setMatCategory] = useState('');
  const [matArticleId, setMatArticleId] = useState('');
  const [matQty, setMatQty] = useState('1');
  const [savingMat, setSavingMat] = useState(false);

  // Admin Multi-Photo Upload State
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingPhotoTarget, setPendingPhotoTarget] =
    useState<Assignment | null>(null);
  const [pendingPhotoFiles, setPendingPhotoFiles] = useState<File[]>([]);
  const [photoCaption, setPhotoCaption] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploadProgress, setPhotoUploadProgress] =
    useState<BatchPhotoUploadProgress | null>(null);

  // Gestione tasto / gesto "Indietro" su Smartphone Android (evita chiusura accidentale PWA)
  const backStateRef = useRef({
    hasEmailDraft: Boolean(emailDraft),
    hasPendingPhotos: pendingPhotoFiles.length > 0,
    hasConfirmDelete: Boolean(confirmDeleteTask),
    hasReviewingTask: Boolean(reviewingTask),
    addingMatForAsg: Boolean(addingMatForAsg),
    taskModalOpen,
    absenceModalOpen,
    monthDrawerOpen,
    selectedTaskId,
    activeTab,
  });

  useEffect(() => {
    backStateRef.current = {
      hasEmailDraft: Boolean(emailDraft),
      hasPendingPhotos: pendingPhotoFiles.length > 0,
      hasConfirmDelete: Boolean(confirmDeleteTask),
      hasReviewingTask: Boolean(reviewingTask),
      addingMatForAsg: Boolean(addingMatForAsg),
      taskModalOpen,
      absenceModalOpen,
      monthDrawerOpen,
      selectedTaskId,
      activeTab,
    };
  }, [
    emailDraft,
    pendingPhotoFiles.length,
    confirmDeleteTask,
    reviewingTask,
    addingMatForAsg,
    taskModalOpen,
    absenceModalOpen,
    monthDrawerOpen,
    selectedTaskId,
    activeTab,
  ]);

  const lastBackPressAtRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!window.history.state?.siteMobileGuard) {
      window.history.pushState({ siteMobileGuard: true }, '');
    }

    const handlePopState = () => {
      const s = backStateRef.current;

      // 1. Chiude eventuali modali / bottom-sheet aperti
      if (s.hasEmailDraft) {
        setEmailDraft(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.hasPendingPhotos) {
        setPendingPhotoFiles([]);
        setPendingPhotoTarget(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.hasConfirmDelete) {
        setConfirmDeleteTask(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.hasReviewingTask) {
        setReviewingTask(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.addingMatForAsg) {
        setAddingMatForAsg(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.taskModalOpen) {
        setTaskModalOpen(false);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.absenceModalOpen) {
        setAbsenceModalOpen(false);
        setEditingAbsence(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.monthDrawerOpen) {
        setMonthDrawerOpen(false);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }

      // 2. Chiude il dettaglio intervento e torna alla vista precedente
      if (s.selectedTaskId) {
        setSelectedTaskId(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }

      // 3. Se si trova in Reperibilità, Liberi & KPI, Consuntivo o Gestione, torna al Calendario
      if (s.activeTab !== 'calendar') {
        setActiveTab('calendar');
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }

      // 4. Già sulla schermata principale del Calendario: doppio indietro entro 2.5s per uscire
      const now = Date.now();
      if (now - lastBackPressAtRef.current < 2500) {
        window.history.back();
        return;
      }

      lastBackPressAtRef.current = now;
      window.history.pushState({ siteMobileGuard: true }, '');
      showToast('Premi di nuovo indietro per uscire dall’app', 'info', {
        durationMs: 2500,
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [showToast]);

  // Calendar Scroll & Touch Swipe Refs
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const didInitialScrollRef = useRef(false);
  const touchSwipeStartXRef = useRef<number | null>(null);
  const touchSwipeStartYRef = useRef<number | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (
      activeTab === 'calendar' &&
      !selectedTaskId &&
      calMode !== 'month' &&
      timelineScrollRef.current &&
      !didInitialScrollRef.current
    ) {
      timelineScrollRef.current.scrollTop = Math.max(
        0,
        7 * PHONE_HOUR_HEIGHT - 16
      );
      didInitialScrollRef.current = true;
    }
  }, [activeTab, calMode, selectedTaskId]);

  const activeTechnicians = useMemo(
    () => directory.filter((m) => m.active),
    [directory]
  );

  const selectedTask = useMemo(
    () => tasks.find((t) => t.taskId === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  const activeAssignments = useMemo(
    () => assignments.filter((a) => a.stato !== 'Annullato'),
    [assignments]
  );

  const selectedTaskAssignments = useMemo(() => {
    if (!selectedTask) return [];
    return activeAssignments.filter((a) => a.taskId === selectedTask.taskId);
  }, [activeAssignments, selectedTask]);

  useEffect(() => {
    if (!selectedTask) return;
    setNoteDrafts((prev) => {
      const next = { ...prev };
      for (const asg of selectedTaskAssignments) {
        if (next[asg.assignmentId] === undefined) {
          next[asg.assignmentId] = asg.noteTecnico || '';
        }
      }
      return next;
    });
  }, [selectedTask, selectedTaskAssignments]);

  // Visible Days in Mobile Calendar
  const visibleDays = useMemo(() => {
    if (calMode === 'day') {
      const d = new Date(anchorDate);
      d.setHours(0, 0, 0, 0);
      return [d];
    }
    if (calMode === '3days') {
      return Array.from({ length: 3 }, (_, idx) => {
        const d = new Date(anchorDate);
        d.setDate(anchorDate.getDate() + idx);
        d.setHours(0, 0, 0, 0);
        return d;
      });
    }
    const start = getStartOfWeek(anchorDate);
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(start);
      d.setDate(start.getDate() + idx);
      return d;
    });
  }, [anchorDate, calMode]);

  const visibleDayStartsMs = useMemo(
    () => visibleDays.map((d) => startOfLocalDayMs(d.getTime())),
    [visibleDays]
  );

  // Google Calendar Top Horizontal Strip Spans (>= 3 solar days, Lavorazione altro AT, All-day Absences)
  const topStripPacked = useMemo(() => {
    const items: HorizontalStripItem<Task | Absence>[] = [];
    for (const t of tasks) {
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
    for (const a of absences) {
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
    return packHorizontalStripSpans(items, visibleDayStartsMs);
  }, [tasks, absences, visibleDayStartsMs]);

  const monthDays = useMemo(
    () => getMonthCalendarDays(anchorDate),
    [anchorDate]
  );

  const mobileWeekBadge = useMemo(() => {
    if (calMode === 'month') {
      return formatCalendarWeekBadgeIt([
        new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1),
        new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0),
      ]);
    }
    return formatCalendarWeekBadgeIt(visibleDays);
  }, [anchorDate, calMode, visibleDays]);

  // KPI Metrics & Free Technicians for anchorDate
  const todayStartMs = useMemo(() => startOfDayMs(nowMs), [nowMs]);
  const anchorDayMs = useMemo(() => startOfDayMs(anchorDate), [anchorDate]);

  const kpiStats = useMemo(() => {
    const total = tasks.length;
    const unassigned = tasks.filter(
      (t) => t.statoPrevalente === 'Non Assegnato'
    ).length;
    const inProgress = tasks.filter(
      (t) => t.statoPrevalente === 'Preso in Carico'
    ).length;
    const completed = tasks.filter(
      (t) => t.statoPrevalente === 'Completato'
    ).length;
    return { total, unassigned, inProgress, completed };
  }, [tasks]);

  const freeTechEvaluation = useMemo(() => {
    const busyEmails = new Set<string>();
    const dayEndMs = addLocalDaysMs(anchorDayMs, 1);

    for (const t of tasks) {
      if (t.statoPrevalente === 'Completato') continue;
      if (taskOccursOnDay(t, anchorDayMs)) {
        for (const em of t.assignedEmails) {
          busyEmails.add(em.toLowerCase());
        }
      }
    }

    const absentList: { tech: (typeof activeTechnicians)[number]; overlaps: Absence[] }[] = [];
    const commitmentList: { tech: (typeof activeTechnicians)[number]; overlaps: Absence[] }[] = [];
    const absentAllDayEmails = new Set<string>();
    const partialAbsenceMap = new Map<string, Absence[]>();

    for (const tech of activeTechnicians) {
      const overlaps = findOverlappingAbsencesForTech(
        absences,
        tech.email,
        anchorDayMs,
        dayEndMs
      );
      if (overlaps.length > 0) {
        const trueAbsences = overlaps.filter((a) => !isNonAbsenceEntryType(a.tipo));
        const commitments = overlaps.filter((a) => isNonAbsenceEntryType(a.tipo));
        if (trueAbsences.length > 0) {
          absentList.push({ tech, overlaps: trueAbsences });
        }
        if (commitments.length > 0) {
          commitmentList.push({ tech, overlaps: commitments });
        }
        if (trueAbsences.some((a) => isTopStripAbsence(a))) {
          absentAllDayEmails.add(tech.email.toLowerCase());
        } else {
          partialAbsenceMap.set(tech.email.toLowerCase(), overlaps);
        }
      }
    }

    const free = activeTechnicians.filter((m) => {
      const norm = m.email.toLowerCase();
      return !busyEmails.has(norm) && !absentAllDayEmails.has(norm);
    });

    return {
      free,
      busyCount: busyEmails.size,
      absentList,
      commitmentList,
      partialAbsenceMap,
    };
  }, [tasks, absences, activeTechnicians, anchorDayMs]);

  const filteredQueueTasks = useMemo(() => {
    const q = queueSearch.trim().toLowerCase();
    return tasks.filter((t) => {
      if (queueFilter === 'PENDING_REVIEW' && !t.pendingAdminReview) {
        return false;
      }
      if (queueFilter === 'UNASSIGNED' && t.statoPrevalente !== 'Non Assegnato') {
        return false;
      }
      if (
        queueFilter === 'IN_PROGRESS' &&
        t.statoPrevalente !== 'Preso in Carico'
      ) {
        return false;
      }
      if (queueFilter === 'COMPLETED' && t.statoPrevalente !== 'Completato') {
        return false;
      }
      if (q) {
        const hay = `${t.taskCode} ${t.commessa} ${formatTaskCommessaLabel(t)} ${t.descrizione} ${t.assignedNames.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tasks, queueFilter, queueSearch]);

  // Task Modal parsed window & absence conflict detection
  const taskModalWindow = useMemo(() => {
    const s = new Date(inizioInput).getTime();
    const f = new Date(fineInput).getTime();
    return {
      inizioMs: Number.isNaN(s) ? 0 : s,
      fineMs: Number.isNaN(f) ? 0 : f,
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
        taskModalWindow.fineMs
      );
      if (overlaps.length > 0) {
        map.set(tech.email.toLowerCase(), overlaps);
      }
    }
    return map;
  }, [activeTechnicians, absences, taskModalWindow]);

  // Date Navigation Helpers
  const shiftPeriod = (dir: -1 | 1) => {
    const next = new Date(anchorDate);
    if (calMode === 'day') {
      next.setDate(next.getDate() + dir);
    } else if (calMode === '3days') {
      next.setDate(next.getDate() + dir * 3);
    } else if (calMode === 'week') {
      next.setDate(next.getDate() + dir * 7);
    } else {
      next.setMonth(next.getMonth() + dir);
    }
    setAnchorDate(next);
  };

  const shiftAnchorSingleDay = (dir: -1 | 1) => {
    const next = new Date(anchorDate);
    next.setDate(next.getDate() + dir);
    setAnchorDate(next);
  };

  const goToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setAnchorDate(d);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touchSwipeStartXRef.current = e.touches[0].clientX;
    touchSwipeStartYRef.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (
      touchSwipeStartXRef.current === null ||
      touchSwipeStartYRef.current === null ||
      e.changedTouches.length !== 1
    ) {
      return;
    }
    const dx = e.changedTouches[0].clientX - touchSwipeStartXRef.current;
    const dy = e.changedTouches[0].clientY - touchSwipeStartYRef.current;
    touchSwipeStartXRef.current = null;
    touchSwipeStartYRef.current = null;

    if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.8) {
      shiftPeriod(dx < 0 ? 1 : -1);
    }
  };

  const openNewAbsenceModal = (preselectedEmail?: string) => {
    setEditingAbsence(null);
    setPreselectedAbsenceEmail(preselectedEmail);
    setAbsenceModalOpen(true);
  };

  const openEditAbsenceModal = (absence: Absence) => {
    setEditingAbsence(absence);
    setPreselectedAbsenceEmail(absence.technicianEmail);
    setAbsenceModalOpen(true);
  };

  // Open Create/Edit Task Modal
  const openCreateTaskModal = (
    customStartMs?: number,
    preselectedTechEmail?: string,
    forceOverride?: boolean
  ) => {
    setEditingTask(null);
    setCommessa('');
    setAltroReparto(false);
    setTaskColorId(DEFAULT_TASK_COLOR_ID);
    setDescrizione('');
    const baseMs =
      customStartMs ??
      (() => {
        const d = new Date(anchorDate);
        d.setHours(8, 0, 0, 0);
        return d.getTime();
      })();
    const endMs = baseMs + 2 * 3600000;
    setInizioInput(toLocalDateTimeInput(baseMs));
    setFineInput(toLocalDateTimeInput(endMs));
    setSelectedEmails(
      preselectedTechEmail ? [preselectedTechEmail.toLowerCase()] : []
    );
    setForceAbsentOverride(Boolean(forceOverride));
    setTaskModalOpen(true);
  };

  const openEditTaskModal = (task: Task) => {
    setEditingTask(task);
    setCommessa(task.commessa);
    setAltroReparto(Boolean(task.altroReparto));
    setTaskColorId(resolveTaskColorId(task));
    setDescrizione(task.descrizione);
    setInizioInput(toLocalDateTimeInput(task.inizioMs));
    setFineInput(toLocalDateTimeInput(task.fineMs));
    setSelectedEmails(task.assignedEmails.map((em) => em.toLowerCase()));
    setForceAbsentOverride(false);
    setTaskModalOpen(true);
  };

  const openDuplicateTaskModal = (task: Task) => {
    setEditingTask(null);
    setCommessa(task.commessa);
    setAltroReparto(Boolean(task.altroReparto));
    setTaskColorId(resolveTaskColorId(task));
    setDescrizione(task.descrizione);
    setInizioInput(toLocalDateTimeInput(task.inizioMs));
    setFineInput(toLocalDateTimeInput(task.fineMs));
    setSelectedEmails(task.assignedEmails.map((em) => em.toLowerCase()));
    setForceAbsentOverride(false);
    setTaskModalOpen(true);
    showToast(
      `Bozza creata da ${task.taskCode}. Modifica orari o dettagli e salva per confermare.`,
      'info'
    );
  };

  const handleInizioChange = (val: string) => {
    setInizioInput(val);
    const parsedStart = new Date(val).getTime();
    const parsedEnd = new Date(fineInput).getTime();
    if (!Number.isNaN(parsedStart)) {
      if (Number.isNaN(parsedEnd) || parsedEnd < parsedStart + 3600000) {
        setFineInput(toLocalDateTimeInput(parsedStart + 3600000));
      }
    }
  };

  const durationError = useMemo(() => {
    if (!inizioInput || !fineInput) return null;
    const s = new Date(inizioInput).getTime();
    const f = new Date(fineInput).getTime();
    if (Number.isNaN(s) || Number.isNaN(f)) return 'Formato data/ora non valido.';
    if (f - s < 3600000) {
      return 'La durata minima del task è di 1 ora.';
    }
    return null;
  }, [inizioInput, fineInput]);

  const toggleTechnicianSelection = (email: string) => {
    const clean = email.toLowerCase();
    const isCurrentlyChecked = selectedEmails.includes(clean);
    if (
      !isCurrentlyChecked &&
      modalAbsentConflictsByEmail.has(clean) &&
      !forceAbsentOverride
    ) {
      showToast(
        'Tecnico assente o con impegno nella fascia selezionata. Attiva "Forza su assente / impegno" per selezionarlo.',
        'info'
      );
      return;
    }

    setSelectedEmails((prev) => {
      if (prev.includes(clean)) return prev.filter((e) => e !== clean);
      if (prev.length >= 10) {
        showToast('Massimo 10 tecnici assegnabili per task', 'info');
        return prev;
      }
      return [...prev, clean];
    });
  };

  const handleSaveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || durationError) return;

    const selectedAbsent = selectedEmails.filter((em) =>
      modalAbsentConflictsByEmail.has(em)
    );
    if (selectedAbsent.length > 0 && !forceAbsentOverride) {
      showToast(
        'Conferma la forzatura per assegnare un tecnico segnato assente o con impegni in questa fascia oraria.',
        'error'
      );
      return;
    }

    setSavingTask(true);
    try {
      const selectedAssignees: SelectedAssignee[] = selectedEmails.map(
        (email) => {
          const member = directory.find(
            (m) => m.email.toLowerCase() === email
          );
          return {
            email,
            fullName: member
              ? `${member.nome} ${member.cognome}`.trim()
              : email,
            linkedUid: member?.linkedUid || '',
          };
        }
      );

      const savedId = await saveTaskAndAssignments({
        existingTask: editingTask || undefined,
        existingTaskAssignments: editingTask
          ? activeAssignments.filter((a) => a.taskId === editingTask.taskId)
          : [],
        existingTaskMaterials: editingTask
          ? usedMaterials.filter((m) => m.taskId === editingTask.taskId)
          : [],
        existingTaskPhotos: editingTask
          ? photos.filter((p) => p.taskId === editingTask.taskId)
          : [],
        allTasksForCommessaCount: tasks,
        commessa: altroReparto ? commessa.trim() : commessa,
        altroReparto,
        colorId: taskColorId,
        descrizione,
        inizioIso: new Date(inizioInput).toISOString(),
        fineIso: new Date(fineInput).toISOString(),
        assignees: selectedAssignees,
        adminUid: profile.uid,
        currentAdminUids,
        activeAdminEmails,
      });

      setSelectedTaskId(savedId);
      setTaskModalOpen(false);
      showToast(
        editingTask
          ? 'Intervento aggiornato correttamente'
          : altroReparto
            ? 'Lavorazione altro AT pianificata a margine'
            : 'Nuovo intervento pianificato',
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio task.',
        'error'
      );
    } finally {
      setSavingTask(false);
    }
  };

  // Whole-Task Status Override (Admin without mandatory notes)
  const handleWholeTaskStatusOverride = async (
    task: Task,
    newStatus: TaskStatus
  ) => {
    if (!profile) return;
    setUpdatingTaskStatus(true);
    const wasAlreadyCompleted = task.statoPrevalente === 'Completato';
    try {
      const taskAsgs = activeAssignments.filter(
        (a) => a.taskId === task.taskId
      );
      await adminUpdateEntireTaskStatus({
        task,
        taskAssignments: taskAsgs,
        newStatus,
        actorName:
          `${profile.nome} ${profile.cognome}`.trim() || profile.email,
      });
      showToast(`${task.taskCode} impostato su "${newStatus}"`, 'success');

      if (!wasAlreadyCompleted && newStatus === 'Completato') {
        if (task.altroReparto) {
          return;
        }
        if (task.pendingAdminReview) {
          showToast(
            'Task completato · Revisiona e inserisci la commessa per inviare il riepilogo email Admin.',
            'info'
          );
          return;
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
          taskMaterials: usedMaterials.filter((m) => m.taskId === task.taskId),
          taskPhotos: photos.filter((p) => p.taskId === task.taskId),
          activeAdminEmails,
          resolveDeliverableEmail,
          masterFolderId: settings.driveSharedFolderId,
        });
        setEmailDraft({
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

  // Individual Technician Assignment Status Override (Admin without mandatory notes)
  const handleIndividualStatusChange = async (
    asg: Assignment,
    newStatus: AssignmentStatus
  ) => {
    if (!profile) return;
    setUpdatingAsgId(asg.assignmentId);
    try {
      const parentTask = tasks.find((t) => t.taskId === asg.taskId) || null;
      const currentNote =
        noteDrafts[asg.assignmentId] !== undefined
          ? noteDrafts[asg.assignmentId]
          : asg.noteTecnico;
      const siblings = activeAssignments.filter((a) => a.taskId === asg.taskId);
      const res = await updateAssignmentStatusAndNotes({
        assignment: asg,
        siblingAssignments: siblings,
        newStatus,
        noteTecnico: currentNote,
        exemptCommesse: settings.exemptCommesse,
        isAltroReparto: Boolean(parentTask?.altroReparto),
        actorUid: profile.uid,
        isAdminActor: true,
      });
      showToast(
        `Stato di ${asg.technicianName} impostato su "${newStatus}"`,
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
            [asg.assignmentId]: currentNote,
          },
          taskMaterials: usedMaterials.filter((m) => m.taskId === asg.taskId),
          taskPhotos: photos.filter((p) => p.taskId === asg.taskId),
          activeAdminEmails,
          resolveDeliverableEmail,
          masterFolderId: settings.driveSharedFolderId,
        });
        setEmailDraft({
          ...summary,
          modalTitle: 'Task completato — Invia riepilogo',
        });
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore stato tecnico.',
        'error'
      );
    } finally {
      setUpdatingAsgId(null);
    }
  };

  const handleSaveAdminNote = async (asg: Assignment) => {
    if (!profile) return;
    setSavingNoteAsgId(asg.assignmentId);
    try {
      const parentTask = tasks.find((t) => t.taskId === asg.taskId) || null;
      const draft =
        noteDrafts[asg.assignmentId] !== undefined
          ? noteDrafts[asg.assignmentId]
          : asg.noteTecnico;
      await updateAssignmentStatusAndNotes({
        assignment: asg,
        siblingAssignments: activeAssignments.filter(
          (a) => a.taskId === asg.taskId
        ),
        newStatus: asg.stato,
        noteTecnico: draft,
        exemptCommesse: settings.exemptCommesse,
        isAltroReparto: Boolean(parentTask?.altroReparto),
        actorUid: profile.uid,
        isAdminActor: true,
      });
      showToast(`Nota salvata per ${asg.technicianName}`, 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio nota.',
        'error'
      );
    } finally {
      setSavingNoteAsgId(null);
    }
  };

  const handleReviewCompleted = (payload: ReviewCompletedPayload) => {
    if (payload.resultingTaskStatus === 'Completato' && !payload.task.altroReparto) {
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
        taskMaterials: usedMaterials.filter(
          (m) => m.taskId === payload.task.taskId
        ),
        taskPhotos: photos.filter((p) => p.taskId === payload.task.taskId),
        activeAdminEmails,
        resolveDeliverableEmail,
        masterFolderId: settings.driveSharedFolderId,
      });
      setEmailDraft({
        ...summary,
        modalTitle: 'Revisione completata — Invia riepilogo',
      });
    }
  };

  // Delete Task Confirmed
  const handleDeleteTaskConfirmed = async () => {
    if (!confirmDeleteTask) return;
    setDeletingTask(true);
    try {
      const tId = confirmDeleteTask.taskId;
      await deleteTaskCascade({
        taskId: tId,
        assignments: assignments.filter((a) => a.taskId === tId),
        usedMaterials: usedMaterials.filter((m) => m.taskId === tId),
        photos: photos.filter((p) => p.taskId === tId),
      });
      if (selectedTaskId === tId) {
        setSelectedTaskId(null);
      }
      showToast(`Task ${confirmDeleteTask.taskCode} eliminato`, 'info');
      setConfirmDeleteTask(null);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore eliminazione task.',
        'error'
      );
    } finally {
      setDeletingTask(false);
    }
  };

  // Admin Add Material
  const activeArticles = useMemo(
    () => articles.filter((a) => a.active),
    [articles]
  );

  const activeCategories = useMemo(() => {
    const set = new Set<string>();
    activeArticles.forEach((a) => set.add(a.categoria));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeArticles]);

  const filteredCatalogForModal = useMemo(() => {
    if (!matCategory) return activeArticles;
    return activeArticles.filter((a) => a.categoria === matCategory);
  }, [activeArticles, matCategory]);

  const handleAdminAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addingMatForAsg || !profile) return;
    const art = activeArticles.find((a) => a.articleId === matArticleId);
    if (!art) {
      showToast('Seleziona un articolo dal catalogo', 'error');
      return;
    }
    const qtyNum = Number(matQty.replace(',', '.'));
    if (Number.isNaN(qtyNum) || qtyNum <= 0) {
      showToast('Inserisci una quantità valida maggiore di zero', 'error');
      return;
    }
    setSavingMat(true);
    try {
      await addUsedMaterialToAssignment({
        assignment: addingMatForAsg,
        article: art,
        quantita: qtyNum,
        actorUid: profile.uid,
        squadEmails: selectedTask?.assignedEmails,
      });
      showToast('Materiale registrato', 'success');
      setAddingMatForAsg(null);
      setMatArticleId('');
      setMatQty('1');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore aggiunta materiale.',
        'error'
      );
    } finally {
      setSavingMat(false);
    }
  };

  // Multi-Photo Batch Upload Confirmed
  const handleAdminPhotoConfirmUpload = async () => {
    if (
      pendingPhotoFiles.length === 0 ||
      !pendingPhotoTarget ||
      !profile ||
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
    const cleanCaption = photoCaption.trim();

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
              caption: cleanCaption,
            });
          },
        });

      if (failedFiles.length === 0) {
        showToast(
          uploadedCount === 1
            ? 'Foto archiviata nella cartella centrale Google Drive SITE'
            : `${uploadedCount} foto archiviate nella cartella centrale Google Drive SITE`,
          'success'
        );
        setPendingPhotoFiles([]);
        setPendingPhotoTarget(null);
        setPhotoCaption('');
      } else {
        showToast(
          `${uploadedCount} foto caricate, ${failedFiles.length} non riuscite.`,
          'error'
        );
        setPendingPhotoFiles((prev) =>
          prev.filter((f) => failedFiles.some((ff) => ff.fileName === f.name))
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore caricamento foto su Google Drive.',
        'error'
      );
    } finally {
      setUploadingPhoto(false);
      setPhotoUploadProgress(null);
    }
  };

  // Compose Gmail Notification for Task
  const openEmailForTask = (task: Task) => {
    const taskAsgs = activeAssignments.filter((a) => a.taskId === task.taskId);
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
        taskMaterials: usedMaterials.filter((m) => m.taskId === task.taskId),
        taskPhotos: photos.filter((p) => p.taskId === task.taskId),
        activeAdminEmails,
        resolveDeliverableEmail,
        masterFolderId: settings.driveSharedFolderId,
      });
      setEmailDraft(summary);
      return;
    }

    const deliverableSquadEmails = Array.from(
      new Set(task.assignedEmails.map(resolveDeliverableEmail).filter(Boolean))
    );
    const recipients =
      deliverableSquadEmails.length > 0
        ? deliverableSquadEmails.join(', ')
        : activeAdminEmails.length > 0
          ? activeAdminEmails.join(', ')
          : BOOTSTRAPPED_ADMIN_EMAILS[0];

    const notesLines = taskAsgs
      .filter((a) => a.noteTecnico.trim())
      .map((a) => `- ${a.technicianName}: ${a.noteTecnico.trim()}`)
      .join('\n');

    setEmailDraft({
      to: recipients,
      contextTitle: `Notifica Task ${task.taskCode}`,
      subject: `[SITE Interventi] ${task.taskCode} · ${commessaDisplay} (${task.statoPrevalente})`,
      bodyText: [
        `Dettagli intervento ${task.taskCode}:`,
        `Commessa: ${commessaDisplay}`,
        `Stato: ${task.statoPrevalente}`,
        `Pianificazione: ${formatDateIt(task.inizioMs)} ${formatTimeIt(
          task.inizioMs
        )} – ${formatTimeIt(task.fineMs)}`,
        `Squadra: ${task.assignedNames.length > 0
          ? task.assignedNames.join(', ')
          : 'Da assegnare'
        }`,
        '',
        `Descrizione:`,
        task.descrizione,
        ...(notesLines ? ['', 'Note operative:', notesLines] : []),
      ].join('\n'),
    });
  };

  const monthTitleLabel = anchorDate.toLocaleDateString('it-IT', {
    month: 'long',
    year: 'numeric',
  });

  const currentMinOfDay = useMemo(() => {
    const d = new Date(nowMs);
    return d.getHours() * 60 + d.getMinutes();
  }, [nowMs]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col pb-16">
      {/* Compact Sticky Top App Bar */}
      <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between gap-2">
        {selectedTask ? (
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setSelectedTaskId(null)}
              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer shrink-0"
              aria-label="Torna indietro"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <p className="text-sm font-semibold font-mono text-slate-900 truncate">
                {selectedTask.taskCode} · {formatTaskCommessaLabel(selectedTask)}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center shrink-0">
              <div className="grid grid-cols-2 gap-0 w-4 h-4 p-0">
                <span className="bg-white rounded-[1px] m-[1px]" />
                <span className="bg-slate-400 rounded-[1px] m-[1px]" />
                <span className="bg-slate-400 rounded-[1px] m-[1px]" />
                <span className="bg-white rounded-[1px] m-[1px]" />
              </div>
            </div>
            <span className="font-display text-sm font-semibold tracking-tight text-slate-900 truncate">
              Admin Mobile
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <AdminNotificationControl variant="mobile-header" />
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={() => setViewMode('mobile')}
            className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 flex items-center gap-2 cursor-pointer whitespace-nowrap"
          >
            <Smartphone className="w-3.5 h-3.5 text-slate-700 shrink-0" />
            <span>Vista Tecnico</span>
          </button>
        </div>
      </header>

      {/* VIEW A: SELECTED TASK FULL ADMIN INSPECTOR */}
      {selectedTask ? (
        <main className="flex-1 p-4 space-y-4 max-w-2xl w-full mx-auto animate-fluid-slide">
          {selectedTask.pendingAdminReview && (
            <section className="rounded-2xl bg-slate-50 border border-slate-300 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <ClipboardCheck className="w-4 h-4 text-slate-700 shrink-0" />
                <h2 className="text-xs font-semibold text-slate-900">
                  Task autonomo · In attesa di revisione
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setReviewingTask(selectedTask)}
                className="w-full min-h-[44px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold flex items-center justify-center gap-2 hover:bg-slate-800 cursor-pointer"
              >
                <ClipboardCheck className="w-4 h-4" />
                <span>Revisiona e inserisci commessa</span>
              </button>
            </section>
          )}

          {selectedTask.altroReparto && (
            <section className="rounded-2xl bg-slate-50 border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700">
              Lavorazione altro AT
            </section>
          )}

          {/* Task Summary Card */}
          <section className="rounded-2xl bg-white border border-slate-200 p-4 space-y-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-slate-500 font-mono tabular-nums flex-wrap">
                <span className="font-semibold text-slate-900">
                  {formatTaskCommessaLabel(selectedTask)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{selectedTask.taskCode}</span>
                <span aria-hidden="true">·</span>
                <StatusIndicator status={selectedTask.statoPrevalente} />
              </div>
              <p className="text-sm font-semibold text-slate-900 leading-snug">
                {selectedTask.descrizione}
              </p>
            </div>

            <div className="text-xs text-slate-600 font-mono tabular-nums pt-2 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
              <span>
                {formatDateIt(selectedTask.inizioMs)} ·{' '}
                {formatTimeIt(selectedTask.inizioMs)} –{' '}
                {formatTimeIt(selectedTask.fineMs)}
              </span>
              <span>
                {selectedTaskAssignments.length > 0
                  ? `${selectedTaskAssignments.length} tecnici`
                  : 'Non assegnato'}
              </span>
            </div>

            {/* Quick Inline Operator Color Picker */}
            <div className="pt-2 border-t border-slate-100">
              <TaskColorPicker
                compact
                value={resolveTaskColorId(selectedTask)}
                operatorColorLabels={settings.operatorColorLabels}
                onChange={(nextColor) => {
                  updateTaskColorId(selectedTask.taskId, nextColor).catch(
                    (err) =>
                      showToast(
                        err instanceof Error
                          ? err.message
                          : 'Errore aggiornamento colore.',
                        'error'
                      )
                  );
                }}
              />
            </div>

            {/* Quick Admin Actions Row */}
            <div className="pt-2 border-t border-slate-100 grid grid-cols-4 gap-1.5">
              <button
                type="button"
                onClick={() => openEditTaskModal(selectedTask)}
                className="min-h-[44px] px-1 py-2 rounded-xl border border-slate-300 bg-white text-[11px] font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <Edit3 className="w-3.5 h-3.5 shrink-0" />
                <span>Modifica</span>
              </button>
              <button
                type="button"
                onClick={() => openDuplicateTaskModal(selectedTask)}
                className="min-h-[44px] px-1 py-2 rounded-xl border border-slate-300 bg-white text-[11px] font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
                title="Copia evento in una nuova bozza"
              >
                <Copy className="w-3.5 h-3.5 shrink-0 text-slate-600" />
                <span>Copia</span>
              </button>
              <button
                type="button"
                onClick={() => openEmailForTask(selectedTask)}
                className="min-h-[44px] px-1 py-2 rounded-xl border border-slate-300 bg-white text-[11px] font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <Mail className="w-3.5 h-3.5 shrink-0" />
                <span>Gmail</span>
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteTask(selectedTask)}
                className="min-h-[44px] px-1 py-2 rounded-xl border border-red-300 bg-white text-[11px] font-semibold text-red-700 hover:bg-red-50 hover:border-red-400 flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>Elimina</span>
              </button>
            </div>
          </section>

          {/* Whole-Task Admin Status Override */}
          <section className="rounded-2xl bg-white border border-slate-200 p-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold text-slate-900">
                Stato intero task
              </h2>
              <span className="text-[11px] text-slate-500">Regia Admin</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  {
                    status: 'Assegnato' as TaskStatus,
                    label: 'Assegnato',
                    icon: CalendarRange,
                  },
                  {
                    status: 'Preso in Carico' as TaskStatus,
                    label: 'In carico',
                    icon: Play,
                  },
                  {
                    status: 'Completato' as TaskStatus,
                    label: 'Completato',
                    icon: CheckCircle2,
                  },
                ] as const
              ).map((btn) => {
                const Icon = btn.icon;
                const isActive = selectedTask.statoPrevalente === btn.status;
                return (
                  <button
                    key={btn.status}
                    type="button"
                    disabled={updatingTaskStatus}
                    onClick={() =>
                      handleWholeTaskStatusOverride(selectedTask, btn.status)
                    }
                    className={`min-h-[44px] px-2 py-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${isActive
                      ? 'bg-slate-900 text-white border-slate-950'
                      : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400'
                      }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span>{btn.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Per-Technician Assignments, Notes, Materials & Multi-Photo */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                Squadra assegnata ({selectedTaskAssignments.length})
              </h2>
              <button
                type="button"
                onClick={() => openEditTaskModal(selectedTask)}
                className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold flex items-center gap-2 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>Gestisci squadra</span>
              </button>
            </div>

            {selectedTaskAssignments.length === 0 ? (
              <div className="rounded-2xl bg-white border border-slate-200 p-4 text-center space-y-2">
                <p className="text-xs text-slate-600">
                  Nessun tecnico assegnato.
                </p>
                <button
                  type="button"
                  onClick={() => openEditTaskModal(selectedTask)}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold inline-flex items-center gap-2 hover:bg-slate-800 cursor-pointer"
                >
                  <UserPlus className="w-4 h-4" />
                  <span>Assegna tecnici</span>
                </button>
              </div>
            ) : (
              selectedTaskAssignments.map((asg) => {
                const asgMats = usedMaterials.filter(
                  (m) => m.assignmentId === asg.assignmentId
                );
                const asgPhotos = photos.filter(
                  (p) => p.assignmentId === asg.assignmentId
                );
                const noteVal =
                  noteDrafts[asg.assignmentId] !== undefined
                    ? noteDrafts[asg.assignmentId]
                    : asg.noteTecnico;

                return (
                  <div
                    key={asg.assignmentId}
                    className="rounded-2xl bg-white border border-slate-200 p-4 space-y-4"
                  >
                    {/* Tech Header + Individual Status Selector */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">
                          {asg.technicianName}
                        </p>
                        <p className="text-[11px] font-mono text-slate-500 truncate">
                          {asg.technicianEmail}
                        </p>
                      </div>

                      <select
                        value={asg.stato}
                        disabled={updatingAsgId === asg.assignmentId}
                        onChange={(e) =>
                          handleIndividualStatusChange(
                            asg,
                            e.target.value as AssignmentStatus
                          )
                        }
                        aria-label={`Stato per ${asg.technicianName}`}
                        className="min-h-[44px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-900 cursor-pointer shrink-0"
                      >
                        <option value="Assegnato">Assegnato</option>
                        <option value="Preso in Carico">Preso in Carico</option>
                        <option value="Completato">Completato</option>
                      </select>
                    </div>

                    {/* Technician Note */}
                    <div className="space-y-2">
                      <label className="block text-xs font-semibold text-slate-700">
                        Note intervento
                      </label>
                      <textarea
                        rows={2}
                        value={noteVal}
                        onChange={(e) =>
                          setNoteDrafts((prev) => ({
                            ...prev,
                            [asg.assignmentId]: e.target.value,
                          }))
                        }
                        placeholder="Scrivi o aggiorna note..."
                        className="w-full px-4 py-2 rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                      />
                      {noteVal !== asg.noteTecnico && (
                        <button
                          type="button"
                          disabled={savingNoteAsgId === asg.assignmentId}
                          onClick={() => handleSaveAdminNote(asg)}
                          className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold inline-flex items-center gap-2 hover:bg-slate-800 cursor-pointer"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>
                            {savingNoteAsgId === asg.assignmentId
                              ? 'Salvataggio...'
                              : 'Salva nota'}
                          </span>
                        </button>
                      )}
                    </div>

                    {/* Materials Section */}
                    <div className="pt-2 border-t border-slate-100 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-800 tabular-nums">
                          Materiali ({asgMats.length})
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setAddingMatForAsg(asg);
                            setMatCategory('');
                            setMatArticleId('');
                            setMatQty('1');
                          }}
                          className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 flex items-center gap-2 cursor-pointer"
                        >
                          <PackagePlus className="w-3.5 h-3.5" />
                          <span>Materiale</span>
                        </button>
                      </div>

                      {asgMats.length > 0 && (
                        <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl px-4">
                          {asgMats.map((m) => (
                            <div
                              key={m.usedId}
                              className="py-2 flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <span className="font-mono font-semibold text-slate-900">
                                  {m.codiceArticolo}
                                </span>{' '}
                                <span className="text-slate-600">
                                  · {m.descrizioneArticolo}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                                  {m.quantita} {m.unitaMisura}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removeUsedMaterial(m.usedId)}
                                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 cursor-pointer"
                                  aria-label="Rimuovi materiale"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Multi-Photo Upload & Gallery Section */}
                    <div className="pt-2 border-t border-slate-100 space-y-2">
                      <span className="block text-xs font-semibold text-slate-800 tabular-nums">
                        Foto su Google Drive ({asgPhotos.length})
                      </span>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPendingPhotoTarget(asg);
                            setPendingPhotoFiles([]);
                            setPhotoCaption('');
                            cameraInputRef.current?.click();
                          }}
                          className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
                        >
                          <Camera className="w-4 h-4 text-slate-700 shrink-0" />
                          <span>Scatta foto</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPendingPhotoTarget(asg);
                            setPendingPhotoFiles([]);
                            setPhotoCaption('');
                            galleryInputRef.current?.click();
                          }}
                          className="min-h-[44px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
                        >
                          <ImageIcon className="w-4 h-4 shrink-0" />
                          <span>Galleria</span>
                        </button>
                      </div>

                      {asgPhotos.length > 0 && (
                        <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl px-4">
                          {asgPhotos.map((p) => (
                            <div
                              key={p.photoId}
                              className="py-2 flex items-center justify-between gap-2 text-xs"
                            >
                              <a
                                href={p.driveWebViewLink}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="min-w-0 flex items-center gap-2 text-slate-800 hover:text-slate-950 truncate font-semibold"
                              >
                                <ExternalLink className="w-3.5 h-3.5 shrink-0 text-slate-400" />
                                <span className="truncate">{p.fileName}</span>
                              </a>
                              <button
                                type="button"
                                onClick={() =>
                                  removeInterventionPhoto(p.photoId)
                                }
                                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 cursor-pointer shrink-0"
                                aria-label="Rimuovi collegamento foto"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </main>
      ) : (
        /* VIEW B: MAIN SMARTPHONE ADMIN TABS */
        <main className="flex-1 flex flex-col min-h-0">
          {/* TAB 1: SMARTPHONE ADMIN CALENDAR */}
          {activeTab === 'calendar' && (
            <div
              className="flex-1 flex flex-col"
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
            >
              {/* Calendar Control Strip */}
              <div className="bg-white border-b border-slate-200 p-4 space-y-2">
                {pendingReviewTasksCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setQueueFilter('PENDING_REVIEW');
                      setActiveTab('free_kpi');
                    }}
                    className="w-full min-h-[40px] px-4 py-2 rounded-xl bg-slate-50 border border-slate-300 text-slate-900 text-xs font-semibold flex items-center justify-between gap-2 hover:bg-slate-100 cursor-pointer"
                  >
                    <span className="flex items-center gap-2 truncate">
                      <ClipboardCheck className="w-3.5 h-3.5 text-slate-700 shrink-0" />
                      <span className="truncate">
                        {pendingReviewTasksCount} task autonomi da revisionare
                      </span>
                    </span>
                    <span className="underline shrink-0">Apri coda</span>
                  </button>
                )}

                <div className="flex items-center justify-between gap-2">
                  {/* Expandable Month Drawer Trigger + ISO Week Number */}
                  <button
                    type="button"
                    onClick={() => setMonthDrawerOpen((v) => !v)}
                    className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 flex items-center gap-2 text-left cursor-pointer min-w-0"
                  >
                    <span className="font-display text-sm font-semibold capitalize text-slate-900 truncate">
                      {monthTitleLabel}
                    </span>
                    <span className="text-slate-300 shrink-0" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-xs font-semibold text-slate-600 tabular-nums shrink-0 whitespace-nowrap">
                      {mobileWeekBadge}
                    </span>
                    {monthDrawerOpen ? (
                      <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
                    )}
                  </button>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => shiftPeriod(-1)}
                      className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                      aria-label="Periodo precedente"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={goToday}
                      className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                    >
                      Oggi
                    </button>
                    <button
                      type="button"
                      onClick={() => shiftPeriod(1)}
                      className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                      aria-label="Periodo successivo"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openNewAbsenceModal()}
                      className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-slate-800 text-xs font-semibold flex items-center gap-2 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                      title="Segna assenza tecnico"
                    >
                      <CalendarOff className="w-3.5 h-3.5 shrink-0" />
                      <span className="hidden sm:inline">Assenza</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openCreateTaskModal()}
                      className="min-h-[40px] px-2 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold flex items-center gap-2 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4 shrink-0" />
                      <span>Task</span>
                    </button>
                  </div>
                </div>

                {/* Mode Switcher: 3g (Default) | 1g | Sett | Mese */}
                <div className="grid grid-cols-4 gap-2">
                  {(
                    [
                      { id: '3days', label: '3 giorni' },
                      { id: 'day', label: '1 giorno' },
                      { id: 'week', label: 'Settimana' },
                      { id: 'month', label: 'Mese' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setCalMode(m.id)}
                      className={`min-h-[36px] rounded-xl border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${calMode === m.id
                        ? 'bg-slate-900 text-white border-slate-950'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>

                {/* Collapsible Mini-Month Picker */}
                {monthDrawerOpen && (
                  <div className="pt-2 border-t border-slate-100 space-y-2">
                    <div className="grid grid-cols-7 text-center text-[10px] font-semibold text-slate-400">
                      {['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((d, idx) => (
                        <span key={idx}>{d}</span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-2">
                      {monthDays.map((d) => {
                        const dMs = startOfDayMs(d);
                        const isCurrMonth =
                          d.getMonth() === anchorDate.getMonth();
                        const isSelected = isSameDay(dMs, anchorDayMs);
                        const isToday = isSameDay(dMs, todayStartMs);
                        const hasTasks = tasks.some((t) =>
                          taskOccursOnDay(t, dMs)
                        );
                        return (
                          <button
                            key={dMs}
                            type="button"
                            onClick={() => {
                              setAnchorDate(new Date(d));
                              setMonthDrawerOpen(false);
                            }}
                            className={`min-h-[36px] rounded-xl border flex flex-col items-center justify-center text-xs font-mono tabular-nums cursor-pointer ${isSelected
                              ? 'bg-slate-900 text-white border-slate-950 font-semibold'
                              : isToday
                                ? 'bg-slate-100 text-slate-900 border-slate-400 font-semibold'
                                : isCurrMonth
                                  ? 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
                                  : 'bg-slate-50 text-slate-400 border-slate-200'
                              }`}
                          >
                            <span>{d.getDate()}</span>
                            {hasTasks && (
                              <span
                                className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-slate-500'
                                  }`}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Calendar Body: Month Overview vs 24h Vertical Timeline */}
              {calMode === 'month' ? (
                <div className="p-4 space-y-4">
                  <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                    <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center py-2 text-[11px] font-semibold text-slate-500">
                      {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(
                        (lbl) => (
                          <span key={lbl}>{lbl}</span>
                        )
                      )}
                    </div>
                    <div className="grid grid-cols-7 gap-0">
                      {monthDays.map((d) => {
                        const dMs = startOfDayMs(d);
                        const dayTasks = tasks.filter((t) =>
                          taskOccursOnDay(t, dMs)
                        );
                        const dayAbsences = absences.filter((a) =>
                          absenceOccursOnDay(a, dMs)
                        );
                        const dayTrueAbsencesCount = dayAbsences.filter(
                          (a) => !isNonAbsenceEntryType(a.tipo)
                        ).length;
                        const dayCommitmentsCount = dayAbsences.length - dayTrueAbsencesCount;
                        const isCurrMonth =
                          d.getMonth() === anchorDate.getMonth();
                        const isSelected = isSameDay(dMs, anchorDayMs);
                        const isToday = isSameDay(dMs, todayStartMs);

                        return (
                          <button
                            key={dMs}
                            type="button"
                            onClick={() => setAnchorDate(new Date(d))}
                            className={`min-h-[68px] p-2 border border-slate-100 flex flex-col items-start text-left transition-colors cursor-pointer ${isSelected
                              ? 'bg-slate-100 border-slate-400'
                              : isCurrMonth
                                ? 'bg-white hover:bg-slate-50'
                                : 'bg-slate-50 text-slate-400'
                              }`}
                          >
                            <span
                              className={`text-xs font-mono tabular-nums px-2 py-0 rounded-md ${isToday
                                ? 'bg-slate-900 text-white font-semibold'
                                : 'font-semibold text-slate-800'
                                }`}
                            >
                              {d.getDate()}
                            </span>
                            {dayTasks.length > 0 && (
                              <span className="mt-2 text-[10px] font-mono font-semibold text-slate-600 tabular-nums">
                                {dayTasks.length} task
                              </span>
                            )}
                            {dayTrueAbsencesCount > 0 && (
                              <span className="text-[10px] font-mono font-normal text-slate-500 tabular-nums">
                                {dayTrueAbsencesCount} ass.
                              </span>
                            )}
                            {dayCommitmentsCount > 0 && (
                              <span className="text-[10px] font-mono font-normal text-sky-700 tabular-nums">
                                {dayCommitmentsCount} imp.
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Selected Day Agenda below Month */}
                  <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-900">
                        Agenda del {formatDateIt(anchorDayMs)}
                      </h3>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => openNewAbsenceModal()}
                          className="min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
                        >
                          Assenza
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            openCreateTaskModal(anchorDayMs + 8 * 3600000)
                          }
                          className="min-h-[36px] px-2 py-2 rounded-lg bg-slate-900 border border-slate-950 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer"
                        >
                          Nuovo task
                        </button>
                      </div>
                    </div>

                    {absences
                      .filter((a) => absenceOccursOnDay(a, anchorDayMs))
                      .map((abs) => (
                        <button
                          key={abs.absenceId}
                          type="button"
                          onClick={() => openEditAbsenceModal(abs)}
                          className={`w-full text-left p-4 rounded-xl border flex items-center justify-between gap-2 cursor-pointer ${getAbsenceToneClasses(abs.tipo).block
                            }`}
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold truncate">
                              {formatAbsenceCalendarLabel(abs, {
                                shortTechName: abs.technicianName,
                                prefixAssenza: true,
                              })}
                            </p>
                            <p className="text-[11px] font-mono tabular-nums text-slate-600 truncate">
                              {formatAbsenceDateSummary(abs)}
                              {abs.note ? ` · ${abs.note}` : ''}
                            </p>
                          </div>
                          <span className="text-xs font-semibold underline shrink-0">
                            Modifica
                          </span>
                        </button>
                      ))}

                    {tasks
                      .filter((t) => taskOccursOnDay(t, anchorDayMs))
                      .map((t) => {
                        const visual = getTaskEventVisualStyle(t, {
                          operatorColorLabels: settings.operatorColorLabels,
                        });
                        return (
                          <button
                            key={t.taskId}
                            type="button"
                            onClick={() => setSelectedTaskId(t.taskId)}
                            className="w-full text-left p-4 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer"
                          >
                            <div className="min-w-0 space-y-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${visual.swatchClassName}`}
                                  aria-hidden="true"
                                />
                                <p className="text-xs font-semibold text-slate-900 leading-snug whitespace-normal break-words">
                                  {formatCalendarEventTitle(
                                    t.assignedNames,
                                    t.descrizione
                                  )}
                                </p>
                              </div>
                              <p className="text-[11px] font-mono text-slate-600 tabular-nums">
                                {formatTimeIt(t.inizioMs)} –{' '}
                                {formatTimeIt(t.fineMs)} · {visual.operatorLabel}{' '}
                                · {formatTaskCommessaLabel(t)}
                              </p>
                            </div>
                            <StatusIndicator status={t.statoPrevalente} />
                          </button>
                        );
                      })}
                    {tasks.filter((t) => taskOccursOnDay(t, anchorDayMs))
                      .length === 0 &&
                      absences.filter((a) => absenceOccursOnDay(a, anchorDayMs))
                        .length === 0 && (
                        <p className="text-xs text-slate-500 py-2">
                          Nessun intervento o assenza in questa giornata.
                        </p>
                      )}
                  </div>
                </div>
              ) : (
                /* 24h Vertical Scrollable Timeline (1g / 3g / Sett) */
                <div className="flex-1 flex flex-col bg-white overflow-hidden">
                  <div className="bg-white border-b border-slate-200 shrink-0">
                    <div className="flex">
                      <div className="w-12 shrink-0 border-r border-slate-200" />
                      <div
                        className="flex-1 grid gap-2 p-2"
                        style={{
                          gridTemplateColumns: `repeat(${visibleDays.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {visibleDays.map((d) => {
                          const dMs = startOfDayMs(d);
                          const isToday = isSameDay(dMs, todayStartMs);
                          const dayCount = tasks.filter((t) =>
                            taskOccursOnDay(t, dMs)
                          ).length;
                          const rawWeekday = d.toLocaleDateString('it-IT', {
                            weekday: 'short',
                          });
                          const weekdayLabel =
                            rawWeekday.charAt(0).toUpperCase() +
                            rawWeekday.slice(1);
                          return (
                            <button
                              key={dMs}
                              type="button"
                              onClick={() => {
                                setAnchorDate(new Date(d));
                                if (calMode === 'week') setCalMode('day');
                              }}
                              className={`p-2 rounded-xl border text-center transition-colors cursor-pointer ${isToday
                                ? 'border-slate-950 bg-slate-900 text-white'
                                : 'border-slate-300 bg-white text-slate-900 hover:bg-slate-50'
                                }`}
                            >
                              <div
                                className={`text-[10px] font-semibold ${isToday ? 'text-slate-300' : 'text-slate-500'
                                  }`}
                              >
                                {weekdayLabel}
                              </div>
                              <div className="text-xs font-mono font-semibold tabular-nums">
                                {d.getDate()}
                              </div>
                              <div
                                className={`text-[10px] font-mono tabular-nums ${isToday ? 'text-slate-300' : 'text-slate-400'
                                  }`}
                              >
                                {dayCount > 0 ? `${dayCount} task` : '—'}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {topStripPacked.laneCount > 0 && (
                      <div className="flex max-h-[96px] overflow-y-auto">
                        <div className="w-12 shrink-0 border-r border-slate-200" />
                        <div
                          className="flex-1 relative"
                          style={{
                            height: `${topStripPacked.laneCount * 24 + 4}px`,
                          }}
                        >
                          <div
                            className="absolute inset-0 grid divide-x divide-slate-200 pointer-events-none"
                            style={{
                              gridTemplateColumns: `repeat(${visibleDays.length}, minmax(0, 1fr))`,
                            }}
                          >
                            {visibleDays.map((d) => (
                              <div key={d.getTime()} />
                            ))}
                          </div>

                          {topStripPacked.spans.map((span) => {
                            const colCount = visibleDays.length;
                            const leftPct = (span.startCol / colCount) * 100;
                            const widthPct =
                              ((span.endCol - span.startCol + 1) / colCount) *
                              100;
                            const topPx = span.lane * 24 + 2;

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
                                    height: '20px',
                                  }}
                                  className={`absolute z-10 px-2 border text-[10px] font-semibold truncate flex items-center gap-2 cursor-pointer ${span.continuesBefore
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
                                      prefixAssenza: false,
                                    })}
                                    {abs.note ? ` — ${abs.note}` : ''}
                                  </span>
                                </button>
                              );
                            }

                            const t = span.item.payload as Task;
                            const visual = getTaskEventVisualStyle(t, {
                              operatorColorLabels: settings.operatorColorLabels,
                            });
                            return (
                              <button
                                key={span.item.id}
                                type="button"
                                onClick={() => setSelectedTaskId(t.taskId)}
                                style={{
                                  top: `${topPx}px`,
                                  left: `calc(${leftPct}% + 2px)`,
                                  width: `calc(${widthPct}% - 4px)`,
                                  height: '20px',
                                }}
                                className={`absolute z-10 px-2 text-[10px] font-semibold truncate flex items-center justify-between gap-2 cursor-pointer ${span.continuesBefore
                                  ? 'rounded-l-none'
                                  : 'rounded-l-md'
                                  } ${span.continuesAfter
                                    ? 'rounded-r-none'
                                    : 'rounded-r-md'
                                  } ${visual.cardClassName}`}
                              >
                                <span className="inline-flex items-center gap-2 truncate">
                                  {visual.isCompleted && (
                                    <Check className="w-2.5 h-2.5 stroke-[3] shrink-0" />
                                  )}
                                  <span className="truncate">
                                    {formatCalendarEventTitle(
                                      t.assignedNames,
                                      t.descrizione
                                    )}
                                  </span>
                                </span>
                                <span
                                  className={`font-mono text-[9px] shrink-0 ${visual.subtleMetaClassName}`}
                                >
                                  {formatTaskCommessaLabel(t)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 00:00 – 24:00 Scrollable Grid */}
                  <div
                    ref={timelineScrollRef}
                    className="flex-1 overflow-y-auto max-h-[calc(100vh-248px)]"
                  >
                    <div
                      className="relative flex"
                      style={{ height: `${PHONE_TOTAL_GRID_HEIGHT}px` }}
                    >
                      {/* Hour Labels Gutter */}
                      <div className="w-12 shrink-0 border-r border-slate-200 bg-slate-50 relative select-none">
                        {Array.from({ length: 24 }, (_, hour) => (
                          <div
                            key={hour}
                            style={{ top: `${hour * PHONE_HOUR_HEIGHT}px` }}
                            className="absolute inset-x-0 -translate-y-2 pr-2 text-right text-[10px] font-mono text-slate-400 tabular-nums"
                          >
                            {hour === 0
                              ? ''
                              : `${String(hour).padStart(2, '0')}:00`}
                          </div>
                        ))}
                      </div>

                      {/* Day Columns */}
                      <div
                        className="flex-1 grid divide-x divide-slate-200 relative"
                        style={{
                          gridTemplateColumns: `repeat(${visibleDays.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {visibleDays.map((d) => {
                          const dMs = startOfDayMs(d);
                          const isToday = isSameDay(dMs, todayStartMs);
                          const dayTasks = tasks.filter(
                            (t) => !isTopStripTask(t) && taskOccursOnDay(t, dMs)
                          );
                          const dayHourlyAbsences = absences.filter(
                            (a) =>
                              !isTopStripAbsence(a) &&
                              absenceOccursOnDay(a, dMs)
                          );
                          const {
                            positionedTasks: positioned,
                            positionedAbsences: hourlyAbsences,
                          } = layoutMobileAdminColumnItems(
                            dayTasks,
                            dayHourlyAbsences,
                            dMs
                          );

                          return (
                            <div key={dMs} className="relative h-full">
                              {/* Tap-to-Create Hour Slots */}
                              {Array.from({ length: 24 }, (_, hour) => (
                                <div
                                  key={hour}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() =>
                                    openCreateTaskModal(dMs + hour * 3600000)
                                  }
                                  onKeyDown={(ev) => {
                                    if (ev.key === 'Enter' || ev.key === ' ') {
                                      ev.preventDefault();
                                      openCreateTaskModal(dMs + hour * 3600000);
                                    }
                                  }}
                                  style={{
                                    top: `${hour * PHONE_HOUR_HEIGHT}px`,
                                    height: `${PHONE_HOUR_HEIGHT}px`,
                                  }}
                                  className="absolute inset-x-0 w-full border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                                  aria-label={`Crea task alle ${hour}:00`}
                                />
                              ))}

                              {/* Live Current-Time Line */}
                              {isToday && (
                                <div
                                  style={{
                                    top: `${(currentMinOfDay / 60) * PHONE_HOUR_HEIGHT
                                      }px`,
                                  }}
                                  className="absolute inset-x-0 z-20 pointer-events-none flex items-center"
                                >
                                  <span className="w-2 h-2 rounded-full bg-slate-900 -translate-x-1/2" />
                                  <div className="flex-1 h-[1.5px] bg-slate-900" />
                                </div>
                              )}

                              {/* Hourly Absence & Commitment Blocks (resizable shared lanes in second plane) */}
                              {hourlyAbsences.map((ha) => {
                                const topPx =
                                  (ha.startMin / 60) * PHONE_HOUR_HEIGHT;
                                const heightPx = Math.max(
                                  24,
                                  ((ha.endMin - ha.startMin) / 60) *
                                  PHONE_HOUR_HEIGHT -
                                  2
                                );
                                const colSpan = ha.colSpan || 1;
                                const isAtRightEdge =
                                  ha.colIndex + colSpan >= ha.totalCols;
                                let leftPct: number;
                                let widthPct: number;
                                if (ha.totalCols <= 1) {
                                  leftPct = 0;
                                  widthPct = 100;
                                } else {
                                  const unitPct = 100 / ha.totalCols;
                                  leftPct = ha.colIndex * unitPct;
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
                                    ha.absence.technicianName,
                                  ]) || ha.absence.technicianName;
                                return (
                                  <button
                                    key={ha.absence.absenceId}
                                    type="button"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      openEditAbsenceModal(ha.absence);
                                    }}
                                    style={{
                                      top: `${topPx + 1}px`,
                                      height: `${heightPx}px`,
                                      left: `calc(${leftPct}% + 1.5px)`,
                                      width: `calc(${widthPct}% - 3px)`,
                                      zIndex: 8 + ha.colIndex,
                                      transition:
                                        'transform 140ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                                    }}
                                    className={`absolute rounded-lg border border-dashed px-2 py-0 text-left overflow-hidden cursor-pointer ring-1 ring-white/90 shadow-xs hover:shadow-md active:scale-[0.985] ${getAbsenceToneClasses(ha.absence.tipo)
                                      .block
                                      }`}
                                  >
                                    <p className="text-[9px] font-semibold leading-tight truncate">
                                      {formatAbsenceCalendarLabel(ha.absence, {
                                        shortTechName: shortTech,
                                        prefixAssenza: false,
                                      })}
                                    </p>
                                    <p className="text-[8px] font-mono tabular-nums opacity-85 truncate">
                                      {formatMinutesAsHHMM(ha.startMin)}–
                                      {formatMinutesAsHHMM(ha.endMin)}
                                    </p>
                                  </button>
                                );
                              })}

                              {/* Positioned Task Blocks */}
                              {positioned.map((pos) => {
                                const topPx =
                                  (pos.startMin / 60) * PHONE_HOUR_HEIGHT;
                                const heightPx = Math.max(
                                  30,
                                  ((pos.endMin - pos.startMin) / 60) *
                                  PHONE_HOUR_HEIGHT -
                                  2
                                );
                                const colSpan = pos.colSpan || 1;
                                const isAtRightEdge =
                                  pos.colIndex + colSpan >= pos.totalCols;
                                let leftPct: number;
                                let widthPct: number;
                                if (pos.totalCols <= 1) {
                                  leftPct = 0;
                                  widthPct = 100;
                                } else {
                                  const unitPct = 100 / pos.totalCols;
                                  leftPct = pos.colIndex * unitPct;
                                  const overlapBonusPct = isAtRightEdge
                                    ? 0
                                    : Math.min(12, unitPct * 0.3);
                                  widthPct = Math.min(
                                    100 - leftPct,
                                    colSpan * unitPct + overlapBonusPct
                                  );
                                }
                                const isSelected = selectedTaskId === pos.task.taskId;

                                const isCompactWeek = calMode === 'week';
                                const visual = getTaskEventVisualStyle(
                                  pos.task,
                                  {
                                    operatorColorLabels:
                                      settings.operatorColorLabels,
                                  }
                                );

                                return (
                                  <button
                                    key={pos.task.taskId}
                                    type="button"
                                    onClick={(ev) => {
                                      ev.stopPropagation();
                                      setSelectedTaskId(pos.task.taskId);
                                    }}
                                    style={{
                                      top: `${topPx + 1}px`,
                                      height: `${heightPx}px`,
                                      left: `calc(${leftPct}% + 1.5px)`,
                                      width: `calc(${widthPct}% - 3px)`,
                                      zIndex: isSelected ? 35 : 15 + pos.colIndex,
                                      transition:
                                        'transform 140ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                                    }}
                                    className={`absolute rounded-lg px-2 py-0 text-left overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ring-1 ring-white/90 dark:ring-slate-900/90 active:scale-[0.985] cursor-pointer flex flex-col justify-start ${isSelected
                                      ? 'shadow-xl ring-2 ring-slate-900'
                                      : 'shadow-xs hover:shadow-md'
                                      } ${visual.cardClassName}`}
                                  >
                                    <p
                                      className={`${isCompactWeek
                                        ? 'text-[8px] leading-[1.15]'
                                        : 'text-[9.5px] leading-[1.18]'
                                        } font-semibold whitespace-normal break-words`}
                                    >
                                      {visual.isCompleted && (
                                        <Check className="inline w-2.5 h-2.5 stroke-[3] mr-2" />
                                      )}
                                      {formatCalendarEventTitle(
                                        pos.task.assignedNames,
                                        pos.task.descrizione
                                      )}
                                    </p>
                                    <p
                                      className={`${isCompactWeek
                                        ? 'text-[7.5px]'
                                        : 'text-[9px]'
                                        } font-mono tabular-nums leading-[1.15] ${visual.subtleMetaClassName}`}
                                    >
                                      {formatMinutesAsHHMM(pos.startMin)}–
                                      {formatMinutesAsHHMM(pos.endMin)}
                                    </p>
                                    <p
                                      className={`${isCompactWeek
                                        ? 'text-[7.5px]'
                                        : 'text-[9px]'
                                        } font-mono font-semibold leading-[1.15] whitespace-normal break-words ${visual.subtleMetaClassName}`}
                                    >
                                      {formatTaskCommessaLabel(pos.task)}
                                    </p>
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: LIBERI & KPI + CODA RAPIDA ADMIN */}
          {activeTab === 'free_kpi' && (
            <div className="p-4 space-y-4 max-w-2xl w-full mx-auto">
              {pendingReviewTasksCount > 0 && (
                <button
                  type="button"
                  onClick={() => setQueueFilter('PENDING_REVIEW')}
                  className={`w-full rounded-2xl border p-4 text-left flex items-center justify-between gap-4 transition-colors cursor-pointer ${queueFilter === 'PENDING_REVIEW'
                    ? 'bg-slate-900 border-slate-950 text-white'
                    : 'bg-white border-slate-300 text-slate-900 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                >
                  <p
                    className={`text-xs font-semibold ${queueFilter === 'PENDING_REVIEW'
                      ? 'text-slate-200'
                      : 'text-slate-800'
                      }`}
                  >
                    Task autonomi da revisionare
                  </p>
                  <span className="text-2xl font-semibold font-mono tabular-nums shrink-0">
                    {pendingReviewTasksCount}
                  </span>
                </button>
              )}

              {/* 2x2 Compact KPI Stat Grid */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setQueueFilter('ALL')}
                  className={`rounded-2xl border p-4 text-left transition-colors cursor-pointer ${queueFilter === 'ALL'
                    ? 'bg-slate-900 border-slate-950 text-white'
                    : 'bg-white border-slate-300 text-slate-900 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                >
                  <p
                    className={`text-xs ${queueFilter === 'ALL'
                      ? 'text-slate-300'
                      : 'text-slate-500'
                      }`}
                  >
                    Totale task
                  </p>
                  <p className="mt-2 text-2xl font-semibold font-mono tabular-nums">
                    {kpiStats.total}
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setQueueFilter('UNASSIGNED')}
                  className={`rounded-2xl border p-4 text-left transition-colors cursor-pointer ${queueFilter === 'UNASSIGNED'
                    ? 'bg-slate-900 border-slate-950 text-white'
                    : 'bg-white border-slate-300 text-slate-900 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                >
                  <p
                    className={`text-xs ${queueFilter === 'UNASSIGNED'
                      ? 'text-slate-300'
                      : 'text-slate-500'
                      }`}
                  >
                    Da assegnare
                  </p>
                  <p className="mt-2 text-2xl font-semibold font-mono tabular-nums">
                    {kpiStats.unassigned}
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setQueueFilter('IN_PROGRESS')}
                  className={`rounded-2xl border p-4 text-left transition-colors cursor-pointer ${queueFilter === 'IN_PROGRESS'
                    ? 'bg-slate-900 border-slate-950 text-white'
                    : 'bg-white border-slate-300 text-slate-900 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                >
                  <p
                    className={`text-xs ${queueFilter === 'IN_PROGRESS'
                      ? 'text-slate-300'
                      : 'text-slate-500'
                      }`}
                  >
                    In carico
                  </p>
                  <p className="mt-2 text-2xl font-semibold font-mono tabular-nums">
                    {kpiStats.inProgress}
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setQueueFilter('COMPLETED')}
                  className={`rounded-2xl border p-4 text-left transition-colors cursor-pointer ${queueFilter === 'COMPLETED'
                    ? 'bg-slate-900 border-slate-950 text-white'
                    : 'bg-white border-slate-300 text-slate-900 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                >
                  <p
                    className={`text-xs ${queueFilter === 'COMPLETED'
                      ? 'text-slate-300'
                      : 'text-slate-500'
                      }`}
                  >
                    Completati
                  </p>
                  <p className="mt-2 text-2xl font-semibold font-mono tabular-nums">
                    {kpiStats.completed}
                  </p>
                </button>
              </div>

              {/* Free Technicians & Absences on Selected Day */}
              <section className="rounded-2xl bg-white border border-slate-200 p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-900">
                      Tecnici liberi ({freeTechEvaluation.free.length}/
                      {activeTechnicians.length})
                    </h2>
                    <p className="text-xs text-slate-500 font-mono tabular-nums">
                      Giorno: {formatDateIt(anchorDayMs)}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => shiftAnchorSingleDay(-1)}
                      className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                      aria-label="Giorno precedente"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={goToday}
                      className="min-h-[40px] px-4 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
                    >
                      Oggi
                    </button>
                    <button
                      type="button"
                      onClick={() => shiftAnchorSingleDay(1)}
                      className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                      aria-label="Giorno successivo"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {freeTechEvaluation.free.length === 0 ? (
                  <p className="text-xs text-slate-500 py-2">
                    Nessun tecnico completamente disponibile in questa data.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {freeTechEvaluation.free.map((tech) => {
                      const partialAbs =
                        freeTechEvaluation.partialAbsenceMap.get(
                          tech.email.toLowerCase()
                        );
                      return (
                        <div
                          key={tech.memberId}
                          className="py-2 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 truncate">
                              {tech.nome} {tech.cognome}
                            </p>
                            <p className="text-[11px] font-mono text-slate-500 truncate">
                              {tech.email}
                            </p>
                            {partialAbs && partialAbs.length > 0 && (
                              <p className="text-[11px] text-slate-600 font-normal">
                                {partialAbs[0].tipo}:{' '}
                                {formatTimeIt(partialAbs[0].inizioMs)}–
                                {formatTimeIt(partialAbs[0].fineMs)}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => openNewAbsenceModal(tech.email)}
                              className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
                              title="Segna assenza"
                            >
                              <CalendarOff className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                openCreateTaskModal(
                                  anchorDayMs + 8 * 3600000,
                                  tech.email
                                )
                              }
                              className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold flex items-center gap-2 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                            >
                              <Plus className="w-4 h-4" />
                              <span>Assegna</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {freeTechEvaluation.absentList.length > 0 && (
                  <div className="pt-4 border-t border-slate-100 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-800">
                        Assenti / permessi ({freeTechEvaluation.absentList.length})
                      </h3>
                      <button
                        type="button"
                        onClick={() => openNewAbsenceModal()}
                        className="min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                      >
                        + Assenza
                      </button>
                    </div>
                    <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-2">
                      {freeTechEvaluation.absentList.map(({ tech, overlaps }) => (
                        <div
                          key={tech.memberId}
                          className="flex items-center justify-between gap-2"
                        >
                          <button
                            type="button"
                            onClick={() => openEditAbsenceModal(overlaps[0])}
                            className="flex-1 min-w-0 px-2 py-2 rounded-lg border border-slate-300 bg-white text-left hover:bg-slate-50 cursor-pointer"
                          >
                            <p className="text-xs font-semibold text-slate-900 truncate">
                              {tech.nome} {tech.cognome} ·{' '}
                              <span className="text-slate-600 font-normal">
                                {overlaps[0].tipo}
                              </span>
                            </p>
                            <p className="text-[11px] font-mono text-slate-500 tabular-nums truncate">
                              {formatAbsenceDateSummary(overlaps[0])}
                            </p>
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              openCreateTaskModal(
                                anchorDayMs + 8 * 3600000,
                                tech.email,
                                true
                              )
                            }
                            className="min-h-[40px] px-2 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer shrink-0 whitespace-nowrap"
                          >
                            Forza task
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {freeTechEvaluation.commitmentList.length > 0 && (
                  <div className="pt-4 border-t border-slate-100 space-y-2">
                    <h3 className="text-xs font-semibold text-slate-800">
                      Visite mediche e assemblee ({freeTechEvaluation.commitmentList.length})
                    </h3>
                    <div className="space-y-2 rounded-xl border border-sky-200 bg-sky-50/60 p-2">
                      {freeTechEvaluation.commitmentList.map(({ tech, overlaps }) => (
                        <div
                          key={tech.memberId}
                          className="flex items-center justify-between gap-2"
                        >
                          <button
                            type="button"
                            onClick={() => openEditAbsenceModal(overlaps[0])}
                            className={`flex-1 min-w-0 px-2 py-2 rounded-lg border text-left cursor-pointer ${getAbsenceToneClasses(overlaps[0].tipo).block
                              }`}
                          >
                            <p className="text-xs font-semibold truncate">
                              {tech.nome} {tech.cognome} ·{' '}
                              <span className="font-normal">{overlaps[0].tipo}</span>
                            </p>
                            <p className="text-[11px] font-mono opacity-80 tabular-nums truncate">
                              {formatAbsenceDateSummary(overlaps[0])}
                            </p>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Operational Task Queue with 1-Tap Admin Status Advance & Review */}
              <section className="rounded-2xl bg-white border border-slate-200 p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Coda interventi ({filteredQueueTasks.length})
                  </h2>
                  <button
                    type="button"
                    onClick={() => openCreateTaskModal()}
                    className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold flex items-center gap-2 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Nuovo task</span>
                  </button>
                </div>

                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={queueSearch}
                    onChange={(e) => setQueueSearch(e.target.value)}
                    placeholder="Cerca commessa, codice o tecnico..."
                    className="w-full min-h-[44px] pl-8 pr-4 py-2 rounded-xl border border-slate-300 text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                  />
                </div>

                {filteredQueueTasks.length === 0 ? (
                  <p className="text-xs text-slate-500 py-4 text-center">
                    Nessun task trovato per il filtro selezionato.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {filteredQueueTasks.slice(0, 30).map((t) => (
                      <div
                        key={t.taskId}
                        className="p-2 rounded-xl border border-slate-200 space-y-2"
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedTaskId(t.taskId)}
                          className="w-full px-2 py-2 rounded-lg border border-slate-300 bg-white text-left flex items-start justify-between gap-2 hover:bg-slate-50 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold font-mono text-slate-900 truncate">
                              {formatTaskCommessaLabel(t)} · {t.taskCode}
                            </p>
                            <p className="text-xs text-slate-700 line-clamp-1">
                              {t.descrizione}
                            </p>
                            <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                              {formatDateIt(t.inizioMs)}{' '}
                              {formatTimeIt(t.inizioMs)} ·{' '}
                              {t.assignedNames.length > 0
                                ? t.assignedNames.join(', ')
                                : 'Non assegnato'}
                            </p>
                          </div>
                          <StatusIndicator status={t.statoPrevalente} />
                        </button>

                        <div className="flex flex-wrap items-center gap-2">
                          {t.pendingAdminReview && (
                            <button
                              type="button"
                              onClick={() => setReviewingTask(t)}
                              className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-white text-xs font-semibold flex items-center gap-2 hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                            >
                              <ClipboardCheck className="w-4 h-4" />
                              <span>Revisiona commessa</span>
                            </button>
                          )}

                          {t.statoPrevalente !== 'Completato' && (
                            <>
                              {t.statoPrevalente !== 'Preso in Carico' && (
                                <button
                                  type="button"
                                  disabled={updatingTaskStatus}
                                  onClick={() =>
                                    handleWholeTaskStatusOverride(
                                      t,
                                      'Preso in Carico'
                                    )
                                  }
                                  className="min-h-[40px] px-4 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 flex items-center gap-2 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                                >
                                  <Play className="w-3.5 h-3.5" />
                                  <span>Avvia in carico</span>
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={updatingTaskStatus}
                                onClick={() =>
                                  handleWholeTaskStatusOverride(t, 'Completato')
                                }
                                className="min-h-[40px] px-4 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 flex items-center gap-2 hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                                <span>Segna completato</span>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
          {/* TAB: REPERIBILITÀ */}
          {activeTab === 'on_call' && (
            <div className="p-3 pb-24 max-w-3xl w-full mx-auto">
              <OnCallCalendarView />
            </div>
          )}
          {/* TAB 3: CONSUNTIVO MATERIALI */}
          {activeTab === 'materials' && (
            <div className="p-4 max-w-3xl w-full mx-auto">
              <AdminMaterialsReportView onOpenEmailModal={setEmailDraft} />
            </div>
          )}

          {/* TAB 4: GESTIONE (CATALOGO ARTICOLI + TEAM & REGOLE + LOGOUT) */}
          {activeTab === 'manage' && (
            <div className="p-4 space-y-4 max-w-3xl w-full mx-auto">
              {/* Sub-section Switcher */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setManageSection('articles')}
                  className={`min-h-[44px] rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap ${manageSection === 'articles'
                    ? 'bg-slate-900 text-white border-slate-950'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  <Layers className="w-4 h-4" />
                  <span>Catalogo articoli</span>
                </button>
                <button
                  type="button"
                  onClick={() => setManageSection('team')}
                  className={`min-h-[44px] rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap ${manageSection === 'team'
                    ? 'bg-slate-900 text-white border-slate-950'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  <Users className="w-4 h-4" />
                  <span>Team & regole</span>
                </button>
              </div>

              {manageSection === 'articles' ? (
                <AdminArticlesView />
              ) : (
                <AdminTeamSettingsView onOpenEmailModal={setEmailDraft} />
              )}

              {/* Account & Sign Out Card */}
              <div className="rounded-2xl bg-white border border-slate-200 p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-900 truncate">
                    {profile?.nome} {profile?.cognome}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 truncate">
                    {profile?.email}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={signOutUser}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-red-300 bg-white text-xs font-semibold text-red-700 flex items-center gap-2 hover:bg-red-50 hover:border-red-400 cursor-pointer shrink-0"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Esci</span>
                </button>
              </div>
            </div>
          )}
        </main>
      )}

      {/* Fixed Bottom Navigation Tab Bar (44px+ hitboxes, thumb-zone anchored) */}
      {!selectedTask && (
        <nav
          aria-label="Navigazione Admin Mobile"
          className="fixed bottom-0 left-0 right-0 z-40 h-16 bg-white border-t border-slate-200 grid grid-cols-5 items-center gap-1 px-1.5"
        >
          {(
            [
              { id: 'calendar', label: 'Calendario', icon: CalendarRange },
              { id: 'on_call', label: 'Reperib.', icon: PhoneCall },
              {
                id: 'free_kpi',
                label:
                  pendingReviewTasksCount > 0
                    ? `Coda (${pendingReviewTasksCount})`
                    : 'Liberi & KPI',
                icon: UserCheck,
              },
              { id: 'materials', label: 'Consuntivo', icon: ClipboardList },
              { id: 'manage', label: 'Gestione', icon: Users },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`min-h-[48px] px-0.5 border flex flex-col items-center justify-center rounded-xl cursor-pointer interactive-tab overflow-hidden ${active
                  ? 'bg-slate-900 text-white border-slate-950 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="text-[9.5px] font-semibold tracking-tight truncate max-w-full">
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {/* Hidden File Inputs for Camera & Multi-Photo Gallery */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const selected = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (selected.length > 0 && pendingPhotoTarget) {
            setPendingPhotoFiles((prev) => [...prev, ...selected]);
          }
        }}
      />
      <input
        ref={galleryInputRef}
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

      {/* Task Creation / Edit Modal */}
      {taskModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 p-0 sm:p-4">
          <form
            onSubmit={handleSaveTask}
            className="w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-6 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">
                {editingTask
                  ? `Modifica ${editingTask.taskCode}`
                  : 'Pianifica nuovo task'}
              </h3>
              <button
                type="button"
                onClick={() => setTaskModalOpen(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 cursor-pointer"
                aria-label="Chiudi"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {/* Lavorazione altro AT Toggle */}
              <label className="flex items-center gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={altroReparto}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setAltroReparto(checked);
                    if (
                      checked &&
                      !editingTask &&
                      taskColorId === DEFAULT_TASK_COLOR_ID
                    ) {
                      setTaskColorId('lavender');
                    }
                  }}
                  className="w-4 h-4 rounded border-slate-300 text-slate-900 shrink-0"
                />
                <span className="block text-xs font-semibold text-slate-900">
                  Lavorazione altro AT (senza commessa)
                </span>
              </label>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Colore operatore / evento
                </label>
                <TaskColorPicker
                  value={taskColorId}
                  onChange={setTaskColorId}
                  operatorColorLabels={settings.operatorColorLabels}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Codice commessa {altroReparto ? '(opzionale)' : '*'}
                </label>
                <input
                  type="text"
                  required={!altroReparto}
                  value={commessa}
                  onChange={(e) => setCommessa(e.target.value.toUpperCase())}
                  placeholder={
                    altroReparto
                      ? 'Lascia vuoto per lavorazione altro AT'
                      : 'Es. H265001'
                  }
                  className="w-full min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Descrizione lavoro *
                </label>
                <textarea
                  rows={3}
                  required
                  value={descrizione}
                  onChange={(e) => setDescrizione(e.target.value)}
                  placeholder="Descrivi l'attività tecnica da eseguire..."
                  className="w-full px-4 py-2 rounded-xl border border-slate-300 text-sm text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Data e ora inizio *
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={inizioInput}
                    onChange={(e) => handleInizioChange(e.target.value)}
                    className="w-full min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 font-mono text-xs text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Data e ora fine * (min +1h)
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={fineInput}
                    onChange={(e) => setFineInput(e.target.value)}
                    className="w-full min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 font-mono text-xs text-slate-900"
                  />
                </div>
              </div>

              {durationError && (
                <p className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-xl p-2">
                  {durationError}
                </p>
              )}

              <div>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <label className="block text-xs font-semibold text-slate-700">
                    Squadra tecnici ({selectedEmails.length}/10)
                  </label>
                  {modalAbsentConflictsByEmail.size > 0 && (
                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={forceAbsentOverride}
                        onChange={(e) =>
                          setForceAbsentOverride(e.target.checked)
                        }
                        className="rounded border-slate-300 text-slate-900"
                      />
                      <span>Forza su assente / impegno</span>
                    </label>
                  )}
                </div>

                {activeTechnicians.length === 0 ? (
                  <p className="text-xs text-slate-500 border border-slate-200 rounded-xl p-4">
                    Nessun tecnico attivo in anagrafica.
                  </p>
                ) : (
                  <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                    {activeTechnicians.map((tech) => {
                      const lower = tech.email.toLowerCase();
                      const checked = selectedEmails.includes(lower);
                      const overlaps = modalAbsentConflictsByEmail.get(lower);
                      const isAbsent = Boolean(overlaps && overlaps.length > 0);
                      const blocked =
                        isAbsent && !forceAbsentOverride && !checked;

                      return (
                        <label
                          key={tech.memberId}
                          className={`min-h-[48px] flex items-center justify-between gap-2 px-4 py-2 ${blocked
                            ? 'bg-slate-50 text-slate-400 cursor-not-allowed'
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
                              className="w-4 h-4 rounded border-slate-300 text-slate-900 shrink-0"
                            />
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-slate-900 truncate">
                                {tech.nome} {tech.cognome}
                              </p>
                              <p className="text-[11px] font-mono text-slate-500 truncate">
                                {tech.email}
                              </p>
                            </div>
                          </div>
                          {isAbsent && overlaps && (
                            <span className="inline-flex items-center gap-2 text-[11px] font-semibold text-slate-600 shrink-0">
                              <AlertTriangle className="w-3.5 h-3.5" />
                              <span>{overlaps[0].tipo}</span>
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-200 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTaskModalOpen(false)}
                disabled={savingTask}
                className="min-h-[48px] px-4 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={savingTask || Boolean(durationError)}
                className="min-h-[48px] px-4 py-2 rounded-xl bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {savingTask
                  ? 'Salvataggio...'
                  : editingTask
                    ? 'Salva modifiche'
                    : 'Crea task'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Material Bottom Sheet */}
      {addingMatForAsg && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 p-0 sm:p-4">
          <form
            onSubmit={handleAdminAddMaterial}
            className="w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl bg-white border border-slate-200 p-6 space-y-4"
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
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2">
                Categoria
              </label>
              <select
                value={matCategory}
                onChange={(e) => {
                  setMatCategory(e.target.value);
                  setMatArticleId('');
                }}
                className="w-full min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 text-sm bg-white"
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
                className="w-full min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 text-sm bg-white"
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
                Quantità *
              </label>
              <input
                type="number"
                step="any"
                min="0.01"
                required
                value={matQty}
                onChange={(e) => setMatQty(e.target.value)}
                className="w-full min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 font-mono text-sm tabular-nums"
              />
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAddingMatForAsg(null)}
                className="min-h-[48px] rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={savingMat}
                className="min-h-[48px] rounded-xl bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {savingMat ? 'Salvataggio...' : 'Registra'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Absence Create / Edit Modal */}
      {profile && (
        <AbsenceModal
          open={absenceModalOpen}
          existingAbsence={editingAbsence}
          isAdminActor={true}
          actorUid={profile.uid}
          availableTechnicians={directory}
          preselectedTechEmail={preselectedAbsenceEmail}
          initialDateMs={anchorDayMs}
          knownAdminUids={currentAdminUids}
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
              ? activeAssignments.filter(
                (a) => a.taskId === reviewingTask.taskId
              )
              : []
          }
          taskMaterials={
            reviewingTask
              ? usedMaterials.filter((m) => m.taskId === reviewingTask.taskId)
              : []
          }
          taskPhotos={
            reviewingTask
              ? photos.filter((p) => p.taskId === reviewingTask.taskId)
              : []
          }
          directory={directory}
          absences={absences}
          adminUid={profile.uid}
          currentAdminUids={currentAdminUids}
          activeAdminEmails={activeAdminEmails}
          masterDriveFolderId={settings.driveSharedFolderId}
          operatorColorLabels={settings.operatorColorLabels}
          connectGoogleWorkspace={connectGoogleWorkspace}
          onClose={() => setReviewingTask(null)}
          onReviewCompleted={handleReviewCompleted}
          onToast={showToast}
        />
      )}

      {/* Delete Task Confirmation Modal */}
      <ConfirmModal
        open={Boolean(confirmDeleteTask)}
        title="Eliminare questo intervento?"
        description={
          confirmDeleteTask
            ? `Verranno eliminati definitivamente il task ${confirmDeleteTask.taskCode} (${formatTaskCommessaLabel(confirmDeleteTask)}), le assegnazioni collegate e le voci materiali associate.`
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

      {/* Gmail Notification Modal */}
      <EmailNotificationModal
        draft={emailDraft}
        onClose={() => setEmailDraft(null)}
      />
    </div>
  );
};
