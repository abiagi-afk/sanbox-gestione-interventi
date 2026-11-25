import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Headphones,
  PhoneCall,
  Plus,
  Repeat,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  areSameTechnicianEmails,
  computeOnCallWeekWindow,
  findStaffMemberByAnyEmail,
  isEligibleForOnCallGroup,
  isItalianPublicHolidayDate,
  ON_CALL_GROUP_LABELS,
  OnCallGroup,
  OnCallOverride,
  OnCallOverrideScope,
  StaffMember,
} from '../types/domain';
import {
  deleteOnCallOverrideById,
  deleteOnCallShiftById,
  upsertOnCallOverride,
  upsertOnCallShift,
} from '../lib/firestoreService';
import {
  findOverlappingAbsencesForTech,
  formatAbsenceDateSummary,
  startOfLocalDayMs,
} from '../lib/calendarLayout';
import { formatDateIt, formatTimeIt } from '../lib/exportUtils';

function toLocalYmd(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function getMondayOfWeekMs(ms: number): number {
  const d = new Date(ms);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + diffToMonday,
    0,
    0,
    0,
    0
  ).getTime();
}

interface OnCallDayModalProps {
  open: boolean;
  dayMs: number | null;
  initialGroup?: OnCallGroup;
  onClose: () => void;
}

