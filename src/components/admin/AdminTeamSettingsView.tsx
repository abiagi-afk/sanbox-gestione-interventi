import React, { useMemo, useState } from 'react';
import {
  Check,
  Database,
  Download,
  Edit3,
  ExternalLink,
  FileSpreadsheet,
  FolderGit2,
  HardDrive,
  Mail,
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  deleteStaffMember,
  importLegacyFirestoreToNeon,
  saveAppSettings,
  upsertStaffMember,
} from '../../lib/firestoreService';
import { formatDateTimeIt } from '../../lib/exportUtils';
import {
  fetchSmtpStatus,
  flushPendingEmailOutbox,
  formatEmailChannelLabel,
  sendServerSmtpTestEmail,
  SmtpStatusInfo,
} from '../../lib/workspaceApi';
import {
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  DEFAULT_OPERATOR_COLOR_LABELS,
  extractDriveFolderId,
  extractGoogleSheetId,
  getDeliverableEmail,
  getWorkspaceDriveEmail,
  isLoginOnlyIdEmail,
  isWorkspaceDriveEmail,
  MASTER_DRIVE_OWNER_EMAIL,
  StaffMember,
  suggestTecnicoMailFromIdEmail,
  TASK_COLOR_IDS,
  TaskColorId,
  UserRole,
  VALIDATION_LIMITS,
} from '../../types/domain';
import {
  GoogleSheetDiagnosticResult,
  verifyGoogleSheetConnection,
} from '../../lib/googleSheetsSync';
import {
  getTaskEventVisualStyle,
  TASK_COLOR_PALETTE,
} from '../../lib/calendarLayout';
import { ConfirmModal } from '../ConfirmModal';
import { EmailDraftConfig } from '../EmailNotificationModal';
import { AdminNotificationControl } from '../AdminNotificationControl';

interface AdminTeamSettingsViewProps {
  onOpenEmailModal: (draft: EmailDraftConfig) => void;
}

function buildOperatorLabelsDraft(
  custom?: Partial<Record<TaskColorId, string>>
): Record<TaskColorId, string> {
  const result = { ...DEFAULT_OPERATOR_COLOR_LABELS };
  if (custom) {
    for (const colorId of TASK_COLOR_IDS) {
      const val = custom[colorId]?.trim();
      if (val) {
        result[colorId] = val;
      }
    }
  }
  return result;
}

