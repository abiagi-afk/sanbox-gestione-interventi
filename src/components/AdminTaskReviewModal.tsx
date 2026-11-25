import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileSpreadsheet,
  FolderSync,
  X,
} from 'lucide-react';
import {
  Absence,
  areSameTechnicianEmails,
  Assignment,
  DEFAULT_DRIVE_SHARED_FOLDER_ID,
  extractDriveFolderId,
  extractGoogleSheetId,
  findStaffMemberByAnyEmail,
  getDeliverableEmail,
  InterventionPhoto,
  isLoginOnlyIdEmail,
  StaffMember,
  Task,
  TaskColorId,
  TaskStatus,
  UsedMaterial,
  VALIDATION_LIMITS,
} from '../types/domain';
import {
  reviewAutonomousTaskByAdmin,
  SelectedAssignee,
} from '../lib/firestoreService';
import {
  findTaskDriveSubfolderByName,
  formatTaskDriveSubfolderName,
  renameTaskDriveSubfolder,
  TEMPORARY_UNREVIEWED_FOLDER_PREFIX,
} from '../lib/workspaceApi';
import {
  findOverlappingAbsencesForTech,
  formatAbsenceDateSummary,
  resolveTaskColorId,
} from '../lib/calendarLayout';
import { collectImpactedWeekCodes } from '../lib/googleSheetsSync';
import { StatusIndicator } from './StatusIndicator';
import { TaskColorPicker } from './TaskColorPicker';

function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export interface ReviewCompletedPayload {
  task: Task;
  commessa: string;
  descrizione: string;
  inizioMs: number;
  fineMs: number;
  resultingTaskStatus: TaskStatus;
  updatedAssignments: Assignment[];
  syncGoogleSheet: boolean;
}

interface AdminTaskReviewModalProps {
  open: boolean;
  task: Task | null;
  taskAssignments: Assignment[];
  taskMaterials: UsedMaterial[];
  taskPhotos: InterventionPhoto[];
  directory: StaffMember[];
  absences: Absence[];
  adminUid: string;
  currentAdminUids: string[];
  activeAdminEmails: string[];
  masterDriveFolderId?: string;
  googleSheetId?: string;
  operatorColorLabels?: Partial<Record<TaskColorId, string>> | null;
  connectGoogleWorkspace: () => Promise<string>;
  onClose: () => void;
  onReviewCompleted: (payload: ReviewCompletedPayload) => void;
  onToast: (msg: string, tone?: 'success' | 'error' | 'info') => void;
}

