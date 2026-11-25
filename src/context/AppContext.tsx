import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { User } from 'firebase/auth';
import {
  ensureWorkspaceAccessToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from '../lib/firebase';
import {
  bootstrapAuthenticatedUser,
  clearPhotoPendingCleanup,
  deriveLiveTasksFromAssignments,
  fetchNeonDatabaseStatus,
  fetchWorkspaceSnapshot,
  fetchWorkspaceVersion,
  markPhotoOwnershipConsolidated,
  NeonDatabaseStatus,
  NeonNotConfiguredError,
  registerLocalSyncListener,
} from '../lib/firestoreService';
import {
  consolidateExternalPhotosOwnership,
  deleteUploaderSupersededDriveFiles,
  syncMasterFolderEditorPermissions,
  syncOwnerGmailTokenToServer,
} from '../lib/workspaceApi';
import {
  Absence,
  AppSettings,
  areSameTechnicianEmails,
  Article,
  Assignment,
  BOOTSTRAPPED_ADMIN_EMAILS,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_EXEMPT_COMMESSE,
  extractDriveFolderId,
  findStaffMemberByAnyEmail,
  getDeliverableEmail,
  InterventionPhoto,
  OnCallOverride,
  OnCallShift,
  isLoginOnlyIdEmail,
  MASTER_DRIVE_OWNER_EMAIL,
  resolveAnagraficaDriveShareEmails,
  StaffMember,
  Task,
  TaskStatus,
  UsedMaterial,
  UserProfile,
} from '../types/domain';
import {
  playTaskCompletedChime,
  showForegroundDesktopNotification,
  unlockNotificationAudio,
} from '../lib/notificationService';

export interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
  durationMs?: number;
}

export interface ToastItem {
  id: string;
  message: string;
  tone: 'success' | 'error' | 'info';
  actionLabel?: string;
  onAction?: () => void;
}

export interface DriveSyncStatus {
  isMasterOwner: boolean;
  syncing: boolean;
  lastSyncedAt: number | null;
  sharedTargetsCount: number;
  pendingConsolidationCount: number;
  error: string | null;
}

interface AppContextValue {
  authReady: boolean;
  dataLoading: boolean;
  neonStatus: NeonDatabaseStatus | null;
  neonSetupRequired: boolean;
  checkingNeonStatus: boolean;
  refreshNeonStatus: () => Promise<NeonDatabaseStatus>;
  refreshWorkspaceData: (options?: { forceFull?: boolean }) => Promise<void>;
  firebaseUser: User | null;
  profile: UserProfile | null;
  authError: string | null;
  isSigningInUser: boolean;
  hasWorkspaceToken: boolean;
  viewMode: 'admin' | 'mobile';
  setViewMode: (mode: 'admin' | 'mobile') => void;
  signInWithGoogle: (forceAccountPicker?: boolean) => Promise<void>;
  connectGoogleWorkspace: (options?: {
    forceConsent?: boolean;
  }) => Promise<string>;
  signOutUser: () => Promise<void>;
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
  currentAdminUids: string[];
  knownAdminUids: string[];
  activeAdminEmails: string[];
  currentUserReplyToEmail: string;
  resolveDeliverableEmail: (rawEmail: string) => string;
  pendingReviewTasksCount: number;
  driveSyncStatus: DriveSyncStatus;
  syncMasterDrivePermissionsAndOwnership: (options?: {
    interactive?: boolean;
    extraEmails?: string[];
  }) => Promise<void>;
  pendingCleanupPhotos: InterventionPhoto[];
  cleaningUpDriveFiles: boolean;
  cleanupMySupersededDrivePhotos: () => Promise<void>;
  pendingOpenTaskId: string | null;
  requestOpenTask: (taskId: string) => void;
  clearPendingOpenTask: () => void;
  toasts: ToastItem[];
  showToast: (
    message: string,
    tone?: 'success' | 'error' | 'info',
    options?: ToastOptions
  ) => void;
  dismissToast: (id: string) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
  exemptCommesse: [...DEFAULT_EXEMPT_COMMESSE],
  driveRootFolderName: 'Gestione Commesse',
  driveSharedFolderId: DEFAULT_DRIVE_SHARED_FOLDER_ID,
  googleSheetId: '',
  updatedByUid: '',
};

