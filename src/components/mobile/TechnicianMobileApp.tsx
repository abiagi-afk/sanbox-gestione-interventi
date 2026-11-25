import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Calendar,
  CalendarOff,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  ExternalLink,
  HardDrive,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  LogOut,
  Mail,
  Minus,
  Monitor,
  PackagePlus,
  PhoneCall,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
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
  formatCalendarEventTitle,
  formatDateIt,
  formatShortTechName,
  formatSquadShortNames,
  formatTimeIt,
} from '../../lib/exportUtils';
import {
  countTouchedSolarDays,
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
} from '../../lib/calendarLayout';
import {
  assignmentOccursOnDay,
  formatMinutesAsHHMM,
  getMonthCalendarDays,
  getStartOfWeek,
  getWeekdayShortIt,
  isSameDay,
  layoutOverlappingAssignmentsAndAbsences,
  resolveSquadDetailsForAssignment,
  startOfDayMs,
  toLocalDateTimeInputValue,
} from '../../lib/technicianShared';
import {
  Absence,
  areSameTechnicianEmails,
  Assignment,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  extractDriveFolderId,
  findStaffMemberByAnyEmail,
  isAssignmentOwnedByViewer,
  resolveOnCallSummaryForDate,
  MASTER_DRIVE_OWNER_EMAIL,
  StaffMember,
  Task,
  VALIDATION_LIMITS,
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
import { OnCallCalendarView } from '../OnCallCalendarView';

type MobileTab = 'calendar' | 'on_call' | 'agenda' | 'catalog';
type SmartphoneCalMode = '3days' | 'week' | 'month' | 'day';

const PHONE_HOUR_HEIGHT = 48;
const PHONE_TOTAL_GRID_HEIGHT = 24 * PHONE_HOUR_HEIGHT;

interface TechnicianMobileAppProps {
  onExitSmartphonePreview?: () => void;
}

export const TechnicianMobileApp: React.FC<TechnicianMobileAppProps> = ({
  onExitSmartphonePreview,
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

  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState(false);

  // Autonomous Task Creation Modal State
  const [autonomousModalOpen, setAutonomousModalOpen] = useState(false);
  const [autoDescrizione, setAutoDescrizione] = useState('');
  const [autoInizioLocal, setAutoInizioLocal] = useState('');
  const [autoFineLocal, setAutoFineLocal] = useState('');
  const [creatingAutonomous, setCreatingAutonomous] = useState(false);

  // Absence Modal State
  const [absenceModalOpen, setAbsenceModalOpen] = useState(false);
  const [editingAbsence, setEditingAbsence] = useState<Absence | null>(null);

  // Smartphone-first defaults: Calendar tab active on 3-Day view
  const [activeTab, setActiveTab] = useState<MobileTab>('calendar');
  const [calMode, setCalMode] = useState<SmartphoneCalMode>('3days');
  const [monthDrawerOpen, setMonthDrawerOpen] = useState(false);

  const [agendaFilter, setAgendaFilter] = useState<
    'open' | 'today' | 'completed'
  >('open');
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<
    string | null
  >(null);

  // Admin-only preview selector when testing Mobile View
  const [adminPreviewTechEmail, setAdminPreviewTechEmail] =
    useState<string>('AUTO');

  const [calendarDate, setCalendarDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  // Live current-time indicator tick
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  // Auto-scroll timeline to 07:30 on open or view switch
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeTab === 'calendar' && calMode !== 'month') {
      const el = timelineScrollRef.current;
      if (el) {
        el.scrollTop = Math.round(7.5 * PHONE_HOUR_HEIGHT);
      }
    }
  }, [activeTab, calMode]);

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Catalog search
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogCategory, setCatalogCategory] = useState('ALL');

  // Active intervention note draft
  const [noteDraft, setNoteDraft] = useState('');
  const [updatingStatus, setUpdatingStatus] = useState(false);

  // Add Material Bottom Sheet
  const [materialSheetOpen, setMaterialSheetOpen] = useState(false);
  const [sheetCategory, setSheetCategory] = useState('ALL');
  const [sheetSearch, setSheetSearch] = useState('');
  const [sheetArticleId, setSheetArticleId] = useState('');
  const [sheetQty, setSheetQty] = useState(1);
  const [savingMaterial, setSavingMaterial] = useState(false);

  // Photo Capture & Multi-Photo Batch Upload Confirmation
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingPhotoFiles, setPendingPhotoFiles] = useState<File[]>([]);
  const [photoCaption, setPhotoCaption] = useState('');
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUploadProgress, setPhotoUploadProgress] =
    useState<BatchPhotoUploadProgress | null>(null);

  // Gmail Notification Modal
  const [emailDraft, setEmailDraft] = useState<EmailDraftConfig | null>(null);
  // Gestione tasto / gesto "Indietro" su Smartphone Android (evita chiusura accidentale PWA)
  const backStateRef = useRef({
    confirmCleanupOpen,
    autonomousModalOpen,
    absenceModalOpen,
    materialSheetOpen,
    hasPendingPhotos: pendingPhotoFiles.length > 0,
    hasEmailDraft: Boolean(emailDraft),
    monthDrawerOpen,
    selectedAssignmentId,
    activeTab,
  });

  useEffect(() => {
    backStateRef.current = {
      confirmCleanupOpen,
      autonomousModalOpen,
      absenceModalOpen,
      materialSheetOpen,
      hasPendingPhotos: pendingPhotoFiles.length > 0,
      hasEmailDraft: Boolean(emailDraft),
      monthDrawerOpen,
      selectedAssignmentId,
      activeTab,
    };
  }, [
    confirmCleanupOpen,
    autonomousModalOpen,
    absenceModalOpen,
    materialSheetOpen,
    pendingPhotoFiles.length,
    emailDraft,
    monthDrawerOpen,
    selectedAssignmentId,
    activeTab,
  ]);

  const lastBackPressAtRef = useRef<number>(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Inserisce uno stato sentinella all'ingresso dell'app mobile
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
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.materialSheetOpen) {
        setMaterialSheetOpen(false);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.autonomousModalOpen) {
        setAutonomousModalOpen(false);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.absenceModalOpen) {
        setAbsenceModalOpen(false);
        setEditingAbsence(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.confirmCleanupOpen) {
        setConfirmCleanupOpen(false);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }
      if (s.monthDrawerOpen) {
        setMonthDrawerOpen(false);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }

      // 2. Chiude il dettaglio intervento e torna alla vista precedente
      if (s.selectedAssignmentId) {
        setSelectedAssignmentId(null);
        window.history.pushState({ siteMobileGuard: true }, '');
        return;
      }

      // 3. Se si trova in Agenda, Reperibilità o Catalogo, torna al Calendario principale
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

  const { visibleAssignments, isShowingMultiTechAdminPreview } = useMemo(() => {
    if (!profile) {
      return {
        visibleAssignments: [] as Assignment[],
        isShowingMultiTechAdminPreview: false,
      };
    }
    const activeAll = assignments.filter((a) => a.stato !== 'Annullato');
    const own = activeAll.filter((a) =>
      isAssignmentOwnedByViewer(a, profile.email, profile.uid, directory)
    );

    if (profile.role !== 'admin') {
      return { visibleAssignments: own, isShowingMultiTechAdminPreview: false };
    }

    if (adminPreviewTechEmail === 'ALL') {
      return {
        visibleAssignments: activeAll,
        isShowingMultiTechAdminPreview: true,
      };
    }
    if (adminPreviewTechEmail !== 'AUTO') {
      return {
        visibleAssignments: activeAll.filter((a) =>
          isAssignmentOwnedByViewer(a, adminPreviewTechEmail, undefined, directory)
        ),
        isShowingMultiTechAdminPreview: false,
      };
    }

    if (own.length > 0) {
      return { visibleAssignments: own, isShowingMultiTechAdminPreview: false };
    }
    return {
      visibleAssignments: activeAll,
      isShowingMultiTechAdminPreview: true,
    };
  }, [assignments, profile, adminPreviewTechEmail, directory]);

  // Handle deep-link task open
  useEffect(() => {
    if (!pendingOpenTaskId) return;
    const match = visibleAssignments.find((a) => a.taskId === pendingOpenTaskId);
    if (match) {
      setSelectedAssignmentId(match.assignmentId);
      setNoteDraft(match.noteTecnico || '');
      clearPendingOpenTask();
    }
  }, [pendingOpenTaskId, visibleAssignments, clearPendingOpenTask]);

  const tasksById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) {
      map.set(t.taskId, t);
    }
    return map;
  }, [tasks]);

  const assignmentsByTaskId = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const a of assignments) {
      if (a.stato === 'Annullato') continue;
      const existing = map.get(a.taskId);
      if (existing) {
        existing.push(a);
      } else {
        map.set(a.taskId, [a]);
      }
    }
    return map;
  }, [assignments]);

  const directoryByEmail = useMemo(() => {
    const map = new Map<string, StaffMember>();
    for (const member of directory) {
      map.set(member.email.trim().toLowerCase(), member);
      if (member.secondaryEmail?.trim()) {
        map.set(member.secondaryEmail.trim().toLowerCase(), member);
      }
    }
    return map;
  }, [directory]);

  const calendarAssignments = useMemo(() => {
    if (!isShowingMultiTechAdminPreview) return visibleAssignments;
    const seenTasks = new Set<string>();
    const deduped: Assignment[] = [];
    for (const a of visibleAssignments) {
      if (seenTasks.has(a.taskId)) continue;
      seenTasks.add(a.taskId);
      deduped.push(a);
    }
    return deduped;
  }, [visibleAssignments, isShowingMultiTechAdminPreview]);

  const visibleAbsences = useMemo(() => {
    if (!profile) return [] as Absence[];
    const ownEmail = profile.email.toLowerCase();
    if (profile.role !== 'admin') {
      return absences.filter(
        (ab) =>
          Boolean(
            (profile.uid && ab.technicianUid === profile.uid) ||
            areSameTechnicianEmails(ab.technicianEmail, ownEmail, directory)
          )
      );
    }
    if (adminPreviewTechEmail === 'ALL') {
      return absences;
    }
    if (adminPreviewTechEmail !== 'AUTO') {
      return absences.filter((ab) =>
        areSameTechnicianEmails(
          ab.technicianEmail,
          adminPreviewTechEmail,
          directory
        )
      );
    }
    const ownAsgs = assignments.some(
      (a) =>
        a.stato !== 'Annullato' &&
        isAssignmentOwnedByViewer(a, ownEmail, profile.uid, directory)
    );
    if (ownAsgs) {
      return absences.filter(
        (ab) =>
          Boolean(
            (profile.uid && ab.technicianUid === profile.uid) ||
            areSameTechnicianEmails(ab.technicianEmail, ownEmail, directory)
          )
      );
    }
    return absences;
  }, [absences, assignments, profile, adminPreviewTechEmail, directory]);

  const openNewAutonomousTaskModal = () => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    const startMs = now.getTime();
    const endMs = startMs + 2 * 3600000;
    setAutoDescrizione('');
    setAutoInizioLocal(toLocalDateTimeInputValue(startMs));
    setAutoFineLocal(toLocalDateTimeInputValue(endMs));
    setAutonomousModalOpen(true);
  };

  const handleCreateAutonomousTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setCreatingAutonomous(true);
    try {
      const autonomousCount = tasks.filter(
        (t) => t.createdByRole === 'technician'
      ).length;
      const selfStaff = findStaffMemberByAnyEmail(profile.email, directory);
      const officialFullName = selfStaff
        ? `${selfStaff.nome} ${selfStaff.cognome}`.trim()
        : `${profile.nome} ${profile.cognome}`.trim();
      const res = await createAutonomousTechnicianTask({
        descrizione: autoDescrizione,
        inizioIso: autoInizioLocal,
        fineIso: autoFineLocal,
        technicianUid: profile.uid,
        technicianEmail: profile.email,
        technicianDeliverableEmail: currentUserReplyToEmail || profile.email,
        technicianFullName: officialFullName,
        knownAdminUids,
        activeAdminEmails,
        existingAutonomousCount: autonomousCount,
        directory,
      });
      setAutonomousModalOpen(false);
      setNoteDraft('');
      setSelectedAssignmentId(res.assignmentId);
      showToast(
        `Task ${res.taskCode} creato e preso in carico. In attesa di commessa da Admin.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore creazione task autonomo.',
        'error'
      );
    } finally {
      setCreatingAutonomous(false);
    }
  };

  const getSquadDetailsForAssignment = (asg: Assignment) => {
    const viewerEmail = isShowingMultiTechAdminPreview
      ? (profile?.email || '').trim().toLowerCase()
      : asg.technicianEmail.trim().toLowerCase();
    return resolveSquadDetailsForAssignment({
      asg,
      tasksById,
      assignmentsByTaskId,
      directoryByEmail,
      viewerEmail,
    });
  };

  const todayCount = useMemo(
    () =>
      visibleAssignments.filter((a) =>
        assignmentOccursOnDay(a, startOfDayMs(nowTick))
      ).length,
    [visibleAssignments, nowTick]
  );
  const assignedCount = useMemo(
    () => visibleAssignments.filter((a) => a.stato === 'Assegnato').length,
    [visibleAssignments]
  );
  const inProgressCount = useMemo(
    () => visibleAssignments.filter((a) => a.stato === 'Preso in Carico').length,
    [visibleAssignments]
  );
  const completedCount = useMemo(
    () => visibleAssignments.filter((a) => a.stato === 'Completato').length,
    [visibleAssignments]
  );

  const filteredAgenda = useMemo(() => {
    const todayMs = startOfDayMs(nowTick);
    return visibleAssignments.filter((a) => {
      if (agendaFilter === 'open') {
        return a.stato === 'Assegnato' || a.stato === 'Preso in Carico';
      }
      if (agendaFilter === 'today') {
        return assignmentOccursOnDay(a, todayMs);
      }
      return a.stato === 'Completato';
    });
  }, [visibleAssignments, agendaFilter, nowTick]);

  const selectedAssignment = useMemo(
    () =>
      assignments.find((a) => a.assignmentId === selectedAssignmentId) || null,
    [assignments, selectedAssignmentId]
  );

  const selectedParentTask = useMemo(
    () =>
      selectedAssignment
        ? tasks.find((t) => t.taskId === selectedAssignment.taskId) || null
        : null,
    [tasks, selectedAssignment]
  );

  const siblingAssignments = useMemo(
    () =>
      selectedAssignment
        ? assignments.filter((a) => a.taskId === selectedAssignment.taskId)
        : [],
    [assignments, selectedAssignment]
  );

  const assignmentMaterials = useMemo(
    () =>
      selectedAssignment
        ? usedMaterials.filter((m) => m.taskId === selectedAssignment.taskId)
        : [],
    [usedMaterials, selectedAssignment]
  );

  const assignmentPhotos = useMemo(
    () =>
      selectedAssignment
        ? photos.filter((p) => p.taskId === selectedAssignment.taskId)
        : [],
    [photos, selectedAssignment]
  );

  const openAssignmentDetail = (asg: Assignment) => {
    setSelectedAssignmentId(asg.assignmentId);
    setNoteDraft(asg.noteTecnico || '');
  };

  const isSelectedAltroReparto = Boolean(selectedParentTask?.altroReparto);
  const isSelectedPendingReview = Boolean(
    selectedParentTask?.pendingAdminReview ||
    (!isSelectedAltroReparto &&
      selectedAssignment &&
      !selectedAssignment.commessa.trim())
  );

  const isCommessaExempt = useMemo(() => {
    if (!selectedAssignment) return false;
    if (isSelectedAltroReparto) return true;
    const clean = selectedAssignment.commessa.trim().toUpperCase();
    if (!clean) return false;
    return settings.exemptCommesse
      .map((c) => c.trim().toUpperCase())
      .includes(clean);
  }, [selectedAssignment, isSelectedAltroReparto, settings.exemptCommesse]);

  const handleTransitionStatus = async (
    targetStatus: 'Preso in Carico' | 'Completato',
    onlySaveNote = false
  ) => {
    if (!profile || !selectedAssignment) return;

    const cleanNote = noteDraft.trim();
    if (!onlySaveNote && targetStatus === 'Completato') {
      if (profile.role !== 'admin' && !isCommessaExempt && !cleanNote) {
        const commessaHint = selectedAssignment.commessa.trim()
          ? `sulla commessa ${selectedAssignment.commessa.trim()}`
          : 'per chiudere il task';
        showToast(
          `Le Note attività sono obbligatorie ${commessaHint}.`,
          'error'
        );
        return;
      }
    }

    setUpdatingStatus(true);
    try {
      const res = await updateAssignmentStatusAndNotes({
        assignment: selectedAssignment,
        siblingAssignments,
        parentTask: selectedParentTask || undefined,
        newStatus: onlySaveNote ? selectedAssignment.stato : targetStatus,
        noteTecnico: noteDraft,
        exemptCommesse: settings.exemptCommesse,
        isAltroReparto: isSelectedAltroReparto,
        actorUid: profile.uid,
        actorEmail: profile.email,
        isAdminActor: profile.role === 'admin',
        directory,
      });

      if (onlySaveNote) {
        showToast('Note attività salvate.', 'success');
        return;
      }

      if (targetStatus === 'Preso in Carico') {
        showToast('Intervento preso in carico.', 'success');
        return;
      }

      if (
        res.taskBecameCompleted &&
        !isSelectedPendingReview &&
        !isSelectedAltroReparto
      ) {
        const activeSiblings = siblingAssignments.filter(
          (s) => s.stato !== 'Annullato'
        );
        const effectiveSquad =
          activeSiblings.length > 0 ? activeSiblings : [selectedAssignment];
        const effectiveTask = res.authoritativeTask || selectedParentTask;
        const completedByName =
          `${profile.nome} ${profile.cognome}`.trim() ||
          selectedAssignment.technicianName;

        const summary = buildTaskCompletionEmailSummary({
          task: effectiveTask,
          completedByName,
          completedByReplyToEmail: currentUserReplyToEmail,
          commessa: selectedAssignment.commessa,
          taskCode:
            effectiveTask?.taskCode || selectedAssignment.assignmentCode,
          descrizioneTask: selectedAssignment.descrizioneTask,
          inizioMs: selectedAssignment.inizioMs,
          fineMs: selectedAssignment.fineMs,
          squadAssignments: effectiveSquad,
          overrideNoteByAssignmentId: {
            [selectedAssignment.assignmentId]: cleanNote,
          },
          overrideNotesByEmail: res.squadNotesByEmail,
          taskMaterials: assignmentMaterials,
          taskPhotos: assignmentPhotos,
          activeAdminEmails,
          resolveDeliverableEmail,
          directory,
          masterFolderId: settings.driveSharedFolderId,
        });

        setEmailDraft({
          ...summary,
          modalTitle: 'Invia riepilogo completamento',
          submitLabel: 'Invia riepilogo email',
        });
        showToast(
          'Intervento chiuso da tutta la squadra. Invia il riepilogo email.',
          'success'
        );
      } else if (isSelectedPendingReview && res.nextTaskStatus === 'Completato') {
        showToast(
          'Task completato. La mail partirà dopo la revisione Admin.',
          'success'
        );
      } else if (res.nextTaskStatus !== 'Completato') {
        showToast(
          `Quota personale completata (${res.completedCount}/${res.totalSquadCount}). Il riepilogo email si aprirà all’ultimo collega che chiude il task.`,
          'success'
        );
      } else {
        showToast('Intervento completato con successo.', 'success');
      }
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore aggiornamento intervento.',
        'error'
      );
    } finally {
      setUpdatingStatus(false);
    }
  };

  const activeArticles = useMemo(
    () => articles.filter((a) => a.active),
    [articles]
  );

  const distinctCategories = useMemo(
    () =>
      Array.from(new Set(activeArticles.map((a) => a.categoria))).sort((a, b) =>
        a.localeCompare(b, 'it')
      ),
    [activeArticles]
  );

  const sheetFilteredArticles = useMemo(() => {
    const q = sheetSearch.trim().toLowerCase();
    return activeArticles.filter((a) => {
      if (sheetCategory !== 'ALL' && a.categoria !== sheetCategory) {
        return false;
      }
      if (!q) return true;
      return (
        a.codiceArticolo.toLowerCase().includes(q) ||
        a.descrizione.toLowerCase().includes(q)
      );
    });
  }, [activeArticles, sheetCategory, sheetSearch]);

  const handleConfirmAddMaterial = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile || !selectedAssignment) return;
    const art = activeArticles.find((a) => a.articleId === sheetArticleId);
    if (!art) {
      showToast('Seleziona un articolo dalla lista.', 'error');
      return;
    }
    setSavingMaterial(true);
    try {
      await addUsedMaterialToAssignment({
        assignment: selectedAssignment,
        article: art,
        quantita: sheetQty,
        actorUid: profile.uid,
        squadEmails: selectedParentTask?.assignedEmails,
        directory,
      });
      showToast(`${art.codiceArticolo} aggiunto ai materiali usati.`, 'success');
      setMaterialSheetOpen(false);
      setSheetArticleId('');
      setSheetQty(1);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore inserimento materiale.',
        'error'
      );
    } finally {
      setSavingMaterial(false);
    }
  };

  const handleConfirmPhotoUpload = async () => {
    if (!profile || !selectedAssignment || pendingPhotoFiles.length === 0) return;
    setUploadingPhoto(true);
    setPhotoUploadProgress({
      current: 1,
      total: pendingPhotoFiles.length,
      fileName: pendingPhotoFiles[0].name,
    });
    try {
      const accessToken = await connectGoogleWorkspace();
      const taskCode =
        selectedParentTask?.taskCode || selectedAssignment.assignmentCode;

      const { uploadedCount, failedFiles } =
        await uploadMultipleInterventionPhotosToDrive({
          accessToken,
          files: pendingPhotoFiles,
          masterFolderId: settings.driveSharedFolderId,
          commessa: selectedAssignment.commessa,
          taskCode,
          uploaderEmail: profile.email,
          onProgress: (prog) => setPhotoUploadProgress(prog),
          onFileUploaded: async (uploaded) => {
            await recordInterventionPhoto({
              assignment: selectedAssignment,
              actorUid: profile.uid,
              fileName: uploaded.fileName,
              driveFileId: uploaded.driveFileId,
              driveWebViewLink: uploaded.driveWebViewLink,
              driveThumbnailLink: uploaded.driveThumbnailLink,
              folderPath: uploaded.folderPath,
              driveSubfolderId: uploaded.driveSubfolderId,
              ownerConsolidated: uploaded.ownerConsolidated,
              squadEmails: selectedParentTask?.assignedEmails,
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
        err instanceof Error ? err.message : 'Errore caricamento su Drive.',
        'error'
      );
    } finally {
      setUploadingPhoto(false);
      setPhotoUploadProgress(null);
    }
  };

  // Smartphone Calendar Days Calculation
  const threeDays = useMemo(() => {
    return Array.from({ length: 3 }, (_, idx) => {
      const d = new Date(calendarDate);
      d.setDate(calendarDate.getDate() + idx);
      d.setHours(0, 0, 0, 0);
      return d;
    });
  }, [calendarDate]);

  const weekDays = useMemo(() => {
    const start = getStartOfWeek(calendarDate);
    return Array.from({ length: 7 }, (_, idx) => {
      const d = new Date(start);
      d.setDate(start.getDate() + idx);
      return d;
    });
  }, [calendarDate]);

  const monthDays = useMemo(
    () => getMonthCalendarDays(calendarDate),
    [calendarDate]
  );

  const timelineDays = useMemo(() => {
    if (calMode === '3days') return threeDays;
    if (calMode === 'week') return weekDays;
    return [calendarDate];
  }, [calMode, threeDays, weekDays, calendarDate]);

  const stepCalendar = (direction: -1 | 1, forceMonth = false) => {
    setCalendarDate((prev) => {
      const next = new Date(prev);
      if (forceMonth || calMode === 'month') {
        next.setMonth(prev.getMonth() + direction, 1);
      } else if (calMode === 'week') {
        next.setDate(prev.getDate() + direction * 7);
      } else if (calMode === '3days') {
        next.setDate(prev.getDate() + direction * 3);
      } else {
        next.setDate(prev.getDate() + direction);
      }
      next.setHours(0, 0, 0, 0);
      return next;
    });
  };

  const handleCalendarTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };

  const handleCalendarTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - touchStartRef.current.x;
    const dy = t.clientY - touchStartRef.current.y;
    touchStartRef.current = null;

    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      stepCalendar(dx < 0 ? 1 : -1);
    }
  };

  const monthYearLabel = useMemo(() => {
    const formatted = new Intl.DateTimeFormat('it-IT', {
      month: 'long',
      year: 'numeric',
    }).format(calendarDate);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }, [calendarDate]);

  const techWeekBadge = useMemo(() => {
    if (calMode === 'month') {
      return formatCalendarWeekBadgeIt([
        new Date(calendarDate.getFullYear(), calendarDate.getMonth(), 1),
        new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 0),
      ]);
    }
    return formatCalendarWeekBadgeIt(timelineDays);
  }, [calMode, calendarDate, timelineDays]);

  const timelineDayStartsMs = useMemo(
    () => timelineDays.map((d) => startOfDayMs(d)),
    [timelineDays]
  );

  const { topStripAssignments, verticalGridAssignments } = useMemo(() => {
    const top: Assignment[] = [];
    const vertical: Assignment[] = [];
    for (const asg of calendarAssignments) {
      const parent = tasksById.get(asg.taskId);
      const goesTop = parent
        ? isTopStripTask(parent)
        : countTouchedSolarDays(asg.inizioMs, asg.fineMs) >= 3;
      if (goesTop) {
        top.push(asg);
      } else {
        vertical.push(asg);
      }
    }
    return { topStripAssignments: top, verticalGridAssignments: vertical };
  }, [calendarAssignments, tasksById]);

  const { topStripAbsences, hourlyGridAbsences } = useMemo(() => {
    const top: Absence[] = [];
    const hourly: Absence[] = [];
    for (const ab of visibleAbsences) {
      if (isTopStripAbsence(ab)) {
        top.push(ab);
      } else {
        hourly.push(ab);
      }
    }
    return { topStripAbsences: top, hourlyGridAbsences: hourly };
  }, [visibleAbsences]);

  const packedMobileTopStrip = useMemo(() => {
    const items: HorizontalStripItem<Assignment | Absence>[] = [
      ...topStripAbsences.map((ab) => ({
        id: `abs_${ab.absenceId}`,
        kind: 'absence' as const,
        inizioMs: ab.inizioMs,
        fineMs: ab.fineMs,
        payload: ab,
      })),
      ...topStripAssignments.map((asg) => ({
        id: `asg_${asg.assignmentId}`,
        kind: 'task' as const,
        inizioMs: asg.inizioMs,
        fineMs: asg.fineMs,
        payload: asg,
      })),
    ];
    return packHorizontalStripSpans(items, timelineDayStartsMs);
  }, [topStripAbsences, topStripAssignments, timelineDayStartsMs]);

  const hours24 = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);
  const nowDate = new Date(nowTick);
  const nowMinutesOfDay = nowDate.getHours() * 60 + nowDate.getMinutes();
  const isAnchorToday = isSameDay(calendarDate.getTime(), nowTick);

  // -------------------------------------------------------------------------
  // Detail View for Selected Intervention (Mobile Ergonomic Full View)
  // -------------------------------------------------------------------------
  if (selectedAssignment) {
    const detailSquad = getSquadDetailsForAssignment(selectedAssignment);
    const isLockedForTech =
      selectedAssignment.stato === 'Completato' && profile?.role !== 'admin';
    const isWholeTaskLockedForTech =
      detailSquad.sharedCalendarStatus === 'Completato' &&
      profile?.role !== 'admin';
    const canAddPhotosAndMaterials =
      selectedAssignment.stato !== 'Assegnato' && !isLockedForTech;
    const isMultiTechSquad = detailSquad.members.length > 1;
    const orderedDetailMembers = [...detailSquad.members].sort(
      (a, b) => Number(b.isViewer) - Number(a.isViewer)
    );
    const completedSquadCount = detailSquad.members.filter(
      (m) => m.status === 'Completato'
    ).length;
    const canMutateOwnItem = (ownerEmail: string, ownerUid?: string) =>
      profile?.role === 'admin' ||
      (!isLockedForTech &&
        Boolean(
          profile &&
          ((profile.uid && ownerUid && ownerUid === profile.uid) ||
            areSameTechnicianEmails(ownerEmail, profile.email, directory))
        ));

    const resolvedSubfolderId = assignmentPhotos.find(
      (p) => p.driveSubfolderId
    )?.driveSubfolderId;
    const taskDriveFolderUrl = resolvedSubfolderId
      ? `https://drive.google.com/drive/folders/${resolvedSubfolderId}`
      : `https://drive.google.com/drive/folders/${extractDriveFolderId(
        settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
      )}`;
    const taskSubfolderLabel = formatTaskDriveSubfolderName(
      selectedAssignment.commessa,
      selectedParentTask?.taskCode || selectedAssignment.assignmentCode
    );
    const headerCommessaTitle = isSelectedAltroReparto
      ? 'Lavorazione altro AT'
      : isSelectedPendingReview
        ? 'Da revisionare'
        : `Commessa ${selectedAssignment.commessa}`;

    return (
      <div className="min-h-screen bg-slate-50 flex flex-col animate-fluid-slide">
        <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setSelectedAssignmentId(null)}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer interactive-press"
            aria-label="Torna indietro"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <div className="text-center min-w-0 flex-1">
            <p className="font-mono text-xs font-semibold text-slate-900 truncate">
              {headerCommessaTitle}
            </p>
            <p className="text-[11px] font-normal text-slate-500 font-mono truncate">
              {selectedParentTask?.taskCode || selectedAssignment.assignmentCode}
            </p>
          </div>

          {!isSelectedAltroReparto &&
            !isSelectedPendingReview &&
            (profile?.role === 'admin' ||
              detailSquad.sharedCalendarStatus === 'Completato') ? (
            <button
              type="button"
              onClick={() => {
                const activeSiblings = siblingAssignments.filter(
                  (s) => s.stato !== 'Annullato'
                );
                const effectiveSquad =
                  activeSiblings.length > 0
                    ? activeSiblings
                    : [selectedAssignment];
                const summary = buildTaskCompletionEmailSummary({
                  task: selectedParentTask,
                  completedByName:
                    `${profile?.nome || ''} ${profile?.cognome || ''}`.trim() ||
                    selectedAssignment.technicianName,
                  completedByReplyToEmail: currentUserReplyToEmail,
                  commessa: selectedAssignment.commessa,
                  taskCode:
                    selectedParentTask?.taskCode ||
                    selectedAssignment.assignmentCode,
                  descrizioneTask: selectedAssignment.descrizioneTask,
                  inizioMs: selectedAssignment.inizioMs,
                  fineMs: selectedAssignment.fineMs,
                  squadAssignments: effectiveSquad,
                  overrideNoteByAssignmentId: {
                    [selectedAssignment.assignmentId]:
                      noteDraft || selectedAssignment.noteTecnico,
                  },
                  taskMaterials: assignmentMaterials,
                  taskPhotos: assignmentPhotos,
                  activeAdminEmails,
                  resolveDeliverableEmail,
                  masterFolderId: settings.driveSharedFolderId,
                });
                setEmailDraft({
                  ...summary,
                  subject:
                    detailSquad.sharedCalendarStatus === 'Completato'
                      ? summary.subject
                      : `[SITE Aggiornamento] ${selectedParentTask?.taskCode ||
                      selectedAssignment.assignmentCode
                      } · Commessa ${selectedAssignment.commessa} (${selectedAssignment.stato
                      })`,
                });
              }}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              title="Invia riepilogo email ad Admin e squadra"
            >
              <Mail className="w-5 h-5" />
            </button>
          ) : (
            <div className="min-w-[44px]" />
          )}
        </header>

        <main className="flex-1 max-w-lg w-full mx-auto px-4 pt-4 pb-24 space-y-4">
          {(() => {
            const detailVisual = getTaskEventVisualStyle(selectedParentTask, {
              statusOverride: detailSquad.sharedCalendarStatus,
              operatorColorLabels: settings.operatorColorLabels,
              fallbackColorId: selectedAssignment.colorId,
            });
            return (
              <section
                className={`rounded-xl p-4 space-y-2 ${detailVisual.cardClassName}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-xs tabular-nums ${detailVisual.subtleMetaClassName}`}
                  >
                    {formatDateIt(selectedAssignment.inizioMs)} ·{' '}
                    {formatTimeIt(selectedAssignment.inizioMs)}–
                    {formatTimeIt(selectedAssignment.fineMs)} ·{' '}
                    {detailVisual.operatorLabel}
                  </span>
                  {isSelectedAltroReparto ? (
                    <span className="text-xs font-semibold">Altro AT</span>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs">
                      <StatusIndicator
                        status={selectedAssignment.stato}
                        inheritColor
                      />
                      {detailSquad.totalCount > 1 &&
                        detailSquad.sharedCalendarStatus !==
                        selectedAssignment.stato && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-semibold">
                              Squadra: {detailSquad.sharedCalendarStatus}
                            </span>
                          </>
                        )}
                    </div>
                  )}
                </div>

                <h1 className="font-display text-lg font-semibold leading-snug">
                  {selectedAssignment.descrizioneTask}
                </h1>
              </section>
            );
          })()}

          {/* Squadra Intervento e Stato Individuale (no duplicate squad text) */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                Squadra intervento
              </h2>
              {detailSquad.members.length > 1 && !isSelectedAltroReparto && (
                <span className="font-mono text-xs font-semibold text-slate-600 tabular-nums shrink-0">
                  {completedSquadCount}/{detailSquad.members.length} completati
                </span>
              )}
            </div>

            <div className="divide-y divide-slate-100">
              {orderedDetailMembers.map((member) => (
                <div
                  key={member.email || member.name}
                  className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-900 truncate">
                      {member.name}
                      {member.isViewer && (
                        <span className="font-normal text-slate-500"> · Tu</span>
                      )}
                    </p>
                  </div>

                  <div className="shrink-0">
                    {isSelectedAltroReparto ? (
                      <span className="text-xs font-semibold text-slate-600">
                        Altro AT
                      </span>
                    ) : (
                      <StatusIndicator status={member.status} />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {isSelectedAltroReparto ? (
            <div className="bg-slate-50 border border-slate-300 rounded-xl p-4 text-xs font-normal text-slate-700 leading-relaxed">
              <span className="font-semibold text-slate-900">
                Lavorazione per altro reparto (Altro AT):
              </span>{' '}
              evento informativo in calendario.
            </div>
          ) : (
            <>
              {isSelectedPendingReview && (
                <div className="bg-slate-50 border border-slate-300 rounded-xl p-4 text-xs font-normal text-slate-800 leading-relaxed">
                  <span className="font-semibold text-slate-900">
                    Task autonomo in attesa di revisione Admin:
                  </span>{' '}
                  cartella provvisoria <span className="font-mono">{taskSubfolderLabel}</span>.
                </div>
              )}

              {/* Materiali Utilizzati */}
              <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="text-sm font-semibold text-slate-900">
                    Materiali utilizzati ({assignmentMaterials.length})
                  </h2>
                  {canAddPhotosAndMaterials && (
                    <button
                      type="button"
                      onClick={() => {
                        setSheetCategory('ALL');
                        setSheetSearch('');
                        setSheetArticleId('');
                        setSheetQty(1);
                        setMaterialSheetOpen(true);
                      }}
                      className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer shrink-0"
                    >
                      <PackagePlus className="w-4 h-4" />
                      <span>Aggiungi</span>
                    </button>
                  )}
                </div>

                {assignmentMaterials.length === 0 ? (
                  <p className="text-xs font-normal text-slate-500">
                    Nessun materiale registrato.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {assignmentMaterials.map((mat) => {
                      const canEditMat = canMutateOwnItem(
                        mat.technicianEmail,
                        mat.technicianUid
                      );
                      return (
                        <div
                          key={mat.usedId}
                          className="py-2 first:pt-0 last:pb-0 flex items-center justify-between gap-4"
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-xs font-semibold text-slate-900">
                              {mat.codiceArticolo}
                              {isMultiTechSquad && (
                                <span className="font-sans font-normal text-slate-500">
                                  {' '}
                                  · {mat.technicianName}
                                </span>
                              )}
                            </p>
                            <p className="text-xs font-normal text-slate-600 truncate">
                              {mat.descrizioneArticolo}
                            </p>
                          </div>

                          {canEditMat ? (
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={async () => {
                                  if (mat.quantita <= 1) {
                                    await removeUsedMaterial(mat.usedId);
                                    showToast('Articolo rimosso.', 'info');
                                  } else {
                                    await updateUsedMaterialQty(
                                      mat.usedId,
                                      mat.quantita - 1
                                    );
                                  }
                                }}
                                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                                aria-label="Riduci quantità"
                              >
                                <Minus className="w-4 h-4" />
                              </button>
                              <span className="min-w-[48px] text-center font-mono text-xs font-semibold text-slate-900 tabular-nums">
                                {mat.quantita} {mat.unitaMisura}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  updateUsedMaterialQty(
                                    mat.usedId,
                                    mat.quantita + 1
                                  )
                                }
                                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                                aria-label="Aumenta quantità"
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <span className="font-mono text-xs font-semibold text-slate-900 tabular-nums shrink-0">
                              {mat.quantita} {mat.unitaMisura}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Foto Attività */}
              <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-slate-900">
                      Foto attività ({assignmentPhotos.length})
                    </h2>
                    <p className="text-xs font-normal text-slate-500 font-mono truncate">
                      {taskSubfolderLabel}
                    </p>
                  </div>
                  <a
                    href={taskDriveFolderUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 inline-flex items-center gap-2 shrink-0 whitespace-nowrap"
                  >
                    <span>Cartella</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                {canAddPhotosAndMaterials && (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => cameraInputRef.current?.click()}
                      className="min-h-[48px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-white text-xs font-semibold flex items-center justify-center gap-2 hover:bg-slate-800 cursor-pointer"
                    >
                      <Camera className="w-4 h-4" />
                      <span>Scatta foto</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => galleryInputRef.current?.click()}
                      className="min-h-[48px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-semibold flex items-center justify-center gap-2 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                    >
                      <ImageIcon className="w-4 h-4" />
                      <span>Galleria</span>
                    </button>
                  </div>
                )}

                {assignmentPhotos.length === 0 ? (
                  <p className="text-xs font-normal text-slate-500">
                    Nessuna foto allegata.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {assignmentPhotos.map((p) => {
                      const canDeletePhoto = canMutateOwnItem(
                        p.technicianEmail,
                        p.technicianUid
                      );
                      return (
                        <div
                          key={p.photoId}
                          className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-200 bg-slate-50"
                        >
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 truncate">
                              {p.fileName}
                            </p>
                            {(p.caption || isMultiTechSquad) && (
                              <p className="text-[11px] font-normal text-slate-600 truncate">
                                {isMultiTechSquad ? p.technicianName : ''}
                                {isMultiTechSquad && p.caption ? ' · ' : ''}
                                {p.caption}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <a
                              href={p.driveWebViewLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 inline-flex items-center gap-2"
                            >
                              <span>Drive</span>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                            {canDeletePhoto && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await removeInterventionPhoto(p.photoId);
                                  showToast('Foto rimossa.', 'info');
                                }}
                                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer"
                                aria-label="Rimuovi foto"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Note Attività */}
              <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor="mobile-note-tecnico"
                    className="text-sm font-semibold text-slate-900"
                  >
                    Note attività
                  </label>
                  <span className="text-xs font-normal text-slate-500">
                    {isCommessaExempt ? 'Opzionali' : 'Obbligatorie'}
                  </span>
                </div>

                <textarea
                  id="mobile-note-tecnico"
                  rows={4}
                  disabled={isWholeTaskLockedForTech}
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="Operazioni effettuate, collaudi o segnalazioni..."
                  className="w-full p-4 rounded-lg border border-slate-300 text-sm font-normal text-slate-900 disabled:bg-slate-50 disabled:text-slate-600 focus:outline-none focus:border-slate-900"
                />

                {!isWholeTaskLockedForTech &&
                  noteDraft !== selectedAssignment.noteTecnico && (
                    <button
                      type="button"
                      disabled={updatingStatus}
                      onClick={() =>
                        handleTransitionStatus('Preso in Carico', true)
                      }
                      className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                    >
                      <Save className="w-4 h-4" />
                      <span>Salva bozza note</span>
                    </button>
                  )}

                {isLockedForTech && (
                  <p className="text-xs font-normal text-slate-700 bg-slate-50 border border-slate-200 rounded-lg p-4">
                    {isWholeTaskLockedForTech
                      ? 'Intervento chiuso da tutta la squadra.'
                      : 'Quota personale completata · in attesa della chiusura degli altri colleghi.'}
                  </p>
                )}
              </section>
            </>
          )}
        </main>

        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const selected = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (selected.length > 0) {
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
            if (selected.length > 0) {
              setPendingPhotoFiles((prev) => [...prev, ...selected]);
            }
          }}
        />

        {!isLockedForTech && !isSelectedAltroReparto && (
          <div className="fixed bottom-0 left-0 right-0 z-30 p-4 pb-safe bg-white border-t border-slate-200">
            <div className="max-w-lg mx-auto">
              {selectedAssignment.stato === 'Assegnato' ? (
                <button
                  type="button"
                  disabled={updatingStatus}
                  onClick={() => handleTransitionStatus('Preso in Carico')}
                  className="w-full h-12 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  <span>
                    {updatingStatus
                      ? 'Aggiornamento...'
                      : 'Prendi in carico intervento'}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={updatingStatus}
                  onClick={() => handleTransitionStatus('Completato')}
                  className="w-full h-12 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {updatingStatus
                      ? 'Chiusura in corso...'
                      : 'Completa intervento'}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Mobile Bottom Sheet: Add Used Material */}
        {materialSheetOpen && (
          <div className="fixed inset-0 z-50 flex flex-col justify-end bg-slate-950/50 backdrop-blur-xs">
            <form
              onSubmit={handleConfirmAddMaterial}
              className="w-full max-w-lg mx-auto bg-white border-t border-slate-200 rounded-t-2xl p-6 pb-safe max-h-[85vh] flex flex-col"
            >
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 shrink-0">
                <h3 className="text-base font-semibold text-slate-900">
                  Inserisci materiale utilizzato
                </h3>
                <button
                  type="button"
                  onClick={() => setMaterialSheetOpen(false)}
                  className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="mt-4 space-y-4 flex-1 overflow-y-auto">
                <div className="grid grid-cols-1 gap-2">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={sheetSearch}
                      onChange={(e) => setSheetSearch(e.target.value)}
                      placeholder="Cerca codice o nome articolo..."
                      className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-lg border border-slate-300 text-sm font-normal text-slate-900"
                    />
                  </div>
                  <select
                    value={sheetCategory}
                    onChange={(e) => setSheetCategory(e.target.value)}
                    className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-normal bg-white text-slate-900"
                  >
                    <option value="ALL">Tutte le categorie</option>
                    {distinctCategories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                {sheetFilteredArticles.length === 0 ? (
                  <p className="text-xs font-normal text-slate-500 py-6 text-center">
                    Nessun articolo trovato nel catalogo.
                  </p>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto">
                    {sheetFilteredArticles.map((art) => {
                      const selected = sheetArticleId === art.articleId;
                      return (
                        <button
                          key={art.articleId}
                          type="button"
                          onClick={() => setSheetArticleId(art.articleId)}
                          className={`w-full text-left px-4 py-2 min-h-[56px] rounded-lg border flex items-center justify-between gap-4 transition-colors cursor-pointer ${selected
                            ? 'bg-slate-900 text-white border-slate-950'
                            : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                            }`}
                        >
                          <div className="min-w-0">
                            <p
                              className={`font-mono text-xs font-semibold ${selected ? 'text-white' : 'text-slate-900'
                                }`}
                            >
                              {art.codiceArticolo}
                            </p>
                            <p
                              className={`text-xs font-normal truncate ${selected ? 'text-slate-200' : 'text-slate-600'
                                }`}
                            >
                              {art.descrizione}
                            </p>
                          </div>
                          <span
                            className={`font-mono text-xs shrink-0 ${selected ? 'text-slate-300' : 'text-slate-500'
                              }`}
                          >
                            {art.unitaMisura}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="pt-2 flex items-center justify-between gap-4">
                  <label className="text-sm font-semibold text-slate-900">
                    Quantità utilizzata
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setSheetQty((q) => Math.max(1, q - 1))}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 cursor-pointer"
                    >
                      <Minus className="w-4 h-4" />
                    </button>
                    <input
                      type="number"
                      step="any"
                      min="0.01"
                      required
                      value={sheetQty}
                      onChange={(e) => setSheetQty(Number(e.target.value))}
                      className="w-20 min-h-[44px] text-center font-mono font-semibold text-base border border-slate-300 rounded-lg tabular-nums text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => setSheetQty((q) => q + 1)}
                      className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="pt-4 mt-4 border-t border-slate-100 shrink-0">
                <button
                  type="submit"
                  disabled={savingMaterial || !sheetArticleId}
                  className="w-full h-12 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-white font-semibold text-sm cursor-pointer disabled:opacity-40"
                >
                  {savingMaterial
                    ? 'Registrazione...'
                    : 'Conferma materiale nel task'}
                </button>
              </div>
            </form>
          </div>
        )}

        <MultiPhotoUploadModal
          open={pendingPhotoFiles.length > 0}
          files={pendingPhotoFiles}
          driveFolderPath={taskSubfolderLabel}
          caption={photoCaption}
          onCaptionChange={setPhotoCaption}
          onRemoveFile={(idx) =>
            setPendingPhotoFiles((prev) => prev.filter((_, i) => i !== idx))
          }
          onAppendFiles={(extra) =>
            setPendingPhotoFiles((prev) => [...prev, ...extra])
          }
          onConfirm={handleConfirmPhotoUpload}
          onCancel={() => {
            setPendingPhotoFiles([]);
            setPhotoCaption('');
          }}
          uploading={uploadingPhoto}
          progress={photoUploadProgress}
          technicianLabel={selectedAssignment.technicianName}
        />

        <EmailNotificationModal
          draft={emailDraft}
          onClose={() => setEmailDraft(null)}
        />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Smartphone-Native App Shell
  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Compact Sticky Smartphone Top Bar */}
      <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center shrink-0">
            <div className="grid grid-cols-2 gap-0 w-3 h-3">
              <span className="bg-slate-400 rounded-[1px]" />
              <span className="bg-white rounded-[1px]" />
              <span className="bg-white rounded-[1px]" />
              <span className="bg-slate-400 rounded-[1px]" />
            </div>
          </div>
          <span className="font-display text-sm font-semibold text-slate-900 truncate">
            {activeTab === 'calendar'
              ? 'Calendario'
              : activeTab === 'on_call'
                ? 'Reperibilità'
                : activeTab === 'agenda'
                  ? 'I miei task'
                  : 'Catalogo'}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onExitSmartphonePreview && (
            <button
              type="button"
              onClick={onExitSmartphonePreview}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
            >
              <Monitor className="w-4 h-4 shrink-0" />
              <span>Vista Web</span>
            </button>
          )}
          {profile?.role === 'admin' && (
            <button
              type="button"
              onClick={() => setViewMode('admin')}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white cursor-pointer whitespace-nowrap"
            >
              <LayoutDashboard className="w-4 h-4 shrink-0" />
              <span className="lg:hidden">Admin Mobile</span>
              <span className="hidden lg:inline">Portale Admin</span>
            </button>
          )}
          <PWAInstallButton compact />
        </div>
      </header>

      <main className="flex-1 w-full max-w-lg mx-auto px-2 sm:px-4 pt-2 pb-20 space-y-2">
        {pendingCleanupPhotos.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-4">
            <div className="flex items-start gap-2 min-w-0">
              <HardDrive className="w-4 h-4 text-slate-700 shrink-0" />
              <div className="min-w-0 text-xs">
                <p className="font-semibold text-slate-900">
                  Libera spazio Google Drive
                </p>
                <p className="text-[11px] font-normal text-slate-600 leading-snug">
                  {pendingCleanupPhotos.length} copie già consolidate su{' '}
                  {MASTER_DRIVE_OWNER_EMAIL}.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={cleaningUpDriveFiles}
              onClick={() => setConfirmCleanupOpen(true)}
              className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white shrink-0 whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              {cleaningUpDriveFiles ? 'Pulizia...' : 'Libera ora'}
            </button>
          </div>
        )}

        {activeTab === 'calendar' && (
          <div className="space-y-2">
            {/* Slim Smartphone Status Strip + Actions */}
            <div className="bg-white border border-slate-200 rounded-xl p-2 space-y-2">
              <div className="grid grid-cols-4 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setAgendaFilter('today');
                    setActiveTab('agenda');
                  }}
                  className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex flex-col items-center justify-center cursor-pointer"
                >
                  <span className="text-[10px] font-normal text-slate-500">Oggi</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {todayCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAgendaFilter('open');
                    setActiveTab('agenda');
                  }}
                  className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex flex-col items-center justify-center cursor-pointer"
                >
                  <span className="text-[10px] font-normal text-slate-500">Da fare</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {assignedCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAgendaFilter('open');
                    setActiveTab('agenda');
                  }}
                  className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex flex-col items-center justify-center cursor-pointer"
                >
                  <span className="text-[10px] font-normal text-slate-500">In corso</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {inProgressCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAgendaFilter('completed');
                    setActiveTab('agenda');
                  }}
                  className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex flex-col items-center justify-center cursor-pointer"
                >
                  <span className="text-[10px] font-normal text-slate-500">Chiusi</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {completedCount}
                  </span>
                </button>
              </div>

              {profile?.role === 'admin' && directory.length > 0 && (
                <div className="pt-2 border-t border-slate-100 flex items-center gap-2">
                  <UserCheck className="w-4 h-4 text-slate-500 shrink-0" />
                  <select
                    value={adminPreviewTechEmail}
                    onChange={(e) => setAdminPreviewTechEmail(e.target.value)}
                    aria-label="Seleziona tecnico anteprima mobile"
                    className="flex-1 min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-normal text-slate-800 focus:outline-none"
                  >
                    <option value="AUTO">Anteprima automatica</option>
                    <option value="ALL">Tutti i tecnici</option>
                    {directory
                      .filter((m) => m.active)
                      .map((m) => (
                        <option key={m.memberId} value={m.email.toLowerCase()}>
                          {m.nome} {m.cognome}
                        </option>
                      ))}
                  </select>
                </div>
              )}

              {/* Quick Actions */}
              <div className="pt-2 border-t border-slate-100 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={openNewAutonomousTaskModal}
                  className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
                >
                  <Plus className="w-4 h-4 shrink-0" />
                  <span>Nuovo task</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingAbsence(null);
                    setAbsenceModalOpen(true);
                  }}
                  className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
                >
                  <CalendarOff className="w-4 h-4 text-slate-700 shrink-0" />
                  <span>Segna assenza</span>
                </button>
              </div>
            </div>

            {/* Unified Smartphone Calendar Card */}
            <div
              onTouchStart={handleCalendarTouchStart}
              onTouchEnd={handleCalendarTouchEnd}
              className="bg-white border border-slate-200 rounded-xl overflow-hidden select-none"
            >
              {/* Top Mobile Calendar Bar */}
              <div className="p-2 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    onClick={() => stepCalendar(-1)}
                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                    aria-label="Indietro"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (calMode === 'month') {
                        setCalMode('3days');
                        setMonthDrawerOpen(false);
                      } else {
                        setMonthDrawerOpen((v) => !v);
                      }
                    }}
                    className="min-h-[36px] px-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 inline-flex items-center gap-2 text-xs font-semibold text-slate-900 truncate cursor-pointer"
                  >
                    <span className="truncate">{monthYearLabel}</span>
                    <span className="text-slate-300 shrink-0" aria-hidden="true">
                      ·
                    </span>
                    <span className="font-mono text-xs font-normal text-slate-500 tabular-nums shrink-0 whitespace-nowrap">
                      {techWeekBadge}
                    </span>
                    {monthDrawerOpen || calMode === 'month' ? (
                      <ChevronUp className="w-4 h-4 text-slate-500 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => stepCalendar(1)}
                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
                    aria-label="Avanti"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!isAnchorToday && (
                    <button
                      type="button"
                      onClick={() => {
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        setCalendarDate(today);
                      }}
                      className="min-h-[36px] px-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
                    >
                      Oggi
                    </button>
                  )}

                  <div className="inline-flex items-center gap-2">
                    {(
                      [
                        { id: 'day', label: '1g' },
                        { id: '3days', label: '3g' },
                        { id: 'week', label: 'Sett' },
                        { id: 'month', label: 'Mese' },
                      ] as const
                    ).map((mode) => {
                      const active = calMode === mode.id;
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          onClick={() => {
                            setCalMode(mode.id);
                            setMonthDrawerOpen(false);
                          }}
                          className={`min-h-[36px] px-2 rounded-lg border text-xs font-semibold cursor-pointer whitespace-nowrap interactive-press ${active
                            ? 'bg-slate-900 text-white border-slate-950 shadow-xs'
                            : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                            }`}
                        >
                          {mode.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Expandable Mini-Month Drawer */}
              {monthDrawerOpen && calMode !== 'month' && (
                <div className="p-2 bg-slate-50 border-b border-slate-200 space-y-2 animate-fluid-slide">
                  <div className="flex items-center justify-between text-xs text-slate-600 px-2">
                    <span>Seleziona giorno</span>
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => stepCalendar(-1, true)}
                        className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 cursor-pointer"
                        aria-label="Mese precedente"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => stepCalendar(1, true)}
                        className="min-h-[32px] min-w-[32px] flex items-center justify-center rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 cursor-pointer"
                        aria-label="Mese successivo"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-7 text-center text-[10px] font-semibold text-slate-500">
                    {['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((lbl, idx) => (
                      <span key={idx} className="py-2">
                        {lbl}
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-7 gap-2">
                    {monthDays.map((d) => {
                      const dMs = startOfDayMs(d);
                      const inMonth = d.getMonth() === calendarDate.getMonth();
                      const isTodayCell = isSameDay(dMs, nowTick);
                      const isInVisibleRange = timelineDays.some((td) =>
                        isSameDay(td.getTime(), dMs)
                      );
                      const isAnchor = isSameDay(dMs, calendarDate.getTime());
                      const dayTasksCount = calendarAssignments.filter((a) =>
                        assignmentOccursOnDay(a, dMs)
                      ).length;

                      return (
                        <button
                          key={d.toISOString()}
                          type="button"
                          onClick={() => {
                            setCalendarDate(new Date(d));
                            setMonthDrawerOpen(false);
                          }}
                          className={`h-10 rounded-lg border flex flex-col items-center justify-center transition-colors cursor-pointer ${isAnchor
                            ? 'bg-slate-900 text-white border-slate-950'
                            : isTodayCell
                              ? 'bg-slate-100 text-slate-900 border-slate-400 font-semibold'
                              : isInVisibleRange
                                ? 'bg-slate-100 text-slate-900 border-slate-300'
                                : inMonth
                                  ? 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                                  : 'bg-slate-50 text-slate-400 border-slate-200'
                            }`}
                        >
                          <span className="font-mono text-xs font-semibold tabular-nums leading-none">
                            {d.getDate()}
                          </span>
                          <span
                            className={`text-[8px] font-mono leading-none tabular-nums ${dayTasksCount > 0
                              ? isAnchor
                                ? 'text-slate-300 font-semibold'
                                : 'text-slate-700 font-semibold'
                              : 'opacity-0'
                              }`}
                          >
                            {dayTasksCount > 0 ? `${dayTasksCount}t` : '·'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Smartphone Timeline (3d / Week / 1d) */}
              {calMode !== 'month' && (
                <div className="flex flex-col">
                  <div className="bg-white border-b border-slate-200">
                    <div className="flex">
                      <div className="w-10 shrink-0 border-r border-slate-100 flex items-center justify-center text-[10px] font-mono text-slate-500">
                        Ora
                      </div>

                      <div
                        className="flex-1 grid"
                        style={{
                          gridTemplateColumns: `repeat(${timelineDays.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {timelineDays.map((day) => {
                          const dMs = startOfDayMs(day);
                          const isTodayCol = isSameDay(dMs, nowTick);
                          const dayCount = calendarAssignments.filter((a) =>
                            assignmentOccursOnDay(a, dMs)
                          ).length;
                          const shortDay = getWeekdayShortIt(day);
                          const dayLabel =
                            calMode === 'week' ? shortDay.charAt(0) : shortDay;

                          return (
                            <button
                              key={day.toISOString()}
                              type="button"
                              onClick={() => {
                                setCalendarDate(new Date(day));
                                if (calMode === 'week') {
                                  setCalMode('3days');
                                } else if (calMode === '3days') {
                                  setCalMode('day');
                                }
                              }}
                              className="py-2 px-0 border-r last:border-r-0 border-slate-100 flex flex-col items-center justify-center hover:bg-slate-50 cursor-pointer"
                            >
                              <span
                                className={`text-[10px] font-semibold ${isTodayCol ? 'text-slate-900' : 'text-slate-500'
                                  }`}
                              >
                                {dayLabel}
                              </span>
                              <span
                                className={`w-7 h-7 rounded-lg inline-flex items-center justify-center font-mono text-xs font-semibold tabular-nums ${isTodayCol
                                  ? 'bg-slate-900 text-white'
                                  : 'text-slate-900'
                                  }`}
                              >
                                {day.getDate()}
                              </span>
                              {calMode !== 'week' && (
                                <span className="text-[9px] font-mono text-slate-400 tabular-nums">
                                  {dayCount > 0 ? `${dayCount} task` : 'libero'}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {packedMobileTopStrip.laneCount > 0 && (
                      <div className="flex">
                        <div className="w-10 shrink-0 border-r border-slate-100" />
                        <div
                          className="flex-1 relative"
                          style={{
                            height: `${packedMobileTopStrip.laneCount * 24 + 4}px`,
                          }}
                        >
                          <div
                            className="absolute inset-0 grid divide-x divide-slate-100 pointer-events-none"
                            style={{
                              gridTemplateColumns: `repeat(${timelineDays.length}, minmax(0, 1fr))`,
                            }}
                          >
                            {timelineDays.map((d) => (
                              <div key={d.getTime()} />
                            ))}
                          </div>

                          {packedMobileTopStrip.spans.map((span) => {
                            const colCount = timelineDays.length;
                            const leftPct = (span.startCol / colCount) * 100;
                            const widthPct =
                              ((span.endCol - span.startCol + 1) / colCount) *
                              100;
                            const topPx = span.lane * 24 + 2;

                            if (span.item.kind === 'absence') {
                              const ab = span.item.payload as Absence;
                              const tone = getAbsenceToneClasses(ab.tipo);
                              const label = `${formatAbsenceCalendarLabel(ab, {
                                shortTechName: formatShortTechName(
                                  ab.technicianName
                                ),
                                prefixAssenza: false,
                              })}${ab.note ? ` - ${ab.note}` : ''}`;
                              return (
                                <button
                                  key={span.item.id}
                                  type="button"
                                  onClick={() => {
                                    setEditingAbsence(ab);
                                    setAbsenceModalOpen(true);
                                  }}
                                  style={{
                                    top: `${topPx}px`,
                                    left: `calc(${leftPct}% + 2px)`,
                                    width: `calc(${widthPct}% - 4px)`,
                                    height: '20px',
                                  }}
                                  className={`absolute z-10 px-2 border text-left text-[9.5px] font-semibold leading-tight truncate flex items-center gap-2 cursor-pointer transition-colors ${span.continuesBefore
                                    ? 'rounded-l-none'
                                    : 'rounded-l-md'
                                    } ${span.continuesAfter
                                      ? 'rounded-r-none'
                                      : 'rounded-r-md'
                                    } ${tone.bar}`}
                                  title={`${ab.technicianName} · ${ab.tipo} (${formatAbsenceDateSummary(
                                    ab
                                  )})`}
                                >
                                  {span.continuesBefore && (
                                    <ChevronLeft className="w-3 h-3 shrink-0" />
                                  )}
                                  <span className="truncate">{label}</span>
                                  {span.continuesAfter && (
                                    <ChevronRight className="w-3 h-3 shrink-0" />
                                  )}
                                </button>
                              );
                            }

                            const asg = span.item.payload as Assignment;
                            const parent = tasksById.get(asg.taskId);
                            const isAltro = Boolean(parent?.altroReparto);
                            const squad = getSquadDetailsForAssignment(asg);
                            const fullTitle = formatCalendarEventTitle(
                              squad.allNames,
                              asg.descrizioneTask
                            );
                            const visual = getTaskEventVisualStyle(parent, {
                              statusOverride: squad.sharedCalendarStatus,
                              operatorColorLabels:
                                settings.operatorColorLabels,
                              fallbackColorId: asg.colorId,
                            });

                            return (
                              <button
                                key={span.item.id}
                                type="button"
                                onClick={() => openAssignmentDetail(asg)}
                                style={{
                                  top: `${topPx}px`,
                                  left: `calc(${leftPct}% + 2px)`,
                                  width: `calc(${widthPct}% - 4px)`,
                                  height: '20px',
                                }}
                                className={`absolute z-10 px-2 text-left text-[9.5px] font-semibold leading-tight truncate flex items-center gap-2 cursor-pointer transition-opacity active:opacity-85 ${span.continuesBefore
                                  ? 'rounded-l-none'
                                  : 'rounded-l-md'
                                  } ${span.continuesAfter
                                    ? 'rounded-r-none'
                                    : 'rounded-r-md'
                                  } ${visual.cardClassName}`}
                                title={fullTitle}
                              >
                                {span.continuesBefore && (
                                  <ChevronLeft className="w-3 h-3 shrink-0" />
                                )}
                                <span className="truncate">
                                  {isAltro ? `Altro AT · ${fullTitle}` : fullTitle}
                                </span>
                                {span.continuesAfter && (
                                  <ChevronRight className="w-3 h-3 shrink-0" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Scrollable 00:00–24:00 Vertical Smartphone Grid */}
                  <div
                    ref={timelineScrollRef}
                    className="h-[calc(100vh-280px)] min-h-[400px] max-h-[620px] overflow-y-auto overflow-x-hidden relative"
                  >
                    <div
                      className="flex relative"
                      style={{ height: `${PHONE_TOTAL_GRID_HEIGHT}px` }}
                    >
                      <div className="w-10 shrink-0 border-r border-slate-100 bg-white relative">
                        {hours24.map((h) => (
                          <div
                            key={h}
                            className="relative border-b border-slate-100 pr-2 text-right"
                            style={{ height: `${PHONE_HOUR_HEIGHT}px` }}
                          >
                            <span className="inline-block -translate-y-2 text-[10px] font-mono text-slate-400 tabular-nums">
                              {String(h).padStart(2, '0')}
                            </span>
                          </div>
                        ))}
                      </div>

                      <div
                        className="flex-1 grid relative"
                        style={{
                          gridTemplateColumns: `repeat(${timelineDays.length}, minmax(0, 1fr))`,
                        }}
                      >
                        {timelineDays.map((day) => {
                          const dMs = startOfDayMs(day);
                          const dEndMs = dMs + 24 * 3600000;
                          const isTodayCol = isSameDay(dMs, nowTick);
                          const colAssignments = verticalGridAssignments.filter(
                            (a) => assignmentOccursOnDay(a, dMs)
                          );
                          const colHourlyAbsences = hourlyGridAbsences.filter(
                            (ab) => ab.inizioMs < dEndMs && ab.fineMs > dMs
                          );
                          const {
                            positionedAssignments: positioned,
                            positionedAbsences,
                          } = layoutOverlappingAssignmentsAndAbsences({
                            dayAssignments: colAssignments,
                            dayHourlyAbsences: colHourlyAbsences,
                            dayStartMs: dMs,
                            hourHeightPx: PHONE_HOUR_HEIGHT,
                            minTaskHeightPx: 30,
                            minAbsenceHeightPx: 26,
                          });

                          return (
                            <div
                              key={day.toISOString()}
                              className={`relative border-r last:border-r-0 border-slate-100 ${isTodayCol ? 'bg-slate-50/50' : ''
                                }`}
                              style={{ height: `${PHONE_TOTAL_GRID_HEIGHT}px` }}
                            >
                              {hours24.map((h) => (
                                <div
                                  key={h}
                                  className="border-b border-slate-100 pointer-events-none relative"
                                  style={{ height: `${PHONE_HOUR_HEIGHT}px` }}
                                >
                                  <div
                                    className="w-full border-b border-dashed border-slate-100 absolute left-0"
                                    style={{ top: `${PHONE_HOUR_HEIGHT / 2}px` }}
                                  />
                                </div>
                              ))}

                              {isTodayCol && (
                                <div
                                  className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                                  style={{
                                    top: `${(nowMinutesOfDay / 60) * PHONE_HOUR_HEIGHT
                                      }px`,
                                  }}
                                >
                                  <span className="w-2 h-2 rounded-full bg-slate-900 shrink-0" />
                                  <div className="h-[1px] bg-slate-900 flex-1" />
                                </div>
                              )}

                              {positionedAbsences.map((ha) => {
                                const ab = ha.absence;
                                const tone = getAbsenceToneClasses(ab.tipo);
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
                                    key={ab.absenceId}
                                    type="button"
                                    onClick={() => {
                                      setEditingAbsence(ab);
                                      setAbsenceModalOpen(true);
                                    }}
                                    style={{
                                      top: `${ha.topPx + 1}px`,
                                      height: `${Math.max(24, ha.heightPx - 2)}px`,
                                      left: `calc(${leftPct}% + 1px)`,
                                      width: `calc(${widthPct}% - 2px)`,
                                      zIndex: 8 + ha.colIndex,
                                      transition:
                                        'transform 140ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 140ms cubic-bezier(0.16, 1, 0.3, 1)',
                                    }}
                                    className={`absolute rounded-lg border border-dashed px-2 py-0 text-left overflow-hidden cursor-pointer ring-1 ring-white/90 shadow-xs hover:shadow-md active:scale-[0.985] ${tone.block}`}
                                  >
                                    <p className="text-[9px] font-semibold leading-tight truncate">
                                      {formatAbsenceCalendarLabel(ab, {
                                        shortTechName: formatShortTechName(
                                          ab.technicianName
                                        ),
                                        prefixAssenza: false,
                                      })}
                                    </p>
                                    <p className="text-[8px] font-mono tabular-nums opacity-85 truncate">
                                      {formatMinutesAsHHMM(ha.clippedStartMinutes)}–
                                      {formatMinutesAsHHMM(ha.clippedEndMinutes)}
                                    </p>
                                  </button>
                                );
                              })}

                              {/* Smartphone Task Blocks — zero duplicate "Con: ..." */}
                              {positioned.map((pos) => {
                                const {
                                  asg,
                                  clippedStartMinutes: startMin,
                                  clippedEndMinutes: endMin,
                                  colIndex,
                                  totalCols,
                                  colSpan = 1,
                                } = pos;
                                const topPx =
                                  (startMin / 60) * PHONE_HOUR_HEIGHT + 1;
                                const heightPx = Math.max(
                                  30,
                                  ((endMin - startMin) / 60) *
                                  PHONE_HOUR_HEIGHT -
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
                                const isCompactWeekCol = calMode === 'week';

                                const squad =
                                  getSquadDetailsForAssignment(asg);
                                const parent = tasksById.get(asg.taskId);
                                const commessaDisplay = parent
                                  ? formatTaskCommessaLabel(parent)
                                  : asg.commessa || 'Da revisionare';
                                const visual = getTaskEventVisualStyle(parent, {
                                  statusOverride: squad.sharedCalendarStatus,
                                  operatorColorLabels:
                                    settings.operatorColorLabels,
                                  fallbackColorId: asg.colorId,
                                });

                                return (
                                  <button
                                    key={asg.assignmentId}
                                    type="button"
                                    onClick={() => openAssignmentDetail(asg)}
                                    className={`absolute text-left rounded-lg overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden cursor-pointer flex flex-col justify-start px-2 py-0.5 ring-1 ring-white/90 dark:ring-slate-900/90 shadow-xs interactive-press transition-all ${visual.cardClassName}`}
                                    style={{
                                      top: `${topPx}px`,
                                      height: `${heightPx}px`,
                                      left: `calc(${leftPct}% + 1px)`,
                                      width: `calc(${widthPct}% - 2px)`,
                                      zIndex: 15 + colIndex,
                                    }}
                                  >
                                    <p
                                      className={`${isCompactWeekCol
                                        ? 'text-[8px] leading-[1.15]'
                                        : 'text-[9.5px] leading-[1.2]'
                                        } font-semibold whitespace-normal break-words`}
                                    >
                                      {formatCalendarEventTitle(
                                        squad.allNames,
                                        asg.descrizioneTask
                                      )}
                                    </p>
                                    <p
                                      className={`${isCompactWeekCol
                                        ? 'text-[7.5px]'
                                        : 'text-[9px]'
                                        } font-mono tabular-nums leading-[1.15] ${visual.subtleMetaClassName}`}
                                    >
                                      {formatMinutesAsHHMM(startMin)}–
                                      {formatMinutesAsHHMM(endMin)}
                                    </p>
                                    <p
                                      className={`${isCompactWeekCol
                                        ? 'text-[7.5px]'
                                        : 'text-[9px]'
                                        } font-mono font-semibold leading-[1.15] whitespace-normal break-words ${visual.subtleMetaClassName}`}
                                    >
                                      {isCompactWeekCol
                                        ? commessaDisplay
                                        : `${commessaDisplay} · ${visual.operatorLabel}`}
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

              {/* Smartphone Full Month View */}
              {calMode === 'month' && (
                <div>
                  <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500 text-center">
                    {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(
                      (w) => (
                        <div key={w} className="py-2">
                          {w}
                        </div>
                      )
                    )}
                  </div>

                  <div className="grid grid-cols-7">
                    {monthDays.map((day) => {
                      const dMs = startOfDayMs(day);
                      const inMonth = day.getMonth() === calendarDate.getMonth();
                      const isTodayCell = isSameDay(dMs, nowTick);
                      const isSelectedCell = isSameDay(
                        dMs,
                        calendarDate.getTime()
                      );
                      const dayItems = calendarAssignments.filter((a) =>
                        assignmentOccursOnDay(a, dMs)
                      );

                      return (
                        <button
                          key={day.toISOString()}
                          type="button"
                          onClick={() => setCalendarDate(new Date(day))}
                          onDoubleClick={() => {
                            setCalendarDate(new Date(day));
                            setCalMode('3days');
                          }}
                          className={`min-h-[68px] p-2 border-b border-r last:border-r-0 border-slate-100 flex flex-col items-center justify-start gap-2 transition-colors cursor-pointer ${isSelectedCell
                            ? 'bg-slate-100 text-slate-900'
                            : inMonth
                              ? 'bg-white text-slate-900'
                              : 'bg-slate-50 text-slate-400'
                            }`}
                        >
                          <span
                            className={`w-6 h-6 rounded-lg inline-flex items-center justify-center font-mono text-xs font-semibold tabular-nums ${isTodayCell
                              ? 'bg-slate-900 text-white'
                              : inMonth
                                ? 'text-slate-900'
                                : 'text-slate-400'
                              }`}
                          >
                            {day.getDate()}
                          </span>

                          <div className="w-full space-y-2">
                            {dayItems.slice(0, 2).map((asg) => {
                              const parent = tasksById.get(asg.taskId);
                              const squad = getSquadDetailsForAssignment(asg);
                              const visual = getTaskEventVisualStyle(parent, {
                                statusOverride: squad.sharedCalendarStatus,
                                operatorColorLabels:
                                  settings.operatorColorLabels,
                                fallbackColorId: asg.colorId,
                              });
                              return (
                                <div
                                  key={asg.assignmentId}
                                  className={`w-full px-2 py-0 rounded text-[7.5px] font-semibold leading-[1.2] whitespace-normal break-words text-left ${visual.cardClassName}`}
                                >
                                  {formatSquadShortNames(squad.allNames)}
                                </div>
                              );
                            })}
                            {dayItems.length > 2 && (
                              <span className="block text-[8px] font-mono text-slate-500 text-center">
                                +{dayItems.length - 2}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Selected Day Touch List inside Month View */}
                  <div className="p-4 bg-slate-50 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900">
                        {formatDateIt(calendarDate.getTime())}
                      </span>
                      <button
                        type="button"
                        onClick={() => setCalMode('3days')}
                        className="inline-flex items-center gap-2 min-h-[36px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 cursor-pointer"
                      >
                        <span>Apri in 3 giorni</span>
                        <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                      </button>
                    </div>

                    {calendarAssignments.filter((a) =>
                      assignmentOccursOnDay(a, startOfDayMs(calendarDate))
                    ).length === 0 &&
                      visibleAbsences.filter(
                        (ab) =>
                          ab.inizioMs < startOfDayMs(calendarDate) + 86400000 &&
                          ab.fineMs > startOfDayMs(calendarDate)
                      ).length === 0 ? (
                      <p className="text-xs font-normal text-slate-500">
                        Nessun intervento o assenza prevista in questa data.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {visibleAbsences
                          .filter(
                            (ab) =>
                              ab.inizioMs <
                              startOfDayMs(calendarDate) + 86400000 &&
                              ab.fineMs > startOfDayMs(calendarDate)
                          )
                          .map((ab) => (
                            <button
                              key={ab.absenceId}
                              type="button"
                              onClick={() => {
                                setEditingAbsence(ab);
                                setAbsenceModalOpen(true);
                              }}
                              className="w-full p-4 rounded-xl bg-white border border-slate-300 text-left flex items-center justify-between gap-4 cursor-pointer"
                            >
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-slate-900">
                                  {formatAbsenceCalendarLabel(ab, {
                                    shortTechName: ab.technicianName,
                                    prefixAssenza: true,
                                  })}
                                </p>
                                <p className="font-mono text-[11px] font-normal text-slate-600 tabular-nums">
                                  {formatAbsenceDateSummary(ab)}
                                </p>
                              </div>
                              <span className="text-xs font-semibold text-slate-800 shrink-0">
                                Modifica
                              </span>
                            </button>
                          ))}
                        {calendarAssignments
                          .filter((a) =>
                            assignmentOccursOnDay(a, startOfDayMs(calendarDate))
                          )
                          .map((asg) => {
                            const parent = tasksById.get(asg.taskId);
                            const squad = getSquadDetailsForAssignment(asg);
                            const commLabel = parent
                              ? formatTaskCommessaLabel(parent)
                              : asg.commessa || 'Da revisionare';
                            const visual = getTaskEventVisualStyle(parent, {
                              statusOverride: squad.sharedCalendarStatus,
                              operatorColorLabels:
                                settings.operatorColorLabels,
                              fallbackColorId: asg.colorId,
                            });
                            return (
                              <button
                                key={asg.assignmentId}
                                type="button"
                                onClick={() => openAssignmentDetail(asg)}
                                className={`w-full p-4 rounded-xl text-left flex items-center justify-between gap-4 cursor-pointer ${visual.cardClassName}`}
                              >
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold leading-snug whitespace-normal break-words">
                                    {formatCalendarEventTitle(
                                      squad.allNames,
                                      asg.descrizioneTask
                                    )}
                                  </p>
                                  <p
                                    className={`font-mono text-[11px] tabular-nums ${visual.subtleMetaClassName}`}
                                  >
                                    {formatTimeIt(asg.inizioMs)} –{' '}
                                    {formatTimeIt(asg.fineMs)} ·{' '}
                                    {visual.operatorLabel}
                                  </p>
                                  <p
                                    className={`font-mono text-[11px] font-semibold ${visual.subtleMetaClassName}`}
                                  >
                                    {commLabel}
                                  </p>
                                </div>
                                <StatusIndicator
                                  status={asg.stato}
                                  inheritColor
                                />
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'agenda' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={openNewAutonomousTaskModal}
                className="flex-1 min-h-[44px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-white text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Plus className="w-4 h-4 shrink-0" />
                <span>Nuovo task autonomo</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingAbsence(null);
                  setAbsenceModalOpen(true);
                }}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
              >
                <CalendarOff className="w-4 h-4 text-slate-700 shrink-0" />
                <span>Assenza</span>
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setAgendaFilter('open')}
                className={`min-h-[40px] px-2 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${agendaFilter === 'open'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
              >
                Da eseguire ({assignedCount + inProgressCount})
              </button>
              <button
                type="button"
                onClick={() => setAgendaFilter('today')}
                className={`min-h-[40px] px-2 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${agendaFilter === 'today'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
              >
                Oggi ({todayCount})
              </button>
              <button
                type="button"
                onClick={() => setAgendaFilter('completed')}
                className={`min-h-[40px] px-2 py-2 rounded-lg border text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${agendaFilter === 'completed'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
              >
                Completati ({completedCount})
              </button>
            </div>

            {filteredAgenda.length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
                <p className="text-sm font-semibold text-slate-800">
                  Nessun intervento in questa vista
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredAgenda.map((asg) => {
                  const matsCount = usedMaterials.filter(
                    (m) => m.taskId === asg.taskId
                  ).length;
                  const photosCount = photos.filter(
                    (p) => p.taskId === asg.taskId
                  ).length;
                  const parent = tasksById.get(asg.taskId);
                  const squad = getSquadDetailsForAssignment(asg);
                  const visual = getTaskEventVisualStyle(parent, {
                    statusOverride: squad.sharedCalendarStatus,
                    operatorColorLabels: settings.operatorColorLabels,
                    fallbackColorId: asg.colorId,
                  });
                  const commessaLabel = parent?.altroReparto
                    ? 'Altro AT'
                    : parent?.pendingAdminReview || !asg.commessa.trim()
                      ? 'Da revisionare'
                      : `Commessa ${asg.commessa}`;

                  return (
                    <button
                      key={asg.assignmentId}
                      type="button"
                      onClick={() => openAssignmentDetail(asg)}
                      className={`w-full text-left rounded-xl p-4 space-y-2 cursor-pointer interactive-card shadow-xs active:scale-[0.985] transition-all ring-1 ring-black/5 dark:ring-white/10 ${visual.cardClassName}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={`font-mono text-xs font-semibold tabular-nums ${visual.subtleMetaClassName}`}
                        >
                          {commessaLabel} · {visual.operatorLabel} ·{' '}
                          {formatDateIt(asg.inizioMs)}
                        </span>
                        <StatusIndicator status={asg.stato} inheritColor />
                      </div>

                      <h2 className="font-display text-base font-semibold leading-snug">
                        {formatCalendarEventTitle(
                          squad.allNames,
                          asg.descrizioneTask
                        )}
                      </h2>

                      <div
                        className={`pt-2 border-t border-current/15 flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums ${visual.subtleMetaClassName}`}
                      >
                        <span>
                          {formatTimeIt(asg.inizioMs)} –{' '}
                          {formatTimeIt(asg.fineMs)}
                        </span>
                        <span>
                          {matsCount} mat. · {photosCount} foto
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'catalog' && (
          <div className="space-y-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 truncate">
                  {profile?.nome} {profile?.cognome}
                </p>
                <p className="text-xs font-mono font-normal text-slate-500 truncate">
                  {profile?.email}
                </p>
              </div>
              <button
                type="button"
                onClick={signOutUser}
                className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0"
              >
                <LogOut className="w-4 h-4" />
                <span>Esci</span>
              </button>
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-1 gap-2">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    placeholder="Cerca nel catalogo articoli..."
                    className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-normal text-slate-900"
                  />
                </div>
                <select
                  value={catalogCategory}
                  onChange={(e) => setCatalogCategory(e.target.value)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-normal text-slate-900"
                >
                  <option value="ALL">Tutte le categorie</option>
                  {distinctCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
                {activeArticles
                  .filter((a) => {
                    if (
                      catalogCategory !== 'ALL' &&
                      a.categoria !== catalogCategory
                    ) {
                      return false;
                    }
                    const q = catalogSearch.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      a.codiceArticolo.toLowerCase().includes(q) ||
                      a.descrizione.toLowerCase().includes(q)
                    );
                  })
                  .map((art) => (
                    <div
                      key={art.articleId}
                      className="px-4 py-2 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-semibold text-slate-900">
                          {art.codiceArticolo}
                        </p>
                        <p className="text-xs font-normal text-slate-700">
                          {art.descrizione}
                        </p>
                        <p className="text-[11px] font-normal text-slate-500">
                          {art.categoria}
                        </p>
                      </div>
                      <span className="font-mono text-xs text-slate-500 shrink-0">
                        {art.unitaMisura}
                      </span>
                    </div>
                  ))}
                {activeArticles.length === 0 && (
                  <p className="p-6 text-xs font-normal text-slate-500 text-center">
                    Catalogo articoli vuoto.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        {activeTab === 'on_call' && <OnCallCalendarView />}
      </main>

      {/* Fixed Smartphone Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-slate-200 px-2 py-2 pb-safe">
        <div className="max-w-lg mx-auto grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('calendar')}
            className={`min-h-[48px] rounded-lg border flex flex-col items-center justify-center cursor-pointer interactive-tab ${activeTab === 'calendar'
              ? 'bg-slate-900 text-white border-slate-950 shadow-xs'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
          >
            <Calendar className="w-4 h-4" />
            <span className="text-[11px] font-semibold">Calendario</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('on_call')}
            className={`min-h-[48px] rounded-lg border flex flex-col items-center justify-center cursor-pointer interactive-tab ${activeTab === 'on_call'
              ? 'bg-slate-900 text-white border-slate-950 shadow-xs'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
          >
            <PhoneCall className="w-4 h-4" />
            <span className="text-[11px] font-semibold">Reperib.</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('agenda')}
            className={`min-h-[48px] rounded-lg border flex flex-col items-center justify-center cursor-pointer interactive-tab ${activeTab === 'agenda'
              ? 'bg-slate-900 text-white border-slate-950 shadow-xs'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
          >
            <ClipboardList className="w-4 h-4" />
            <span className="text-[11px] font-semibold">I miei task</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('catalog')}
            className={`min-h-[48px] rounded-lg border flex flex-col items-center justify-center cursor-pointer interactive-tab ${activeTab === 'catalog'
              ? 'bg-slate-900 text-white border-slate-950 shadow-xs'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
          >
            <Layers className="w-4 h-4" />
            <span className="text-[11px] font-semibold">Catalogo</span>
          </button>
        </div>
      </nav>

      {/* Autonomous Task Creation Modal */}
      {autonomousModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auto-task-modal-title"
        >
          <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-white border border-slate-200 p-6 space-y-4 animate-fluid-sheet sm:animate-fluid-pop">
            <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <h3
                id="auto-task-modal-title"
                className="text-base font-semibold text-slate-900"
              >
                Nuovo task autonomo
              </h3>
              <button
                type="button"
                onClick={() => setAutonomousModalOpen(false)}
                disabled={creatingAutonomous}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 cursor-pointer"
                aria-label="Chiudi"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateAutonomousTask} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Descrizione attività *
                </label>
                <textarea
                  rows={3}
                  required
                  maxLength={VALIDATION_LIMITS.TASK_DESC_MAX_LEN}
                  value={autoDescrizione}
                  onChange={(e) => setAutoDescrizione(e.target.value)}
                  placeholder="Es. TK-48291 · Reperibilità o attività fuori programma..."
                  className="w-full p-4 rounded-lg border border-slate-300 text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 resize-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Data e ora inizio *
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={autoInizioLocal}
                    onChange={(e) => setAutoInizioLocal(e.target.value)}
                    className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Data e ora fine *
                  </label>
                  <input
                    type="datetime-local"
                    required
                    value={autoFineLocal}
                    onChange={(e) => setAutoFineLocal(e.target.value)}
                    className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                  />
                </div>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAutonomousModalOpen(false)}
                  disabled={creatingAutonomous}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={creatingAutonomous}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                >
                  {creatingAutonomous ? 'Creazione...' : 'Crea e prendi in carico'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {profile && (
        <AbsenceModal
          open={absenceModalOpen}
          existingAbsence={editingAbsence}
          isAdminActor={profile.role === 'admin'}
          actorUid={profile.uid}
          selfTechnician={{
            email: profile.email,
            fullName: `${profile.nome} ${profile.cognome}`.trim(),
            uid: profile.uid,
          }}
          availableTechnicians={directory}
          preselectedTechEmail={
            adminPreviewTechEmail !== 'AUTO' && adminPreviewTechEmail !== 'ALL'
              ? adminPreviewTechEmail
              : profile.email
          }
          initialDateMs={calendarDate.getTime()}
          knownAdminUids={knownAdminUids}
          onClose={() => {
            setAbsenceModalOpen(false);
            setEditingAbsence(null);
          }}
          onSaved={(msg) => showToast(msg, 'success')}
          onError={(msg) => showToast(msg, 'error')}
        />
      )}

      <ConfirmModal
        open={confirmCleanupOpen}
        title={`Eliminare ${pendingCleanupPhotos.length} copie temporanee dal tuo Drive?`}
        description={`Le foto dell'intervento sono già archiviate sull'account centrale SITE (${MASTER_DRIVE_OWNER_EMAIL}).`}
        confirmLabel="Elimina copie personali"
        destructive
        loading={cleaningUpDriveFiles}
        onConfirm={async () => {
          await cleanupMySupersededDrivePhotos();
          setConfirmCleanupOpen(false);
        }}
        onCancel={() => setConfirmCleanupOpen(false)}
      />
    </div>
  );
};
