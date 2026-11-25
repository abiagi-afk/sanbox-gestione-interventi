import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarOff, FileSpreadsheet, Trash2, X } from 'lucide-react';
import {
  Absence,
  AbsenceType,
  areSameTechnicianEmails,
  extractGoogleSheetId,
  findStaffMemberByAnyEmail,
  isNonAbsenceEntryType,
  NON_ABSENCE_ENTRY_TYPES,
  StaffMember,
  TRUE_ABSENCE_TYPES,
  VALIDATION_LIMITS,
} from '../types/domain';
import { deleteAbsenceById, upsertAbsence } from '../lib/firestoreService';
import { collectImpactedWeekCodes } from '../lib/googleSheetsSync';

function toLocalDateStr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalDateTimeStr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function computeLocalAbsenceInterval(params: {
  allDay: boolean;
  startDate: string;
  endDate: string;
  startDateTime: string;
  endDateTime: string;
}): { inizioMs: number; fineMs: number } | null {
  if (params.allDay) {
    const sp = params.startDate.slice(0, 10).split('-').map(Number);
    const ep = params.endDate.slice(0, 10).split('-').map(Number);
    if (sp.length !== 3 || ep.length !== 3) return null;
    const s = new Date(sp[0], sp[1] - 1, sp[2], 0, 0, 0, 0).getTime();
    const e = new Date(ep[0], ep[1] - 1, ep[2] + 1, 0, 0, 0, 0).getTime();
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
    return { inizioMs: s, fineMs: e };
  }
  const s = new Date(params.startDateTime).getTime();
  const e = new Date(params.endDateTime).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return { inizioMs: s, fineMs: e };
}

export interface AbsenceMutationSheetPayload {
  prevAbsence: Absence | null;
  nextAbsence: Absence | null;
  syncGoogleSheet: boolean;
}

interface AbsenceModalProps {
  open: boolean;
  existingAbsence?: Absence | null;
  isAdminActor: boolean;
  actorUid: string;
  selfTechnician?: {
    email: string;
    fullName: string;
    uid: string;
  };
  availableTechnicians?: StaffMember[];
  preselectedTechEmail?: string;
  initialDateMs?: number;
  knownAdminUids: string[];
  googleSheetId?: string;
  onAbsenceMutated?: (
    payload: AbsenceMutationSheetPayload
  ) => void | Promise<void>;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

export const AbsenceModal: React.FC<AbsenceModalProps> = ({
  open,
  existingAbsence,
  isAdminActor,
  actorUid,
  selfTechnician,
  availableTechnicians = [],
  preselectedTechEmail,
  initialDateMs,
  knownAdminUids,
  googleSheetId,
  onAbsenceMutated,
  onClose,
  onSaved,
  onError,
}) => {
  const activeTechOptions = useMemo(() => {
    const list = availableTechnicians.filter((m) => m.active);
    if (
      existingAbsence &&
      !list.some((m) =>
        areSameTechnicianEmails(
          m.email,
          existingAbsence.technicianEmail,
          availableTechnicians
        )
      )
    ) {
      const parts = existingAbsence.technicianName.split(/\s+/);
      list.unshift({
        memberId: 'existing_temp',
        email: existingAbsence.technicianEmail,
        nome: parts[0] || existingAbsence.technicianName,
        cognome: parts.slice(1).join(' ') || '',
        role: 'technician',
        active: true,
        linkedUid: existingAbsence.technicianUid,
        adminUids: existingAbsence.adminUids,
        createdByUid: existingAbsence.createdByUid,
      });
    }
    return list;
  }, [availableTechnicians, existingAbsence]);

  const [selectedTechEmail, setSelectedTechEmail] = useState('');
  const [tipo, setTipo] = useState<AbsenceType>('Ferie');
  const [allDay, setAllDay] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [startDateTime, setStartDateTime] = useState('');
  const [endDateTime, setEndDateTime] = useState('');
  const [note, setNote] = useState('');
  const [syncGoogleSheet, setSyncGoogleSheet] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const hasGoogleSheet =
    isAdminActor && Boolean(extractGoogleSheetId(googleSheetId));

  const initializedSessionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      initializedSessionKeyRef.current = null;
      return;
    }

    const sessionKey = existingAbsence
      ? `edit:${existingAbsence.absenceId}`
      : `new:${preselectedTechEmail || ''}:${initialDateMs || ''}`;

    if (initializedSessionKeyRef.current === sessionKey) {
      return;
    }
    initializedSessionKeyRef.current = sessionKey;