export const AdminTaskReviewModal: React.FC<AdminTaskReviewModalProps> = ({
  open,
  task,
  taskAssignments,
  taskMaterials,
  taskPhotos,
  directory,
  absences,
  adminUid,
  currentAdminUids,
  activeAdminEmails,
  masterDriveFolderId,
  googleSheetId,
  operatorColorLabels,
  connectGoogleWorkspace,
  onClose,
  onReviewCompleted,
  onToast,
}) => {
  const [commessa, setCommessa] = useState('');
  const [descrizione, setDescrizione] = useState('');
  const [inizioLocal, setInizioLocal] = useState('');
  const [fineLocal, setFineLocal] = useState('');
  const [colorId, setColorId] = useState<TaskColorId>('peacock');
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const [markAddedColleaguesCompleted, setMarkAddedColleaguesCompleted] =
    useState(true);
  const [forceAbsentOverride, setForceAbsentOverride] = useState(false);
  const [confirmDriveRename, setConfirmDriveRename] = useState(true);
  const [confirmSheetSync, setConfirmSheetSync] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const hasGoogleSheet = Boolean(extractGoogleSheetId(googleSheetId));

  useEffect(() => {
    if (!open || !task) return;
    setCommessa(task.commessa || '');
    setDescrizione(task.descrizione || '');
    setInizioLocal(toLocalDateTimeInput(task.inizioMs));
    setFineLocal(toLocalDateTimeInput(task.fineMs));
    setColorId(resolveTaskColorId(task));
    const resolvedPreselected = Array.from(
      new Set(
        task.assignedEmails.map((e) => {
          const staff = findStaffMemberByAnyEmail(e, directory);
          return (staff ? staff.email : e).trim().toLowerCase();
        })
      )
    );
    setSelectedEmails(resolvedPreselected);
    setMarkAddedColleaguesCompleted(task.statoPrevalente === 'Completato');
    setForceAbsentOverride(false);
    setConfirmDriveRename(true);
    setConfirmSheetSync(true);
  }, [open, task, directory]);

  const activeStaff = useMemo(() => {
    const list = directory.filter((m) => m.active);
    if (task) {
      task.assignedEmails.forEach((em, idx) => {
        const lower = em.toLowerCase();
        if (!list.some((m) => areSameTechnicianEmails(m.email, lower, directory))) {
          const full = task.assignedNames[idx] || em;
          const parts = full.split(/\s+/);
          const storedDeliv = (
            task.assignedDeliverableEmails?.[idx] || ''
          )
            .trim()
            .toLowerCase();
          list.unshift({
            memberId: `rev_${lower}`,
            email: lower,
            secondaryEmail:
              storedDeliv && storedDeliv !== lower ? storedDeliv : undefined,
            nome: parts[0] || full,
            cognome: parts.slice(1).join(' ') || '',
            role: 'technician',
            active: true,
            linkedUid: '',
            adminUids: task.adminUids,
            createdByUid: task.createdByUid,
          });
        }
      });
    }
    return list;
  }, [directory, task]);

  const parsedWindow = useMemo(() => {
    const s = new Date(inizioLocal).getTime();
    const e = new Date(fineLocal).getTime();
    return {
      inizioMs: Number.isNaN(s) ? task?.inizioMs || 0 : s,
      fineMs: Number.isNaN(e) ? task?.fineMs || 0 : e,
    };
  }, [inizioLocal, fineLocal, task]);

  const absentConflictsByEmail = useMemo(() => {
    const map = new Map<string, Absence[]>();
    for (const m of activeStaff) {
      const overlaps = findOverlappingAbsencesForTech(
        absences,
        m.email,
        parsedWindow.inizioMs,
        parsedWindow.fineMs,
        directory
      );
      if (overlaps.length > 0) {
        map.set(m.email.toLowerCase(), overlaps);
      }
    }
    return map;
  }, [activeStaff, absences, parsedWindow, directory]);

  if (!open || !task) return null;

  const selectedAbsentEmails = selectedEmails.filter((em) =>
    absentConflictsByEmail.has(em)
  );
  const addedColleaguesCount = selectedEmails.filter(
    (em) => !task.assignedEmails.some((x) => areSameTechnicianEmails(x, em, directory))
  ).length;

  const cleanUpperCommessa = commessa.trim().toUpperCase();
  const oldTempFolderName = `${TEMPORARY_UNREVIEWED_FOLDER_PREFIX} - ${task.taskCode}`;
  const targetDriveFolderName = cleanUpperCommessa
    ? formatTaskDriveSubfolderName(cleanUpperCommessa, task.taskCode)
    : `${'<Commessa>'} - ${task.taskCode}`;

  const reviewWeekCodesLabel =
    parsedWindow.inizioMs > 0 && parsedWindow.fineMs > 0
      ? collectImpactedWeekCodes([parsedWindow]).join(', ')
      : '';

  const toggleEmail = (emailLower: string) => {
    const isSelected = selectedEmails.includes(emailLower);
    if (isSelected) {
      setSelectedEmails((prev) => prev.filter((x) => x !== emailLower));
      return;
    }
    if (absentConflictsByEmail.has(emailLower) && !forceAbsentOverride) {
      onToast(
        'Tecnico assente o con impegno nella fascia oraria. Attiva "Forza su assente / impegno" per aggiungerlo.',
        'info'
      );
      return;
    }
    setSelectedEmails((prev) => [...prev, emailLower]);
  };

  const handleConfirmReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cleanUpperCommessa) {
      onToast('Inserire il codice Commessa definitivo.', 'error');
      return;
    }
    if (selectedAbsentEmails.length > 0 && !forceAbsentOverride) {
      onToast(
        'Conferma la forzatura per assegnare tecnici segnati assenti o con impegni in questa fascia.',
        'error'
      );
      return;
    }
    if (taskPhotos.length > 0 && !confirmDriveRename) {
      onToast(
        'Conferma la rinomina della cartella Google Drive per allineare le foto caricate alla commessa.',
        'info'
      );
      return;
    }

    const assignees: SelectedAssignee[] = selectedEmails.map((em) => {
      const m =
        activeStaff.find((s) => s.email.toLowerCase() === em) ||
        findStaffMemberByAnyEmail(em, activeStaff);
      return {
        email: m ? m.email.trim().toLowerCase() : em,
        fullName: m ? `${m.nome} ${m.cognome}`.trim() : em,
        linkedUid: m?.linkedUid || '',
        deliverableEmail: m
          ? getDeliverableEmail(m)
          : isLoginOnlyIdEmail(em)
            ? ''
            : em,
      };
    });

    setSubmitting(true);
    try {
      let renamedFolderPath: string | undefined;
      let resolvedSubfolderId: string | undefined;

      const knownSubfolderId =
        taskPhotos.find((p) => p.driveSubfolderId)?.driveSubfolderId || '';

      if (taskPhotos.length > 0 || knownSubfolderId) {
        try {
          const accessToken = await connectGoogleWorkspace();
          let folderIdToRename = knownSubfolderId;

          if (!folderIdToRename) {
            const found = await findTaskDriveSubfolderByName({
              accessToken,
              masterFolderId: extractDriveFolderId(
                masterDriveFolderId || DEFAULT_DRIVE_SHARED_FOLDER_ID
              ),
              folderName: oldTempFolderName,
            });
            if (found) {
              folderIdToRename = found.id;
            }
          }

          if (folderIdToRename) {
            const renameRes = await renameTaskDriveSubfolder({
              accessToken,
              subfolderId: folderIdToRename,
              newCommessa: cleanUpperCommessa,
              taskCode: task.taskCode,
            });
            renamedFolderPath = renameRes.newFolderPath;
            resolvedSubfolderId = renameRes.subfolderId;
          }
        } catch (driveErr) {
          onToast(
            driveErr instanceof Error
              ? `Task revisionato, ma rinomina cartella Drive non riuscita: ${driveErr.message}`
              : 'Rinomina cartella Google Drive non riuscita.',
            'info'
          );
        }
      }

      const { resultingTaskStatus, updatedAssignments } =
        await reviewAutonomousTaskByAdmin({
          task,
          existingTaskAssignments: taskAssignments,
          existingTaskMaterials: taskMaterials,
          existingTaskPhotos: taskPhotos,
          commessa: cleanUpperCommessa,
          descrizione,
          inizioIso: inizioLocal,
          fineIso: fineLocal,
          colorId,
          assignees,
          markAddedColleaguesCompleted,
          newFolderPath:
            renamedFolderPath ||
            formatTaskDriveSubfolderName(cleanUpperCommessa, task.taskCode),
          resolvedSubfolderId,
          adminUid,
          currentAdminUids,
          activeAdminEmails,
          directory,
        });

      onToast(
        renamedFolderPath
          ? `Task ${task.taskCode} revisionato su Commessa ${cleanUpperCommessa} · Cartella Drive rinominata.`
          : `Task ${task.taskCode} revisionato su Commessa ${cleanUpperCommessa}.`,
        'success'
      );

      onReviewCompleted({
        task: {
          ...task,
          commessa: cleanUpperCommessa,
          descrizione: descrizione.trim(),
          inizioMs: parsedWindow.inizioMs,
          fineMs: parsedWindow.fineMs,
          assignedEmails: assignees.map((a) => a.email),
          assignedNames: assignees.map((a) => a.fullName),
          assignedDeliverableEmails: assignees.map(
            (a) => a.deliverableEmail || a.email
          ),
          statoPrevalente: resultingTaskStatus,
          pendingAdminReview: false,
          colorId,
        },
        commessa: cleanUpperCommessa,
        descrizione: descrizione.trim(),
        inizioMs: parsedWindow.inizioMs,
        fineMs: parsedWindow.fineMs,
        resultingTaskStatus,
        updatedAssignments,
        syncGoogleSheet:
          hasGoogleSheet && confirmSheetSync && assignees.length > 0,
      });
      onClose();
    } catch (err) {
      onToast(
        err instanceof Error
          ? err.message
          : 'Errore durante la revisione del task autonomo.',
        'error'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-modal-title"
    >
      <div className="w-full sm:max-w-2xl rounded-t-2xl sm:rounded-xl bg-white border border-slate-200 max-h-[92vh] flex flex-col overflow-hidden animate-fluid-sheet sm:animate-fluid-pop shadow-xl">
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ClipboardCheck className="w-4 h-4 text-slate-700 shrink-0" />
            <div className="min-w-0">
              <h3
                id="review-modal-title"
                className="text-base font-semibold text-slate-900 truncate"
              >
                Revisione task autonomo · {task.taskCode}
              </h3>
              <p className="text-xs font-normal text-slate-500 truncate">
                Inserito da {task.assignedNames.join(', ') || 'Tecnico'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer"
            aria-label="Chiudi finestra"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form
          onSubmit={handleConfirmReview}
          className="p-6 space-y-4 overflow-y-auto"
        >
          {/* Current Field Summary */}
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <span>Stato attuale:</span>
                <StatusIndicator status={task.statoPrevalente} />
              </div>
              <div className="font-mono tabular-nums">
                Materiali: {taskMaterials.length} · Foto Drive: {taskPhotos.length}
              </div>
            </div>
            {taskAssignments.some((a) => a.noteTecnico.trim()) && (
              <div className="pt-2 border-t border-slate-200 text-xs text-slate-700 space-y-2">
                <div className="font-semibold text-slate-900">
                  Note inserite dal tecnico:
                </div>
                {taskAssignments
                  .filter((a) => a.noteTecnico.trim())
                  .map((a) => (
                    <p key={a.assignmentId} className="whitespace-pre-line font-normal">
                      <span className="font-semibold">{a.technicianName}:</span>{' '}
                      {a.noteTecnico}
                    </p>
                  ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2">
                Codice commessa definitivo *
              </label>
              <input
                type="text"
                value={commessa}
                onChange={(e) => setCommessa(e.target.value.toUpperCase())}
                placeholder="Es. C26045"
                maxLength={VALIDATION_LIMITS.COMMESSA_MAX_LEN}
                required
                autoFocus
                className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Inizio *
                </label>
                <input
                  type="datetime-local"
                  value={inizioLocal}
                  onChange={(e) => setInizioLocal(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Fine *
                </label>
                <input
                  type="datetime-local"
                  value={fineLocal}
                  onChange={(e) => setFineLocal(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-2 py-2 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              Descrizione attività *
            </label>
            <textarea
              rows={2}
              value={descrizione}
              onChange={(e) => setDescrizione(e.target.value)}
              maxLength={VALIDATION_LIMITS.TASK_DESC_MAX_LEN}
              required
              className="w-full px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-normal text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 resize-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-2">
              Colore evento / operatore
            </label>
            <TaskColorPicker
              value={colorId}
              onChange={setColorId}
              operatorColorLabels={operatorColorLabels}
            />
          </div>

          {/* Squad Selection + Absent Conflict Guard */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <label className="text-xs font-semibold text-slate-700">
                Squadra tecnici ({selectedEmails.length})
              </label>
              {absentConflictsByEmail.size > 0 && (
                <label className="inline-flex items-center gap-2 text-xs font-normal text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forceAbsentOverride}
                    onChange={(e) => setForceAbsentOverride(e.target.checked)}
                    className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                  />
                  <span>Forza su assente / impegno</span>
                </label>
              )}
            </div>

            <div className="max-h-40 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
              {activeStaff.map((member) => {
                const lower = member.email.toLowerCase();
                const checked = selectedEmails.includes(lower);
                const overlaps = absentConflictsByEmail.get(lower);
                const isAbsent = Boolean(overlaps && overlaps.length > 0);
                const blocked = isAbsent && !forceAbsentOverride && !checked;

                return (
                  <label
                    key={lower}
                    className={`flex items-center justify-between gap-4 px-4 py-2 text-xs transition-colors ${blocked
                        ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                        : checked
                          ? 'bg-slate-50 text-slate-900 cursor-pointer'
                          : 'hover:bg-slate-50 text-slate-700 cursor-pointer'
                      }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={blocked}
                        onChange={() => toggleEmail(lower)}
                        className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                      />
                      <span className="font-semibold truncate">
                        {member.cognome} {member.nome}
                      </span>
                    </div>
                    {isAbsent && overlaps && (
                      <span className="inline-flex items-center gap-2 text-[11px] font-normal text-slate-600 shrink-0">
                        <AlertTriangle className="w-3.5 h-3.5 text-slate-700" />
                        <span>
                          {overlaps[0].tipo} ({formatAbsenceDateSummary(overlaps[0])})
                        </span>
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>

          {task.statoPrevalente === 'Completato' && addedColleaguesCount > 0 && (
            <label className="flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-300 p-4 text-xs font-normal text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={markAddedColleaguesCompleted}
                onChange={(e) =>
                  setMarkAddedColleaguesCompleted(e.target.checked)
                }
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <span>
                Segna come <span className="font-semibold">Completato</span> anche i {addedColleaguesCount} colleghi aggiunti ora in squadra.
              </span>
            </label>
          )}

          {/* Explicit Google Drive Rename Confirmation when photos exist */}
          {taskPhotos.length > 0 && (
            <label className="flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-300 p-4 text-xs font-normal text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmDriveRename}
                onChange={(e) => setConfirmDriveRename(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <div className="space-y-2">
                <div className="font-semibold text-slate-900 flex items-center gap-2">
                  <FolderSync className="w-4 h-4 text-slate-700 shrink-0" />
                  <span>
                    Rinomina cartella Google Drive ({taskPhotos.length} foto)
                  </span>
                </div>
                <p className="text-slate-600">
                  Da <span className="font-mono">{oldTempFolderName}</span> a{' '}
                  <span className="font-mono font-semibold text-slate-900">
                    {targetDriveFolderName}
                  </span>
                  .
                </p>
              </div>
            </label>
          )}

          {hasGoogleSheet && selectedEmails.length > 0 && (
            <label className="flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-300 p-4 text-xs font-normal text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmSheetSync}
                onChange={(e) => setConfirmSheetSync(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              <div className="space-y-1">
                <div className="font-semibold text-slate-900 flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-slate-700 shrink-0" />
                  <span>
                    Scrivi task approvato sul foglio Google Sheet
                    {reviewWeekCodesLabel ? ` (${reviewWeekCodesLabel})` : ''}
                  </span>
                </div>
                <p className="text-slate-600">
                  Inserisce la descrizione attività nelle celle dei tecnici selezionati conservando le note manuali.
                </p>
              </div>
            </label>
          )}

          {task.statoPrevalente === 'Completato' && (
            <div className="flex items-center gap-2 text-xs font-normal text-slate-700">
              <CheckCircle2 className="w-4 h-4 text-slate-900 shrink-0" />
              <span>
                Al salvataggio si aprirà il riepilogo email per Admin e squadra tecnici.
              </span>
            </div>
          )}

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors whitespace-nowrap cursor-pointer"
            >
              Annulla
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              {submitting
                ? 'Revisione in corso...'
                : 'Conferma revisione'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