export const AdminTeamSettingsView: React.FC<AdminTeamSettingsViewProps> = ({
  onOpenEmailModal,
}) => {
  const {
    profile,
    directory,
    articles,
    tasks,
    assignments,
    settings,
    neonStatus,
    refreshNeonStatus,
    currentAdminUids,
    driveSyncStatus,
    syncMasterDrivePermissionsAndOwnership,
    pendingCleanupPhotos,
    cleaningUpDriveFiles,
    cleanupMySupersededDrivePhotos,
    connectGoogleWorkspace,
    resolveDeliverableEmail,
    showToast,
  } = useApp();

  // Staff Member Modal
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<StaffMember | null>(null);
  const [email, setEmail] = useState('');
  const [secondaryEmail, setSecondaryEmail] = useState('');
  const [nome, setNome] = useState('');
  const [cognome, setCognome] = useState('');
  const [role, setRole] = useState<UserRole>('technician');
  const [active, setActive] = useState(true);
  const [savingMember, setSavingMember] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<StaffMember | null>(null);
  const [deletingMember, setDeletingMember] = useState(false);
  const [confirmCleanupOpen, setConfirmCleanupOpen] = useState(false);
  const [importingLegacy, setImportingLegacy] = useState(false);

  // SMTP + Safety Outbox Diagnostic Status (Read-only, zero secrets in UI)
  const [smtpStatus, setSmtpStatus] = useState<SmtpStatusInfo | null>(null);
  const [smtpStatusError, setSmtpStatusError] = useState<string | null>(null);
  const [smtpCheckedOnce, setSmtpCheckedOnce] = useState(false);
  const [loadingSmtpStatus, setLoadingSmtpStatus] = useState(false);
  const [confirmTestSmtpOpen, setConfirmTestSmtpOpen] = useState(false);
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [confirmFlushOutboxOpen, setConfirmFlushOutboxOpen] = useState(false);
  const [flushingOutbox, setFlushingOutbox] = useState(false);

  // Settings Form State
  const [exemptList, setExemptList] = useState<string[]>(
    settings.exemptCommesse
  );
  const [newCommessaExempt, setNewCommessaExempt] = useState('');
  const [driveFolder, setDriveFolder] = useState(settings.driveRootFolderName);
  const [driveSharedFolderInput, setDriveSharedFolderInput] = useState(
    settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
  );
  const [googleSheetInput, setGoogleSheetInput] = useState(
    settings.googleSheetId || ''
  );
  const [verifyingSheet, setVerifyingSheet] = useState(false);
  const [sheetDiagnostic, setSheetDiagnostic] =
    useState<GoogleSheetDiagnosticResult | null>(null);
  const [sheetDiagnosticError, setSheetDiagnosticError] = useState<
    string | null
  >(null);
  const [operatorLabels, setOperatorLabels] = useState<
    Record<TaskColorId, string>
  >(() => buildOperatorLabelsDraft(settings.operatorColorLabels));
  const [previewColorId, setPreviewColorId] = useState<TaskColorId>('peacock');
  const [savingSettings, setSavingSettings] = useState(false);

  // Sync local settings state if updated externally
  React.useEffect(() => {
    setExemptList(settings.exemptCommesse);
    setDriveFolder(settings.driveRootFolderName);
    setDriveSharedFolderInput(
      settings.driveSharedFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
    );
    setGoogleSheetInput(settings.googleSheetId || '');
    setOperatorLabels(buildOperatorLabelsDraft(settings.operatorColorLabels));
  }, [settings]);

  const refreshSmtpStatus = React.useCallback(async (forceRefresh = false) => {
    setLoadingSmtpStatus(true);
    setSmtpStatusError(null);
    try {
      const status = await fetchSmtpStatus(forceRefresh);
      setSmtpStatus(status);
    } catch (err) {
      setSmtpStatusError(
        err instanceof Error
          ? err.message
          : 'Impossibile verificare lo stato del motore email.'
      );
    } finally {
      setLoadingSmtpStatus(false);
      setSmtpCheckedOnce(true);
    }
  }, []);

  React.useEffect(() => {
    refreshSmtpStatus();
  }, [refreshSmtpStatus, tasks.length]);

  const handleSendTestSmtpConfirmed = async () => {
    if (!profile) return;
    setSendingTestEmail(true);
    try {
      const targetEmail = resolveDeliverableEmail(profile.email);
      const res = await sendServerSmtpTestEmail(targetEmail);
      setConfirmTestSmtpOpen(false);
      showToast(
        `Email di prova inviata a ${res.recipient} tramite ${formatEmailChannelLabel(
          res.channel
        )}.`,
        'success'
      );
      await refreshSmtpStatus(true);
    } catch (err) {
      setConfirmTestSmtpOpen(false);
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore invio email di prova SMTP.',
        'error',
        { durationMs: 7500 }
      );
      await refreshSmtpStatus(true);
    } finally {
      setSendingTestEmail(false);
    }
  };

  const handleFlushOutboxConfirmed = async () => {
    setFlushingOutbox(true);
    try {
      const res = await flushPendingEmailOutbox();
      setConfirmFlushOutboxOpen(false);
      await refreshSmtpStatus();
      if (res.sentCount > 0 && res.failedCount === 0) {
        showToast(
          `Inviati ${res.sentCount} riepiloghi in coda tramite ${formatEmailChannelLabel(
            res.channelUsed
          )}.`,
          'success'
        );
      } else if (res.sentCount > 0 && res.failedCount > 0) {
        showToast(
          `Inviati ${res.sentCount} riepiloghi, ${res.remainingCount} ancora in attesa (${res.lastError || 'verifica SMTP_PASS'
          }).`,
          'info',
          { durationMs: 6500 }
        );
      } else {
        showToast(
          res.lastError ||
          'Impossibile recapitare i messaggi in coda. Aggiorna SMTP_PASS oppure accedi con a.biagi@sitespa.it.',
          'error',
          { durationMs: 7000 }
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore durante l’invio dei riepiloghi in coda.',
        'error'
      );
    } finally {
      setFlushingOutbox(false);
    }
  };

  const handleImportLegacyFirestore = async () => {
    setImportingLegacy(true);
    try {
      const imported = await importLegacyFirestoreToNeon();
      await refreshNeonStatus();
      showToast(
        `Storico importato su Neon: ${imported.directory} operatori, ${imported.articles} articoli, ${imported.tasks} task.`,
        'success',
        { durationMs: 7000 }
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore importazione dati storici.',
        'error',
        { durationMs: 8000 }
      );
    } finally {
      setImportingLegacy(false);
    }
  };

  const resolvedDriveFolderId = useMemo(
    () =>
      extractDriveFolderId(
        driveSharedFolderInput || DEFAULT_DRIVE_SHARED_FOLDER_ID
      ),
    [driveSharedFolderInput]
  );

  const resolvedGoogleSheetId = useMemo(
    () => extractGoogleSheetId(googleSheetInput),
    [googleSheetInput]
  );

  const handleVerifyGoogleSheet = async () => {
    setVerifyingSheet(true);
    setSheetDiagnosticError(null);
    try {
      const diag = await verifyGoogleSheetConnection({
        rawGoogleSheetId: googleSheetInput,
        connectGoogleWorkspace,
        directory,
      });
      setSheetDiagnostic(diag);
      showToast(
        `Collegamento verificato: "${diag.spreadsheetTitle}" (${diag.wkTabs.length} schede WK).`,
        'success'
      );
    } catch (err) {
      setSheetDiagnostic(null);
      const msg =
        err instanceof Error
          ? err.message
          : 'Impossibile verificare il foglio Google Sheet.';
      setSheetDiagnosticError(msg);
      showToast(msg, 'error');
    } finally {
      setVerifyingSheet(false);
    }
  };

  const tasksTodayCountByEmail = useMemo(() => {
    const today = new Date();
    const map = new Map<string, number>();
    for (const t of tasks) {
      const d = new Date(t.inizioMs);
      if (
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth() &&
        d.getDate() === today.getDate()
      ) {
        for (const em of t.assignedEmails) {
          const k = em.toLowerCase();
          map.set(k, (map.get(k) || 0) + 1);
        }
      }
    }
    return map;
  }, [tasks]);

  const openNewStaffModal = () => {
    setEditingMember(null);
    setEmail('');
    setSecondaryEmail('');
    setNome('');
    setCognome('');
    setRole('technician');
    setActive(true);
    setStaffModalOpen(true);
  };

  const openEditStaffModal = (m: StaffMember) => {
    setEditingMember(m);
    setEmail(m.email);
    setSecondaryEmail(m.secondaryEmail || '');
    setNome(m.nome);
    setCognome(m.cognome);
    setRole(m.role);
    setActive(m.active);
    setStaffModalOpen(true);
  };

  const handleSaveStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setSavingMember(true);
    try {
      await upsertStaffMember({
        existingMember: editingMember || undefined,
        email,
        secondaryEmail,
        nome,
        cognome,
        role,
        active,
        adminUid: profile.uid,
        currentAdminUids,
      });

      if (
        driveSyncStatus.isMasterOwner &&
        active &&
        isWorkspaceDriveEmail(email)
      ) {
        syncMasterDrivePermissionsAndOwnership({
          interactive: false,
          extraEmails: [email.trim().toLowerCase()],
        }).catch(() => undefined);
      }

      showToast(
        editingMember
          ? 'Profilo operatore aggiornato.'
          : 'Nuovo operatore aggiunto in organico.',
        'success'
      );
      setStaffModalOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio operatore.',
        'error'
      );
    } finally {
      setSavingMember(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!confirmDelete) return;
    setDeletingMember(true);
    try {
      await deleteStaffMember(confirmDelete, profile?.email);
      showToast('Operatore rimosso dall’organico.', 'info');
      setConfirmDelete(null);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore rimozione operatore.',
        'error'
      );
    } finally {
      setDeletingMember(false);
    }
  };

  const handleAddExemptCommessa = () => {
    const clean = newCommessaExempt.trim().toUpperCase();
    if (!clean) return;
    if (!exemptList.includes(clean)) {
      setExemptList((prev) => [...prev, clean]);
    }
    setNewCommessaExempt('');
  };

  const persistAllSettings = async (
    labelsOverride?: Record<TaskColorId, string>
  ) => {
    if (!profile) return;
    const rawSheetTrimmed = googleSheetInput.trim();
    const normalizedSheetId = extractGoogleSheetId(rawSheetTrimmed);
    if (rawSheetTrimmed && !normalizedSheetId) {
      showToast(
        'Inserisci un URL o un ID valido di Google Sheets oppure svuota il campo.',
        'error'
      );
      return;
    }

    setSavingSettings(true);
    try {
      const normalizedFolderId = extractDriveFolderId(driveSharedFolderInput);
      const effectiveLabels = labelsOverride || operatorLabels;
      await saveAppSettings({
        exemptCommesse: exemptList,
        driveRootFolderName: driveFolder || 'Gestione Commesse',
        driveSharedFolderId: normalizedFolderId,
        googleSheetId: normalizedSheetId,
        operatorColorLabels: effectiveLabels,
        adminUid: profile.uid,
      });
      setDriveSharedFolderInput(normalizedFolderId);
      setGoogleSheetInput(normalizedSheetId);
      if (driveSyncStatus.isMasterOwner) {
        syncMasterDrivePermissionsAndOwnership({ interactive: false }).catch(
          () => undefined
        );
      }
      showToast('Impostazioni salvate.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio impostazioni.',
        'error'
      );
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await persistAllSettings();
  };

  const previewOutline = getTaskEventVisualStyle(
    { colorId: previewColorId, statoPrevalente: 'Assegnato' },
    { operatorColorLabels: operatorLabels }
  );
  const previewSolid = getTaskEventVisualStyle(
    { colorId: previewColorId, statoPrevalente: 'Preso in Carico' },
    { operatorColorLabels: operatorLabels }
  );
  const previewStriped = getTaskEventVisualStyle(
    { colorId: previewColorId, statoPrevalente: 'Completato' },
    { operatorColorLabels: operatorLabels }
  );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Left 8 Cols: Team Directory + Operator Calendar Colors */}
      <div className="xl:col-span-8 space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <h2 className="text-sm font-semibold text-slate-900">
              Anagrafica tecnici e ruoli
            </h2>
            <button
              type="button"
              onClick={openNewStaffModal}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <UserPlus className="w-4 h-4" />
              <span>Aggiungi operatore</span>
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2 px-4">Nominativo</th>
                  <th className="py-2 px-4">Account Workspace / Posta</th>
                  <th className="py-2 px-4">Ruolo</th>
                  <th className="py-2 px-4 text-right">Task oggi</th>
                  <th className="py-2 px-4">Stato</th>
                  <th className="py-2 px-4 text-right">Azioni</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs font-normal">
                {directory.map((m) => {
                  const isSelf =
                    Boolean(profile?.email) &&
                    m.email.toLowerCase() === profile?.email.toLowerCase();
                  const todayCount =
                    tasksTodayCountByEmail.get(m.email.toLowerCase()) || 0;
                  const wsEmail = getWorkspaceDriveEmail(m);
                  const mailEmail = getDeliverableEmail(m);
                  const hasSeparateMail =
                    Boolean(mailEmail) && mailEmail !== wsEmail;

                  return (
                    <tr key={m.memberId} className="hover:bg-slate-50">
                      <td className="py-2 px-4 font-semibold text-slate-900 whitespace-nowrap">
                        {m.nome} {m.cognome}
                      </td>
                      <td className="py-2 px-4 font-mono text-slate-600 whitespace-nowrap">
                        <div>{wsEmail || m.email}</div>
                        {hasSeparateMail ? (
                          <div className="text-[11px] text-slate-500">
                            Posta: {mailEmail}
                          </div>
                        ) : isLoginOnlyIdEmail(m.email) && !mailEmail ? (
                          <div className="text-[11px] text-amber-700 font-sans">
                            Manca recapito @tecnicositespa.it
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 px-4 text-slate-700 whitespace-nowrap">
                        {m.role === 'admin' ? 'Admin' : 'Tecnico'}
                      </td>
                      <td className="py-2 px-4 text-right font-mono text-slate-800 tabular-nums">
                        {todayCount}
                      </td>
                      <td className="py-2 px-4 text-slate-600 whitespace-nowrap">
                        {m.active ? 'Attivo' : 'Sospeso'}
                        {m.linkedUid ? ' · Collegato' : ' · In attesa 1° login'}
                      </td>
                      <td className="py-2 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-2">
                          <button
                            type="button"
                            disabled={!mailEmail}
                            onClick={() => {
                              if (!mailEmail) return;
                              onOpenEmailModal({
                                to: mailEmail,
                                subject:
                                  '[SITE Interventi] Comunicazione Operativa',
                                contextTitle: `Messaggio a ${m.nome} ${m.cognome}`,
                                bodyText: `Ciao ${m.nome},\n\n`,
                              });
                            }}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            title={
                              mailEmail
                                ? `Invia email a ${mailEmail}`
                                : 'Configura prima la casella posta @tecnicositespa.it'
                            }
                          >
                            <Mail className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditStaffModal(m)}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                            title="Modifica operatore"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          {!isSelf && (
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(m)}
                              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer"
                              title="Rimuovi operatore"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Google Calendar Operator Colors & Motifs Configuration */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4 text-slate-700 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900">
                Colori evento ed etichette operatori
              </h2>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() =>
                  setOperatorLabels({ ...DEFAULT_OPERATOR_COLOR_LABELS })
                }
                className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-4 h-4" />
                <span>Predefiniti</span>
              </button>
              <button
                type="button"
                disabled={savingSettings}
                onClick={() => persistAllSettings()}
                className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>
                  {savingSettings ? 'Salvataggio...' : 'Salva etichette'}
                </span>
              </button>
            </div>
          </div>

          {/* Live Motif Preview across the 3 Calendar States */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-slate-600">
              Anteprima stati calendario ({operatorLabels[previewColorId] || DEFAULT_OPERATOR_COLOR_LABELS[previewColorId]})
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <div
                className={`rounded-lg px-4 py-2 ${previewOutline.cardClassName}`}
              >
                <div className="font-semibold truncate">
                  Assegnato · Bordo colorato
                </div>
                <div className="text-[11px] font-mono tabular-nums opacity-85">
                  09:00 – 13:00
                </div>
              </div>
              <div
                className={`rounded-lg px-4 py-2 ${previewSolid.cardClassName}`}
              >
                <div className="font-semibold truncate">
                  Preso in Carico · Pieno
                </div>
                <div
                  className={`text-[11px] font-mono tabular-nums ${previewSolid.subtleMetaClassName}`}
                >
                  09:00 – 13:00
                </div>
              </div>
              <div
                className={`rounded-lg px-4 py-2 ${previewStriped.cardClassName}`}
              >
                <div className="font-semibold flex items-center gap-2 truncate">
                  <Check className="w-3.5 h-3.5 stroke-[3] shrink-0" />
                  <span className="truncate">Completato · Tratteggiato</span>
                </div>
                <div
                  className={`text-[11px] font-mono tabular-nums ${previewStriped.subtleMetaClassName}`}
                >
                  09:00 – 13:00
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
            {TASK_COLOR_IDS.map((colorId) => {
              const entry = TASK_COLOR_PALETTE[colorId];
              const isPreview = previewColorId === colorId;
              return (
                <div
                  key={colorId}
                  onFocus={() => setPreviewColorId(colorId)}
                  onClick={() => setPreviewColorId(colorId)}
                  className={`rounded-lg border p-2 flex items-center gap-2 transition-colors ${isPreview
                      ? 'border-slate-900 bg-slate-50'
                      : 'border-slate-200 bg-white'
                    }`}
                >
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${entry.themeClass} gcal-swatch-fill`}
                    title={entry.colorNameIt}
                  />
                  <div className="min-w-0 flex-1">
                    <label className="block text-[11px] font-normal text-slate-500">
                      {entry.colorNameIt}
                    </label>
                    <input
                      type="text"
                      value={operatorLabels[colorId] || ''}
                      maxLength={VALIDATION_LIMITS.OPERATOR_LABEL_MAX_LEN}
                      placeholder={DEFAULT_OPERATOR_COLOR_LABELS[colorId]}
                      onChange={(e) =>
                        setOperatorLabels((prev) => ({
                          ...prev,
                          [colorId]: e.target.value,
                        }))
                      }
                      className="w-full min-h-[32px] px-2 py-0 rounded-md border border-slate-300 bg-white text-xs font-semibold text-slate-900"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Right 4 Cols: Notifications + Database Neon + Server SMTP + Regole Commesse & Archivio Centrale Google Drive */}
      <div className="xl:col-span-4 space-y-4">
        <AdminNotificationControl variant="panel" />

        {/* Read-only Neon PostgreSQL Status & Optional Historical Import Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-slate-700 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900">
                Database PostgreSQL (Neon)
              </h2>
            </div>
            <button
              type="button"
              onClick={() => {
                void refreshNeonStatus();
              }}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              title="Aggiorna stato database Neon"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-500">Stato motore SQL:</span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                <Check className="w-4 h-4" />
                <span>Attivo · Letture illimitate</span>
              </span>
            </div>
            {neonStatus?.hostHint && (
              <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span className="font-sans text-xs text-slate-500">Host:</span>
                <span className="text-slate-700 truncate max-w-[190px]">
                  {neonStatus.hostHint}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
              <span className="font-sans text-xs text-slate-500">
                Record attivi:
              </span>
              <span className="text-slate-800">
                {directory.length} op. · {articles.length} art. · {tasks.length}{' '}
                task ({assignments.length} quote)
              </span>
            </div>
          </div>

          <button
            type="button"
            disabled={importingLegacy}
            onClick={handleImportLegacyFirestore}
            className="w-full inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer disabled:opacity-50"
            title="Copia nel database Neon eventuali dati già salvati nel precedente archivio Firebase (disponibile quando la quota giornaliera Firebase si azzera)"
          >
            <Download className="w-4 h-4" />
            <span>
              {importingLegacy
                ? 'Importazione storico in corso...'
                : 'Importa storico da Firebase (opzionale)'}
            </span>
          </button>
        </div>

        {/* Read-only SMTP Google + Safety Outbox Diagnostic & Test Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-slate-700 shrink-0" />
              <h2 className="text-sm font-semibold text-slate-900">
                Motore email SMTP Google + Coda di sicurezza
              </h2>
            </div>
            <button
              type="button"
              disabled={loadingSmtpStatus}
              onClick={() => void refreshSmtpStatus(true)}
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer disabled:opacity-50"
              title="Verifica stato SMTP_PASS"
            >
              <RefreshCw
                className={`w-4 h-4 ${loadingSmtpStatus ? 'animate-spin' : ''
                  }`}
              />
            </button>
          </div>

          <div className="divide-y divide-slate-100 border-y border-slate-100 text-xs">
            <div className="flex items-center justify-between gap-2 py-2.5">
              <span className="text-slate-500">Stato SMTP_PASS (H24):</span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                {!smtpCheckedOnce && loadingSmtpStatus ? (
                  <span>Verifica in corso...</span>
                ) : smtpStatusError ? (
                  <span className="text-red-700">Errore verifica</span>
                ) : smtpStatus?.smtpUsable ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                    <span>Attivo (smtp.gmail.com)</span>
                  </>
                ) : smtpStatus?.smtpAuthRevoked ? (
                  <span className="text-amber-700">
                    App Password da rigenerare
                  </span>
                ) : (
                  <span className="text-amber-700">
                    SMTP_PASS non configurato
                  </span>
                )}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-2.5 font-mono text-[11px] tabular-nums">
              <span className="font-sans text-xs text-slate-500">
                Mittente autenticato:
              </span>
              <span className="text-slate-800 truncate">
                {smtpStatus?.senderEmail || MASTER_DRIVE_OWNER_EMAIL}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-2.5">
              <span className="text-slate-500">Backup emergenza Gmail:</span>
              <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                <Check className="w-3.5 h-3.5 text-emerald-700" />
                <span>Attivo per invio coda</span>
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 py-2.5 font-mono text-[11px] tabular-nums">
              <span className="font-sans text-xs text-slate-500">
                Coda di sicurezza:
              </span>
              <span className="text-slate-800">
                {smtpStatus?.pendingOutboxCount || 0} riepiloghi in attesa
              </span>
            </div>
          </div>

          {smtpStatusError && (
            <p className="text-xs font-normal text-red-800 bg-red-50 border border-red-200 rounded-lg p-3 leading-relaxed">
              {smtpStatusError}
            </p>
          )}

          {smtpCheckedOnce && !smtpStatusError && !smtpStatus?.smtpUsable && (
            <div className="text-xs font-normal text-slate-700 border-t border-slate-100 pt-3 space-y-1.5 leading-relaxed">
              <p className="font-semibold text-amber-900">
                {smtpStatus?.smtpAuthRevoked
                  ? 'App Password Google revocata: rigenerala in 30 secondi'
                  : 'Configura SMTP_PASS per attivare l’invio immediato H24'}
              </p>
              <p>
                Apri <span className="font-mono font-semibold">myaccount.google.com/apppasswords</span> con <span className="font-mono">{MASTER_DRIVE_OWNER_EMAIL}</span>, crea una nuova password a 16 lettere e sostituiscila nel segreto <span className="font-mono font-semibold">SMTP_PASS</span> di AI Studio.
              </p>
              <p className="text-[11px] text-slate-500">
                Le App Password Google non scadono a tempo (vengono azzerate solo quando cambi la password principale dell&apos;account). Nel frattempo eventuali chiusure task vengono salvate nella coda di sicurezza senza perdere nulla.
              </p>
            </div>
          )}

          {(smtpStatus?.pendingOutboxCount || 0) > 0 && (
            <div className="border-t border-slate-100 pt-3 space-y-2.5">
              <div className="text-xs text-slate-700 space-y-1">
                <p className="font-semibold text-slate-900 tabular-nums">
                  {smtpStatus?.pendingOutboxCount}{' '}
                  {smtpStatus?.pendingOutboxCount === 1
                    ? 'riepilogo custodito nella coda protetta'
                    : 'riepiloghi custoditi nella coda protetta'}
                </p>
                {(smtpStatus?.pendingOutboxPreview || [])
                  .slice(0, 3)
                  .map((item) => (
                    <p
                      key={item.outboxId}
                      className="text-[11px] text-slate-600 truncate font-mono"
                    >
                      {item.subject} · CC: {item.cc.join(', ') || 'nessuno'}
                    </p>
                  ))}
              </div>
              <button
                type="button"
                disabled={flushingOutbox}
                onClick={() => setConfirmFlushOutboxOpen(true)}
                className="w-full inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 hover:bg-slate-800 text-xs font-semibold text-white cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                <Send className="w-3.5 h-3.5" />
                <span>
                  {flushingOutbox
                    ? 'Invio coda in corso...'
                    : `Invia riepiloghi in coda (${smtpStatus?.pendingOutboxCount})`}
                </span>
              </button>
            </div>
          )}

          <button
            type="button"
            disabled={sendingTestEmail}
            onClick={() => setConfirmTestSmtpOpen(true)}
            className="w-full inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <Send className="w-4 h-4" />
            <span>
              {sendingTestEmail
                ? 'Verifica invio SMTP in corso...'
                : 'Testa invio SMTP_PASS'}
            </span>
          </button>
        </div>

        <form
          onSubmit={handleSaveSettings}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <h2 className="text-sm font-semibold text-slate-900">
            Regole commesse, Google Drive e Google Sheets
          </h2>

          <div className="pt-4 border-t border-slate-100 space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Commesse esenti da note obbligatorie
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newCommessaExempt}
                onChange={(e) =>
                  setNewCommessaExempt(e.target.value.toUpperCase())
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddExemptCommessa();
                  }
                }}
                placeholder="Es. H265001"
                className="flex-1 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
              />
              <button
                type="button"
                onClick={handleAddExemptCommessa}
                className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>Aggiungi</span>
              </button>
            </div>

            {exemptList.length === 0 ? (
              <p className="text-xs font-normal text-slate-500">
                Tutte le commesse richiedono note obbligatorie alla chiusura.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2 pt-2">
                {exemptList.map((code) => (
                  <div
                    key={code}
                    className="inline-flex items-center gap-2 px-2 py-2 rounded-lg border border-slate-200 bg-slate-50 font-mono text-xs text-slate-800"
                  >
                    <span>{code}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setExemptList((prev) => prev.filter((c) => c !== code))
                      }
                      className="inline-flex items-center justify-center w-6 h-6 rounded border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                      aria-label={`Rimuovi ${code}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <FolderGit2 className="w-4 h-4 text-slate-600" />
                <span>Cartella centrale Google Drive</span>
              </label>
              <a
                href={`https://drive.google.com/drive/folders/${resolvedDriveFolderId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 whitespace-nowrap"
              >
                <span>Apri su Drive</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>

            <input
              type="text"
              required
              value={driveSharedFolderInput}
              onChange={(e) => setDriveSharedFolderInput(e.target.value)}
              placeholder={DEFAULT_DRIVE_SHARED_FOLDER_ID}
              className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
            />

            <div className="text-[11px] font-normal text-slate-500 space-y-2 leading-relaxed">
              <p>
                Proprietario archivio:{' '}
                <span className="font-mono font-semibold text-slate-800">
                  {MASTER_DRIVE_OWNER_EMAIL}
                </span>
              </p>
              <p className="font-mono tabular-nums text-slate-600">
                Account Workspace in anagrafica: {driveSyncStatus.sharedTargetsCount} · Foto esterne da consolidare:{' '}
                {driveSyncStatus.pendingConsolidationCount}
              </p>
              <p className="text-slate-500">
                Condivisione basata solo sull&apos;anagrafica attiva (<span className="font-mono">@sitespa.it</span> e <span className="font-mono">.id@sitespa.it</span>, escluse le caselle <span className="font-mono">@tecnicositespa.it</span> di sola posta).
              </p>
              {driveSyncStatus.lastSyncedAt && (
                <p className="font-mono tabular-nums text-slate-500">
                  Ultimo allineamento:{' '}
                  {formatDateTimeIt(driveSyncStatus.lastSyncedAt)}
                </p>
              )}
              {driveSyncStatus.error && (
                <p className="text-slate-900 font-semibold">{driveSyncStatus.error}</p>
              )}
            </div>

            <button
              type="button"
              disabled={driveSyncStatus.syncing}
              onClick={() =>
                syncMasterDrivePermissionsAndOwnership({ interactive: true })
              }
              className="w-full inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${driveSyncStatus.syncing ? 'animate-spin' : ''
                  }`}
              />
              <span>
                {driveSyncStatus.syncing
                  ? 'Allineamento Drive in corso...'
                  : 'Sincronizza permessi Drive'}
              </span>
            </button>
          </div>

          <div className="pt-4 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <FileSpreadsheet className="w-4 h-4 text-slate-600 shrink-0" />
                <span>Foglio settimanale Google Sheets (WK_XX)</span>
              </label>
              {resolvedGoogleSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${resolvedGoogleSheetId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 whitespace-nowrap shrink-0"
                >
                  <span>Apri foglio</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>

            <input
              type="text"
              value={googleSheetInput}
              onChange={(e) => {
                setGoogleSheetInput(e.target.value);
                setSheetDiagnosticError(null);
              }}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
            />

            <p className="text-[11px] font-normal text-slate-500 leading-relaxed">
              Compila le schede settimanali (es. <span className="font-mono">WK_45</span>) per ogni tecnico (<span className="font-mono">COGNOME</span> + <span className="font-mono">NOME</span>) da lunedì a domenica con task approvati e assenze, conservando colori e note manuali.
            </p>

            {sheetDiagnosticError && (
              <p className="text-xs font-normal text-red-800 bg-red-50 border border-red-200 rounded-lg p-3 leading-relaxed">
                {sheetDiagnosticError}
              </p>
            )}

            {sheetDiagnostic && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Documento:</span>
                  <span className="font-semibold text-slate-900 truncate max-w-[200px]">
                    {sheetDiagnostic.spreadsheetTitle}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                  <span className="font-sans text-xs text-slate-500">
                    Schede WK rilevate:
                  </span>
                  <span className="text-slate-800">
                    {sheetDiagnostic.wkTabs.length} ·{' '}
                    {sheetDiagnostic.matchedCurrentTab
                      ? `Attuale: ${sheetDiagnostic.matchedCurrentTab}`
                      : `${sheetDiagnostic.currentWeekCode} assente`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                  <span className="font-sans text-xs text-slate-500">
                    Tecnici allineati:
                  </span>
                  <span className="text-slate-800">
                    {sheetDiagnostic.matchedTechniciansCount} /{' '}
                    {sheetDiagnostic.totalActiveTechniciansCount}
                  </span>
                </div>
                {sheetDiagnostic.unmatchedTechnicianNames.length > 0 && (
                  <p className="pt-1 border-t border-slate-200 text-[11px] text-amber-800 leading-relaxed">
                    Non trovati nelle colonne COGNOME/NOME:{' '}
                    <span className="font-semibold">
                      {sheetDiagnostic.unmatchedTechnicianNames.join(', ')}
                    </span>
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              disabled={!googleSheetInput.trim() || verifyingSheet}
              onClick={handleVerifyGoogleSheet}
              className="w-full inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              <RefreshCw
                className={`w-4 h-4 ${verifyingSheet ? 'animate-spin' : ''}`}
              />
              <span>
                {verifyingSheet
                  ? 'Verifica foglio in corso...'
                  : 'Verifica collegamento foglio'}
              </span>
            </button>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              disabled={savingSettings}
              className="w-full inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>
                {savingSettings ? 'Salvataggio...' : 'Salva impostazioni'}
              </span>
            </button>
          </div>
        </form>

        {pendingCleanupPhotos.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex items-start gap-2">
              <HardDrive className="w-4 h-4 text-slate-700 shrink-0" />
              <div className="space-y-2 text-xs">
                <p className="font-semibold text-slate-900">
                  Spazio Google Drive personale recuperabile
                </p>
                <p className="text-slate-600 font-normal leading-relaxed">
                  {pendingCleanupPhotos.length} copie temporanee già consolidate su{' '}
                  <span className="font-mono">{MASTER_DRIVE_OWNER_EMAIL}</span>.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={cleaningUpDriveFiles}
              onClick={() => setConfirmCleanupOpen(true)}
              className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white cursor-pointer disabled:opacity-50"
            >
              {cleaningUpDriveFiles
                ? 'Rimozione copie temporanee...'
                : `Libera spazio personale (${pendingCleanupPhotos.length} file)`}
            </button>
          </div>
        )}
      </div>

      {/* Add / Edit Staff Modal */}
      {staffModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4">
          <form
            onSubmit={handleSaveStaff}
            className="w-full max-w-md rounded-xl bg-white border border-slate-200 p-6 animate-fluid-pop shadow-xl"
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-base font-semibold text-slate-900">
                {editingMember ? 'Modifica operatore' : 'Nuovo operatore'}
              </h3>
              <button
                type="button"
                onClick={() => setStaffModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Nome *
                  </label>
                  <input
                    type="text"
                    required
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                    placeholder="Mario"
                    className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-normal text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Cognome *
                  </label>
                  <input
                    type="text"
                    required
                    value={cognome}
                    onChange={(e) => setCognome(e.target.value)}
                    placeholder="Rossi"
                    className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-normal text-slate-900"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Account Google Workspace — Login &amp; Drive *
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value.toLowerCase())}
                  placeholder={
                    role === 'admin'
                      ? 'nome.cognome@sitespa.it'
                      : 'nome.cognome@sitespa.it oppure nome.cognome.id@sitespa.it'
                  }
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-sm text-slate-900"
                />
                <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">
                  {isLoginOnlyIdEmail(email)
                    ? 'Account .id@sitespa.it abilitato per Login e Google Drive: indica sotto la casella @tecnicositespa.it per invio/ricezione mail.'
                    : 'Se la casella è @sitespa.it completa, vale già sia per Google Workspace/Drive sia per invio/ricezione mail.'}
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="block text-xs font-semibold text-slate-700">
                    Casella solo posta (es. @tecnicositespa.it)
                  </label>
                  {isLoginOnlyIdEmail(email) &&
                    !secondaryEmail.trim() &&
                    suggestTecnicoMailFromIdEmail(email) && (
                      <button
                        type="button"
                        onClick={() =>
                          setSecondaryEmail(
                            suggestTecnicoMailFromIdEmail(email)
                          )
                        }
                        className="text-[11px] font-mono font-semibold text-slate-900 underline underline-offset-2 cursor-pointer"
                      >
                        Usa {suggestTecnicoMailFromIdEmail(email)}
                      </button>
                    )}
                </div>
                <input
                  type="email"
                  value={secondaryEmail}
                  onChange={(e) =>
                    setSecondaryEmail(e.target.value.toLowerCase())
                  }
                  placeholder="nome.cognome@tecnicositespa.it"
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-sm text-slate-900"
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Usata esclusivamente per invio/ricezione riepiloghi email (mai condivisa su Google Drive). Lascia vuoto per gli account @sitespa.it completi.
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Ruolo nel sistema
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as UserRole)}
                  disabled={
                    editingMember
                      ? editingMember.email.toLowerCase() ===
                      profile?.email.toLowerCase()
                      : false
                  }
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-normal bg-white text-slate-900 disabled:bg-slate-100"
                >
                  <option value="technician">
                    Tecnico (Portale Tecnico e App Mobile)
                  </option>
                  <option value="admin">
                    Admin (Portale Admin completo)
                  </option>
                </select>
              </div>

              <label className="flex items-center gap-2 pt-2 text-xs font-normal text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-slate-900"
                />
                <span>Operatore attivo per nuove assegnazioni</span>
              </label>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setStaffModalOpen(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={savingMember}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {savingMember ? 'Salvataggio...' : 'Salva operatore'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Staff Confirm */}
      <ConfirmModal
        open={Boolean(confirmDelete)}
        title="Rimuovere l'operatore dall'organico?"
        description={
          confirmDelete
            ? `L'operatore ${confirmDelete.nome} ${confirmDelete.cognome} (${confirmDelete.email}) non comparirà più nelle nuove assegnazioni.`
            : ''
        }
        confirmLabel="Rimuovi operatore"
        destructive
        loading={deletingMember}
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Personal Drive Temporary Copies Cleanup Confirm */}
      <ConfirmModal
        open={confirmCleanupOpen}
        title={`Eliminare ${pendingCleanupPhotos.length} copie temporanee dal tuo Google Drive?`}
        description={`Le foto originali sono già state consolidate nell'archivio centrale aziendale (${MASTER_DRIVE_OWNER_EMAIL}).`}
        confirmLabel="Elimina copie e libera spazio"
        destructive
        loading={cleaningUpDriveFiles}
        onConfirm={async () => {
          await cleanupMySupersededDrivePhotos();
          setConfirmCleanupOpen(false);
        }}
        onCancel={() => setConfirmCleanupOpen(false)}
      />

      {/* Test Email Explicit Confirmation Dialog */}
      <ConfirmModal
        open={confirmTestSmtpOpen}
        title="Testare l'invio tramite SMTP_PASS?"
        description={`Verrà inviato un messaggio di verifica all'indirizzo ${profile ? resolveDeliverableEmail(profile.email) : MASTER_DRIVE_OWNER_EMAIL
          } tramite SMTP Google (${MASTER_DRIVE_OWNER_EMAIL}), lo stesso canale H24 utilizzato dai tecnici alla chiusura degli interventi.`}
        confirmLabel="Conferma e invia prova"
        loading={sendingTestEmail}
        onConfirm={handleSendTestSmtpConfirmed}
        onCancel={() => setConfirmTestSmtpOpen(false)}
      />

      {/* Flush Queued Outbox Emails Explicit Confirmation Dialog */}
      <ConfirmModal
        open={confirmFlushOutboxOpen}
        title={`Inviare ${smtpStatus?.pendingOutboxCount || 0} riepiloghi in coda?`}
        description={`Verranno recapitati ${smtpStatus?.pendingOutboxCount || 0
          } riepiloghi di chiusura intervento a nome di ${MASTER_DRIVE_OWNER_EMAIL} verso gli Admin in A: e i rispettivi tecnici in CC:.`}
        confirmLabel="Conferma e invia coda"
        loading={flushingOutbox}
        onConfirm={handleFlushOutboxConfirmed}
        onCancel={() => setConfirmFlushOutboxOpen(false)}
      />
    </div>
  );
};