    setConfirmingDelete(false);
    setSyncGoogleSheet(true);
    const baseMs = initialDateMs || Date.now();
    const baseDay = new Date(baseMs);
    const defaultStartDt = new Date(
      baseDay.getFullYear(),
      baseDay.getMonth(),
      baseDay.getDate(),
      9,
      0,
      0,
      0
    ).getTime();
    const defaultEndDt = new Date(
      baseDay.getFullYear(),
      baseDay.getMonth(),
      baseDay.getDate(),
      13,
      0,
      0,
      0
    ).getTime();

    if (existingAbsence) {
      const matched = findStaffMemberByAnyEmail(
        existingAbsence.technicianEmail,
        activeTechOptions
      );
      setSelectedTechEmail(
        (matched ? matched.email : existingAbsence.technicianEmail).toLowerCase()
      );
      setTipo(existingAbsence.tipo);
      setAllDay(existingAbsence.allDay);
      const effectiveEndMs = Math.max(
        existingAbsence.inizioMs,
        existingAbsence.fineMs - 1
      );
      setStartDate(toLocalDateStr(existingAbsence.inizioMs));
      setEndDate(toLocalDateStr(effectiveEndMs));
      setStartDateTime(toLocalDateTimeStr(existingAbsence.inizioMs));
      setEndDateTime(toLocalDateTimeStr(existingAbsence.fineMs));
      setNote(existingAbsence.note || '');
    } else {
      const initialEmail = isAdminActor
        ? (
          preselectedTechEmail ||
          activeTechOptions[0]?.email ||
          selfTechnician?.email ||
          ''
        ).toLowerCase()
        : (selfTechnician?.email || '').toLowerCase();
      setSelectedTechEmail(initialEmail);
      setTipo('Ferie');
      setAllDay(true);
      const dayStr = toLocalDateStr(baseMs);
      setStartDate(dayStr);
      setEndDate(dayStr);
      setStartDateTime(toLocalDateTimeStr(defaultStartDt));
      setEndDateTime(toLocalDateTimeStr(defaultEndDt));
      setNote('');
    }
  }, [
    open,
    existingAbsence,
    isAdminActor,
    preselectedTechEmail,
    activeTechOptions,
    selfTechnician,
    initialDateMs,
  ]);

  // Se l'anagrafica tecnici arriva dopo l'apertura della modale, valorizza solo il tecnico vuoto senza toccare gli altri campi
  useEffect(() => {
    if (!open || existingAbsence || !isAdminActor || selectedTechEmail) return;
    const fallbackEmail = (
      preselectedTechEmail ||
      activeTechOptions[0]?.email ||
      selfTechnician?.email ||
      ''
    ).toLowerCase();
    if (fallbackEmail) {
      setSelectedTechEmail(fallbackEmail);
    }
  }, [
    open,
    existingAbsence,
    isAdminActor,
    selectedTechEmail,
    preselectedTechEmail,
    activeTechOptions,
    selfTechnician,
  ]);
  if (!open) return null;

  const resolvedTech = (() => {
    if (!isAdminActor && selfTechnician) {
      return {
        email: selfTechnician.email,
        fullName: selfTechnician.fullName,
        uid: selfTechnician.uid,
      };
    }
    const found =
      activeTechOptions.find(
        (m) => m.email.toLowerCase() === selectedTechEmail.toLowerCase()
      ) || findStaffMemberByAnyEmail(selectedTechEmail, activeTechOptions);
    if (found) {
      return {
        email: found.email,
        fullName: `${found.nome} ${found.cognome}`.trim(),
        uid: found.linkedUid || '',
      };
    }
    if (selfTechnician) {
      return selfTechnician;
    }
    return { email: '', fullName: '', uid: '' };
  })();

  const draftInterval = computeLocalAbsenceInterval({
    allDay,
    startDate,
    endDate,
    startDateTime,
    endDateTime,
  });

  const impactedWeekCodesLabel = (() => {
    const intervals: Array<{ inizioMs: number; fineMs: number }> = [];
    if (existingAbsence) {
      intervals.push({
        inizioMs: existingAbsence.inizioMs,
        fineMs: existingAbsence.fineMs,
      });
    }
    if (draftInterval) {
      intervals.push(draftInterval);
    }
    return collectImpactedWeekCodes(intervals).join(', ');
  })();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvedTech.email) {
      onError('Selezionare un tecnico valido.');
      return;
    }

    setSaving(true);
    try {
      const savedAbsenceId = await upsertAbsence({
        existingAbsence: existingAbsence || undefined,
        technicianEmail: resolvedTech.email,
        technicianName: resolvedTech.fullName,
        technicianUid: resolvedTech.uid,
        tipo,
        allDay,
        startDateOrIso: allDay ? startDate : startDateTime,
        endDateOrIso: allDay ? endDate : endDateTime,
        note,
        actorUid,
        isAdminActor,
        knownAdminUids,
      });
      const isCommitment = isNonAbsenceEntryType(tipo);
      onSaved(
        existingAbsence
          ? isCommitment
            ? `${tipo} aggiornata (${resolvedTech.fullName}).`
            : `Assenza aggiornata (${resolvedTech.fullName} · ${tipo}).`
          : isCommitment
            ? `${tipo} registrata (${resolvedTech.fullName}).`
            : `Assenza registrata (${resolvedTech.fullName} · ${tipo}).`
      );
      if (onAbsenceMutated && draftInterval) {
        const nextAbsenceObj: Absence = {
          absenceId: savedAbsenceId,
          technicianEmail: resolvedTech.email.trim().toLowerCase(),
          technicianName: resolvedTech.fullName,
          technicianUid: resolvedTech.uid,
          tipo,
          allDay,
          inizio: new Date(draftInterval.inizioMs).toISOString(),
          fine: new Date(draftInterval.fineMs).toISOString(),
          inizioMs: draftInterval.inizioMs,
          fineMs: draftInterval.fineMs,
          note: note.trim(),
          createdByUid: existingAbsence?.createdByUid || actorUid,
          createdByRole: isAdminActor ? 'admin' : 'technician',
          adminUids: knownAdminUids,
        };
        await onAbsenceMutated({
          prevAbsence: existingAbsence || null,
          nextAbsence: nextAbsenceObj,
          syncGoogleSheet: hasGoogleSheet && syncGoogleSheet,
        });
      }
      onClose();
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Errore salvataggio assenza.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!existingAbsence) return;
    setSaving(true);
    try {
      await deleteAbsenceById(existingAbsence.absenceId);
      const removedLabel = isNonAbsenceEntryType(existingAbsence.tipo)
        ? `${existingAbsence.tipo} rimossa`
        : 'Assenza rimossa';
      onSaved(`${removedLabel} per ${existingAbsence.technicianName}.`);
      if (onAbsenceMutated) {
        await onAbsenceMutated({
          prevAbsence: existingAbsence,
          nextAbsence: null,
          syncGoogleSheet: hasGoogleSheet && syncGoogleSheet,
        });
      }
      onClose();
    } catch (err) {
      onError(
        err instanceof Error ? err.message : 'Errore rimozione assenza.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="absence-modal-title"
    >
      <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl bg-white border border-slate-200 max-h-[92vh] flex flex-col overflow-hidden animate-fluid-sheet sm:animate-fluid-pop shadow-xl">
        <div className="flex items-center justify-between gap-4 p-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <CalendarOff className="w-4 h-4 text-slate-700 shrink-0" />
            <h3
              id="absence-modal-title"
              className="text-base font-semibold text-slate-900 truncate"
            >
              {isNonAbsenceEntryType(tipo)
                ? existingAbsence
                  ? `Modifica ${tipo}`
                  : `Registra ${tipo}`
                : existingAbsence
                  ? 'Modifica assenza'
                  : 'Registra assenza'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer shrink-0"
            aria-label="Chiudi finestra"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
          {isAdminActor ? (
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                Tecnico interessato *
              </label>
              <select
                value={selectedTechEmail}
                onChange={(e) => setSelectedTechEmail(e.target.value)}
                required
                className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:border-slate-900"
              >
                {activeTechOptions.length === 0 && (
                  <option value="">Nessun tecnico attivo in organico</option>
                )}
                {activeTechOptions.map((m) => (
                  <option key={m.email} value={m.email.toLowerCase()}>
                    {m.cognome} {m.nome} ({m.email})
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
              <div className="text-xs text-slate-500">Tecnico</div>
              <div className="text-sm font-semibold text-slate-900">
                {resolvedTech.fullName}{' '}
                <span className="font-normal text-slate-500">
                  · {resolvedTech.email}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                Causale assenza *
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {TRUE_ABSENCE_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setTipo(t);
                      if (t === 'Permesso' && !existingAbsence) {
                        setAllDay(false);
                      }
                    }}
                    className={`min-h-[40px] px-2 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${tipo === t
                        ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                      }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-700">
                Attività / visite di servizio (non figurano come assenze)
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {NON_ABSENCE_ENTRY_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setTipo(t);
                      if (!existingAbsence) {
                        setAllDay(false);
                      }
                    }}
                    className={`min-h-[40px] px-3 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${tipo === t
                        ? t === 'Visita Medica'
                          ? 'bg-sky-900 text-white border-sky-950 hover:bg-sky-800'
                          : 'bg-violet-900 text-white border-violet-950 hover:bg-violet-800'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                      }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Modalità oraria
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAllDay(true)}
                className={`min-h-[40px] px-4 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${allDay
                    ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                Giornata intera
              </button>
              <button
                type="button"
                onClick={() => setAllDay(false)}
                className={`min-h-[40px] px-4 py-2 rounded-lg text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${!allDay
                    ? 'bg-slate-900 text-white border-slate-950 hover:bg-slate-800'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                  }`}
              >
                Fascia oraria
              </button>
            </div>
          </div>

          {allDay ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Dal giorno *
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    setStartDate(v);
                    if (endDate && v > endDate) {
                      setEndDate(v);
                    }
                  }}
                  required
                  className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Al giorno (incluso) *
                </label>
                <input
                  type="date"
                  value={endDate}
                  min={startDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  {isNonAbsenceEntryType(tipo) ? 'Inizio *' : 'Inizio assenza *'}
                </label>
                <input
                  type="datetime-local"
                  value={startDateTime}
                  onChange={(e) => setStartDateTime(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  {isNonAbsenceEntryType(tipo) ? 'Fine *' : 'Fine assenza *'}
                </label>
                <input
                  type="datetime-local"
                  value={endDateTime}
                  onChange={(e) => setEndDateTime(e.target.value)}
                  required
                  className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono tabular-nums text-slate-900 focus:outline-none focus:border-slate-900"
                />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Note opzionali
            </label>
            <textarea
              rows={2}
              maxLength={VALIDATION_LIMITS.ABSENCE_NOTE_MAX_LEN}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Es. Sede visita medica, assemblea sindacale, dettagli..."
              className="w-full px-4 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:outline-none focus:border-slate-900 resize-none"
            />
          </div>

          {hasGoogleSheet && !confirmingDelete && (
            <label className="flex items-start gap-2.5 rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={syncGoogleSheet}
                onChange={(e) => setSyncGoogleSheet(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 shrink-0"
              />
              <div className="min-w-0 space-y-0.5">
                <div className="font-semibold text-slate-900 flex items-center gap-1.5">
                  <FileSpreadsheet className="w-3.5 h-3.5 text-slate-700 shrink-0" />
                  <span>
                    Aggiorna anche foglio Google Sheet
                    {impactedWeekCodesLabel
                      ? ` (${impactedWeekCodesLabel})`
                      : ''}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500">
                  Scrive l&apos;annotazione sulle celle del tecnico mantenendo eventuali note manuali.
                </p>
              </div>
            </label>
          )}

          {existingAbsence && confirmingDelete ? (
            <div className="rounded-xl bg-slate-50 border border-slate-300 p-4 space-y-4">
              <p className="text-xs font-semibold text-slate-900">
                {isNonAbsenceEntryType(existingAbsence.tipo)
                  ? `Confermi la rimozione definitiva di questa ${existingAbsence.tipo.toLowerCase()}?`
                  : 'Confermi la rimozione definitiva di questa assenza?'}
              </p>
              {hasGoogleSheet && (
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={syncGoogleSheet}
                    onChange={(e) => setSyncGoogleSheet(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 shrink-0"
                  />
                  <span>
                    Rimuovi la voce anche dal foglio Google Sheet
                    {impactedWeekCodesLabel
                      ? ` (${impactedWeekCodesLabel})`
                      : ''}
                  </span>
                </label>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={saving}
                  className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={saving}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-red-700 border border-red-900 text-xs font-semibold text-white hover:bg-red-800 cursor-pointer"
                >
                  {saving ? 'Rimozione...' : 'Elimina voce'}
                </button>
              </div>
            </div>
          ) : (
            <div className="pt-4 border-t border-slate-200 flex items-center justify-between gap-2">
              {existingAbsence ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={saving}
                  className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-red-300 bg-white text-xs font-semibold text-red-700 hover:bg-red-50 hover:border-red-400 transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Elimina</span>
                </button>
              ) : (
                <div />
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={saving}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors whitespace-nowrap cursor-pointer"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[44px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                >
                  {saving
                    ? 'Salvataggio...'
                    : existingAbsence
                      ? 'Salva modifiche'
                      : isNonAbsenceEntryType(tipo)
                        ? `Registra ${tipo}`
                        : 'Registra assenza'}
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
};
