import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CalendarOff,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Layers,
  List,
  LogOut,
  Mail,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PhoneCall,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Smartphone,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  Absence,
  areSameTechnicianEmails,
  Article,
  Assignment,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_DRIVE_SHARED_FOLDER_URL,
  extractDriveFolderId,
  findStaffMemberByAnyEmail,
  InterventionPhoto,
  isAssignmentOwnedByViewer,
  StaffMember,
  Task,
  UsedMaterial,
  VALIDATION_LIMITS,
} from '../../types/domain';
import {
  addUsedMaterialToAssignment,
  createAutonomousTechnicianTask,
  recordInterventionPhoto,
  removeInterventionPhoto,
  removeUsedMaterial,
  updateAssignmentStatusAndNotes,
  updateUsedMaterialQty,
} from '../../lib/firestoreService';
import {
  BatchPhotoUploadProgress,
  buildTaskCompletionEmailSummary,
  formatTaskDriveSubfolderName,
  uploadMultipleInterventionPhotosToDrive,
} from '../../lib/workspaceApi';
import {
  addLocalDaysMs,
  formatAbsenceCalendarLabel,
  formatAbsenceDateSummary,
  formatCalendarWeekBadgeIt,
  formatTaskCommessaLabel,
  getAbsenceToneClasses,
  getTaskEventVisualStyle,
  HorizontalStripItem,
  isTopStripAbsence,
  isTopStripTask,
  packHorizontalStripSpans,
  startOfLocalDayMs,
} from '../../lib/calendarLayout';
import {
  formatCalendarEventTitle,
  formatDateIt,
  formatDateTimeIt,
  formatShortTechName,
  formatSquadShortNames,
  formatTimeIt,
} from '../../lib/exportUtils';
import {
  assignmentOccursOnDay,
  getMonthCalendarDays,
  getStartOfWeek,
  getWeekdayShortIt,
  isSameDay,
  layoutOverlappingAssignmentsAndAbsences,
  resolveSquadDetailsForAssignment,
  startOfDayMs,
  toLocalDateTimeInputValue,
} from '../../lib/technicianShared';
import { PWAInstallButton } from '../PWAInstallButton';
import { StatusIndicator } from '../StatusIndicator';
import { AbsenceModal } from '../AbsenceModal';
import { ConfirmModal } from '../ConfirmModal';
import {
  EmailDraftConfig,
  EmailNotificationModal,
} from '../EmailNotificationModal';
import { MultiPhotoUploadModal } from '../MultiPhotoUploadModal';
import { OnCallCalendarView } from '../OnCallCalendarView';

type TechWebSection = 'calendar' | 'on_call' | 'tasks' | 'catalog';
type TechCalendarMode = 'day' | 'week' | 'month' | 'list';
type TechStatusFilter =
  | 'ALL'
  | 'Assegnato'
  | 'Preso in Carico'
  | 'Completato'
  | 'PENDING_REVIEW';
type MyTasksFilter = 'ACTIVE' | 'TODAY' | 'COMPLETED';

const SIDEBAR_STORAGE_KEY = 'site_tech_sidebar_expanded';
const HOUR_HEIGHT_PX = 56;
const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

interface TechnicianWebPortalProps {
  onToggleSmartphonePreview?: () => void;
}