const AppContext = createContext<AppContextValue | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [authReady, setAuthReady] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [neonStatus, setNeonStatus] = useState<NeonDatabaseStatus | null>(null);
  const [neonSetupRequired, setNeonSetupRequired] = useState(false);
  const [checkingNeonStatus, setCheckingNeonStatus] = useState(true);

  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningInUser, setIsSigningInUser] = useState(false);
  const [hasWorkspaceToken, setHasWorkspaceToken] = useState(false);
  const [viewMode, setViewMode] = useState<'admin' | 'mobile'>('admin');

  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [articles, setArticles] = useState<Article[]>([]);
  const [directory, setDirectory] = useState<StaffMember[]>([]);
  const [rawTasks, setRawTasks] = useState<Task[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [usedMaterials, setUsedMaterials] = useState<UsedMaterial[]>([]);
  const [photos, setPhotos] = useState<InterventionPhoto[]>([]);
  const [absences, setAbsences] = useState<Absence[]>([]);
  const [onCallShifts, setOnCallShifts] = useState<OnCallShift[]>([]);
  const [onCallOverrides, setOnCallOverrides] = useState<OnCallOverride[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const tasks = useMemo(
    () => deriveLiveTasksFromAssignments(rawTasks, assignments, directory),
    [rawTasks, assignments, directory]
  );

  const [driveSyncing, setDriveSyncing] = useState(false);
  const [driveLastSyncedAt, setDriveLastSyncedAt] = useState<number | null>(
    null
  );
  const [driveSyncError, setDriveSyncError] = useState<string | null>(null);
  const [cleaningUpDriveFiles, setCleaningUpDriveFiles] = useState(false);

  const [pendingOpenTaskId, setPendingOpenTaskId] = useState<string | null>(
    () => {
      if (typeof window === 'undefined') return null;
      const params = new URLSearchParams(window.location.search);
      const tid = params.get('taskId')?.trim() || '';
      if (tid) {
        params.delete('taskId');
        const nextQuery = params.toString();
        const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''
          }${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
        return tid;
      }
      return null;
    }
  );

  const lastDriveAutoSyncSigRef = React.useRef<string>('');
  const driveSyncInFlightRef = React.useRef(false);
  const autoCleanupInFlightRef = React.useRef(false);
  const autoCleanedPhotoIdsRef = React.useRef<Set<string>>(new Set());
  const prevTaskStatusesRef = React.useRef<Map<string, TaskStatus> | null>(
    null
  );
  const notifiedCompletedIdsRef = React.useRef<Set<string>>(new Set());
  const lastPromptedConsolidationSigRef = React.useRef<string>('');
  const snapshotInFlightRef = React.useRef(false);
  const snapshotQueuedRef = React.useRef(false);
  const snapshotForceQueuedRef = React.useRef(false);
  const lastSnapshotVersionRef = React.useRef<string>('');

  const requestOpenTask = useCallback((taskId: string) => {
    const clean = taskId.trim();
    if (clean) {
      setPendingOpenTaskId(clean);
    }
  }, []);

  const clearPendingOpenTask = useCallback(() => {
    setPendingOpenTaskId(null);
  }, []);

  const showToast = useCallback(
    (
      message: string,
      tone: 'success' | 'error' | 'info' = 'info',
      options?: ToastOptions
    ) => {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [
        ...prev.slice(-3),
        {
          id,
          message,
          tone,
          actionLabel: options?.actionLabel,
          onAction: options?.onAction,
        },
      ]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, options?.durationMs ?? 4500);
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Unlock Web Audio API on first user gesture and listen for Service Worker notification clicks
  useEffect(() => {
    const handleUnlock = () => {
      unlockNotificationAudio();
    };
    window.addEventListener('pointerdown', handleUnlock, { once: true });
    window.addEventListener('keydown', handleUnlock, { once: true });

    const handleSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; taskId?: string } | undefined;
      if (data?.type === 'SITE_OPEN_TASK' && data.taskId) {
        requestOpenTask(data.taskId);
      }
    };
    navigator.serviceWorker?.addEventListener('message', handleSwMessage);

    return () => {
      window.removeEventListener('pointerdown', handleUnlock);
      window.removeEventListener('keydown', handleUnlock);
      navigator.serviceWorker?.removeEventListener('message', handleSwMessage);
    };
  }, [requestOpenTask]);

  const refreshNeonStatus = useCallback(async (): Promise<NeonDatabaseStatus> => {
    setCheckingNeonStatus(true);
    try {
      const status = await fetchNeonDatabaseStatus(Boolean(firebaseUser));
      setNeonStatus(status);
      setNeonSetupRequired(!status.configured || !status.connected);
      return status;
    } catch (err) {
      const fallback: NeonDatabaseStatus = {
        configured: false,
        connected: false,
        hostHint: '',
        error:
          err instanceof Error
            ? err.message
            : 'Impossibile verificare lo stato del database.',
      };
      setNeonStatus(fallback);
      setNeonSetupRequired(true);
      return fallback;
    } finally {
      setCheckingNeonStatus(false);
    }
  }, [firebaseUser]);

  // Initial check of Neon PostgreSQL connection status on boot
  useEffect(() => {
    void refreshNeonStatus();
  }, [refreshNeonStatus]);

  // Listen to Firebase Auth state changes (Google Sign-In + Drive OAuth)
  useEffect(() => {
    const unsub = initAuth((user, tokenPresent) => {
      setFirebaseUser(user);
      setHasWorkspaceToken(tokenPresent);
      if (!user) {
        setProfile(null);
        setArticles([]);
        setDirectory([]);
        setRawTasks([]);
        setAssignments([]);
        setUsedMaterials([]);
        setPhotos([]);
        setAbsences([]);
        setOnCallShifts([]);
        setOnCallOverrides([]);
        setDataLoading(false);
        setAuthReady(true);
        lastDriveAutoSyncSigRef.current = '';
        prevTaskStatusesRef.current = null;
        notifiedCompletedIdsRef.current.clear();
        return;
      }
      setAuthReady(true);
    });

    return () => unsub();
  }, []);

  // Bootstrap authenticated user profile once Neon PostgreSQL is connected
  useEffect(() => {
    if (!authReady || checkingNeonStatus || neonSetupRequired || !firebaseUser) {
      return;
    }

    let cancelled = false;
    setDataLoading(true);
    setAuthError(null);

    bootstrapAuthenticatedUser(firebaseUser)
      .then((userProfile) => {
        if (cancelled) return;
        setProfile(userProfile);
        const isMobileDevice = window.innerWidth < 1024;
        if (userProfile.role === 'technician') {
          setViewMode('mobile');
        } else {
          setViewMode(isMobileDevice ? 'mobile' : 'admin');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof NeonNotConfiguredError) {
          setNeonSetupRequired(true);
          setDataLoading(false);
          return;
        }
        const msg =
          err instanceof Error
            ? err.message
            : 'Errore caricamento profilo utente.';
        setAuthError(msg);
        setDataLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authReady, checkingNeonStatus, neonSetupRequired, firebaseUser]);

  const refreshWorkspaceData = useCallback(
    async (options?: { forceFull?: boolean }) => {
      if (!firebaseUser || neonSetupRequired) return;
      const forceFull = Boolean(options?.forceFull);
      if (snapshotInFlightRef.current) {
        snapshotQueuedRef.current = true;
        if (forceFull) {
          snapshotForceQueuedRef.current = true;
        }
        return;
      }
      snapshotInFlightRef.current = true;

      try {
        if (!forceFull && lastSnapshotVersionRef.current) {
          const remoteVersion = await fetchWorkspaceVersion(firebaseUser);
          if (remoteVersion && remoteVersion === lastSnapshotVersionRef.current) {
            return;
          }
        }

        const snap = await fetchWorkspaceSnapshot(firebaseUser);
        if (snap.version) {
          lastSnapshotVersionRef.current = snap.version;
        }
        setSettings({
          ...snap.settings,
          driveSharedFolderId: extractDriveFolderId(
            snap.settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
          ),
        });
        setArticles(
          [...snap.articles].sort(
            (a, b) =>
              a.categoria.localeCompare(b.categoria, 'it') ||
              a.codiceArticolo.localeCompare(b.codiceArticolo, 'it')
          )
        );
        setDirectory(
          [...snap.directory].sort((a, b) =>
            `${a.cognome} ${a.nome}`.localeCompare(`${b.cognome} ${b.nome}`, 'it')
          )
        );
        setRawTasks([...snap.tasks].sort((a, b) => a.inizioMs - b.inizioMs));
        setAssignments(
          [...snap.assignments].sort((a, b) => a.inizioMs - b.inizioMs)
        );
        setUsedMaterials(snap.usedMaterials);
        setPhotos(snap.photos);
        setAbsences([...snap.absences].sort((a, b) => a.inizioMs - b.inizioMs));
        setOnCallShifts(
          [...(snap.onCallShifts || [])].sort((a, b) => a.inizioMs - b.inizioMs)
        );
        setOnCallOverrides(
          [...(snap.onCallOverrides || [])].sort((a, b) => a.inizioMs - b.inizioMs)
        );
        setDataLoading(false);
      } catch (err) {
        if (err instanceof NeonNotConfiguredError) {
          setNeonSetupRequired(true);
        } else {
          console.error('Errore sincronizzazione dati Neon:', err);
        }
        setDataLoading(false);
      } finally {
        snapshotInFlightRef.current = false;
        if (snapshotQueuedRef.current) {
          const nextForce = snapshotForceQueuedRef.current;
          snapshotQueuedRef.current = false;
          snapshotForceQueuedRef.current = false;
          void refreshWorkspaceData({ forceFull: nextForce });
        }
      }
    },
    [firebaseUser, neonSetupRequired]
  );

  // Controllo versione leggero ogni 25s (quando attivo) + refresh immediato su mutazioni locali
  useEffect(() => {
    if (!authReady || neonSetupRequired || !firebaseUser || !profile) {
      return;
    }

    let disposed = false;
    let debounceTimer: number | null = null;
    let pendingForce = false;

    const scheduleRefresh = (delayMs = 40, forceFull = false) => {
      if (disposed) return;
      if (forceFull) {
        pendingForce = true;
      }
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        const shouldForce = pendingForce;
        pendingForce = false;
        if (!disposed) {
          void refreshWorkspaceData({ forceFull: shouldForce });
        }
      }, delayMs);
    };

    // Initial full state load
    lastSnapshotVersionRef.current = '';
    void refreshWorkspaceData({ forceFull: true });

    const unsubLocal = registerLocalSyncListener(() => {
      scheduleRefresh(15, true);
    });

    const syncInterval = window.setInterval(() => {
      if (!disposed && document.visibilityState === 'visible') {
        scheduleRefresh(50, false);
      }
    }, 25_000);

    const handleVisibilityOrOnline = () => {
      if (document.visibilityState === 'visible') {
        scheduleRefresh(50, false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityOrOnline);
    window.addEventListener('online', handleVisibilityOrOnline);

    return () => {
      disposed = true;
      unsubLocal();
      document.removeEventListener(
        'visibilitychange',
        handleVisibilityOrOnline
      );
      window.removeEventListener('online', handleVisibilityOrOnline);
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      window.clearInterval(syncInterval);
    };
  }, [authReady, neonSetupRequired, firebaseUser, profile, refreshWorkspaceData]);

  const signInWithGoogle = useCallback(
    async (forceAccountPicker = false) => {
      setIsSigningInUser(true);
      setAuthError(null);
      try {
        const res = await googleSignIn({
          forceAccountPicker,
          loginHint: forceAccountPicker
            ? undefined
            : firebaseUser?.email || undefined,
        });
        setHasWorkspaceToken(Boolean(res.accessToken));
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Accesso con Google annullato o non riuscito.';
        setAuthError(msg);
        showToast(msg, 'error');
      } finally {
        setIsSigningInUser(false);
      }
    },
    [firebaseUser?.email, showToast]
  );

  const connectGoogleWorkspace = useCallback(
    async (options?: { forceConsent?: boolean }): Promise<string> => {
      if (!options?.forceConsent) {
        const existing = getAccessToken();
        if (existing) {
          setHasWorkspaceToken(true);
          return existing;
        }
      }
      const token = await ensureWorkspaceAccessToken({
        forceConsent: options?.forceConsent,
      });
      setHasWorkspaceToken(true);
      return token;
    },
    []
  );

  const signOutUser = useCallback(async () => {
    if (
      profile?.email &&
      profile.email.trim().toLowerCase() ===
      MASTER_DRIVE_OWNER_EMAIL.toLowerCase()
    ) {
      await syncOwnerGmailTokenToServer(null).catch(() => undefined);
    }
    await logout();
    setHasWorkspaceToken(false);
  }, [profile?.email]);

  // Keep server RAM Gmail bridge warm whenever master owner (a.biagi@sitespa.it) has an active Workspace token in memory
  useEffect(() => {
    if (
      !authReady ||
      neonSetupRequired ||
      !profile ||
      profile.email.trim().toLowerCase() !==
      MASTER_DRIVE_OWNER_EMAIL.toLowerCase() ||
      !hasWorkspaceToken
    ) {
      return;
    }

    const pushTokenIfPresent = () => {
      const activeToken = getAccessToken();
      if (activeToken) {
        void syncOwnerGmailTokenToServer(activeToken).catch(() => undefined);
      }
    };

    pushTokenIfPresent();
    const timer = window.setInterval(pushTokenIfPresent, 15 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [authReady, neonSetupRequired, profile, hasWorkspaceToken]);

  const currentAdminUids = useMemo(() => {
    const uids = directory
      .filter((m) => m.role === 'admin' && m.active && m.linkedUid)
      .map((m) => m.linkedUid);
    if (
      profile?.role === 'admin' &&
      profile.uid &&
      !uids.includes(profile.uid)
    ) {
      uids.unshift(profile.uid);
    }
    return uids.slice(0, 10);
  }, [directory, profile]);

  const knownAdminUids = useMemo(() => {
    if (profile?.role === 'admin') {
      return currentAdminUids;
    }
    const set = new Set<string>();
    for (const m of directory) {
      if (m.role === 'admin' && m.active && m.linkedUid) {
        set.add(m.linkedUid);
      }
    }
    for (const t of tasks) {
      for (const u of t.adminUids || []) {
        if (u) set.add(u);
      }
    }
    for (const a of assignments) {
      for (const u of a.adminUids || []) {
        if (u) set.add(u);
      }
    }
    return Array.from(set).slice(0, 10);
  }, [profile?.role, currentAdminUids, directory, tasks, assignments]);

  const pendingReviewTasksCount = useMemo(
    () => tasks.filter((t) => Boolean(t.pendingAdminReview)).length,
    [tasks]
  );

  const currentUserReplyToEmail = useMemo(() => {
    if (!profile?.email) return '';
    const myPrimary = profile.email.trim().toLowerCase();
    const match =
      findStaffMemberByAnyEmail(myPrimary, directory) ||
      directory.find((m) => Boolean(profile.uid && m.linkedUid === profile.uid));
    const sec = (match?.secondaryEmail || '').trim().toLowerCase();
    if (sec && !isLoginOnlyIdEmail(sec)) {
      return sec;
    }
    const dirPrimary = (match?.email || '').trim().toLowerCase();
    if (dirPrimary && !isLoginOnlyIdEmail(dirPrimary)) {
      return dirPrimary;
    }
    if (!isLoginOnlyIdEmail(myPrimary)) {
      return myPrimary;
    }
    return '';
  }, [directory, profile?.email, profile?.uid]);

  const resolveDeliverableEmail = useCallback(
    (rawEmail: string): string => {
      const clean = rawEmail.trim().toLowerCase();
      if (!clean) return '';
      const match = findStaffMemberByAnyEmail(clean, directory);
      if (match) {
        return getDeliverableEmail(match);
      }
      if (
        profile?.email &&
        areSameTechnicianEmails(clean, profile.email, directory) &&
        currentUserReplyToEmail
      ) {
        return currentUserReplyToEmail;
      }
      return isLoginOnlyIdEmail(clean) ? '' : clean;
    },
    [directory, profile?.email, currentUserReplyToEmail]
  );

  const activeAdminEmails = useMemo(() => {
    const fromDir = directory
      .filter((m) => m.role === 'admin' && m.active)
      .map((m) => getDeliverableEmail(m))
      .filter(Boolean);
    if (profile?.role === 'admin' && profile.active && profile.email) {
      const selfDeliverable = resolveDeliverableEmail(profile.email);
      if (selfDeliverable && !fromDir.includes(selfDeliverable)) {
        fromDir.unshift(selfDeliverable);
      }
    }
    if (fromDir.length > 0) {
      return Array.from(new Set(fromDir)).slice(0, 10);
    }
    const fromTasks: string[] = [];
    for (const t of tasks) {
      for (const em of t.adminEmails || []) {
        const clean = em.trim().toLowerCase();
        if (clean && !fromTasks.includes(clean)) {
          fromTasks.push(clean);
        }
      }
    }
    if (fromTasks.length > 0) {
      return fromTasks.slice(0, 10);
    }
    return [...BOOTSTRAPPED_ADMIN_EMAILS];
  }, [directory, profile, tasks, resolveDeliverableEmail]);

  // Real-time Desktop Chime + Notification + Actionable Toast when any Task transitions to Completato
  useEffect(() => {
    if (
      !authReady ||
      dataLoading ||
      neonSetupRequired ||
      !profile ||
      profile.role !== 'admin' ||
      !profile.active
    ) {
      return;
    }

    if (prevTaskStatusesRef.current === null) {
      const initialMap = new Map<string, TaskStatus>();
      for (const t of tasks) {
        initialMap.set(t.taskId, t.statoPrevalente);
        if (t.statoPrevalente === 'Completato') {
          notifiedCompletedIdsRef.current.add(t.taskId);
        }
      }
      prevTaskStatusesRef.current = initialMap;
      return;
    }

    const prevMap = prevTaskStatusesRef.current;
    const nextMap = new Map<string, TaskStatus>();

    for (const t of tasks) {
      const prevStatus = prevMap.get(t.taskId);
      nextMap.set(t.taskId, t.statoPrevalente);

      if (t.statoPrevalente !== 'Completato') {
        notifiedCompletedIdsRef.current.delete(t.taskId);
        continue;
      }

      const justCompleted =
        (prevStatus !== undefined && prevStatus !== 'Completato') ||
        prevStatus === undefined;

      if (justCompleted && !notifiedCompletedIdsRef.current.has(t.taskId)) {
        notifiedCompletedIdsRef.current.add(t.taskId);
        playTaskCompletedChime();

        const isAutonomousPending =
          Boolean(t.pendingAdminReview) && !t.commessa.trim();
        const squadLabel =
          t.assignedNames.length > 0
            ? t.assignedNames.join(', ')
            : 'Admin SITE';
        const commessaLabel = isAutonomousPending
          ? 'Task autonomo da revisionare'
          : t.commessa.trim() ||
          (t.altroReparto ? 'Altro AT' : 'Senza commessa');

        const toastMessage = isAutonomousPending
          ? `Completato da ${squadLabel} (da revisionare): ${t.descrizione.slice(
            0,
            90
          )}`
          : `Completato · ${commessaLabel} (${squadLabel}): ${t.descrizione.slice(
            0,
            90
          )}`;

        showToast(toastMessage, 'success', {
          actionLabel: isAutonomousPending ? 'Revisiona' : 'Apri Task',
          onAction: () => requestOpenTask(t.taskId),
          durationMs: 8500,
        });

        void showForegroundDesktopNotification({
          title: isAutonomousPending
            ? `Completato (Da revisionare) · ${squadLabel}`
            : `Task Completato · ${commessaLabel}`,
          body: `${squadLabel} — ${t.descrizione.slice(0, 140)}`,
          taskId: t.taskId,
          onClickTask: requestOpenTask,
        });
      }
    }

    prevTaskStatusesRef.current = nextMap;
  }, [
    authReady,
    dataLoading,
    neonSetupRequired,
    profile,
    tasks,
    showToast,
    requestOpenTask,
  ]);

  const isMasterOwner = Boolean(
    profile?.email &&
    areSameTechnicianEmails(
      profile.email,
      MASTER_DRIVE_OWNER_EMAIL,
      directory
    )
  );

  const driveShareTargetEmails = useMemo(
    () => resolveAnagraficaDriveShareEmails(directory),
    [directory]
  );

  const pendingConsolidationPhotos = useMemo(() => {
    return photos.filter(
      (p) =>
        p.ownerConsolidated === false ||
        (p.ownerConsolidated === undefined &&
          !areSameTechnicianEmails(
            p.technicianEmail,
            MASTER_DRIVE_OWNER_EMAIL,
            directory
          ))
    );
  }, [photos, directory]);

  const syncMasterDrivePermissionsAndOwnership = useCallback(
    async (options?: { interactive?: boolean; extraEmails?: string[] }) => {
      const interactive = Boolean(options?.interactive);
      if (!isMasterOwner) {
        if (interactive) {
          showToast(
            `Solo il proprietario della cartella centrale (${MASTER_DRIVE_OWNER_EMAIL}) può consolidare proprietà e permessi Google Drive.`,
            'info'
          );
        }
        return;
      }

      if (driveSyncInFlightRef.current) return;
      driveSyncInFlightRef.current = true;
      setDriveSyncing(true);
      setDriveSyncError(null);

      try {
        const token = interactive
          ? await connectGoogleWorkspace()
          : getAccessToken();

        if (!token) {
          driveSyncInFlightRef.current = false;
          setDriveSyncing(false);
          return;
        }

        const masterFolderId = extractDriveFolderId(
          settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
        );

        const targetEmails = resolveAnagraficaDriveShareEmails(
          directory,
          options?.extraEmails
        );

        const permRes = await syncMasterFolderEditorPermissions({
          accessToken: token,
          masterFolderId,
          targetEmails,
        });

        const taskCodeByTaskId = new Map<string, string>();
        for (const t of tasks) {
          taskCodeByTaskId.set(t.taskId, t.taskCode);
        }

        let consolidatedCount = 0;
        if (pendingConsolidationPhotos.length > 0) {
          const consRes = await consolidateExternalPhotosOwnership({
            accessToken: token,
            masterFolderId,
            pendingPhotos: pendingConsolidationPhotos,
            taskCodeByTaskId,
            onPhotoConsolidated: markPhotoOwnershipConsolidated,
          });
          consolidatedCount = consRes.consolidatedCount;
        }

        setDriveLastSyncedAt(Date.now());

        if (
          interactive ||
          permRes.newlySharedEmails.length > 0 ||
          consolidatedCount > 0
        ) {
          const parts: string[] = [];
          if (permRes.newlySharedEmails.length > 0) {
            parts.push(
              `condivisa cartella Drive con ${permRes.newlySharedEmails.length} ${permRes.newlySharedEmails.length === 1 ? 'utente' : 'utenti'
              } Editor`
            );
          }
          if (consolidatedCount > 0) {
            parts.push(
              `acquisita proprietà di ${consolidatedCount} ${consolidatedCount === 1 ? 'foto esterna' : 'foto esterne'
              }`
            );
          }
          if (parts.length > 0) {
            showToast(`Google Drive SITE: ${parts.join(' · ')}.`, 'success');
          } else if (interactive) {
            showToast(
              `Permessi Editor (${permRes.alreadySharedCount} utenti) e proprietà foto Google Drive già allineati.`,
              'success'
            );
          }
        }
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Errore sincronizzazione cartella Google Drive.';
        setDriveSyncError(msg);
        if (interactive) {
          showToast(msg, 'error');
        }
      } finally {
        driveSyncInFlightRef.current = false;
        setDriveSyncing(false);
      }
    },
    [
      isMasterOwner,
      connectGoogleWorkspace,
      settings.driveSharedFolderId,
      directory,
      tasks,
      pendingConsolidationPhotos,
      showToast,
    ]
  );

  useEffect(() => {
    if (
      !authReady ||
      dataLoading ||
      neonSetupRequired ||
      !isMasterOwner ||
      !hasWorkspaceToken ||
      !getAccessToken()
    ) {
      return;
    }

    const folderId = extractDriveFolderId(
      settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
    );
    const sig = [
      folderId,
      driveShareTargetEmails.slice().sort().join(','),
      pendingConsolidationPhotos
        .map((p) => `${p.photoId}:${p.driveFileId}`)
        .sort()
        .join(','),
    ].join('|');

    if (lastDriveAutoSyncSigRef.current === sig) return;
    lastDriveAutoSyncSigRef.current = sig;

    syncMasterDrivePermissionsAndOwnership({ interactive: false }).catch(
      () => undefined
    );
  }, [
    authReady,
    dataLoading,
    neonSetupRequired,
    isMasterOwner,
    hasWorkspaceToken,
    settings.driveSharedFolderId,
    driveShareTargetEmails,
    pendingConsolidationPhotos,
    syncMasterDrivePermissionsAndOwnership,
  ]);

  useEffect(() => {
    if (
      !authReady ||
      dataLoading ||
      neonSetupRequired ||
      !isMasterOwner ||
      pendingConsolidationPhotos.length === 0 ||
      hasWorkspaceToken
    ) {
      return;
    }

    const sig = pendingConsolidationPhotos
      .map((p) => p.photoId)
      .sort()
      .join(',');
    if (lastPromptedConsolidationSigRef.current === sig) return;
    lastPromptedConsolidationSigRef.current = sig;

    showToast(
      `${pendingConsolidationPhotos.length} ${pendingConsolidationPhotos.length === 1
        ? 'nuova foto richiede'
        : 'nuove foto richiedono'
      } acquisizione proprietà Google Drive.`,
      'info',
      {
        durationMs: 12000,
        actionLabel: 'Acquisisci ora',
        onAction: () => {
          syncMasterDrivePermissionsAndOwnership({ interactive: true }).catch(
            () => undefined
          );
        },
      }
    );
  }, [
    authReady,
    dataLoading,
    neonSetupRequired,
    isMasterOwner,
    hasWorkspaceToken,
    pendingConsolidationPhotos,
    showToast,
    syncMasterDrivePermissionsAndOwnership,
  ]);

  const pendingCleanupPhotos = useMemo(() => {
    if (!profile?.email) return [];
    return photos.filter(
      (p) =>
        Boolean(p.pendingCleanupFileId) &&
        ((profile.uid && p.technicianUid === profile.uid) ||
          areSameTechnicianEmails(p.technicianEmail, profile.email, directory))
    );
  }, [photos, profile?.email, profile?.uid, directory]);

  const cleanupMySupersededDrivePhotos = useCallback(async () => {
    if (pendingCleanupPhotos.length === 0) return;
    setCleaningUpDriveFiles(true);
    try {
      const accessToken = await connectGoogleWorkspace();
      const { deletedCount, failedCount } =
        await deleteUploaderSupersededDriveFiles({
          accessToken,
          photosToClean: pendingCleanupPhotos,
          onPhotoCleaned: clearPhotoPendingCleanup,
        });

      if (failedCount === 0) {
        showToast(
          deletedCount === 1
            ? 'Copia temporanea rimossa dal tuo Google Drive. Spazio liberato.'
            : `${deletedCount} copie temporanee rimosse dal tuo Google Drive. Spazio liberato.`,
          'success'
        );
      } else {
        showToast(
          `Rimosse ${deletedCount} copie temporanee, ${failedCount} non riuscite.`,
          'info'
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore pulizia copie temporanee Google Drive.',
        'error'
      );
    } finally {
      setCleaningUpDriveFiles(false);
    }
  }, [pendingCleanupPhotos, connectGoogleWorkspace, showToast]);

  useEffect(() => {
    if (
      !authReady ||
      dataLoading ||
      neonSetupRequired ||
      !hasWorkspaceToken ||
      autoCleanupInFlightRef.current ||
      pendingCleanupPhotos.length === 0
    ) {
      return;
    }
    const token = getAccessToken();
    if (!token) return;

    const unattempted = pendingCleanupPhotos.filter(
      (p) => !autoCleanedPhotoIdsRef.current.has(p.photoId)
    );
    if (unattempted.length === 0) return;

    for (const p of unattempted) {
      autoCleanedPhotoIdsRef.current.add(p.photoId);
    }
    autoCleanupInFlightRef.current = true;
    setCleaningUpDriveFiles(true);

    deleteUploaderSupersededDriveFiles({
      accessToken: token,
      photosToClean: unattempted,
      onPhotoCleaned: clearPhotoPendingCleanup,
    })
      .catch(() => undefined)
      .finally(() => {
        autoCleanupInFlightRef.current = false;
        setCleaningUpDriveFiles(false);
      });
  }, [
    authReady,
    dataLoading,
    neonSetupRequired,
    hasWorkspaceToken,
    pendingCleanupPhotos,
  ]);

  const driveSyncStatus = useMemo<DriveSyncStatus>(
    () => ({
      isMasterOwner,
      syncing: driveSyncing,
      lastSyncedAt: driveLastSyncedAt,
      sharedTargetsCount: driveShareTargetEmails.length,
      pendingConsolidationCount: pendingConsolidationPhotos.length,
      error: driveSyncError,
    }),
    [
      isMasterOwner,
      driveSyncing,
      driveLastSyncedAt,
      driveShareTargetEmails.length,
      pendingConsolidationPhotos.length,
      driveSyncError,
    ]
  );

  const value = useMemo<AppContextValue>(
    () => ({
      authReady,
      dataLoading,
      neonStatus,
      neonSetupRequired,
      checkingNeonStatus,
      refreshNeonStatus,
      refreshWorkspaceData,
      firebaseUser,
      profile,
      authError,
      isSigningInUser,
      hasWorkspaceToken,
      viewMode,
      setViewMode,
      signInWithGoogle,
      connectGoogleWorkspace,
      signOutUser,
      settings,
      articles,
      directory,
      tasks,
      assignments,
      usedMaterials,
      photos,
      absences,
      onCallShifts,
      onCallOverrides,
      currentAdminUids,
      knownAdminUids,
      activeAdminEmails,
      currentUserReplyToEmail,
      resolveDeliverableEmail,
      pendingReviewTasksCount,
      driveSyncStatus,
      syncMasterDrivePermissionsAndOwnership,
      pendingCleanupPhotos,
      cleaningUpDriveFiles,
      cleanupMySupersededDrivePhotos,
      pendingOpenTaskId,
      requestOpenTask,
      clearPendingOpenTask,
      toasts,
      showToast,
      dismissToast,
    }),
    [
      authReady,
      dataLoading,
      neonStatus,
      neonSetupRequired,
      checkingNeonStatus,
      refreshNeonStatus,
      refreshWorkspaceData,
      firebaseUser,
      profile,
      authError,
      isSigningInUser,
      hasWorkspaceToken,
      viewMode,
      signInWithGoogle,
      connectGoogleWorkspace,
      signOutUser,
      settings,
      articles,
      directory,
      tasks,
      assignments,
      usedMaterials,
      photos,
      absences,
      currentAdminUids,
      knownAdminUids,
      activeAdminEmails,
      currentUserReplyToEmail,
      resolveDeliverableEmail,
      pendingReviewTasksCount,
      driveSyncStatus,
      syncMasterDrivePermissionsAndOwnership,
      pendingCleanupPhotos,
      cleaningUpDriveFiles,
      cleanupMySupersededDrivePhotos,
      pendingOpenTaskId,
      requestOpenTask,
      clearPendingOpenTask,
      toasts,
      showToast,
      dismissToast,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return ctx;
}