export const OnCallDayModal: React.FC<OnCallDayModalProps> = ({
  open,
  dayMs,
  initialGroup = 'technicians',
  onClose,
}) => {
  const {
    profile,
    directory,
    absences,
    onCallShifts,
    onCallOverrides,
    knownAdminUids,
    showToast,
  } = useApp();

  const isAdmin = profile?.role === 'admin';
  const myEmail = (profile?.email || '').trim().toLowerCase();

  const [selectedGroup, setSelectedGroup] = useState<OnCallGroup>(initialGroup);
  const [shiftTechEmail, setShiftTechEmail] = useState('');
  const [shiftStartsAt0700, setShiftStartsAt0700] = useState(false);
  const [shiftNote, setShiftNote] = useState('');
  const [savingShift, setSavingShift] = useState(false);

  const [subScope, setSubScope] = useState<OnCallOverrideScope>('daily');
  const [subTechEmail, setSubTechEmail] = useState('');
  const [subStartDate, setSubStartDate] = useState('');
  const [subEndDate, setSubEndDate] = useState('');
  const [subStartDt, setSubStartDt] = useState('');
  const [subEndDt, setSubEndDt] = useState('');
  const [subNote, setSubNote] = useState('');
  const [savingSub, setSavingSub] = useState(false);

  const activeDirectory = useMemo(
    () => directory.filter((m) => m.active),
    [directory]
  );

  const eligibleMembers = useMemo(
    () =>
      activeDirectory.filter((m) => isEligibleForOnCallGroup(m, selectedGroup)),
    [activeDirectory, selectedGroup]
  );

  const normalizedDayMs = useMemo(
    () => startOfLocalDayMs(dayMs ?? Date.now()),
    [dayMs]
  );
  const weekStartDate = useMemo(
    () => toLocalYmd(getMondayOfWeekMs(normalizedDayMs)),
    [normalizedDayMs]
  );

  const activeShift = useMemo(
    () =>
      onCallShifts.find(
        (s) => s.group === selectedGroup && s.weekStartDate === weekStartDate
      ) || null,
    [onCallShifts, selectedGroup, weekStartDate]
  );

  const activeOverrides = useMemo(
    () =>
      activeShift
        ? onCallOverrides.filter((ov) => ov.shiftId === activeShift.shiftId)
        : [],
    [onCallOverrides, activeShift]
  );

  useEffect(() => {
    if (!open) return;
    setSelectedGroup(initialGroup);
  }, [open, initialGroup, dayMs]);

  useEffect(() => {
    if (!open) return;
    const defaultTech =
      activeShift?.technicianEmail || eligibleMembers[0]?.email || '';

    setShiftTechEmail(defaultTech.toLowerCase());
    setShiftStartsAt0700(
      activeShift
        ? activeShift.startsAt0700
        : isItalianPublicHolidayDate(weekStartDate)
    );
    setShiftNote(activeShift?.note || '');

    const dayStr = toLocalYmd(normalizedDayMs);
    const defaultSub =
      eligibleMembers.find(
        (m) =>
          !areSameTechnicianEmails(
            m.email,
            activeShift?.technicianEmail || defaultTech,
            activeDirectory
          )
      )?.email ||
      eligibleMembers[0]?.email ||
      '';

    setSubScope('daily');
    setSubTechEmail(defaultSub.toLowerCase());
    setSubStartDate(dayStr);
    setSubEndDate(dayStr);
    const dObj = new Date(normalizedDayMs);
    const sDt = new Date(dObj.getFullYear(), dObj.getMonth(), dObj.getDate(), 17, 0);
    const eDt = new Date(
      dObj.getFullYear(),
      dObj.getMonth(),
      dObj.getDate() + 1,
      7,
      0
    );
    setSubStartDt(toLocalDateTimeInput(sDt.getTime()));
    setSubEndDt(toLocalDateTimeInput(eDt.getTime()));
    setSubNote('');
  }, [
    open,
    selectedGroup,
    weekStartDate,
    normalizedDayMs,
    activeShift,
    eligibleMembers,
    activeDirectory,
  ]);

  if (!open || dayMs === null) return null;

  const resolveStaff = (email: string): StaffMember | undefined =>
    activeDirectory.find((m) => m.email.toLowerCase() === email.toLowerCase()) ||
    findStaffMemberByAnyEmail(email, activeDirectory);

  const weekWindow = computeOnCallWeekWindow(weekStartDate, shiftStartsAt0700);
  const overlappingAbsences = activeShift
    ? findOverlappingAbsencesForTech(
      absences,
      activeShift.technicianEmail,
      activeShift.inizioMs,
      activeShift.fineMs,
      directory
    )
    : [];

  const handleSaveBaseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !shiftTechEmail) return;
    const member = resolveStaff(shiftTechEmail);
    if (
      selectedGroup === 'coordinators' &&
      (!member || !isEligibleForOnCallGroup(member, 'coordinators'))
    ) {
      showToast(
        'Nella categoria Assistenti (AT) non possono essere inseriti tecnici.',
        'error'
      );
      return;
    }
    setSavingShift(true);
    try {
      await upsertOnCallShift({
        existingShiftId: activeShift?.shiftId,
        group: selectedGroup,
        weekStartDate,
        startsAt0700: shiftStartsAt0700,
        technicianEmail: member ? member.email : shiftTechEmail,
        technicianName: member
          ? `${member.nome} ${member.cognome}`.trim()
          : shiftTechEmail,
        technicianUid: member?.linkedUid || '',
        note: shiftNote,
        knownAdminUids,
      });
      showToast('Turno settimanale di reperibilità aggiornato.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio turno.',
        'error'
      );
    } finally {
      setSavingShift(false);
    }
  };

  const handleDeleteBaseShift = async () => {
    if (!isAdmin || !activeShift) return;
    setSavingShift(true);
    try {
      await deleteOnCallShiftById(activeShift.shiftId);
      showToast('Turno settimanale rimosso.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore rimozione turno.',
        'error'
      );
    } finally {
      setSavingShift(false);
    }
  };

  const handleCreateSubstitution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeShift || !subTechEmail) return;

    const subMember = resolveStaff(subTechEmail);
    if (
      activeShift.group === 'coordinators' &&
      (!subMember || !isEligibleForOnCallGroup(subMember, 'coordinators'))
    ) {
      showToast(
        'Nella categoria Assistenti (AT) non possono essere inseriti tecnici.',
        'error'
      );
      return;
    }

    let inizioMs = activeShift.inizioMs;
    let fineMs = activeShift.fineMs;

    if (subScope === 'daily') {
      const sp = subStartDate.split('-').map(Number);
      const ep = subEndDate.split('-').map(Number);
      if (sp.length !== 3 || ep.length !== 3) {
        showToast('Seleziona date valide per la sostituzione.', 'error');
        return;
      }
      const rawStart = new Date(sp[0], sp[1] - 1, sp[2], 7, 0, 0, 0).getTime();
      const rawEnd = new Date(ep[0], ep[1] - 1, ep[2] + 1, 7, 0, 0, 0).getTime();
      inizioMs = Math.max(activeShift.inizioMs, rawStart);
      fineMs = Math.min(activeShift.fineMs, rawEnd);
    } else if (subScope === 'hourly') {
      inizioMs = new Date(subStartDt).getTime();
      fineMs = new Date(subEndDt).getTime();
    }

    if (
      !Number.isFinite(inizioMs) ||
      !Number.isFinite(fineMs) ||
      fineMs <= inizioMs
    ) {
      showToast(
        'Intervallo non valido o esterno alla finestra attiva del turno settimanale.',
        'error'
      );
      return;
    }

    setSavingSub(true);
    try {
      await upsertOnCallOverride({
        shiftId: activeShift.shiftId,
        scope: subScope,
        inizioMs,
        fineMs,
        substituteTechnicianEmail: subMember ? subMember.email : subTechEmail,
        substituteTechnicianName: subMember
          ? `${subMember.nome} ${subMember.cognome}`.trim()
          : subTechEmail,
        substituteTechnicianUid: subMember?.linkedUid || '',
        note: subNote,
        knownAdminUids,
      });
      showToast('Sostituzione reperibilità registrata.', 'success');
      setSubNote('');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio sostituzione.',
        'error'
      );
    } finally {
      setSavingSub(false);
    }
  };

  const handleDeleteOverride = async (ov: OnCallOverride) => {
    setSavingSub(true);
    try {
      await deleteOnCallOverrideById(ov.overrideId);
      showToast('Sostituzione annullata.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore annullamento sostituzione.',
        'error'
      );
    } finally {
      setSavingSub(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl bg-white border border-slate-200 max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
        <div className="flex items-center justify-between gap-4 p-4 border-b border-slate-200 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2 truncate">
              {selectedGroup === 'technicians' ? (
                <PhoneCall className="w-4 h-4 text-sky-700 shrink-0" />
              ) : (
                <Headphones className="w-4 h-4 text-violet-700 shrink-0" />
              )}
              <span>Reperibilità · {formatDateIt(normalizedDayMs)}</span>
            </h3>
            {weekWindow && (
              <p className="text-xs font-mono text-slate-500">
                Settimana: Lun {formatDateIt(weekWindow.inizioMs)}{' '}
                {weekWindow.startsAt0700 ? '07:00' : '17:00'} → Lun{' '}
                {formatDateIt(weekWindow.fineMs)} 07:00
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer shrink-0"
            aria-label="Chiudi"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Selettore Linea: Tecnici vs Assistenti (AT) */}
        <div className="px-4 pt-3 pb-2 border-b border-slate-200 bg-slate-50 grid grid-cols-2 gap-2 shrink-0">
          {(['technicians', 'coordinators'] as const).map((grp) => (
            <button
              key={grp}
              type="button"
              onClick={() => setSelectedGroup(grp)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${selectedGroup === grp
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                }`}
            >
              Linea {ON_CALL_GROUP_LABELS[grp]}
            </button>
          ))}
        </div>

        <div className="p-5 pb-24 sm:pb-6 space-y-5 overflow-y-auto">
          {overlappingAbsences.length > 0 && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 flex items-center gap-2 text-xs font-semibold text-red-800">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                Attenzione: il titolare ha un&apos;assenza ({overlappingAbsences[0].tipo} ·{' '}
                {formatAbsenceDateSummary(overlappingAbsences[0])}).
              </span>
            </div>
          )}

          {/* Sezione 1: Titolare Settimana */}
          <form onSubmit={handleSaveBaseShift} className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                1. Titolare Settimana ({ON_CALL_GROUP_LABELS[selectedGroup]})
              </h4>
              {isAdmin && activeShift && (
                <button
                  type="button"
                  disabled={savingShift}
                  onClick={handleDeleteBaseShift}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Rimuovi</span>
                </button>
              )}
            </div>

            {isAdmin ? (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-700">
                    {selectedGroup === 'coordinators'
                      ? 'Assistente (AT) titolare *'
                      : 'Tecnico titolare *'}
                  </label>
                  <select
                    value={shiftTechEmail}
                    onChange={(e) => setShiftTechEmail(e.target.value)}
                    required
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                  >
                    {eligibleMembers.map((m) => (
                      <option key={m.memberId} value={m.email.toLowerCase()}>
                        {m.cognome} {m.nome} ({m.email})
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center gap-2.5 text-xs text-slate-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={shiftStartsAt0700}
                    onChange={(e) => setShiftStartsAt0700(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-slate-900"
                  />
                  <span>
                    <strong>Lunedì festivo:</strong> inizia alle <strong>07:00</strong>{' '}
                    invece delle 17:00
                  </span>
                </label>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-700">
                    Note turno (opzionale)
                  </label>
                  <input
                    type="text"
                    value={shiftNote}
                    onChange={(e) => setShiftNote(e.target.value)}
                    placeholder="Annotazioni sulla settimana..."
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingShift || eligibleMembers.length === 0}
                    className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                  >
                    {savingShift
                      ? 'Salvataggio...'
                      : activeShift
                        ? 'Aggiorna titolare'
                        : 'Assegna settimana'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
                <p className="text-sm font-semibold text-slate-900">
                  {activeShift
                    ? activeShift.technicianName
                    : 'Nessun titolare assegnato per questa settimana'}
                </p>
                {activeShift?.note && (
                  <p className="text-xs text-slate-600 mt-1">{activeShift.note}</p>
                )}
              </div>
            )}
          </form>

          {/* Sezione 2: Sostituzioni */}
          {activeShift && (
            <div className="space-y-4 pt-4 border-t border-slate-200">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                <Repeat className="w-3.5 h-3.5" />
                <span>2. Sostituzioni e Scambi Turno</span>
              </h4>

              {activeOverrides.length > 0 && (
                <div className="space-y-2">
                  {activeOverrides.map((ov) => {
                    const canDeleteOv =
                      isAdmin ||
                      ov.createdByUid === profile?.uid ||
                      areSameTechnicianEmails(
                        ov.originalTechnicianEmail,
                        myEmail,
                        directory
                      ) ||
                      areSameTechnicianEmails(
                        ov.substituteTechnicianEmail,
                        myEmail,
                        directory
                      );

                    return (
                      <div
                        key={ov.overrideId}
                        className="rounded-xl bg-amber-50 border border-amber-300 p-3 flex items-start justify-between gap-3"
                      >
                        <div className="space-y-0.5 text-xs">
                          <p className="font-semibold text-amber-950 flex items-center gap-1.5">
                            <UserCheck className="w-3.5 h-3.5 text-amber-800" />
                            <span>Sostituto: {ov.substituteTechnicianName}</span>
                          </p>
                          <p className="font-mono text-[11px] text-amber-900">
                            Dal {formatDateIt(ov.inizioMs)} {formatTimeIt(ov.inizioMs)} al{' '}
                            {formatDateIt(ov.fineMs)} {formatTimeIt(ov.fineMs)}
                          </p>
                          {ov.note && (
                            <p className="text-amber-800 italic">“{ov.note}”</p>
                          )}
                        </div>

                        {canDeleteOv && (
                          <button
                            type="button"
                            disabled={savingSub}
                            onClick={() => handleDeleteOverride(ov)}
                            className="min-h-[34px] px-2.5 py-1 rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 text-xs font-semibold cursor-pointer shrink-0"
                          >
                            Annulla
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <form
                onSubmit={handleCreateSubstitution}
                className="rounded-xl border border-slate-200 p-4 space-y-3 bg-white"
              >
                <p className="text-xs font-semibold text-slate-900">
                  Inserisci nuova sostituzione
                </p>

                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { id: 'full', label: 'Intera settimana' },
                      { id: 'daily', label: 'Giorni specifici' },
                      { id: 'hourly', label: 'Fascia oraria' },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setSubScope(opt.id)}
                      className={`min-h-[38px] px-2 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer ${subScope === opt.id
                          ? 'bg-slate-900 text-white border-slate-950'
                          : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                        }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-700">
                    {selectedGroup === 'coordinators'
                      ? 'Assistente (AT) sostituto *'
                      : 'Tecnico sostituto *'}
                  </label>
                  <select
                    value={subTechEmail}
                    onChange={(e) => setSubTechEmail(e.target.value)}
                    required
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                  >
                    {eligibleMembers.map((m) => (
                      <option key={m.memberId} value={m.email.toLowerCase()}>
                        {m.cognome} {m.nome} ({m.email})
                      </option>
                    ))}
                  </select>
                </div>

                {subScope === 'daily' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Dal giorno *
                      </label>
                      <input
                        type="date"
                        value={subStartDate}
                        onChange={(e) => {
                          setSubStartDate(e.target.value);
                          if (subEndDate < e.target.value) setSubEndDate(e.target.value);
                        }}
                        required
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Al giorno (incluso) *
                      </label>
                      <input
                        type="date"
                        value={subEndDate}
                        min={subStartDate}
                        onChange={(e) => setSubEndDate(e.target.value)}
                        required
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-mono"
                      />
                    </div>
                  </div>
                )}

                {subScope === 'hourly' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Inizio copertura *
                      </label>
                      <input
                        type="datetime-local"
                        value={subStartDt}
                        onChange={(e) => setSubStartDt(e.target.value)}
                        required
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-slate-700">
                        Fine copertura *
                      </label>
                      <input
                        type="datetime-local"
                        value={subEndDt}
                        onChange={(e) => setSubEndDt(e.target.value)}
                        required
                        className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-mono"
                      />
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    Motivo / Commento scambio
                  </label>
                  <input
                    type="text"
                    value={subNote}
                    onChange={(e) => setSubNote(e.target.value)}
                    placeholder="Es. Scambio turno con collega"
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-sm"
                  />
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={savingSub}
                    className="min-h-[40px] inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{savingSub ? 'Salvataggio...' : 'Registra sostituzione'}</span>
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