export const TechnicianWebPortal: React.FC<TechnicianWebPortalProps> = ({
  onToggleSmartphonePreview,
}) => {
  const {
    profile,
    tasks,
    assignments,
    usedMaterials,
    photos,
    absences,
    articles,
    directory,
    settings,
    knownAdminUids,
    activeAdminEmails,
    currentUserReplyToEmail,
    resolveDeliverableEmail,
    pendingCleanupPhotos,
    cleaningUpDriveFiles,
    cleanupMySupersededDrivePhotos,
    pendingOpenTaskId,
    clearPendingOpenTask,
    setViewMode,
    connectGoogleWorkspace,
    signOutUser,
    showToast,
  } = useApp();

  const isAdmin = profile?.role === 'admin';

  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });

  const [section, setSection] = useState<TechWebSection>('calendar');
  const [calendarMode, setCalendarMode] = useState<TechCalendarMode>('week');
  const [anchorDate, setAnchorDate] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  });

  const [calendarSearch, setCalendarSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<TechStatusFilter>('ALL');

  const [tasksTabFilter, setTasksTabFilter] = useState<MyTasksFilter>('ACTIVE');
  const [tasksSearch, setTasksSearch] = useState('');

  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('ALL');

  // Admin preview filter: 'AUTO' (own email or all if none), 'ALL', or specific email
  const [adminPreviewTechEmail, setAdminPreviewTechEmail] =
    useState<string>('AUTO');

  const [selectedAssignmentId, setSelectedAssignmentId] = useState<
    string | null
  >(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingStatus, setSavingStatus] = useState(false);

  // Modals
  const [absenceModalState, setAbsenceModalState] = useState<{
    open: boolean;
    existing: Absence | null;
    initialDateMs?: number;
  }>({ open: false, existing: null });

  const [autonomousModalOpen, setAutonomousModalOpen] = useState(false);
  const [autoDesc, setAutoDesc] = useState('');
  const [autoStartIso, setAutoStartIso] = useState('');
  const [autoEndIso, setAutoEndIso] = useState('');
  const [creatingAutoTask, setCreatingAutoTask] = useState(false);

  const [materialModalOpen, setMaterialModalOpen] = useState(false);
  const [materialSearch, setMaterialSearch] = useState('');
  const [materialCategory, setMaterialCategory] = useState('ALL');
  const [materialQtyByArticle, setMaterialQtyByArticle] = useState<
    Record<string, string>
  >({});
  const [addingArticleId, setAddingArticleId] = useState<string | null>(null);

  const [pendingPhotoFiles, setPendingPhotoFiles] = useState<File[]>([]);
  const [photoCaptionDraft, setPhotoCaptionDraft] = useState('');
  const [uploadingPhotos, setUploadingPhotos] = useState(false);
  const [uploadProgress, setUploadProgress] =
    useState<BatchPhotoUploadProgress | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const [photoToDelete, setPhotoToDelete] =
    useState<InterventionPhoto | null>(null);
  const [deletingPhoto, setDeletingPhoto] = useState(false);

  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState(false);
  const [emailDraft, setEmailDraft] = useState<EmailDraftConfig | null>(null);

  const verticalGridScrollRef = useRef<HTMLDivElement | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (
      section === 'calendar' &&
      (calendarMode === 'week' || calendarMode === 'day') &&
      verticalGridScrollRef.current
    ) {
      verticalGridScrollRef.current.scrollTop = Math.round(7.5 * HOUR_HEIGHT_PX);
    }
  }, [section, calendarMode]);

  const toggleSidebar = () => {
    setSidebarExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // ignore storage error
      }
      return next;
    });
  };

  // Maps for fast lookups
  const tasksById = useMemo(() => {
    const m = new Map<string, Task>();
    for (const t of tasks) m.set(t.taskId, t);
    return m;
  }, [tasks]);

  const assignmentsByTaskId = useMemo(() => {
    const m = new Map<string, Assignment[]>();
    for (const a of assignments) {
      if (a.stato === 'Annullato') continue;
      const arr = m.get(a.taskId) || [];
      arr.push(a);
      m.set(a.taskId, arr);
    }
    return m;
  }, [assignments]);

  const directoryByEmail = useMemo(() => {
    const m = new Map<string, StaffMember>();
    for (const d of directory) {
      m.set(d.email.trim().toLowerCase(), d);
      if (d.secondaryEmail?.trim()) {
        m.set(d.secondaryEmail.trim().toLowerCase(), d);
      }
    }
    return m;
  }, [directory]);

  const activeStaffMembers = useMemo(
    () => directory.filter((m) => m.active),
    [directory]
  );

  // Effective viewer email & assignments visible in Technician Web Portal
  const myLoginEmail = (profile?.email || '').trim().toLowerCase();

  const effectiveViewerEmail = useMemo(() => {
    if (!isAdmin) return myLoginEmail;
    if (adminPreviewTechEmail === 'ALL') return '';
    if (adminPreviewTechEmail !== 'AUTO') {
      return adminPreviewTechEmail.trim().toLowerCase();
    }
    const hasOwn = assignments.some(
      (a) =>
        a.stato !== 'Annullato' &&
        isAssignmentOwnedByViewer(a, myLoginEmail, profile?.uid, directory)
    );
    return hasOwn ? myLoginEmail : '';
  }, [isAdmin, myLoginEmail, adminPreviewTechEmail, assignments, profile?.uid, directory]);

  const myAssignments = useMemo(() => {
    const valid = assignments.filter((a) => a.stato !== 'Annullato');
    if (!isAdmin) {
      return valid.filter((a) =>
        isAssignmentOwnedByViewer(a, myLoginEmail, profile?.uid, directory)
      );
    }
    if (!effectiveViewerEmail) {
      // Deduplicate one assignment per task when viewing ALL in Admin preview
      const seenTask = new Set<string>();
      const deduped: Assignment[] = [];
      for (const a of valid) {
        if (!seenTask.has(a.taskId)) {
          seenTask.add(a.taskId);
          deduped.push(a);
        }
      }
      return deduped;
    }
    return valid.filter((a) =>
      isAssignmentOwnedByViewer(a, effectiveViewerEmail, undefined, directory)
    );
  }, [assignments, isAdmin, myLoginEmail, effectiveViewerEmail, profile?.uid, directory]);

  const visibleAbsences = useMemo(() => {
    if (!isAdmin) {
      return absences.filter(
        (ab) =>
          Boolean(
            (profile?.uid && ab.technicianUid === profile.uid) ||
            areSameTechnicianEmails(ab.technicianEmail, myLoginEmail, directory)
          )
      );
    }
    if (!effectiveViewerEmail) return absences;
    return absences.filter((ab) =>
      areSameTechnicianEmails(ab.technicianEmail, effectiveViewerEmail, directory)
    );
  }, [absences, isAdmin, myLoginEmail, effectiveViewerEmail, profile?.uid, directory]);

  // Deep-link support via pendingOpenTaskId
  useEffect(() => {
    if (!pendingOpenTaskId) return;
    const match =
      myAssignments.find((a) => a.taskId === pendingOpenTaskId) ||
      assignments.find(
        (a) => a.taskId === pendingOpenTaskId && a.stato !== 'Annullato'
      );
    if (match) {
      setSelectedAssignmentId(match.assignmentId);
      const d = new Date(match.inizioMs);
      setAnchorDate(
        new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
      );
      clearPendingOpenTask();
    }
  }, [pendingOpenTaskId, myAssignments, assignments, clearPendingOpenTask]);

  // Auto-select first relevant assignment when none selected
  useEffect(() => {
    if (
      selectedAssignmentId &&
      myAssignments.some((a) => a.assignmentId === selectedAssignmentId)
    ) {
      return;
    }
    const todayStart = startOfLocalDayMs(Date.now());
    const todayAsg = myAssignments.find((a) =>
      assignmentOccursOnDay(a, todayStart)
    );
    const activeAsg = myAssignments.find((a) => a.stato !== 'Completato');
    const fallback = todayAsg || activeAsg || myAssignments[0] || null;
    setSelectedAssignmentId(fallback ? fallback.assignmentId : null);
  }, [myAssignments, selectedAssignmentId]);

  const selectedAssignment = useMemo(
    () =>
      myAssignments.find((a) => a.assignmentId === selectedAssignmentId) ||
      null,
    [myAssignments, selectedAssignmentId]
  );

  useEffect(() => {
    setNoteDraft(selectedAssignment?.noteTecnico || '');
  }, [selectedAssignment?.assignmentId, selectedAssignment?.noteTecnico]);

  const selectedTask = useMemo(
    () =>
      selectedAssignment
        ? tasksById.get(selectedAssignment.taskId) || null
        : null,
    [selectedAssignment, tasksById]
  );

  const selectedSquad = useMemo(() => {
    if (!selectedAssignment) return null;
    return resolveSquadDetailsForAssignment({
      asg: selectedAssignment,
      tasksById,
      assignmentsByTaskId,
      directoryByEmail,
      viewerEmail: effectiveViewerEmail || selectedAssignment.technicianEmail,
    });
  }, [
    selectedAssignment,
    tasksById,
    assignmentsByTaskId,
    directoryByEmail,
    effectiveViewerEmail,
  ]);

  const selectedTaskMaterials = useMemo(() => {
    if (!selectedAssignment) return [];
    return usedMaterials.filter((m) => m.taskId === selectedAssignment.taskId);
  }, [usedMaterials, selectedAssignment]);

  const selectedTaskPhotos = useMemo(() => {
    if (!selectedAssignment) return [];
    return photos.filter((p) => p.taskId === selectedAssignment.taskId);
  }, [photos, selectedAssignment]);

  const isOwnSelectedAssignment = useMemo(() => {
    if (!selectedAssignment) return false;
    if (isAdmin) return true;
    return isAssignmentOwnedByViewer(
      selectedAssignment,
      myLoginEmail,
      profile?.uid,
      directory
    );
  }, [selectedAssignment, isAdmin, profile?.uid, myLoginEmail, directory]);

  const canAddPhotosAndMaterials = Boolean(
    selectedAssignment &&
    isOwnSelectedAssignment &&
    selectedAssignment.stato === 'Preso in Carico'
  );

  const canModifyOwnItem = (ownerEmail: string, ownerUid?: string): boolean => {
    if (!selectedAssignment) return false;
    if (isAdmin) return selectedAssignment.stato === 'Preso in Carico';
    return (
      selectedAssignment.stato === 'Preso in Carico' &&
      Boolean(
        (profile?.uid && ownerUid && ownerUid === profile.uid) ||
        areSameTechnicianEmails(ownerEmail, myLoginEmail, directory)
      )
    );
  };

  const isSelectedNoteMandatory = useMemo(() => {
    if (!selectedAssignment) return false;
    if (isAdmin) return false;
    if (selectedTask?.altroReparto) return false;
    const cleanCommessa = selectedAssignment.commessa.trim().toUpperCase();
    if (!cleanCommessa) return true;
    const exempt = (settings.exemptCommesse || []).map((c) =>
      c.trim().toUpperCase()
    );
    return !exempt.includes(cleanCommessa);
  }, [selectedAssignment, selectedTask, isAdmin, settings.exemptCommesse]);

  // Personal KPI counts
  const personalKpis = useMemo(() => {
    const todayStart = startOfLocalDayMs(nowMs);
    let todayCount = 0;
    let todoCount = 0;
    let inProgressCount = 0;
    let completedCount = 0;

    for (const a of myAssignments) {
      if (assignmentOccursOnDay(a, todayStart)) todayCount += 1;
      if (a.stato === 'Assegnato') todoCount += 1;
      else if (a.stato === 'Preso in Carico') inProgressCount += 1;
      else if (a.stato === 'Completato') completedCount += 1;
    }

    return { todayCount, todoCount, inProgressCount, completedCount };
  }, [myAssignments, nowMs]);

  // Filtered calendar assignments
  const filteredCalendarAssignments = useMemo(() => {
    const q = calendarSearch.trim().toLowerCase();
    return myAssignments.filter((asg) => {
      const parentTask = tasksById.get(asg.taskId);
      const squad = resolveSquadDetailsForAssignment({
        asg,
        tasksById,
        assignmentsByTaskId,
        directoryByEmail,
        viewerEmail: effectiveViewerEmail || asg.technicianEmail,
      });
      if (statusFilter === 'PENDING_REVIEW') {
        if (!parentTask?.pendingAdminReview) return false;
      } else if (statusFilter !== 'ALL') {
        if (
          squad.sharedCalendarStatus !== statusFilter &&
          asg.stato !== statusFilter
        ) {
          return false;
        }
      }

      if (!q) return true;
      const haystack = [
        asg.commessa,
        asg.assignmentCode,
        parentTask?.taskCode || '',
        asg.descrizioneTask,
        ...squad.allNames,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [
    myAssignments,
    tasksById,
    statusFilter,
    calendarSearch,
    assignmentsByTaskId,
    directoryByEmail,
    effectiveViewerEmail,
  ]);

  // Visible dates for Day / Week
  const visibleDays = useMemo(() => {
    if (calendarMode === 'day') {
      return [anchorDate];
    }
    const mon = getStartOfWeek(anchorDate);
    return Array.from(
      { length: 7 },
      (_, idx) => new Date(addLocalDaysMs(mon.getTime(), idx))
    );
  }, [calendarMode, anchorDate]);

  const visibleDayStartsMs = useMemo(
    () => visibleDays.map((d) => startOfDayMs(d)),
    [visibleDays]
  );

  const monthDays = useMemo(
    () => getMonthCalendarDays(anchorDate),
    [anchorDate]
  );

  const weekBadgeLabel = useMemo(() => {
    if (calendarMode === 'month') {
      return formatCalendarWeekBadgeIt(monthDays);
    }
    return formatCalendarWeekBadgeIt(visibleDays);
  }, [calendarMode, visibleDays, monthDays]);

  const periodRangeLabel = useMemo(() => {
    if (calendarMode === 'day') {
      return formatDateIt(anchorDate.getTime());
    }
    if (calendarMode === 'month') {
      return new Intl.DateTimeFormat('it-IT', {
        month: 'long',
        year: 'numeric',
      }).format(anchorDate);
    }
    const first = visibleDays[0];
    const last = visibleDays[visibleDays.length - 1];
    return `${formatDateIt(first.getTime())} – ${formatDateIt(last.getTime())}`;
  }, [calendarMode, anchorDate, visibleDays]);

  const navigatePeriod = (direction: -1 | 1) => {
    if (calendarMode === 'day') {
      setAnchorDate(
        (prev) => new Date(addLocalDaysMs(prev.getTime(), direction))
      );
    } else if (calendarMode === 'month') {
      setAnchorDate(
        (prev) =>
          new Date(prev.getFullYear(), prev.getMonth() + direction, 1, 0, 0, 0, 0)
      );
    } else {
      setAnchorDate(
        (prev) => new Date(addLocalDaysMs(prev.getTime(), direction * 7))
      );
    }
  };

  const goToday = () => {
    const now = new Date();
    setAnchorDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    );
  };

  // Top horizontal strip (multi-day >= 3 solar days, Altro AT, and all-day/multi-day absences)
  const isAssignmentInTopStrip = (asg: Assignment): boolean => {
    const parentTask = tasksById.get(asg.taskId);
    if (parentTask) return isTopStripTask(parentTask);
    return isTopStripTask({
      inizioMs: asg.inizioMs,
      fineMs: asg.fineMs,
      altroReparto: false,
    });
  };

  const topStripLayout = useMemo(() => {
    const items: HorizontalStripItem<Assignment | Absence>[] = [];
    for (const abs of visibleAbsences) {
      if (isTopStripAbsence(abs)) {
        items.push({
          id: `abs_${abs.absenceId}`,
          kind: 'absence',
          inizioMs: abs.inizioMs,
          fineMs: abs.fineMs,
          payload: abs,
        });
      }
    }
    for (const asg of filteredCalendarAssignments) {
      if (isAssignmentInTopStrip(asg)) {
        items.push({
          id: `asg_${asg.assignmentId}`,
          kind: 'task',
          inizioMs: asg.inizioMs,
          fineMs: asg.fineMs,
          payload: asg,
        });
      }
    }
    return packHorizontalStripSpans(items, visibleDayStartsMs);
  }, [visibleAbsences, filteredCalendarAssignments, visibleDayStartsMs, tasksById]);

  // Filtered "I miei Task" list
  const filteredTasksTableRows = useMemo(() => {
    const todayStart = startOfLocalDayMs(nowMs);
    const q = tasksSearch.trim().toLowerCase();

    return myAssignments
      .filter((asg) => {
        if (tasksTabFilter === 'ACTIVE' && asg.stato === 'Completato') {
          return false;
        }
        if (
          tasksTabFilter === 'TODAY' &&
          !assignmentOccursOnDay(asg, todayStart)
        ) {
          return false;
        }
        if (tasksTabFilter === 'COMPLETED' && asg.stato !== 'Completato') {
          return false;
        }
        if (!q) return true;
        const parentTask = tasksById.get(asg.taskId);
        const haystack = [
          asg.commessa,
          asg.assignmentCode,
          parentTask?.taskCode || '',
          asg.descrizioneTask,
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      })
      .sort((a, b) =>
        tasksTabFilter === 'COMPLETED'
          ? b.inizioMs - a.inizioMs
          : a.inizioMs - b.inizioMs
      );
  }, [myAssignments, tasksTabFilter, tasksSearch, nowMs, tasksById]);

  // Active catalog articles & categories
  const activeArticles = useMemo(
    () => articles.filter((a) => a.active),
    [articles]
  );

  const articleCategories = useMemo(() => {
    const set = new Set<string>();
    for (const a of activeArticles) {
      if (a.categoria.trim()) set.add(a.categoria.trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'it'));
  }, [activeArticles]);

  const filteredCatalogArticles = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    return activeArticles.filter((a) => {
      if (catalogCategory !== 'ALL' && a.categoria !== catalogCategory) {
        return false;
      }
      if (!q) return true;
      return (
        a.codiceArticolo.toLowerCase().includes(q) ||
        a.descrizione.toLowerCase().includes(q) ||
        a.categoria.toLowerCase().includes(q)
      );
    });
  }, [activeArticles, catalogCategory, catalogSearch]);

  const filteredModalArticles = useMemo(() => {
    const q = materialSearch.trim().toLowerCase();
    return activeArticles.filter((a) => {
      if (materialCategory !== 'ALL' && a.categoria !== materialCategory) {
        return false;
      }
      if (!q) return true;
      return (
        a.codiceArticolo.toLowerCase().includes(q) ||
        a.descrizione.toLowerCase().includes(q) ||
        a.categoria.toLowerCase().includes(q)
      );
    });
  }, [activeArticles, materialCategory, materialSearch]);

  // Handlers
  const openCreateAutonomousModal = () => {
    const base = new Date();
    const roundedStart = new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      Math.max(8, base.getHours()),
      0,
      0,
      0
    ).getTime();
    const roundedEnd = roundedStart + 2 * 3600000;
    setAutoDesc('');
    setAutoStartIso(toLocalDateTimeInputValue(roundedStart));
    setAutoEndIso(toLocalDateTimeInputValue(roundedEnd));
    setAutonomousModalOpen(true);
  };

  const handleCreateAutonomousTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setCreatingAutoTask(true);
    try {
      const targetEmail =
        isAdmin && effectiveViewerEmail ? effectiveViewerEmail : profile.email;
      const targetStaff =
        findStaffMemberByAnyEmail(targetEmail, directory) ||
        directoryByEmail.get(targetEmail);
      const targetFullName = targetStaff
        ? `${targetStaff.nome} ${targetStaff.cognome}`.trim()
        : `${profile.nome} ${profile.cognome}`.trim();
      const targetUid =
        isAdmin && effectiveViewerEmail
          ? targetStaff?.linkedUid || profile.uid
          : profile.uid;
      const targetDeliverable = resolveDeliverableEmail(targetEmail);

      const existingAutoCount = tasks.filter(
        (t) => t.createdByRole === 'technician'
      ).length;

      const created = await createAutonomousTechnicianTask({
        descrizione: autoDesc,
        inizioIso: autoStartIso,
        fineIso: autoEndIso,
        technicianUid: targetUid,
        technicianEmail: targetEmail,
        technicianDeliverableEmail: targetDeliverable,
        technicianFullName: targetFullName,
        knownAdminUids,
        activeAdminEmails,
        existingAutonomousCount: existingAutoCount,
        directory,
      });

      setAutonomousModalOpen(false);
      setSelectedAssignmentId(created.assignmentId);
      showToast(
        `Task autonomo ${created.taskCode} creato e preso in carico.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore creazione task autonomo.',
        'error'
      );
    } finally {
      setCreatingAutoTask(false);
    }
  };

  const buildCompletionDraftForSelected = (
    overrideNote?: string,
    taskOverride?: Task | null,
    overrideNotesByEmail?: Record<string, string>
  ): EmailDraftConfig | null => {
    if (!selectedAssignment) return null;
    const siblings = assignmentsByTaskId.get(selectedAssignment.taskId) || [
      selectedAssignment,
    ];
    const effectiveTask = taskOverride ?? selectedTask;
    const taskCode =
      effectiveTask?.taskCode || selectedAssignment.assignmentCode;
    const completedByName =
      `${profile?.nome || ''} ${profile?.cognome || ''}`.trim() ||
      selectedAssignment.technicianName;

    const summary = buildTaskCompletionEmailSummary({
      task: effectiveTask,
      completedByName,
      completedByReplyToEmail: currentUserReplyToEmail,
      commessa: selectedAssignment.commessa,
      taskCode,
      descrizioneTask: selectedAssignment.descrizioneTask,
      inizioMs: selectedAssignment.inizioMs,
      fineMs: selectedAssignment.fineMs,
      squadAssignments: siblings,
      overrideNoteByAssignmentId:
        overrideNote !== undefined
          ? { [selectedAssignment.assignmentId]: overrideNote }
          : undefined,
      overrideNotesByEmail,
      taskMaterials: selectedTaskMaterials,
      taskPhotos: selectedTaskPhotos,
      activeAdminEmails,
      resolveDeliverableEmail,
      directory,
      masterFolderId: settings.driveSharedFolderId,
    });

    return {
      ...summary,
      modalTitle: 'Invia riepilogo completamento',
    };
  };

  const handleSaveNoteOnly = async () => {
    if (!selectedAssignment || !profile) return;
    setSavingStatus(true);
    try {
      const siblings = assignmentsByTaskId.get(selectedAssignment.taskId) || [
        selectedAssignment,
      ];
      await updateAssignmentStatusAndNotes({
        assignment: selectedAssignment,
        siblingAssignments: siblings,
        parentTask: selectedTask || undefined,
        newStatus: selectedAssignment.stato,
        noteTecnico: noteDraft,
        exemptCommesse: settings.exemptCommesse || [],
        isAltroReparto: Boolean(selectedTask?.altroReparto),
        actorUid: profile.uid,
        actorEmail: profile.email,
        isAdminActor: isAdmin,
        directory,
      });
      showToast('Nota attività salvata.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio nota.',
        'error'
      );
    } finally {
      setSavingStatus(false);
    }
  };

  const handleTakeInCharge = async () => {
    if (!selectedAssignment || !profile) return;
    setSavingStatus(true);
    try {
      const siblings = assignmentsByTaskId.get(selectedAssignment.taskId) || [
        selectedAssignment,
      ];
      await updateAssignmentStatusAndNotes({
        assignment: selectedAssignment,
        siblingAssignments: siblings,
        parentTask: selectedTask || undefined,
        newStatus: 'Preso in Carico',
        noteTecnico: noteDraft,
        exemptCommesse: settings.exemptCommesse || [],
        isAltroReparto: Boolean(selectedTask?.altroReparto),
        actorUid: profile.uid,
        actorEmail: profile.email,
        isAdminActor: isAdmin,
        directory,
      });
      showToast('Intervento preso in carico.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore presa in carico.',
        'error'
      );
    } finally {
      setSavingStatus(false);
    }
  };

  const handleCompleteAssignment = async () => {
    if (!selectedAssignment || !profile) return;
    const cleanNote = noteDraft.trim();
    if (isSelectedNoteMandatory && !cleanNote) {
      showToast(
        'Inserisci le note attività prima di completare l’intervento.',
        'error'
      );
      return;
    }

    const siblings = assignmentsByTaskId.get(selectedAssignment.taskId) || [
      selectedAssignment,
    ];

    setSavingStatus(true);
    try {
      const res = await updateAssignmentStatusAndNotes({
        assignment: selectedAssignment,
        siblingAssignments: siblings,
        parentTask: selectedTask || undefined,
        newStatus: 'Completato',
        noteTecnico: cleanNote,
        exemptCommesse: settings.exemptCommesse || [],
        isAltroReparto: Boolean(selectedTask?.altroReparto),
        actorUid: profile.uid,
        actorEmail: profile.email,
        isAdminActor: isAdmin,
        directory,
      });

      const isPendingReview = Boolean(
        selectedTask?.pendingAdminReview ||
        (!selectedTask?.altroReparto && !selectedAssignment.commessa.trim())
      );

      if (
        res.taskBecameCompleted &&
        !selectedTask?.altroReparto &&
        !isPendingReview
      ) {
        const baseDraft = buildCompletionDraftForSelected(
          cleanNote,
          res.authoritativeTask || selectedTask,
          res.squadNotesByEmail
        );
        if (baseDraft) {
          setEmailDraft({
            ...baseDraft,
            submitLabel: 'Invia email di riepilogo',
          });
        }
        showToast(
          'Intervento chiuso da tutta la squadra. Invia il riepilogo email.',
          'success'
        );
      } else if (isPendingReview && res.nextTaskStatus === 'Completato') {
        showToast(
          'Task completato. Il riepilogo email partirà dopo la revisione Admin.',
          'success'
        );
      } else if (res.nextTaskStatus !== 'Completato') {
        showToast(
          `Quota personale completata (${res.completedCount}/${res.totalSquadCount}). Il riepilogo email si aprirà all’ultimo collega che chiude il task.`,
          'success'
        );
      } else {
        showToast('Intervento completato.', 'success');
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore completamento intervento.',
        'error'
      );
    } finally {
      setSavingStatus(false);
    }
  };

  const handleAddMaterial = async (article: Article, rawQty?: string) => {
    if (!selectedAssignment || !profile || !canAddPhotosAndMaterials) return;
    const qty = Number((rawQty || '1').replace(',', '.'));
    if (!Number.isFinite(qty) || qty <= 0) {
      showToast('Inserisci una quantità valida maggiore di zero.', 'error');
      return;
    }
    setAddingArticleId(article.articleId);
    try {
      await addUsedMaterialToAssignment({
        assignment: selectedAssignment,
        article,
        quantita: qty,
        actorUid: profile.uid,
        squadEmails:
          selectedTask?.assignedEmails || selectedAssignment.squadEmails,
        directory,
      });
      showToast(
        `Aggiunto ${qty} ${article.unitaMisura} · ${article.codiceArticolo}`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore aggiunta materiale.',
        'error'
      );
    } finally {
      setAddingArticleId(null);
    }
  };

  const handleStepMaterialQty = async (mat: UsedMaterial, delta: number) => {
    const next = Math.round((mat.quantita + delta) * 100) / 100;
    if (next <= 0) {
      try {
        await removeUsedMaterial(mat.usedId);
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'Errore rimozione materiale.',
          'error'
        );
      }
      return;
    }
    try {
      await updateUsedMaterialQty(mat.usedId, next);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore aggiornamento quantità.',
        'error'
      );
    }
  };

  const handleConfirmPhotoBatchUpload = async () => {
    if (
      !selectedAssignment ||
      !profile ||
      pendingPhotoFiles.length === 0 ||
      uploadingPhotos
    ) {
      return;
    }

    setUploadingPhotos(true);
    setUploadProgress({
      current: 1,
      total: pendingPhotoFiles.length,
      fileName: pendingPhotoFiles[0].name,
    });

    try {
      const accessToken = await connectGoogleWorkspace();
      const taskCode =
        selectedTask?.taskCode || selectedAssignment.assignmentCode;
      const squadEmails =
        selectedTask?.assignedEmails || selectedAssignment.squadEmails;

      const { uploadedCount, failedFiles } =
        await uploadMultipleInterventionPhotosToDrive({
          accessToken,
          files: pendingPhotoFiles,
          masterFolderId: settings.driveSharedFolderId,
          commessa: selectedAssignment.commessa,
          taskCode,
          uploaderEmail: profile.email,
          onProgress: setUploadProgress,
          onFileUploaded: async (res) => {
            await recordInterventionPhoto({
              assignment: selectedAssignment,
              actorUid: profile.uid,
              fileName: res.fileName,
              driveFileId: res.driveFileId,
              driveWebViewLink: res.driveWebViewLink,
              driveThumbnailLink: res.driveThumbnailLink,
              folderPath: res.folderPath,
              driveSubfolderId: res.driveSubfolderId,
              ownerConsolidated: res.ownerConsolidated,
              squadEmails,
              directory,
              caption: photoCaptionDraft,
            });
          },
        });

      setPendingPhotoFiles([]);
      setPhotoCaptionDraft('');
      setUploadProgress(null);

      if (failedFiles.length === 0) {
        showToast(
          uploadedCount === 1
            ? 'Foto caricata su Google Drive.'
            : `${uploadedCount} foto caricate su Google Drive.`,
          'success'
        );
      } else {
        showToast(
          `Caricate ${uploadedCount} foto, ${failedFiles.length} non riuscite.`,
          'error'
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore caricamento foto su Drive.',
        'error'
      );
    } finally {
      setUploadingPhotos(false);
      setUploadProgress(null);
    }
  };

  const handleConfirmDeletePhoto = async () => {
    if (!photoToDelete) return;
    setDeletingPhoto(true);
    try {
      await removeInterventionPhoto(photoToDelete.photoId);
      setPhotoToDelete(null);
      showToast('Foto rimossa dal task.', 'info');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore rimozione foto.',
        'error'
      );
    } finally {
      setDeletingPhoto(false);
    }
  };

  const navItems: {
    id: TechWebSection;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }[] = [
      { id: 'calendar', label: 'Calendario', icon: CalendarRange },
      { id: 'on_call', label: 'Reperibilità', icon: PhoneCall },
      { id: 'tasks', label: 'I miei Task', icon: ClipboardList },
      { id: 'catalog', label: 'Catalogo', icon: Layers },
    ];

  const sectionTitles: Record<TechWebSection, string> = {
    calendar: 'Calendario Operativo',
    on_call: 'Calendario Reperibilità',
    tasks: 'I miei Task',
    catalog: 'Catalogo Articoli',
  };

  const initials =
    `${profile?.nome?.charAt(0) || ''}${profile?.cognome?.charAt(0) || ''
      }`.toUpperCase() || 'TC';

  const selectedDriveFolderUrl = useMemo(() => {
    if (!selectedAssignment) return DEFAULT_DRIVE_SHARED_FOLDER_URL;
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
  }, [selectedAssignment, selectedTaskPhotos, settings.driveSharedFolderId]);

  const selfTechForAbsence = useMemo(() => {
    if (isAdmin && effectiveViewerEmail) {
      const st = directoryByEmail.get(effectiveViewerEmail);
      if (st) {
        return {
          email: st.email,
          fullName: `${st.nome} ${st.cognome}`.trim(),
          uid: st.linkedUid || profile?.uid || '',
        };
      }
    }
    return {
      email: profile?.email || '',
      fullName: `${profile?.nome || ''} ${profile?.cognome || ''}`.trim(),
      uid: profile?.uid || '',
    };
  }, [isAdmin, effectiveViewerEmail, directoryByEmail, profile]);

  return (
    <div className="h-screen overflow-hidden bg-slate-50 flex">
      {/* Left Collapsible Sidebar */}
      <aside
        className={`hidden lg:flex lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-30 ${sidebarExpanded ? 'lg:w-[248px]' : 'lg:w-[64px]'
          }`}
      >
        <div
          className={`h-12 border-b border-slate-200 flex items-center shrink-0 ${sidebarExpanded ? 'px-4 justify-between gap-2' : 'justify-center px-2'
            }`}
        >
          {sidebarExpanded && (
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center shrink-0">
                <div className="grid grid-cols-2 gap-0 w-3 h-3">
                  <span className="bg-slate-400 rounded-[1px]" />
                  <span className="bg-white rounded-[1px]" />
                  <span className="bg-white rounded-[1px]" />
                  <span className="bg-slate-400 rounded-[1px]" />
                </div>
              </div>
              <span className="font-display text-sm font-semibold tracking-tight text-slate-900 truncate">
                Gestione Interventi
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={toggleSidebar}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer shrink-0"
            title={sidebarExpanded ? 'Riduci menu laterale' : 'Espandi menu laterale'}
            aria-label={sidebarExpanded ? 'Riduci menu laterale' : 'Espandi menu laterale'}
          >
            {sidebarExpanded ? (
              <PanelLeftClose className="w-4 h-4" />
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
          </button>
        </div>

        <nav
          className={`flex-1 py-4 space-y-2 overflow-y-auto ${sidebarExpanded ? 'px-4' : 'px-2'
            }`}
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <div key={item.id} className="relative group">
                <button
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`w-full flex items-center min-h-[40px] rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${sidebarExpanded
                      ? 'gap-2 px-4 py-2'
                      : 'justify-center px-0 py-2'
                    } ${active
                      ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                  aria-label={item.label}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {sidebarExpanded && (
                    <span className="truncate whitespace-nowrap">
                      {item.label}
                    </span>
                  )}
                </button>

                {!sidebarExpanded && (
                  <div className="pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-150 absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-2 rounded-lg bg-slate-900 border border-slate-800 text-white text-xs font-normal whitespace-nowrap z-50">
                    {item.label}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div
          className={`border-t border-slate-200 shrink-0 ${sidebarExpanded ? 'p-4 space-y-2' : 'p-2 space-y-2'
            }`}
        >
          {isAdmin && (
            <div className="space-y-2 pb-2 border-b border-slate-200">
              {sidebarExpanded && (
                <select
                  value={adminPreviewTechEmail}
                  onChange={(e) => setAdminPreviewTechEmail(e.target.value)}
                  className="w-full min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-800 focus:outline-none focus:border-slate-900"
                  aria-label="Filtra tecnico in anteprima"
                >
                  <option value="AUTO">Vista personale / Auto</option>
                  <option value="ALL">Tutti i tecnici</option>
                  {activeStaffMembers.map((m) => (
                    <option key={m.memberId} value={m.email.toLowerCase()}>
                      {m.cognome} {m.nome}
                    </option>
                  ))}
                </select>
              )}

              {onToggleSmartphonePreview && (
                <button
                  type="button"
                  onClick={onToggleSmartphonePreview}
                  className={`w-full flex items-center justify-center gap-2 min-h-[40px] rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 transition-colors cursor-pointer ${sidebarExpanded ? 'px-4 py-2' : 'px-0 py-2'
                    }`}
                  title="Anteprima Smartphone"
                  aria-label="Anteprima Smartphone"
                >
                  <Smartphone className="w-4 h-4 shrink-0" />
                  {sidebarExpanded && (
                    <span className="truncate whitespace-nowrap">
                      Anteprima Smartphone
                    </span>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={() => setViewMode('admin')}
                className={`w-full flex items-center justify-center gap-2 min-h-[40px] rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold transition-colors cursor-pointer ${sidebarExpanded ? 'px-4 py-2' : 'px-0 py-2'
                  }`}
                title="Torna a Portale Admin"
                aria-label="Torna a Portale Admin"
              >
                <ShieldCheck className="w-4 h-4 shrink-0" />
                {sidebarExpanded && (
                  <span className="truncate whitespace-nowrap">
                    Portale Admin
                  </span>
                )}
              </button>
            </div>
          )}

          {sidebarExpanded ? (
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-900 truncate">
                  {profile?.nome} {profile?.cognome}
                </p>
                <p className="text-[11px] text-slate-500 font-mono truncate">
                  {profile?.email}
                </p>
              </div>
              <button
                type="button"
                onClick={signOutUser}
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer shrink-0"
                title="Esci"
                aria-label="Esci"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <div
                className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-300 flex items-center justify-center text-[11px] font-semibold text-slate-700 select-none"
                title={`${profile?.nome || ''} ${profile?.cognome || ''}`}
              >
                {initials}
              </div>
              <button
                type="button"
                onClick={signOutUser}
                className="w-full min-h-[36px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer"
                title="Esci"
                aria-label="Esci"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content + Right Inspector */}
      <div
        className={`flex-1 h-screen overflow-hidden flex flex-col min-w-0 ${sidebarExpanded ? 'lg:pl-[248px]' : 'lg:pl-[64px]'
          }`}
      >
        {/* Top 48px Header */}
        <header className="h-12 shrink-0 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 z-20">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-slate-500 whitespace-nowrap">
              Portale Tecnico
            </span>
            <span className="text-slate-300" aria-hidden="true">
              /
            </span>
            <h1 className="font-display font-semibold text-slate-900 truncate">
              {sectionTitles[section]}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton compact />
          </div>
        </header>

        {/* 2-Pane Workspace Body (Center Workspace + Persistent Right Inspector) */}
        <main className="flex-1 min-h-0 overflow-hidden p-4 flex gap-4">
          {/* Center Workspace */}
          <div className="flex-1 min-w-0 h-full flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
            {section === 'calendar' && (
              <>
                {/* Calendar Toolbar Row 1 */}
                <div className="px-4 py-2 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 shrink-0">
                  <div className="flex items-center gap-2">
                    {(
                      [
                        { id: 'day', label: 'Giorno' },
                        { id: 'week', label: 'Settimana' },
                        { id: 'month', label: 'Mese' },
                        { id: 'list', label: 'Elenco' },
                      ] as const
                    ).map((m) => {
                      const active = calendarMode === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => setCalendarMode(m.id)}
                          className={`inline-flex items-center gap-2 min-h-[36px] px-4 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${active
                              ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                            }`}
                        >
                          {m.id === 'list' && <List className="w-3.5 h-3.5" />}
                          <span>{m.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => navigatePeriod(-1)}
                      className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer"
                      aria-label="Periodo precedente"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={goToday}
                      className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      Oggi
                    </button>
                    <button
                      type="button"
                      onClick={() => navigatePeriod(1)}
                      className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer"
                      aria-label="Periodo successivo"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>

                    <div className="pl-2 flex items-center gap-2 text-xs font-mono tabular-nums text-slate-900 whitespace-nowrap">
                      <span className="font-semibold">{periodRangeLabel}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500">{weekBadgeLabel}</span>
                    </div>
                  </div>
                </div>

                {/* Calendar Toolbar Row 2 */}
                <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 shrink-0">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="relative flex-1 max-w-xs min-w-[180px]">
                      <Search className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={calendarSearch}
                        onChange={(e) => setCalendarSearch(e.target.value)}
                        placeholder="Cerca commessa, attività..."
                        className="w-full min-h-[36px] pl-8 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                      />
                    </div>

                    <select
                      value={statusFilter}
                      onChange={(e) =>
                        setStatusFilter(e.target.value as TechStatusFilter)
                      }
                      className="min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 focus:outline-none focus:border-slate-900"
                      aria-label="Filtra per stato"
                    >
                      <option value="ALL">Tutti gli stati</option>
                      <option value="Assegnato">Assegnato</option>
                      <option value="Preso in Carico">Preso in Carico</option>
                      <option value="Completato">Completato</option>
                      <option value="PENDING_REVIEW">Da revisionare</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setAbsenceModalState({
                          open: true,
                          existing: null,
                          initialDateMs: anchorDate.getTime(),
                        })
                      }
                      className="inline-flex items-center gap-2 min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <CalendarOff className="w-4 h-4" />
                      <span>Assenza</span>
                    </button>

                    <button
                      type="button"
                      onClick={openCreateAutonomousModal}
                      className="inline-flex items-center gap-2 min-h-[36px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Nuovo Task</span>
                    </button>
                  </div>
                </div>

                {/* Calendar Views */}
                {(calendarMode === 'week' || calendarMode === 'day') && (
                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    {/* Day Headers */}
                    <div className="flex border-b border-slate-200 bg-slate-50 shrink-0">
                      <div className="w-16 shrink-0 border-r border-slate-200 px-2 py-2 flex items-center justify-center text-[11px] font-semibold text-slate-500">
                        Ora
                      </div>
                      <div
                        className="flex-1 grid divide-x divide-slate-200"
                        style={{
                          gridTemplateColumns: `repeat(${visibleDays.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {visibleDays.map((day, idx) => {
                          const dayStart = visibleDayStartsMs[idx];
                          const isToday = isSameDay(day, new Date(nowMs));
                          const dayCount = filteredCalendarAssignments.filter(
                            (a) => assignmentOccursOnDay(a, dayStart)
                          ).length;
                          const ddmm = `${String(day.getDate()).padStart(
                            2,
                            '0'
                          )}/${String(day.getMonth() + 1).padStart(2, '0')}`;

                          return (
                            <div
                              key={dayStart}
                              className={`px-2 py-2 flex flex-col gap-0 ${isToday ? 'bg-slate-100' : 'bg-white'
                                }`}
                            >
                              <span className="text-[11px] font-normal text-slate-500">
                                {getWeekdayShortIt(day)}
                              </span>
                              <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                                <span
                                  className={
                                    isToday
                                      ? 'px-2 py-0 rounded bg-slate-900 text-white font-semibold'
                                      : 'font-semibold text-slate-900'
                                  }
                                >
                                  {ddmm}
                                </span>
                                <span className="text-slate-400">·</span>
                                <span className="text-[11px] text-slate-500">
                                  {dayCount} task
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Top Horizontal Multi-Day / Altro AT / All-Day Absence Strip */}
                    {topStripLayout.laneCount > 0 && (
                      <div className="flex border-b border-slate-200 bg-slate-50 shrink-0">
                        <div className="w-16 shrink-0 border-r border-slate-200" />
                        <div
                          className="flex-1 relative py-2"
                          style={{
                            height: `${topStripLayout.laneCount * 28 + 16}px`,
                          }}
                        >
                          {topStripLayout.spans.map((span) => {
                            const colCount = visibleDays.length;
                            const leftPct = (span.startCol / colCount) * 100;
                            const widthPct =
                              ((span.endCol - span.startCol + 1) / colCount) *
                              100;
                            const topPx = 8 + span.lane * 28;

                            if (span.item.kind === 'absence') {
                              const abs = span.item.payload as Absence;
                              const tone = getAbsenceToneClasses(abs.tipo);
                              const techShort = formatShortTechName(
                                abs.technicianName
                              );
                              return (
                                <button
                                  key={span.item.id}
                                  type="button"
                                  onClick={() =>
                                    setAbsenceModalState({
                                      open: true,
                                      existing: abs,
                                    })
                                  }
                                  style={{
                                    left: `calc(${leftPct}% + 4px)`,
                                    width: `calc(${widthPct}% - 8px)`,
                                    top: `${topPx}px`,
                                    height: '24px',
                                  }}
                                  className={`absolute rounded-md border px-2 flex items-center justify-between gap-2 text-[11px] cursor-pointer overflow-hidden ${tone.bar}`}
                                >
                                  <span className="flex items-center gap-2 truncate font-semibold">
                                    {span.continuesBefore && (
                                      <ChevronLeft className="w-3 h-3 shrink-0" />
                                    )}
                                    <span className="truncate">
                                      {formatAbsenceCalendarLabel(abs, {
                                        shortTechName: techShort,
                                        prefixAssenza: true,
                                      })}
                                    </span>
                                  </span>
                                  <span className="flex items-center gap-2 shrink-0 font-mono tabular-nums text-[10px]">
                                    <span>{formatDateIt(abs.inizioMs)}</span>
                                    {span.continuesAfter && (
                                      <ChevronRight className="w-3 h-3 shrink-0" />
                                    )}
                                  </span>
                                </button>
                              );
                            }

                            const asg = span.item.payload as Assignment;
                            const parentTask = tasksById.get(asg.taskId);
                            const squad = resolveSquadDetailsForAssignment({
                              asg,
                              tasksById,
                              assignmentsByTaskId,
                              directoryByEmail,
                              viewerEmail:
                                effectiveViewerEmail || asg.technicianEmail,
                            });
                            const vis = getTaskEventVisualStyle(parentTask, {
                              statusOverride: squad.sharedCalendarStatus,
                              operatorColorLabels: settings.operatorColorLabels,
                              fallbackColorId: asg.colorId,
                            });
                            const isSelected =
                              selectedAssignmentId === asg.assignmentId;
                            const eventTitle = formatCalendarEventTitle(
                              squad.allNames,
                              asg.descrizioneTask
                            );
                            const commessaLabel = parentTask
                              ? formatTaskCommessaLabel(parentTask)
                              : asg.commessa || 'Da revisionare';

                            return (
                              <button
                                key={span.item.id}
                                type="button"
                                onClick={() =>
                                  setSelectedAssignmentId(asg.assignmentId)
                                }
                                style={{
                                  left: `calc(${leftPct}% + 4px)`,
                                  width: `calc(${widthPct}% - 8px)`,
                                  top: `${topPx}px`,
                                  height: '24px',
                                }}
                                className={`absolute rounded-md px-2 flex items-center justify-between gap-2 text-[11px] cursor-pointer overflow-hidden ${vis.cardClassName
                                  } ${isSelected ? 'ring-2 ring-slate-900 z-10' : ''
                                  }`}
                              >
                                <span className="flex items-center gap-2 truncate font-semibold">
                                  {span.continuesBefore && (
                                    <ChevronLeft className="w-3 h-3 shrink-0" />
                                  )}
                                  <span className="truncate">{eventTitle}</span>
                                </span>
                                <span
                                  className={`flex items-center gap-2 shrink-0 font-mono tabular-nums text-[10px] ${vis.subtleMetaClassName}`}
                                >
                                  <span>{commessaLabel}</span>
                                  {span.continuesAfter && (
                                    <ChevronRight className="w-3 h-3 shrink-0" />
                                  )}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* 24-Hour Vertical Scrollable Grid */}
                    <div
                      ref={verticalGridScrollRef}
                      className="flex-1 min-h-0 overflow-y-auto relative"
                    >
                      <div
                        className="flex relative"
                        style={{ height: `${24 * HOUR_HEIGHT_PX}px` }}
                      >
                        {/* Left Hour Gutter */}
                        <div className="w-16 shrink-0 border-r border-slate-200 bg-slate-50 relative select-none">
                          {HOURS_24.map((h) => (
                            <div
                              key={h}
                              style={{ height: `${HOUR_HEIGHT_PX}px` }}
                              className="border-b border-slate-100 pr-2 flex items-start justify-end"
                            >
                              <span className="text-[11px] font-mono tabular-nums text-slate-400">
                                {String(h).padStart(2, '0')}:00
                              </span>
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
                          {visibleDays.map((day, colIdx) => {
                            const dayStart = visibleDayStartsMs[colIdx];
                            const dayEnd = addLocalDaysMs(dayStart, 1);
                            const isToday = isSameDay(day, new Date(nowMs));

                            const verticalAsgs =
                              filteredCalendarAssignments.filter(
                                (a) =>
                                  !isAssignmentInTopStrip(a) &&
                                  assignmentOccursOnDay(a, dayStart)
                              );

                            const hourlyAbsences = visibleAbsences.filter(
                              (ab) =>
                                !isTopStripAbsence(ab) &&
                                ab.inizioMs < dayEnd &&
                                ab.fineMs > dayStart
                            );

                            const {
                              positionedAssignments: positioned,
                              positionedAbsences,
                            } = layoutOverlappingAssignmentsAndAbsences({
                              dayAssignments: verticalAsgs,
                              dayHourlyAbsences: hourlyAbsences,
                              dayStartMs: dayStart,
                              hourHeightPx: HOUR_HEIGHT_PX,
                              minTaskHeightPx: 36,
                              minAbsenceHeightPx: 28,
                            });

                            const nowDate = new Date(nowMs);
                            const nowTopPx =
                              ((nowDate.getHours() * 60 +
                                nowDate.getMinutes()) /
                                60) *
                              HOUR_HEIGHT_PX;

                            return (
                              <div
                                key={dayStart}
                                className="relative h-full bg-white"
                              >
                                {HOURS_24.map((h) => (
                                  <div
                                    key={h}
                                    style={{ height: `${HOUR_HEIGHT_PX}px` }}
                                    className="border-b border-slate-100"
                                  />
                                ))}

                                {isToday && (
                                  <div
                                    style={{ top: `${nowTopPx}px` }}
                                    className="absolute inset-x-0 border-t-2 border-slate-900 z-20 pointer-events-none"
                                  />
                                )}

                                {/* Short Hourly Absences & Commitments (resizable shared lanes in second plane) */}
                                {positionedAbsences.map((ha) => {
                                  const abs = ha.absence;
                                  const tone = getAbsenceToneClasses(abs.tipo);
                                  const isAtRightEdge =
                                    ha.colIndex + ha.colSpan >= ha.totalCols;
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
                                      ha.colSpan * unitPct + overlapBonusPct
                                    );
                                  }

                                  return (
                                    <button
                                      key={abs.absenceId}
                                      type="button"
                                      onClick={() =>
                                        setAbsenceModalState({
                                          open: true,
                                          existing: abs,
                                        })
                                      }
                                      style={{
                                        top: `${ha.topPx + 1}px`,
                                        height: `${Math.max(26, ha.heightPx - 2)}px`,
                                        left: `calc(${leftPct}% + 1.5px)`,
                                        width: `calc(${widthPct}% - 3px)`,
                                        zIndex: 8 + ha.colIndex,
                                        transition:
                                          'transform 140ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                                      }}
                                      className={`absolute rounded-lg border border-dashed p-1.5 text-left overflow-hidden cursor-pointer ring-1 ring-white/90 shadow-xs hover:shadow-md active:scale-[0.985] ${tone.block}`}
                                    >
                                      <p className="text-xs font-semibold leading-tight truncate">
                                        {formatAbsenceCalendarLabel(abs, {
                                          prefixAssenza: true,
                                        })}
                                      </p>
                                      <p className="text-[11px] font-mono tabular-nums opacity-85 truncate">
                                        {formatTimeIt(abs.inizioMs)} –{' '}
                                        {formatTimeIt(abs.fineMs)}
                                      </p>
                                    </button>
                                  );
                                })}

                                {/* Vertical Event Cards (NO "Con: ..." duplicate text) */}
                                {positioned.map((pos) => {
                                  const { asg } = pos;
                                  const parentTask = tasksById.get(asg.taskId);
                                  const squad =
                                    resolveSquadDetailsForAssignment({
                                      asg,
                                      tasksById,
                                      assignmentsByTaskId,
                                      directoryByEmail,
                                      viewerEmail:
                                        effectiveViewerEmail ||
                                        asg.technicianEmail,
                                    });
                                  const vis = getTaskEventVisualStyle(
                                    parentTask,
                                    {
                                      statusOverride:
                                        squad.sharedCalendarStatus,
                                      operatorColorLabels:
                                        settings.operatorColorLabels,
                                      fallbackColorId: asg.colorId,
                                    }
                                  );
                                  const isSelected =
                                    selectedAssignmentId === asg.assignmentId;
                                  const colSpan = pos.colSpan ?? 1;
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
                                      : Math.min(14, unitPct * 0.35);
                                    widthPct = Math.min(
                                      100 - leftPct,
                                      colSpan * unitPct + overlapBonusPct
                                    );
                                  }

                                  const eventTitle = formatCalendarEventTitle(
                                    squad.allNames,
                                    asg.descrizioneTask
                                  );
                                  const commessaLabel = parentTask
                                    ? formatTaskCommessaLabel(parentTask)
                                    : asg.commessa || 'Da revisionare';

                                  return (
                                    <button
                                      key={asg.assignmentId}
                                      type="button"
                                      onClick={() =>
                                        setSelectedAssignmentId(
                                          asg.assignmentId
                                        )
                                      }
                                      style={{
                                        top: `${pos.topPx + 1}px`,
                                        height: `${Math.max(
                                          32,
                                          pos.heightPx - 2
                                        )}px`,
                                        left: `calc(${leftPct}% + 1px)`,
                                        width: `calc(${widthPct}% - 2px)`,
                                        zIndex: isSelected
                                          ? 35
                                          : 15 + pos.colIndex,
                                      }}
                                      className={`absolute rounded-lg p-2 text-left overflow-hidden flex flex-col gap-0 transition-all cursor-pointer ring-1 ring-white/90 dark:ring-slate-900/90 ${vis.cardClassName
                                        } ${isSelected
                                          ? 'ring-2 ring-slate-900 shadow-xl'
                                          : 'shadow-xs hover:shadow-sm'
                                        }`}
                                    >
                                      <p className="text-xs font-semibold leading-snug break-words">
                                        {eventTitle}
                                      </p>
                                      {pos.heightPx >= 52 && (
                                        <p
                                          className={`text-[11px] font-mono tabular-nums leading-tight ${vis.subtleMetaClassName}`}
                                        >
                                          {formatTimeIt(asg.inizioMs)} –{' '}
                                          {formatTimeIt(asg.fineMs)}
                                        </p>
                                      )}
                                      {pos.heightPx >= 72 && (
                                        <p
                                          className={`text-[11px] font-mono tabular-nums leading-tight break-words ${vis.subtleMetaClassName}`}
                                        >
                                          {vis.operatorLabel} · {commessaLabel}
                                        </p>
                                      )}
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

                {/* Month View */}
                {calendarMode === 'month' && (
                  <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 shrink-0">
                      {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(
                        (wd) => (
                          <div
                            key={wd}
                            className="px-2 py-2 text-xs font-semibold text-slate-600 border-r last:border-r-0 border-slate-200"
                          >
                            {wd}
                          </div>
                        )
                      )}
                    </div>
                    <div className="flex-1 min-h-0 grid grid-cols-7 grid-rows-6 divide-x divide-y divide-slate-200 overflow-y-auto">
                      {monthDays.map((day) => {
                        const dStart = startOfDayMs(day);
                        const dEnd = addLocalDaysMs(dStart, 1);
                        const inCurrentMonth =
                          day.getMonth() === anchorDate.getMonth();
                        const isToday = isSameDay(day, new Date(nowMs));

                        const dayAbs = visibleAbsences.filter(
                          (ab) => ab.inizioMs < dEnd && ab.fineMs > dStart
                        );
                        const dayAsgs = filteredCalendarAssignments.filter(
                          (a) => assignmentOccursOnDay(a, dStart)
                        );

                        return (
                          <div
                            key={dStart}
                            className={`p-2 flex flex-col gap-2 min-h-[96px] overflow-hidden ${inCurrentMonth ? 'bg-white' : 'bg-slate-50'
                              }`}
                          >
                            <div className="flex items-center justify-between">
                              <span
                                className={`text-xs font-mono tabular-nums ${isToday
                                    ? 'px-2 py-0 rounded bg-slate-900 text-white font-semibold'
                                    : inCurrentMonth
                                      ? 'font-semibold text-slate-900'
                                      : 'text-slate-400'
                                  }`}
                              >
                                {day.getDate()}
                              </span>
                            </div>

                            <div className="space-y-2 overflow-hidden">
                              {dayAbs.slice(0, 1).map((abs) => {
                                const tone = getAbsenceToneClasses(abs.tipo);
                                return (
                                  <button
                                    key={abs.absenceId}
                                    type="button"
                                    onClick={() =>
                                      setAbsenceModalState({
                                        open: true,
                                        existing: abs,
                                      })
                                    }
                                    className={`w-full rounded px-2 py-0 text-left text-[11px] font-semibold border truncate cursor-pointer ${tone.bar}`}
                                  >
                                    {formatAbsenceCalendarLabel(abs, {
                                      prefixAssenza: true,
                                    })}
                                  </button>
                                );
                              })}

                              {dayAsgs.slice(0, 3).map((asg) => {
                                const parentTask = tasksById.get(asg.taskId);
                                const squad = resolveSquadDetailsForAssignment({
                                  asg,
                                  tasksById,
                                  assignmentsByTaskId,
                                  directoryByEmail,
                                  viewerEmail:
                                    effectiveViewerEmail ||
                                    asg.technicianEmail,
                                });
                                const vis = getTaskEventVisualStyle(
                                  parentTask,
                                  {
                                    statusOverride: squad.sharedCalendarStatus,
                                    operatorColorLabels:
                                      settings.operatorColorLabels,
                                    fallbackColorId: asg.colorId,
                                  }
                                );
                                const title = formatCalendarEventTitle(
                                  squad.allNames,
                                  asg.descrizioneTask
                                );
                                return (
                                  <button
                                    key={asg.assignmentId}
                                    type="button"
                                    onClick={() =>
                                      setSelectedAssignmentId(asg.assignmentId)
                                    }
                                    className={`w-full rounded px-2 py-0 text-left text-[11px] font-semibold truncate cursor-pointer ${vis.cardClassName}`}
                                  >
                                    {formatTimeIt(asg.inizioMs)} {title}
                                  </button>
                                );
                              })}

                              {dayAsgs.length > 3 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setAnchorDate(day);
                                    setCalendarMode('day');
                                  }}
                                  className="w-full px-2 py-0 rounded border border-slate-300 bg-white text-[11px] font-semibold text-slate-700 hover:bg-slate-50 text-left cursor-pointer"
                                >
                                  +{dayAsgs.length - 3} altri
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* List View */}
                {calendarMode === 'list' && (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {filteredCalendarAssignments.length === 0 ? (
                      <div className="p-8 text-center">
                        <p className="text-sm font-semibold text-slate-700">
                          Nessun intervento trovato
                        </p>
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                          <tr className="text-xs font-semibold text-slate-600">
                            <th className="px-4 py-2">Data e orario</th>
                            <th className="px-4 py-2">Commessa</th>
                            <th className="px-4 py-2">Attività e squadra</th>
                            <th className="px-4 py-2">Stato</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 text-xs">
                          {filteredCalendarAssignments.map((asg) => {
                            const parentTask = tasksById.get(asg.taskId);
                            const squad = resolveSquadDetailsForAssignment({
                              asg,
                              tasksById,
                              assignmentsByTaskId,
                              directoryByEmail,
                              viewerEmail:
                                effectiveViewerEmail || asg.technicianEmail,
                            });
                            const commessaLabel = parentTask
                              ? formatTaskCommessaLabel(parentTask)
                              : asg.commessa || 'Da revisionare';
                            const isSelected =
                              selectedAssignmentId === asg.assignmentId;

                            return (
                              <tr
                                key={asg.assignmentId}
                                onClick={() =>
                                  setSelectedAssignmentId(asg.assignmentId)
                                }
                                className={`cursor-pointer transition-colors ${isSelected
                                    ? 'bg-slate-100'
                                    : 'hover:bg-slate-50'
                                  }`}
                              >
                                <td className="px-4 py-2 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                  {formatDateIt(asg.inizioMs)} ·{' '}
                                  {formatTimeIt(asg.inizioMs)}–
                                  {formatTimeIt(asg.fineMs)}
                                </td>
                                <td className="px-4 py-2 font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                                  {commessaLabel}
                                </td>
                                <td className="px-4 py-2 text-slate-900">
                                  <span className="font-semibold">
                                    {formatCalendarEventTitle(
                                      squad.allNames,
                                      asg.descrizioneTask
                                    )}
                                  </span>
                                </td>
                                <td className="px-4 py-2 whitespace-nowrap">
                                  <StatusIndicator status={squad.sharedCalendarStatus} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Section: I miei Task */}
            {section === 'tasks' && (
              <>
                <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 shrink-0">
                  <div className="flex items-center gap-2">
                    {(
                      [
                        {
                          id: 'ACTIVE',
                          label: `Da eseguire · ${personalKpis.todoCount +
                            personalKpis.inProgressCount
                            }`,
                        },
                        {
                          id: 'TODAY',
                          label: `Oggi · ${personalKpis.todayCount}`,
                        },
                        {
                          id: 'COMPLETED',
                          label: `Completati · ${personalKpis.completedCount}`,
                        },
                      ] as const
                    ).map((tab) => {
                      const active = tasksTabFilter === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => setTasksTabFilter(tab.id)}
                          className={`min-h-[36px] px-4 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${active
                              ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                            }`}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative w-64">
                      <Search className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={tasksSearch}
                        onChange={(e) => setTasksSearch(e.target.value)}
                        placeholder="Filtra task..."
                        className="w-full min-h-[36px] pl-8 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={openCreateAutonomousModal}
                      className="inline-flex items-center gap-2 min-h-[36px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Nuovo Task</span>
                    </button>
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {filteredTasksTableRows.length === 0 ? (
                    <div className="p-8 text-center">
                      <p className="text-sm font-semibold text-slate-700">
                        Nessun task presente in questo filtro
                      </p>
                    </div>
                  ) : (
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                        <tr className="text-xs font-semibold text-slate-600">
                          <th className="px-4 py-2">Commessa e codice</th>
                          <th className="px-4 py-2">Data e orario</th>
                          <th className="px-4 py-2">Attività</th>
                          <th className="px-4 py-2">Squadra</th>
                          <th className="px-4 py-2 text-right">Mat · Foto</th>
                          <th className="px-4 py-2">Stato</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-xs">
                        {filteredTasksTableRows.map((asg) => {
                          const parentTask = tasksById.get(asg.taskId);
                          const squad = resolveSquadDetailsForAssignment({
                            asg,
                            tasksById,
                            assignmentsByTaskId,
                            directoryByEmail,
                            viewerEmail:
                              effectiveViewerEmail || asg.technicianEmail,
                          });
                          const matCount = usedMaterials.filter(
                            (m) => m.taskId === asg.taskId
                          ).length;
                          const photoCount = photos.filter(
                            (p) => p.taskId === asg.taskId
                          ).length;
                          const commessaLabel = parentTask
                            ? formatTaskCommessaLabel(parentTask)
                            : asg.commessa || 'Da revisionare';
                          const isSelected =
                            selectedAssignmentId === asg.assignmentId;

                          return (
                            <tr
                              key={asg.assignmentId}
                              onClick={() =>
                                setSelectedAssignmentId(asg.assignmentId)
                              }
                              className={`cursor-pointer transition-colors ${isSelected
                                  ? 'bg-slate-100'
                                  : 'hover:bg-slate-50'
                                }`}
                            >
                              <td className="px-4 py-2 whitespace-nowrap">
                                <p className="font-mono tabular-nums font-semibold text-slate-900">
                                  {commessaLabel}
                                </p>
                                <p className="font-mono tabular-nums text-[11px] text-slate-500">
                                  {parentTask?.taskCode || asg.assignmentCode}
                                </p>
                              </td>
                              <td className="px-4 py-2 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                                {formatDateIt(asg.inizioMs)} ·{' '}
                                {formatTimeIt(asg.inizioMs)}–
                                {formatTimeIt(asg.fineMs)}
                              </td>
                              <td className="px-4 py-2 font-semibold text-slate-900 max-w-md truncate">
                                {asg.descrizioneTask}
                              </td>
                              <td className="px-4 py-2 text-slate-700 whitespace-nowrap">
                                {formatSquadShortNames(squad.allNames)}
                              </td>
                              <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                {matCount} · {photoCount}
                              </td>
                              <td className="px-4 py-2 whitespace-nowrap">
                                <StatusIndicator status={asg.stato} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}

            {/* Section: Catalogo */}
            {section === 'catalog' && (
              <>
                <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 shrink-0">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <div className="relative flex-1 max-w-sm">
                      <Search className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={catalogSearch}
                        onChange={(e) => setCatalogSearch(e.target.value)}
                        placeholder="Cerca codice articolo o descrizione..."
                        className="w-full min-h-[36px] pl-8 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                      />
                    </div>

                    <select
                      value={catalogCategory}
                      onChange={(e) => setCatalogCategory(e.target.value)}
                      className="min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 focus:outline-none focus:border-slate-900"
                      aria-label="Filtra per categoria"
                    >
                      <option value="ALL">Tutte le categorie</option>
                      {articleCategories.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>

                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {filteredCatalogArticles.length} articoli attivi
                  </span>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto">
                  {filteredCatalogArticles.length === 0 ? (
                    <div className="p-8 text-center">
                      <p className="text-sm font-semibold text-slate-700">
                        Nessun articolo trovato
                      </p>
                    </div>
                  ) : (
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
                        <tr className="text-xs font-semibold text-slate-600">
                          <th className="px-4 py-2">Codice</th>
                          <th className="px-4 py-2">Descrizione</th>
                          <th className="px-4 py-2">Categoria</th>
                          <th className="px-4 py-2">U.M.</th>
                          {canAddPhotosAndMaterials && (
                            <th className="px-4 py-2 text-right">Azione</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-xs">
                        {filteredCatalogArticles.map((art) => (
                          <tr
                            key={art.articleId}
                            className="hover:bg-slate-50 transition-colors"
                          >
                            <td className="px-4 py-2 font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                              {art.codiceArticolo}
                            </td>
                            <td className="px-4 py-2 text-slate-900">
                              {art.descrizione}
                            </td>
                            <td className="px-4 py-2 text-slate-600 whitespace-nowrap">
                              {art.categoria}
                            </td>
                            <td className="px-4 py-2 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                              {art.unitaMisura}
                            </td>
                            {canAddPhotosAndMaterials && (
                              <td className="px-4 py-2 text-right whitespace-nowrap">
                                <button
                                  type="button"
                                  disabled={addingArticleId === art.articleId}
                                  onClick={() => handleAddMaterial(art, '1')}
                                  className="inline-flex items-center gap-2 min-h-[32px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer disabled:opacity-50"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  <span>Aggiungi al task</span>
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
            )}
            {section === 'on_call' && (
              <div className="flex-1 min-h-0 overflow-y-auto p-4">
                <OnCallCalendarView />
              </div>
            )}
          </div>

          {/* Right Persistent Inspector Panel */}

          {/* Right Persistent Inspector Panel */}
          <aside className="w-[400px] shrink-0 h-full flex flex-col bg-white border border-slate-200 rounded-xl overflow-hidden">
            {/* Personal 4-Metric Strip */}
            <div className="grid grid-cols-4 divide-x divide-slate-200 border-b border-slate-200 bg-slate-50 shrink-0">
              {[
                { label: 'Oggi', value: personalKpis.todayCount },
                { label: 'Da fare', value: personalKpis.todoCount },
                { label: 'In corso', value: personalKpis.inProgressCount },
                { label: 'Chiusi', value: personalKpis.completedCount },
              ].map((stat) => (
                <div key={stat.label} className="p-2 text-center">
                  <p className="text-[11px] text-slate-500">{stat.label}</p>
                  <p className="text-base font-mono tabular-nums font-semibold text-slate-900">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-200">
              {/* Personal Google Drive Cleanup Banner */}
              {pendingCleanupPhotos.length > 0 && (
                <div className="p-4 bg-slate-50 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <HardDrive className="w-4 h-4 text-slate-700 shrink-0" />
                    <span className="text-xs font-semibold text-slate-900 truncate">
                      {pendingCleanupPhotos.length} copie Drive temporanee
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={cleaningUpDriveFiles}
                    onClick={() => setConfirmCleanupOpen(true)}
                    className="min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 hover:border-slate-400 text-xs font-semibold text-slate-800 whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    {cleaningUpDriveFiles ? 'Pulizia...' : 'Libera spazio'}
                  </button>
                </div>
              )}

              {!selectedAssignment ? (
                <div className="p-6 text-center space-y-2">
                  <p className="text-sm font-semibold text-slate-800">
                    Nessun task selezionato
                  </p>
                </div>
              ) : (
                <>
                  {/* Task Summary & Primary Action (NO "In squadra con..." duplicate line) */}
                  <section className="p-4 space-y-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-slate-500">
                          <span className="font-semibold text-slate-900">
                            {selectedTask?.taskCode ||
                              selectedAssignment.assignmentCode}
                          </span>
                          <span>·</span>
                          <span>
                            {selectedTask
                              ? formatTaskCommessaLabel(selectedTask)
                              : selectedAssignment.commessa || 'Da revisionare'}
                          </span>
                          <span>·</span>
                          <span>
                            {
                              getTaskEventVisualStyle(selectedTask, {
                                statusOverride: selectedAssignment.stato,
                                operatorColorLabels:
                                  settings.operatorColorLabels,
                                fallbackColorId: selectedAssignment.colorId,
                              }).operatorLabel
                            }
                          </span>
                        </div>

                        <h2 className="text-base font-semibold text-slate-900 leading-snug break-words">
                          {selectedAssignment.descrizioneTask}
                        </h2>

                        <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-slate-600">
                          <span>
                            {formatDateTimeIt(selectedAssignment.inizioMs)}
                          </span>
                          <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>
                            {formatDateTimeIt(selectedAssignment.fineMs)}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setSelectedAssignmentId(null)}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0"
                        aria-label="Chiudi dettaglio"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        <StatusIndicator status={selectedAssignment.stato} />
                        {selectedSquad &&
                          selectedSquad.totalCount > 1 &&
                          selectedSquad.sharedCalendarStatus !==
                          selectedAssignment.stato && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>
                                Squadra:{' '}
                                <span className="font-semibold text-slate-900">
                                  {selectedSquad.sharedCalendarStatus}
                                </span>
                              </span>
                            </>
                          )}
                      </div>

                      {!selectedTask?.altroReparto &&
                        Boolean(selectedAssignment.commessa.trim()) &&
                        (isAdmin ||
                          selectedSquad?.sharedCalendarStatus ===
                          'Completato') && (
                          <button
                            type="button"
                            onClick={() => {
                              const draft = buildCompletionDraftForSelected(
                                noteDraft.trim()
                              );
                              if (draft) setEmailDraft(draft);
                            }}
                            className="inline-flex items-center gap-2 min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
                          >
                            <Mail className="w-3.5 h-3.5" />
                            <span>Riepilogo email</span>
                          </button>
                        )}
                    </div>

                    {isOwnSelectedAssignment &&
                      selectedAssignment.stato === 'Assegnato' && (
                        <button
                          type="button"
                          disabled={savingStatus}
                          onClick={handleTakeInCharge}
                          className="w-full min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <Play className="w-4 h-4" />
                          <span>
                            {savingStatus
                              ? 'Aggiornamento...'
                              : 'Prendi in Carico Intervento'}
                          </span>
                        </button>
                      )}

                    {isOwnSelectedAssignment &&
                      selectedAssignment.stato === 'Preso in Carico' && (
                        <button
                          type="button"
                          disabled={savingStatus}
                          onClick={handleCompleteAssignment}
                          className="w-full min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          <span>
                            {savingStatus
                              ? 'Aggiornamento...'
                              : 'Completa Intervento'}
                          </span>
                        </button>
                      )}
                  </section>

                  {/* Squadra Intervento */}
                  {selectedSquad && (
                    <section className="p-4 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-slate-900">
                          Squadra intervento
                        </h3>
                        <span className="text-xs font-mono tabular-nums text-slate-500">
                          {selectedSquad.completedCount}/
                          {selectedSquad.totalCount} completati
                        </span>
                      </div>

                      <div className="divide-y divide-slate-100">
                        {selectedSquad.members.map((m) => (
                          <div
                            key={m.email}
                            className="py-2 flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0">
                              <span className="font-semibold text-slate-900">
                                {m.name}
                              </span>
                              {m.isViewer && (
                                <span className="text-slate-500"> · Tu</span>
                              )}
                            </div>
                            <StatusIndicator status={m.status} />
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* Note Attività */}
                  <section className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-900">
                        Note attività
                      </h3>
                      <span className="text-[11px] text-slate-500">
                        {isSelectedNoteMandatory
                          ? 'Obbligatorie a fine lavori'
                          : 'Opzionali'}
                      </span>
                    </div>

                    <textarea
                      rows={3}
                      maxLength={VALIDATION_LIMITS.NOTE_MAX_LEN}
                      disabled={
                        !isOwnSelectedAssignment ||
                        (!isAdmin &&
                          selectedSquad?.sharedCalendarStatus === 'Completato')
                      }
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                      placeholder="Annota attività eseguite, collaudi o riscontri..."
                      className="w-full p-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900 disabled:bg-slate-50"
                    />

                    {isOwnSelectedAssignment &&
                      (isAdmin ||
                        selectedSquad?.sharedCalendarStatus !==
                        'Completato') && (
                        <div className="flex justify-end">
                          <button
                            type="button"
                            disabled={
                              savingStatus ||
                              noteDraft.trim() ===
                              (selectedAssignment.noteTecnico || '').trim()
                            }
                            onClick={handleSaveNoteOnly}
                            className="min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer disabled:opacity-50"
                          >
                            Salva nota
                          </button>
                        </div>
                      )}
                  </section>

                  {/* Materiali Utilizzati */}
                  <section className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-900">
                        Materiali utilizzati ·{' '}
                        <span className="font-mono tabular-nums font-normal text-slate-500">
                          {selectedTaskMaterials.length}
                        </span>
                      </h3>
                      {canAddPhotosAndMaterials && (
                        <button
                          type="button"
                          onClick={() => setMaterialModalOpen(true)}
                          className="inline-flex items-center gap-2 min-h-[32px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Aggiungi</span>
                        </button>
                      )}
                    </div>

                    {selectedTaskMaterials.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Nessun materiale registrato.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {selectedTaskMaterials.map((mat) => {
                          const editable = canModifyOwnItem(
                            mat.technicianEmail,
                            mat.technicianUid
                          );
                          return (
                            <div
                              key={mat.usedId}
                              className="py-2 flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-semibold text-slate-900 truncate">
                                  <span className="font-mono">
                                    {mat.codiceArticolo}
                                  </span>{' '}
                                  — {mat.descrizioneArticolo}
                                </p>
                                <p className="text-[11px] text-slate-500 truncate">
                                  {mat.technicianName} ·{' '}
                                  <span className="font-mono tabular-nums">
                                    {mat.quantita} {mat.unitaMisura}
                                  </span>
                                </p>
                              </div>

                              {editable && (
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleStepMaterialQty(mat, -1)
                                    }
                                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                                    aria-label="Riduci quantità"
                                  >
                                    <Minus className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleStepMaterialQty(mat, 1)
                                    }
                                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                                    aria-label="Aumenta quantità"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      removeUsedMaterial(mat.usedId)
                                    }
                                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer"
                                    aria-label="Rimuovi materiale"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Foto Attività · Google Drive */}
                  <section className="p-4 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-semibold text-slate-900">
                        Foto attività ·{' '}
                        <span className="font-mono tabular-nums font-normal text-slate-500">
                          {selectedTaskPhotos.length}
                        </span>
                      </h3>
                      <div className="flex items-center gap-2">
                        <a
                          href={selectedDriveFolderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 min-h-[32px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 whitespace-nowrap"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                          <span>Cartella</span>
                        </a>
                        {canAddPhotosAndMaterials && (
                          <button
                            type="button"
                            onClick={() => photoInputRef.current?.click()}
                            className="inline-flex items-center gap-2 min-h-[32px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold cursor-pointer whitespace-nowrap"
                          >
                            <UploadCloud className="w-3.5 h-3.5" />
                            <span>Carica</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = e.target.files
                          ? Array.from(e.target.files)
                          : [];
                        e.target.value = '';
                        if (files.length > 0) {
                          setPendingPhotoFiles(files);
                        }
                      }}
                    />

                    {selectedTaskPhotos.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        Nessuna foto allegata.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {selectedTaskPhotos.map((ph) => {
                          const deletable = canModifyOwnItem(
                            ph.technicianEmail,
                            ph.technicianUid
                          );
                          return (
                            <div
                              key={ph.photoId}
                              className="py-2 flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-mono font-semibold text-slate-900 truncate">
                                  {ph.fileName}
                                </p>
                                <p className="text-[11px] text-slate-500 truncate">
                                  {ph.technicianName}
                                  {ph.caption ? ` · ${ph.caption}` : ''}
                                </p>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <a
                                  href={ph.driveWebViewLink}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400"
                                  aria-label="Apri foto su Google Drive"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </a>
                                {deletable && (
                                  <button
                                    type="button"
                                    onClick={() => setPhotoToDelete(ph)}
                                    className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer"
                                    aria-label="Rimuovi foto"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          </aside>
        </main>
      </div>

      {/* Autonomous Task Creation Modal */}
      {autonomousModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auto-task-modal-title"
        >
          <form
            onSubmit={handleCreateAutonomousTask}
            className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 p-6 space-y-4 animate-fluid-pop shadow-xl"
          >
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <h3
                id="auto-task-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                Nuovo task autonomo
              </h3>
              <button
                type="button"
                disabled={creatingAutoTask}
                onClick={() => setAutonomousModalOpen(false)}
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                aria-label="Chiudi finestra"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                Descrizione attività *
              </label>
              <textarea
                rows={3}
                required
                maxLength={VALIDATION_LIMITS.TASK_DESC_MAX_LEN}
                value={autoDesc}
                onChange={(e) => setAutoDesc(e.target.value)}
                placeholder="Descrivi l'intervento ed eventuale numero TK..."
                className="w-full p-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:border-slate-900"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Inizio *
                </label>
                <input
                  type="datetime-local"
                  required
                  value={autoStartIso}
                  onChange={(e) => setAutoStartIso(e.target.value)}
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Fine *
                </label>
                <input
                  type="datetime-local"
                  required
                  value={autoEndIso}
                  onChange={(e) => setAutoEndIso(e.target.value)}
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={creatingAutoTask}
                onClick={() => setAutonomousModalOpen(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={creatingAutoTask}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold cursor-pointer disabled:opacity-50"
              >
                {creatingAutoTask ? 'Creazione...' : 'Crea e prendi in carico'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Material Picker Modal */}
      {materialModalOpen && selectedAssignment && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tech-web-mat-modal-title"
        >
          <div className="w-full max-w-2xl rounded-2xl bg-white border border-slate-200 flex flex-col max-h-[85vh] overflow-hidden animate-fluid-pop shadow-xl">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
              <h3
                id="tech-web-mat-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                Aggiungi materiale al task
              </h3>
              <button
                type="button"
                onClick={() => setMaterialModalOpen(false)}
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                aria-label="Chiudi catalogo"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center gap-2 shrink-0">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={materialSearch}
                  onChange={(e) => setMaterialSearch(e.target.value)}
                  placeholder="Cerca codice o descrizione..."
                  className="w-full min-h-[36px] pl-8 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-xs text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
              <select
                value={materialCategory}
                onChange={(e) => setMaterialCategory(e.target.value)}
                className="min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 focus:outline-none focus:border-slate-900"
              >
                <option value="ALL">Tutte le categorie</option>
                {articleCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-200">
              {filteredModalArticles.map((art) => {
                const qtyVal = materialQtyByArticle[art.articleId] ?? '1';
                return (
                  <div
                    key={art.articleId}
                    className="p-4 flex items-center justify-between gap-4 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900">
                        <span className="font-mono">{art.codiceArticolo}</span>{' '}
                        — {art.descrizione}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {art.categoria} · {art.unitaMisura}
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="number"
                        min="0.1"
                        step="any"
                        value={qtyVal}
                        onChange={(e) =>
                          setMaterialQtyByArticle((prev) => ({
                            ...prev,
                            [art.articleId]: e.target.value,
                          }))
                        }
                        className="w-20 min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-right text-slate-900 focus:outline-none focus:border-slate-900"
                        aria-label={`Quantità ${art.codiceArticolo}`}
                      />
                      <button
                        type="button"
                        disabled={addingArticleId === art.articleId}
                        onClick={() => handleAddMaterial(art, qtyVal)}
                        className="min-h-[36px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 hover:bg-slate-800 text-xs font-semibold cursor-pointer disabled:opacity-50"
                      >
                        Aggiungi
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Absence Modal */}
      <AbsenceModal
        open={absenceModalState.open}
        existingAbsence={absenceModalState.existing}
        isAdminActor={isAdmin}
        actorUid={profile?.uid || ''}
        selfTechnician={selfTechForAbsence}
        availableTechnicians={activeStaffMembers}
        preselectedTechEmail={selfTechForAbsence.email}
        initialDateMs={absenceModalState.initialDateMs}
        knownAdminUids={knownAdminUids}
        onClose={() => setAbsenceModalState({ open: false, existing: null })}
        onSaved={(msg) => showToast(msg, 'success')}
        onError={(msg) => showToast(msg, 'error')}
      />

      {/* Multi-Photo Upload Modal */}
      <MultiPhotoUploadModal
        open={pendingPhotoFiles.length > 0}
        files={pendingPhotoFiles}
        driveFolderPath={
          selectedAssignment
            ? formatTaskDriveSubfolderName(
              selectedAssignment.commessa,
              selectedTask?.taskCode || selectedAssignment.assignmentCode
            )
            : ''
        }
        caption={photoCaptionDraft}
        onCaptionChange={setPhotoCaptionDraft}
        onRemoveFile={(idx) =>
          setPendingPhotoFiles((prev) => prev.filter((_, i) => i !== idx))
        }
        onAppendFiles={(extra) =>
          setPendingPhotoFiles((prev) => [...prev, ...extra])
        }
        onConfirm={handleConfirmPhotoBatchUpload}
        onCancel={() => {
          if (!uploadingPhotos) {
            setPendingPhotoFiles([]);
            setPhotoCaptionDraft('');
          }
        }}
        uploading={uploadingPhotos}
        progress={uploadProgress}
        technicianLabel={selectedAssignment?.technicianName}
      />

      {/* Delete Photo Confirmation */}
      <ConfirmModal
        open={Boolean(photoToDelete)}
        title="Rimuovi foto dal task"
        description={
          photoToDelete
            ? `Confermi la rimozione di "${photoToDelete.fileName}" dall'elenco foto dell'intervento?`
            : ''
        }
        confirmLabel="Rimuovi foto"
        destructive
        loading={deletingPhoto}
        onConfirm={handleConfirmDeletePhoto}
        onCancel={() => setPhotoToDelete(null)}
      />

      {/* Personal Drive Space Cleanup Confirmation */}
      <ConfirmModal
        open={confirmCleanupOpen}
        title="Libera spazio Google Drive personale"
        description={`Le ${pendingCleanupPhotos.length} foto sono già archiviate nella cartella centrale SITE. Vuoi rimuovere le copie temporanee dal tuo Google Drive personale?`}
        confirmLabel="Libera spazio"
        loading={cleaningUpDriveFiles}
        onConfirm={async () => {
          await cleanupMySupersededDrivePhotos();
          setConfirmCleanupOpen(false);
        }}
        onCancel={() => setConfirmCleanupOpen(false)}
      />

      {/* Completion / Summary Email Modal */}
      <EmailNotificationModal
        draft={emailDraft}
        onClose={() => setEmailDraft(null)}
      />
    </div>
  );
};
