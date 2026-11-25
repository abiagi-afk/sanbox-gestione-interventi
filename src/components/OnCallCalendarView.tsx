import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  Headphones,
  List,
  PhoneCall,
  Plus,
  RefreshCw,
  Repeat,
  ShieldAlert,
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
  OnCallShift,
  StaffMember,
} from '../types/domain';
import {
  deleteOnCallOverrideById,
  deleteOnCallShiftById,
  generateOnCallRotation,
  importExcelOnCallPreset,
  upsertOnCallOverride,
  upsertOnCallShift,
} from '../lib/firestoreService';
import {
  addLocalDaysMs,
  findOverlappingAbsencesForTech,
  formatAbsenceDateSummary,
  getIsoWeekNumber,
  startOfLocalDayMs,
} from '../lib/calendarLayout';
import {
  formatDateIt,
  formatShortTechName,
  formatTimeIt,
} from '../lib/exportUtils';

const WEEKDAY_SHORT_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'] as const;
const WEEKDAY_FULL_IT = [
  'Lunedì',
  'Martedì',
  'Mercoledì',
  'Giovedì',
  'Venerdì',
  'Sabato',
  'Domenica',
] as const;

type OnCallViewLayout = 'calendar' | 'weeks';

function toYmd(ms: number): string {
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

function resolveCoverageAtMoment(params: {
  shifts: OnCallShift[];
  overrides: OnCallOverride[];
  group: OnCallGroup;
  atMs: number;
}): {
  status: 'active' | 'daytime_gap' | 'uncovered';
  shift: OnCallShift | null;
  upcomingMondayShift: OnCallShift | null;
  activeOverride: OnCallOverride | null;
  effectiveEmail: string;
  effectiveName: string;
} {
  const { shifts, overrides, group, atMs } = params;
  const groupShifts = shifts.filter((s) => s.group === group);
  const activeShift =
    groupShifts.find((s) => atMs >= s.inizioMs && atMs < s.fineMs) || null;

  if (!activeShift) {
    const d = new Date(atMs);
    if (d.getDay() === 1 && d.getHours() >= 7 && d.getHours() < 17) {
      const todayYmd = toYmd(atMs);
      const tonightShift =
        groupShifts.find((s) => s.weekStartDate === todayYmd) || null;
      if (tonightShift) {
        return {
          status: 'daytime_gap',
          shift: null,
          upcomingMondayShift: tonightShift,
          activeOverride: null,
          effectiveEmail: tonightShift.technicianEmail,
          effectiveName: tonightShift.technicianName,
        };
      }
    }
    return {
      status: 'uncovered',
      shift: null,
      upcomingMondayShift: null,
      activeOverride: null,
      effectiveEmail: '',
      effectiveName: '',
    };
  }

  const matchingOverrides = overrides.filter(
    (ov) =>
      ov.shiftId === activeShift.shiftId &&
      atMs >= ov.inizioMs &&
      atMs < ov.fineMs
  );
  const latestOverride =
    matchingOverrides.length > 0
      ? matchingOverrides[matchingOverrides.length - 1]
      : null;

  return {
    status: 'active',
    shift: activeShift,
    upcomingMondayShift: null,
    activeOverride: latestOverride,
    effectiveEmail: latestOverride
      ? latestOverride.substituteTechnicianEmail
      : activeShift.technicianEmail,
    effectiveName: latestOverride
      ? latestOverride.substituteTechnicianName
      : activeShift.technicianName,
  };
}

export const OnCallCalendarView: React.FC = () => {
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

  const [layoutMode, setLayoutMode] = useState<OnCallViewLayout>('calendar');
  const [monthCursor, setMonthCursor] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  });
  const [groupFilter, setGroupFilter] = useState<'ALL' | OnCallGroup>('ALL');
  const [personFilter, setPersonFilter] = useState<string>('ALL');
  const [importingPreset, setImportingPreset] = useState(false);

  // Modale dettaglio settimana / sostituzioni / modifica turno base
  const [modalState, setModalState] = useState<{
    open: boolean;
    group: OnCallGroup;
    weekStartDate: string;
    focusDayMs?: number;
  }>({ open: false, group: 'technicians', weekStartDate: '' });

  // Campi form turno base (Admin)
  const [shiftTechEmail, setShiftTechEmail] = useState('');
  const [shiftStartsAt0700, setShiftStartsAt0700] = useState(false);
  const [shiftNote, setShiftNote] = useState('');
  const [savingShift, setSavingShift] = useState(false);

  // Campi form nuova sostituzione (Admin & Tecnici)
  const [subScope, setSubScope] = useState<OnCallOverrideScope>('daily');
  const [subTechEmail, setSubTechEmail] = useState('');
  const [subStartDate, setSubStartDate] = useState('');
  const [subEndDate, setSubEndDate] = useState('');
  const [subStartDt, setSubStartDt] = useState('');
  const [subEndDt, setSubEndDt] = useState('');
  const [subNote, setSubNote] = useState('');
  const [savingSub, setSavingSub] = useState(false);

  // Modale Generatore Rotazione (Admin)
  const [rotationModalOpen, setRotationModalOpen] = useState(false);
  const [rotGroup, setRotGroup] = useState<OnCallGroup>('technicians');
  const [rotStartMonday, setRotStartMonday] = useState<string>(() =>
    toYmd(getMondayOfWeekMs(Date.now()))
  );
  const [rotWeeksCount, setRotWeeksCount] = useState<number>(16);
  const [rotOrderedEmails, setRotOrderedEmails] = useState<string[]>([]);
  const [generatingRotation, setGeneratingRotation] = useState(false);

  const activeDirectory = useMemo(
    () => directory.filter((m) => m.active),
    [directory]
  );

  // Membri idonei per ciascuna linea:
  // - Assistenti (AT) ['coordinators']: SOLO Assistenti/Admin (esclusi rigorosamente i Tecnici)
  // - Tecnici ['technicians']: SOLO Tecnici
  const eligibleTechnicians = useMemo(
    () =>
      activeDirectory.filter((m) => isEligibleForOnCallGroup(m, 'technicians')),
    [activeDirectory]
  );

  const eligibleAssistantsAt = useMemo(
    () =>
      activeDirectory.filter((m) => isEligibleForOnCallGroup(m, 'coordinators')),
    [activeDirectory]
  );

  const getEligibleMembersForGroup = (grp: OnCallGroup): StaffMember[] =>
    grp === 'coordinators' ? eligibleAssistantsAt : eligibleTechnicians;

  const nowMs = Date.now();
  const liveTechStatus = useMemo(
    () =>
      resolveCoverageAtMoment({
        shifts: onCallShifts,
        overrides: onCallOverrides,
        group: 'technicians',
        atMs: nowMs,
      }),
    [onCallShifts, onCallOverrides, nowMs]
  );

  const liveAssistantStatus = useMemo(
    () =>
      resolveCoverageAtMoment({
        shifts: onCallShifts,
        overrides: onCallOverrides,
        group: 'coordinators',
        atMs: nowMs,
      }),
    [onCallShifts, onCallOverrides, nowMs]
  );

  // Calcola tutti i Lunedì delle settimane che toccano il mese selezionato
  const monthWeeks = useMemo(() => {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const firstDayMs = new Date(year, month, 1, 0, 0, 0, 0).getTime();
    const lastDayMs = new Date(year, month + 1, 0, 0, 0, 0, 0).getTime();

    const weeks: Array<{
      weekStartDate: string;
      mondayMs: number;
      isoWeek: number;
      daysMs: number[];
    }> = [];

    let curMondayMs = getMondayOfWeekMs(firstDayMs);
    while (curMondayMs <= lastDayMs) {
      const daysMs = Array.from({ length: 7 }, (_, i) =>
        addLocalDaysMs(curMondayMs, i)
      );
      weeks.push({
        weekStartDate: toYmd(curMondayMs),
        mondayMs: curMondayMs,
        isoWeek: getIsoWeekNumber(curMondayMs),
        daysMs,
      });
      curMondayMs = addLocalDaysMs(curMondayMs, 7);
    }
    return weeks;
  }, [monthCursor]);

  const shiftsByGroupAndWeek = useMemo(() => {
    const map = new Map<string, OnCallShift>();
    for (const s of onCallShifts) {
      map.set(`${s.group}__${s.weekStartDate}`, s);
    }
    return map;
  }, [onCallShifts]);

  const overridesByShiftId = useMemo(() => {
    const map = new Map<string, OnCallOverride[]>();
    for (const ov of onCallOverrides) {
      const list = map.get(ov.shiftId) || [];
      list.push(ov);
      map.set(ov.shiftId, list);
    }
    return map;
  }, [onCallOverrides]);

  const resolveStaffOption = (email: string): StaffMember | undefined =>
    activeDirectory.find((m) => m.email.toLowerCase() === email.toLowerCase()) ||
    findStaffMemberByAnyEmail(email, activeDirectory);

  const openWeekModal = (
    group: OnCallGroup,
    weekStartDate: string,
    focusDayMs?: number
  ) => {
    const existing = shiftsByGroupAndWeek.get(`${group}__${weekStartDate}`);
    const eligibleList = getEligibleMembersForGroup(group);
    const defaultTech =
      existing?.technicianEmail || eligibleList[0]?.email || '';

    setShiftTechEmail(defaultTech.toLowerCase());
    setShiftStartsAt0700(
      existing ? existing.startsAt0700 : isItalianPublicHolidayDate(weekStartDate)
    );
    setShiftNote(existing?.note || '');

    // Precompila i campi sostituzione solo con colleghi idonei alla stessa linea
    const baseDayMs =
      focusDayMs ?? startOfLocalDayMs(new Date(weekStartDate).getTime());
    const baseDateStr = toYmd(baseDayMs);
    const defaultSubCandidate =
      eligibleList.find(
        (m) =>
          !areSameTechnicianEmails(
            m.email,
            existing?.technicianEmail || defaultTech,
            activeDirectory
          )
      )?.email ||
      eligibleList[0]?.email ||
      '';

    setSubScope('daily');
    setSubTechEmail(defaultSubCandidate.toLowerCase());
    setSubStartDate(baseDateStr);
    setSubEndDate(baseDateStr);
    const dObj = new Date(baseDayMs);
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

    setModalState({
      open: true,
      group,
      weekStartDate,
      focusDayMs,
    });
  };

  const handleImportExcelPreset = async () => {
    setImportingPreset(true);
    try {
      const count = await importExcelOnCallPreset(knownAdminUids);
      showToast(
        `Importate ${count} settimane di reperibilità (2025–2028) dal piano Excel.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore importazione piano Excel.',
        'error'
      );
    } finally {
      setImportingPreset(false);
    }
  };

  const handleSaveBaseShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin || !modalState.weekStartDate || !shiftTechEmail) return;
    const member = resolveStaffOption(shiftTechEmail);
    if (
      modalState.group === 'coordinators' &&
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
      const existing = shiftsByGroupAndWeek.get(
        `${modalState.group}__${modalState.weekStartDate}`
      );
      await upsertOnCallShift({
        existingShiftId: existing?.shiftId,
        group: modalState.group,
        weekStartDate: modalState.weekStartDate,
        startsAt0700: shiftStartsAt0700,
        technicianEmail: member ? member.email : shiftTechEmail,
        technicianName: member
          ? `${member.nome} ${member.cognome}`.trim()
          : shiftTechEmail,
        technicianUid: member?.linkedUid || '',
        note: shiftNote,
        knownAdminUids,
      });
      showToast('Turno settimanale di reperibilità salvato.', 'success');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio turno.',
        'error'
      );
    } finally {
      setSavingShift(false);
    }
  };

  const handleDeleteBaseShift = async (shift: OnCallShift) => {
    if (!isAdmin) return;
    setSavingShift(true);
    try {
      await deleteOnCallShiftById(shift.shiftId);
      showToast('Turno settimanale rimosso.', 'success');
      setModalState((prev) => ({ ...prev, open: false }));
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore rimozione turno.',
        'error'
      );
    } finally {
      setSavingShift(false);
    }
  };

  const handleCreateSubstitution = async (
    e: React.FormEvent,
    targetShift: OnCallShift
  ) => {
    e.preventDefault();
    if (!subTechEmail) {
      showToast('Seleziona il collega sostituto.', 'error');
      return;
    }

    const subMember = resolveStaffOption(subTechEmail);
    if (
      targetShift.group === 'coordinators' &&
      (!subMember || !isEligibleForOnCallGroup(subMember, 'coordinators'))
    ) {
      showToast(
        'Nella categoria Assistenti (AT) non possono essere inseriti tecnici.',
        'error'
      );
      return;
    }

    let inizioMs = targetShift.inizioMs;
    let fineMs = targetShift.fineMs;

    if (subScope === 'daily') {
      const sp = subStartDate.split('-').map(Number);
      const ep = subEndDate.split('-').map(Number);
      if (sp.length !== 3 || ep.length !== 3) {
        showToast('Seleziona date valide per la sostituzione.', 'error');
        return;
      }
      const rawStart = new Date(sp[0], sp[1] - 1, sp[2], 7, 0, 0, 0).getTime();
      const rawEnd = new Date(ep[0], ep[1] - 1, ep[2] + 1, 7, 0, 0, 0).getTime();
      inizioMs = Math.max(targetShift.inizioMs, rawStart);
      fineMs = Math.min(targetShift.fineMs, rawEnd);
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
        shiftId: targetShift.shiftId,
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

  const openRotationGenerator = () => {
    const eligible = getEligibleMembersForGroup(rotGroup);
    setRotOrderedEmails(eligible.map((m) => m.email.toLowerCase()));
    setRotationModalOpen(true);
  };

  const handleRotationGroupChange = (nextGroup: OnCallGroup) => {
    setRotGroup(nextGroup);
    const eligible = getEligibleMembersForGroup(nextGroup);
    setRotOrderedEmails(eligible.map((m) => m.email.toLowerCase()));
  };

  const handleGenerateRotation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rotOrderedEmails.length === 0) {
      showToast('Seleziona almeno un operatore nella sequenza.', 'error');
      return;
    }
    setGeneratingRotation(true);
    try {
      const members = rotOrderedEmails.map((em) => {
        const m = resolveStaffOption(em);
        return {
          email: m ? m.email : em,
          name: m ? `${m.nome} ${m.cognome}`.trim() : em,
          uid: m?.linkedUid || '',
        };
      });
      const count = await generateOnCallRotation({
        group: rotGroup,
        startWeekDate: rotStartMonday,
        weeksCount: rotWeeksCount,
        members,
        knownAdminUids,
      });
      showToast(`Generate ${count} settimane di rotazione.`, 'success');
      setRotationModalOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore generazione rotazione.',
        'error'
      );
    } finally {
      setGeneratingRotation(false);
    }
  };

  const monthLabel = monthCursor.toLocaleDateString('it-IT', {
    month: 'long',
    year: 'numeric',
  });

  const activeModalShift = modalState.open
    ? shiftsByGroupAndWeek.get(`${modalState.group}__${modalState.weekStartDate}`) ||
    null
    : null;
  const activeModalOverrides = activeModalShift
    ? overridesByShiftId.get(activeModalShift.shiftId) || []
    : [];
  const activeModalWindow = modalState.weekStartDate
    ? computeOnCallWeekWindow(modalState.weekStartDate, shiftStartsAt0700)
    : null;
  const modalEligibleMembers = getEligibleMembersForGroup(modalState.group);
  const rotationEligibleMembers = getEligibleMembersForGroup(rotGroup);

  const visibleGroups: OnCallGroup[] =
    groupFilter === 'ALL' ? ['technicians', 'coordinators'] : [groupFilter];

  // Helper per calcolare la copertura di un singolo giorno su una determinata linea
  const getDayLineCoverage = (
    grp: OnCallGroup,
    weekStartDate: string,
    dayStartMs: number,
    dayIndexInWeek: number
  ) => {
    const shift = shiftsByGroupAndWeek.get(`${grp}__${weekStartDate}`) || null;
    if (!shift) {
      return {
        shift: null,
        activeOv: null as OnCallOverride | null,
        effectiveName: '',
        effectiveEmail: '',
        dayAbsences: [] as ReturnType<typeof findOverlappingAbsencesForTech>,
      };
    }
    const shiftOverrides = overridesByShiftId.get(shift.shiftId) || [];
    const dayEndMs = addLocalDaysMs(dayStartMs, 1);
    const dObj = new Date(dayStartMs);
    const nObj = new Date(dayEndMs);
    const covStartMs =
      dayIndexInWeek === 0 && !shift.startsAt0700
        ? new Date(dObj.getFullYear(), dObj.getMonth(), dObj.getDate(), 17, 0).getTime()
        : new Date(dObj.getFullYear(), dObj.getMonth(), dObj.getDate(), 7, 0).getTime();
    const covEndMs = new Date(
      nObj.getFullYear(),
      nObj.getMonth(),
      nObj.getDate(),
      7,
      0
    ).getTime();

    const dayOverrides = shiftOverrides.filter(
      (ov) => ov.inizioMs < covEndMs && ov.fineMs > covStartMs
    );
    const activeOv =
      dayOverrides.length > 0 ? dayOverrides[dayOverrides.length - 1] : null;
    const effectiveName = activeOv
      ? activeOv.substituteTechnicianName
      : shift.technicianName;
    const effectiveEmail = activeOv
      ? activeOv.substituteTechnicianEmail
      : shift.technicianEmail;
    const dayAbsences = effectiveEmail
      ? findOverlappingAbsencesForTech(
        absences,
        effectiveEmail,
        covStartMs,
        covEndMs,
        directory
      )
      : [];

    return {
      shift,
      activeOv,
      effectiveName,
      effectiveEmail,
      dayAbsences,
    };
  };

  const matchesPersonFilter = (email?: string): boolean => {
    if (personFilter === 'ALL') return true;
    if (!email) return false;
    const target = personFilter === 'MINE' ? myEmail : personFilter;
    return areSameTechnicianEmails(email, target, directory);
  };

  return (
    <div className="space-y-4 pb-8">
      {/* Banner Importazione Excel iniziale se il calendario è vuoto */}
      {isAdmin && onCallShifts.length === 0 && (
        <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold text-amber-950 flex items-center gap-2">
              <FileSpreadsheet className="w-4 h-4 text-amber-800 shrink-0" />
              <span>Nessun turno di reperibilità ancora caricato</span>
            </p>
            <p className="text-xs text-amber-900">
              Puoi importare subito con un clic tutte le 171 settimane (2025–2028) del tuo
              foglio Excel (Tecnici + Assistenti AT), con riconoscimento automatico dei
              Lunedì festivi alle 07:00.
            </p>
          </div>
          <button
            type="button"
            disabled={importingPreset}
            onClick={handleImportExcelPreset}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white border border-slate-950 text-xs font-semibold hover:bg-slate-800 cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
          >
            {importingPreset ? 'Importazione in corso...' : 'Importa Piano Excel 2025–2028'}
          </button>
        </div>
      )}

      {/* Card Stato Attivo Ora / Oggi */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(
          [
            {
              group: 'technicians' as OnCallGroup,
              title: 'Reperibilità Tecnici · Adesso',
              info: liveTechStatus,
              accent: 'sky',
            },
            {
              group: 'coordinators' as OnCallGroup,
              title: 'Reperibilità Assistenti (AT) · Adesso',
              info: liveAssistantStatus,
              accent: 'violet',
            },
          ] as const
        ).map(({ group, title, info, accent }) => {
          const overlappingAbs = info.effectiveEmail
            ? findOverlappingAbsencesForTech(
              absences,
              info.effectiveEmail,
              nowMs,
              nowMs + 3600_000,
              directory
            )
            : [];

          return (
            <div
              key={group}
              className="rounded-xl bg-white border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex items-center gap-2">
                  {accent === 'sky' ? (
                    <PhoneCall className="w-4 h-4 text-sky-700 shrink-0" />
                  ) : (
                    <Headphones className="w-4 h-4 text-violet-700 shrink-0" />
                  )}
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    {title}
                  </span>
                </div>

                {info.status === 'active' && info.shift && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold text-slate-900 truncate">
                        {info.effectiveName}
                      </p>
                      {info.activeOverride && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                          <Repeat className="w-3 h-3" />
                          Sostituto (titolare: {info.shift.technicianName})
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-slate-600 tabular-nums">
                      Turno: Lun {formatDateIt(info.shift.inizioMs)}{' '}
                      {info.shift.startsAt0700 ? '07:00' : '17:00'} → Lun{' '}
                      {formatDateIt(info.shift.fineMs)} 07:00
                    </p>
                    {info.activeOverride && (
                      <p className="text-xs text-amber-800">
                        Copertura sostituzione:{' '}
                        {formatDateIt(info.activeOverride.inizioMs)}{' '}
                        {formatTimeIt(info.activeOverride.inizioMs)} –{' '}
                        {formatDateIt(info.activeOverride.fineMs)}{' '}
                        {formatTimeIt(info.activeOverride.fineMs)}
                        {info.activeOverride.note ? ` · ${info.activeOverride.note}` : ''}
                      </p>
                    )}
                  </>
                )}

                {info.status === 'daytime_gap' && info.upcomingMondayShift && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-slate-800">
                        Fascia lavorativa ordinaria (07:00 – 17:00)
                      </p>
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-300">
                        Cambio turno
                      </span>
                    </div>
                    <p className="text-xs text-slate-600">
                      Inizio reperibilità alle <strong>17:00</strong>:{' '}
                      <span className="font-semibold text-slate-900">
                        {info.upcomingMondayShift.technicianName}
                      </span>
                    </p>
                  </>
                )}

                {info.status === 'uncovered' && (
                  <p className="text-sm font-normal text-slate-500">
                    Nessun turno pianificato per questa data.
                  </p>
                )}

                {overlappingAbs.length > 0 && (
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Assenza registrata: {overlappingAbs[0].tipo} (
                      {formatAbsenceDateSummary(overlappingAbs[0])})
                    </span>
                  </div>
                )}
              </div>

              {(info.shift || info.upcomingMondayShift) && (
                <button
                  type="button"
                  onClick={() => {
                    const target = info.shift || info.upcomingMondayShift!;
                    openWeekModal(target.group, target.weekStartDate, nowMs);
                  }}
                  className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 whitespace-nowrap cursor-pointer shrink-0"
                >
                  Sostituzione
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Toolbar Navigazione Mese, Selettore Vista Calendario/Settimane e Filtri */}
      <div className="rounded-xl bg-white border border-slate-200 p-3.5 flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Switch Vista Calendario vs Vista Settimane */}
          <div className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 p-0.5">
            <button
              type="button"
              onClick={() => setLayoutMode('calendar')}
              className={`inline-flex items-center gap-1.5 min-h-[34px] px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${layoutMode === 'calendar'
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'text-slate-700 hover:text-slate-900'
                }`}
            >
              <CalendarRange className="w-3.5 h-3.5" />
              <span>Calendario</span>
            </button>
            <button
              type="button"
              onClick={() => setLayoutMode('weeks')}
              className={`inline-flex items-center gap-1.5 min-h-[34px] px-3 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer ${layoutMode === 'weeks'
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'text-slate-700 hover:text-slate-900'
                }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>Settimane</span>
            </button>
          </div>

          <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white overflow-hidden">
            <button
              type="button"
              onClick={() =>
                setMonthCursor(
                  (d) => new Date(d.getFullYear(), d.getMonth() - 1, 1, 0, 0, 0, 0)
                )
              }
              className="min-h-[36px] px-2.5 hover:bg-slate-50 text-slate-700 cursor-pointer"
              aria-label="Mese precedente"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                setMonthCursor(
                  new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
                );
              }}
              className="min-h-[36px] px-3 border-x border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer"
            >
              Oggi
            </button>
            <button
              type="button"
              onClick={() =>
                setMonthCursor(
                  (d) => new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0)
                )
              }
              className="min-h-[36px] px-2.5 hover:bg-slate-50 text-slate-700 cursor-pointer"
              aria-label="Mese successivo"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <h2 className="font-display text-base font-semibold text-slate-900 capitalize px-1">
            {monthLabel}
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Legenda rapida */}
          <div className="hidden md:flex items-center gap-2 text-[11px] text-slate-600 pr-2 border-r border-slate-200">
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-xs bg-sky-500 inline-block" />
              Tecnici
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-xs bg-violet-500 inline-block" />
              Assistenti (AT)
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-xs bg-amber-400 inline-block" />
              Sostituzione
            </span>
          </div>

          {/* Filtro Linea */}
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value as 'ALL' | OnCallGroup)}
            className="w-full sm:w-auto min-w-0 max-w-full min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800"
            aria-label="Filtra linea reperibilità"
          >
            <option value="ALL">Tutte le linee (Tecnici + Assistenti AT)</option>
            <option value="technicians">Solo Linea Tecnici</option>
            <option value="coordinators">Solo Assistenti (AT)</option>
          </select>

          {/* Filtro Operatore */}
          <select
            value={personFilter}
            onChange={(e) => setPersonFilter(e.target.value)}
            className="w-full sm:w-auto min-w-0 max-w-full min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800"
            aria-label="Filtra per operatore"
          >
            <option value="ALL">Tutti gli operatori</option>
            {myEmail && <option value="MINE">Solo i miei turni / sostituzioni</option>}
            {activeDirectory.map((m) => (
              <option key={m.memberId} value={m.email.toLowerCase()}>
                {m.cognome} {m.nome}
              </option>
            ))}
          </select>

          {isAdmin && (
            <>
              <button
                type="button"
                onClick={openRotationGenerator}
                className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Genera rotazione</span>
              </button>

              {onCallShifts.length > 0 && (
                <button
                  type="button"
                  disabled={importingPreset}
                  onClick={handleImportExcelPreset}
                  className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-semibold text-slate-800 cursor-pointer disabled:opacity-50"
                  title="Ripristina o allinea i turni dal piano Excel 2025–2028"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>{importingPreset ? 'Import...' : 'Sync Excel 25–28'}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* =====================================================================
          VISTA 1: CALENDARIO MENSILE CLASSICO A 7 COLONNE (LUN -> DOM)
         ===================================================================== */}
      {layoutMode === 'calendar' && (
        <>
          {/* VERSIONE SMARTPHONE (< 768px): Schede Settimanali Verticali a larghezza 100% */}
          <div className="md:hidden space-y-3">
            {monthWeeks.map((week) => {
              const nextMondayMs = addLocalDaysMs(week.mondayMs, 7);
              const isCurrentWeek =
                nowMs >= week.mondayMs && nowMs < nextMondayMs;
              const isHolidayMonday = isItalianPublicHolidayDate(
                week.weekStartDate
              );
              const techShift =
                shiftsByGroupAndWeek.get(`technicians__${week.weekStartDate}`) ||
                null;
              const asstShift =
                shiftsByGroupAndWeek.get(`coordinators__${week.weekStartDate}`) ||
                null;

              return (
                <div
                  key={`mob_${week.weekStartDate}`}
                  className={`rounded-xl bg-white border overflow-hidden ${isCurrentWeek
                      ? 'border-slate-900 shadow-xs'
                      : 'border-slate-200'
                    }`}
                >
                  <div
                    className={`p-3 border-b space-y-2 ${isCurrentWeek
                        ? 'bg-slate-900 text-white border-slate-800'
                        : 'bg-slate-50 text-slate-800 border-slate-200'
                      }`}
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="font-mono font-semibold">
                        Sett. {String(week.isoWeek).padStart(2, '0')} · Lun{' '}
                        {formatDateIt(week.mondayMs)}
                      </span>
                      <span
                        className={`font-mono text-[10px] px-2 py-0.5 rounded-full font-semibold ${isHolidayMonday
                            ? 'bg-amber-400 text-slate-950'
                            : isCurrentWeek
                              ? 'bg-slate-800 text-slate-200'
                              : 'bg-white text-slate-600 border border-slate-200'
                          }`}
                      >
                        {(techShift?.startsAt0700 ?? isHolidayMonday)
                          ? 'Inizio 07:00'
                          : 'Inizio 17:00'}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 gap-1.5">
                      {visibleGroups.includes('technicians') && (
                        <button
                          type="button"
                          onClick={() =>
                            openWeekModal('technicians', week.weekStartDate)
                          }
                          className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold border flex items-center justify-between gap-2 cursor-pointer ${isCurrentWeek
                              ? 'bg-sky-950 text-sky-100 border-sky-700'
                              : 'bg-sky-50 text-sky-950 border-sky-200'
                            }`}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            <PhoneCall className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">
                              Tecnico:{' '}
                              {techShift ? techShift.technicianName : 'Non assegnato'}
                            </span>
                          </span>
                          <span className="text-[11px] underline shrink-0">
                            Modifica
                          </span>
                        </button>
                      )}

                      {visibleGroups.includes('coordinators') && (
                        <button
                          type="button"
                          onClick={() =>
                            openWeekModal('coordinators', week.weekStartDate)
                          }
                          className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-semibold border flex items-center justify-between gap-2 cursor-pointer ${isCurrentWeek
                              ? 'bg-violet-950 text-violet-100 border-violet-700'
                              : 'bg-violet-50 text-violet-950 border-violet-200'
                            }`}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            <Headphones className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">
                              Assistente AT:{' '}
                              {asstShift ? asstShift.technicianName : 'Non assegnato'}
                            </span>
                          </span>
                          <span className="text-[11px] underline shrink-0">
                            Modifica
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {week.daysMs.map((dayStartMs, idx) => {
                      const dObj = new Date(dayStartMs);
                      const isToday = startOfLocalDayMs(nowMs) === dayStartMs;
                      const inSelectedMonth =
                        dObj.getMonth() === monthCursor.getMonth();
                      const techCov = getDayLineCoverage(
                        'technicians',
                        week.weekStartDate,
                        dayStartMs,
                        idx
                      );
                      const asstCov = getDayLineCoverage(
                        'coordinators',
                        week.weekStartDate,
                        dayStartMs,
                        idx
                      );

                      const showTech =
                        visibleGroups.includes('technicians') &&
                        Boolean(techCov.shift) &&
                        matchesPersonFilter(techCov.effectiveEmail);
                      const showAsst =
                        visibleGroups.includes('coordinators') &&
                        Boolean(asstCov.shift) &&
                        matchesPersonFilter(asstCov.effectiveEmail);

                      if (personFilter !== 'ALL' && !showTech && !showAsst) {
                        return null;
                      }

                      return (
                        <button
                          key={`mob_day_${dayStartMs}`}
                          type="button"
                          onClick={() =>
                            openWeekModal(
                              groupFilter === 'coordinators'
                                ? 'coordinators'
                                : 'technicians',
                              week.weekStartDate,
                              dayStartMs
                            )
                          }
                          className={`w-full min-h-[54px] px-3 py-2.5 flex items-center justify-between gap-2 text-left transition-colors cursor-pointer ${!inSelectedMonth ? 'opacity-55 bg-slate-50/60' : ''
                            } ${isToday
                              ? 'bg-slate-100/90'
                              : 'hover:bg-slate-50 active:bg-slate-100'
                            }`}
                        >
                          <div className="w-20 shrink-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`text-xs font-mono font-semibold ${isToday
                                    ? 'px-1.5 py-0.5 rounded bg-slate-900 text-white'
                                    : 'text-slate-900'
                                  }`}
                              >
                                {WEEKDAY_SHORT_IT[idx]} {dObj.getDate()}
                              </span>
                            </div>
                            {idx === 0 && (techShift || asstShift) && (
                              <span className="text-[10px] font-mono text-slate-500">
                                dalle{' '}
                                {(techShift?.startsAt0700 ??
                                  asstShift?.startsAt0700)
                                  ? '07:00'
                                  : '17:00'}
                              </span>
                            )}
                          </div>

                          <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
                            {showTech && (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold truncate max-w-full ${techCov.activeOv
                                    ? 'bg-amber-100 text-amber-950 border-amber-300'
                                    : techCov.dayAbsences.length > 0
                                      ? 'bg-red-50 text-red-900 border-red-300'
                                      : 'bg-sky-50 text-sky-950 border-sky-200'
                                  }`}
                              >
                                <PhoneCall className="w-3 h-3 shrink-0" />
                                <span className="truncate">
                                  {techCov.activeOv ? '↻ ' : ''}
                                  {formatShortTechName(techCov.effectiveName)}
                                </span>
                              </span>
                            )}

                            {showAsst && (
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-semibold truncate max-w-full ${asstCov.activeOv
                                    ? 'bg-amber-100 text-amber-950 border-amber-300'
                                    : asstCov.dayAbsences.length > 0
                                      ? 'bg-red-50 text-red-900 border-red-300'
                                      : 'bg-violet-50 text-violet-950 border-violet-200'
                                  }`}
                              >
                                <Headphones className="w-3 h-3 shrink-0" />
                                <span className="truncate">
                                  {asstCov.activeOv ? '↻ ' : ''}
                                  {formatShortTechName(asstCov.effectiveName)}
                                </span>
                              </span>
                            )}

                            {!showTech && !showAsst && (
                              <span className="text-xs text-slate-400 italic">
                                Non assegnato
                              </span>
                            )}
                          </div>

                          <span className="text-[11px] font-semibold text-slate-500 shrink-0">
                            + Sost.
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* VERSIONE DESKTOP (>= 768px): Griglia 7 Colonne */}
          <div className="hidden md:block rounded-xl bg-white border border-slate-200 overflow-hidden shadow-2xs">
            <div className="overflow-x-auto">
              <div className="min-w-[780px]">
                {/* Intestazione 7 Giorni della Settimana */}
                <div className="grid grid-cols-7 bg-slate-50 border-b border-slate-200">
                  {WEEKDAY_FULL_IT.map((dayName, idx) => (
                    <div
                      key={dayName}
                      className={`px-3 py-2.5 text-xs font-semibold border-r last:border-r-0 border-slate-200 flex items-center justify-between ${idx >= 5 ? 'text-slate-500 bg-slate-100/60' : 'text-slate-700'
                        }`}
                    >
                      <span>{dayName}</span>
                      {idx === 0 && (
                        <span className="text-[10px] font-mono font-normal text-slate-400">
                          Cambio turno
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Righe Settimanali del Mese */}
                <div className="divide-y divide-slate-200">
                  {monthWeeks.map((week) => {
                    const nextMondayMs = addLocalDaysMs(week.mondayMs, 7);
                    const isCurrentWeek =
                      nowMs >= week.mondayMs && nowMs < nextMondayMs;
                    const isHolidayMonday = isItalianPublicHolidayDate(
                      week.weekStartDate
                    );
                    const techShift =
                      shiftsByGroupAndWeek.get(`technicians__${week.weekStartDate}`) ||
                      null;
                    const asstShift =
                      shiftsByGroupAndWeek.get(`coordinators__${week.weekStartDate}`) ||
                      null;

                    return (
                      <div
                        key={week.weekStartDate}
                        className={isCurrentWeek ? 'bg-slate-50/40' : 'bg-white'}
                      >
                        {/* Fascia Superiore Continua della Settimana (stile Google Calendar all-day span) */}
                        <div
                          className={`px-3 py-1.5 border-b flex flex-wrap items-center justify-between gap-2 text-[11px] ${isCurrentWeek
                              ? 'bg-slate-900 text-white border-slate-800'
                              : 'bg-slate-50/90 text-slate-700 border-slate-200'
                            }`}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-semibold">
                              Sett. {String(week.isoWeek).padStart(2, '0')}
                            </span>
                            <span
                              className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${isHolidayMonday
                                  ? isCurrentWeek
                                    ? 'bg-amber-400 text-slate-950 font-semibold'
                                    : 'bg-amber-100 text-amber-900 border border-amber-300 font-semibold'
                                  : isCurrentWeek
                                    ? 'bg-slate-800 text-slate-200'
                                    : 'bg-white text-slate-600 border border-slate-200'
                                }`}
                            >
                              Lun{' '}
                              {(techShift?.startsAt0700 ?? isHolidayMonday)
                                ? '07:00 (Festivo)'
                                : '17:00'}{' '}
                              → Lun 07:00
                            </span>
                            {isCurrentWeek && (
                              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white text-slate-900">
                                In corso
                              </span>
                            )}
                          </div>

                          {/* Pillole Titolari Settimanali Cliccabili */}
                          <div className="flex flex-wrap items-center gap-1.5">
                            {visibleGroups.includes('technicians') && (
                              <button
                                type="button"
                                onClick={() =>
                                  openWeekModal('technicians', week.weekStartDate)
                                }
                                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${isCurrentWeek
                                    ? 'bg-sky-950 text-sky-100 border-sky-700 hover:bg-sky-900'
                                    : 'bg-sky-50 text-sky-950 border-sky-200 hover:bg-sky-100'
                                  }`}
                              >
                                <PhoneCall className="w-3 h-3 shrink-0" />
                                <span>
                                  Tecnico:{' '}
                                  {techShift ? techShift.technicianName : 'Non assegnato'}
                                </span>
                              </button>
                            )}

                            {visibleGroups.includes('coordinators') && (
                              <button
                                type="button"
                                onClick={() =>
                                  openWeekModal('coordinators', week.weekStartDate)
                                }
                                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-semibold border transition-colors cursor-pointer ${isCurrentWeek
                                    ? 'bg-violet-950 text-violet-100 border-violet-700 hover:bg-violet-900'
                                    : 'bg-violet-50 text-violet-950 border-violet-200 hover:bg-violet-100'
                                  }`}
                              >
                                <Headphones className="w-3 h-3 shrink-0" />
                                <span>
                                  Assistente AT:{' '}
                                  {asstShift ? asstShift.technicianName : 'Non assegnato'}
                                </span>
                              </button>
                            )}
                          </div>
                        </div>

                        {/* 7 Caselle Giornaliere (Lun -> Dom) */}
                        <div className="grid grid-cols-7">
                          {week.daysMs.map((dayStartMs, idx) => {
                            const dObj = new Date(dayStartMs);
                            const isToday = startOfLocalDayMs(nowMs) === dayStartMs;
                            const inSelectedMonth =
                              dObj.getMonth() === monthCursor.getMonth();
                            const isWeekend = idx >= 5;

                            const techCov = getDayLineCoverage(
                              'technicians',
                              week.weekStartDate,
                              dayStartMs,
                              idx
                            );
                            const asstCov = getDayLineCoverage(
                              'coordinators',
                              week.weekStartDate,
                              dayStartMs,
                              idx
                            );

                            const showTechBar =
                              visibleGroups.includes('technicians') &&
                              Boolean(techCov.shift) &&
                              matchesPersonFilter(techCov.effectiveEmail);
                            const showAsstBar =
                              visibleGroups.includes('coordinators') &&
                              Boolean(asstCov.shift) &&
                              matchesPersonFilter(asstCov.effectiveEmail);

                            return (
                              <div
                                key={dayStartMs}
                                onClick={() =>
                                  openWeekModal(
                                    groupFilter === 'coordinators'
                                      ? 'coordinators'
                                      : 'technicians',
                                    week.weekStartDate,
                                    dayStartMs
                                  )
                                }
                                className={`min-h-[112px] p-2 border-r last:border-r-0 border-slate-200 flex flex-col justify-between gap-1.5 transition-colors cursor-pointer group ${!inSelectedMonth
                                    ? 'bg-slate-50/70 opacity-60'
                                    : isWeekend
                                      ? 'bg-slate-50/40 hover:bg-slate-50'
                                      : 'bg-white hover:bg-slate-50/80'
                                  } ${isToday ? 'ring-2 ring-inset ring-slate-900' : ''
                                  }`}
                              >
                                {/* Numero Giorno + Azione Rapida */}
                                <div className="flex items-center justify-between gap-1">
                                  <span
                                    className={`text-xs font-mono font-semibold tabular-nums ${isToday
                                        ? 'w-6 h-6 rounded-full bg-slate-900 text-white inline-flex items-center justify-center'
                                        : inSelectedMonth
                                          ? 'text-slate-900'
                                          : 'text-slate-400'
                                      }`}
                                  >
                                    {dObj.getDate()}
                                  </span>

                                  <span className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-semibold text-slate-500">
                                    + Sost.
                                  </span>
                                </div>

                                {/* Eventi Reperibilità del Giorno */}
                                <div className="space-y-1.5 my-auto">
                                  {showTechBar && (
                                    <button
                                      type="button"
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        openWeekModal(
                                          'technicians',
                                          week.weekStartDate,
                                          dayStartMs
                                        );
                                      }}
                                      title={`Tecnico reperibile: ${techCov.effectiveName}${techCov.activeOv
                                          ? ` (sostituisce ${techCov.shift?.technicianName})`
                                          : ''
                                        }`}
                                      className={`w-full text-left px-2 py-1 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer ${techCov.activeOv
                                          ? 'bg-amber-100/90 text-amber-950 border-amber-300 hover:bg-amber-100'
                                          : techCov.dayAbsences.length > 0
                                            ? 'bg-red-50 text-red-900 border-red-300 hover:bg-red-100'
                                            : 'bg-sky-50 text-sky-950 border-sky-200 hover:bg-sky-100'
                                        }`}
                                    >
                                      <div className="flex items-center gap-1 truncate">
                                        <PhoneCall className="w-3 h-3 shrink-0 opacity-75" />
                                        <span className="truncate">
                                          {techCov.activeOv ? '↻ ' : ''}
                                          {formatShortTechName(techCov.effectiveName)}
                                        </span>
                                      </div>
                                      {techCov.activeOv && (
                                        <div className="text-[9.5px] font-normal text-amber-900 truncate">
                                          {techCov.activeOv.scope === 'hourly'
                                            ? `${formatTimeIt(
                                              techCov.activeOv.inizioMs
                                            )}–${formatTimeIt(techCov.activeOv.fineMs)}`
                                            : `Sost. ${formatShortTechName(
                                              techCov.shift?.technicianName || ''
                                            )}`}
                                        </div>
                                      )}
                                      {techCov.dayAbsences.length > 0 && (
                                        <div className="text-[9.5px] font-semibold text-red-700 truncate">
                                          ⚠ {techCov.dayAbsences[0].tipo}
                                        </div>
                                      )}
                                    </button>
                                  )}

                                  {showAsstBar && (
                                    <button
                                      type="button"
                                      onClick={(ev) => {
                                        ev.stopPropagation();
                                        openWeekModal(
                                          'coordinators',
                                          week.weekStartDate,
                                          dayStartMs
                                        );
                                      }}
                                      title={`Assistente (AT) reperibile: ${asstCov.effectiveName}${asstCov.activeOv
                                          ? ` (sostituisce ${asstCov.shift?.technicianName})`
                                          : ''
                                        }`}
                                      className={`w-full text-left px-2 py-1 rounded-md border text-[11px] font-semibold transition-colors cursor-pointer ${asstCov.activeOv
                                          ? 'bg-amber-100/90 text-amber-950 border-amber-300 hover:bg-amber-100'
                                          : asstCov.dayAbsences.length > 0
                                            ? 'bg-red-50 text-red-900 border-red-300 hover:bg-red-100'
                                            : 'bg-violet-50 text-violet-950 border-violet-200 hover:bg-violet-100'
                                        }`}
                                    >
                                      <div className="flex items-center gap-1 truncate">
                                        <Headphones className="w-3 h-3 shrink-0 opacity-75" />
                                        <span className="truncate">
                                          {asstCov.activeOv ? '↻ ' : ''}
                                          {formatShortTechName(asstCov.effectiveName)}
                                        </span>
                                      </div>
                                      {asstCov.activeOv && (
                                        <div className="text-[9.5px] font-normal text-amber-900 truncate">
                                          {asstCov.activeOv.scope === 'hourly'
                                            ? `${formatTimeIt(
                                              asstCov.activeOv.inizioMs
                                            )}–${formatTimeIt(asstCov.activeOv.fineMs)}`
                                            : `Sost. ${formatShortTechName(
                                              asstCov.shift?.technicianName || ''
                                            )}`}
                                        </div>
                                      )}
                                      {asstCov.dayAbsences.length > 0 && (
                                        <div className="text-[9.5px] font-semibold text-red-700 truncate">
                                          ⚠ {asstCov.dayAbsences[0].tipo}
                                        </div>
                                      )}
                                    </button>
                                  )}

                                  {!showTechBar && !showAsstBar && (
                                    <div className="text-[10px] text-slate-300 italic py-1">
                                      —
                                    </div>
                                  )}
                                </div>

                                {/* Orario inizio turno se Lunedì */}
                                <div className="h-3.5 flex items-center justify-end">
                                  {idx === 0 && (techShift || asstShift) && (
                                    <span className="text-[9.5px] font-mono text-slate-400">
                                      {(techShift?.startsAt0700 ?? asstShift?.startsAt0700)
                                        ? '07:00'
                                        : '17:00'}
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* =====================================================================
          VISTA 2: ELENCO DETTAGLIATO SETTIMANE (LUNEDÌ -> DOMENICA)
         ===================================================================== */}
      {layoutMode === 'weeks' && (
        <div className="space-y-3">
          {monthWeeks.map((week) => {
            const nextMondayMs = addLocalDaysMs(week.mondayMs, 7);
            const isCurrentWeek = nowMs >= week.mondayMs && nowMs < nextMondayMs;
            const isHolidayMonday = isItalianPublicHolidayDate(week.weekStartDate);

            return (
              <div
                key={week.weekStartDate}
                className={`rounded-xl bg-white border overflow-hidden ${isCurrentWeek ? 'border-slate-900 shadow-xs' : 'border-slate-200'
                  }`}
              >
                <div
                  className={`px-4 py-2 border-b flex flex-wrap items-center justify-between gap-2 ${isCurrentWeek
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-800 border-slate-200'
                    }`}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold">
                      Sett. {String(week.isoWeek).padStart(2, '0')}
                    </span>
                    <span className={isCurrentWeek ? 'text-slate-300' : 'text-slate-400'}>
                      ·
                    </span>
                    <span className="font-mono tabular-nums">
                      Lun {formatDateIt(week.mondayMs)} → Lun{' '}
                      {formatDateIt(nextMondayMs)} (07:00)
                    </span>
                    {isCurrentWeek && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white text-slate-900">
                        Settimana corrente
                      </span>
                    )}
                    {isHolidayMonday && (
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${isCurrentWeek
                            ? 'bg-amber-400 text-slate-950'
                            : 'bg-amber-100 text-amber-900 border border-amber-300'
                          }`}
                      >
                        Lunedì festivo (inizio 07:00)
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {visibleGroups.map((grp) => {
                      const sh = shiftsByGroupAndWeek.get(
                        `${grp}__${week.weekStartDate}`
                      );
                      return (
                        <button
                          key={grp}
                          type="button"
                          onClick={() => openWeekModal(grp, week.weekStartDate)}
                          className={`min-h-[30px] px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${isCurrentWeek
                              ? 'bg-slate-800 text-white border-slate-700 hover:bg-slate-700'
                              : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-100'
                            }`}
                        >
                          {sh
                            ? `Gestisci ${ON_CALL_GROUP_LABELS[grp]}`
                            : isAdmin
                              ? `+ Assegna ${ON_CALL_GROUP_LABELS[grp]}`
                              : ON_CALL_GROUP_LABELS[grp]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="divide-y divide-slate-200">
                  {visibleGroups.map((grp) => {
                    const shift =
                      shiftsByGroupAndWeek.get(`${grp}__${week.weekStartDate}`) ||
                      null;
                    const shiftOverrides = shift
                      ? overridesByShiftId.get(shift.shiftId) || []
                      : [];

                    if (personFilter !== 'ALL') {
                      const targetEmail =
                        personFilter === 'MINE' ? myEmail : personFilter;
                      const matchesPrimary =
                        shift &&
                        areSameTechnicianEmails(
                          shift.technicianEmail,
                          targetEmail,
                          directory
                        );
                      const matchesSub = shiftOverrides.some((ov) =>
                        areSameTechnicianEmails(
                          ov.substituteTechnicianEmail,
                          targetEmail,
                          directory
                        )
                      );
                      if (!matchesPrimary && !matchesSub) {
                        return null;
                      }
                    }

                    const primaryAbsences = shift
                      ? findOverlappingAbsencesForTech(
                        absences,
                        shift.technicianEmail,
                        shift.inizioMs,
                        shift.fineMs,
                        directory
                      )
                      : [];

                    return (
                      <div key={grp} className="p-3 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${grp === 'technicians'
                                  ? 'bg-sky-50 text-sky-900 border-sky-200'
                                  : 'bg-violet-50 text-violet-900 border-violet-200'
                                }`}
                            >
                              {ON_CALL_GROUP_LABELS[grp]}
                            </span>

                            {shift ? (
                              <>
                                <span className="text-sm font-semibold text-slate-900">
                                  {shift.technicianName}
                                </span>
                                <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-500">
                                  <Clock className="w-3 h-3" />
                                  Inizio Lun {shift.startsAt0700 ? '07:00' : '17:00'}
                                </span>
                                {shiftOverrides.length > 0 && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                                    <Repeat className="w-3 h-3" />
                                    {shiftOverrides.length}{' '}
                                    {shiftOverrides.length === 1
                                      ? 'sostituzione'
                                      : 'sostituzioni'}
                                  </span>
                                )}
                                {primaryAbsences.length > 0 && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-700 border border-red-200">
                                    <ShieldAlert className="w-3 h-3" />
                                    Assenza titolare: {primaryAbsences[0].tipo}
                                  </span>
                                )}
                              </>
                            ) : (
                              <span className="text-xs text-slate-400 italic">
                                Non assegnato
                              </span>
                            )}
                          </div>

                          {shift && (
                            <button
                              type="button"
                              onClick={() => openWeekModal(grp, week.weekStartDate)}
                              className="text-xs font-semibold text-slate-700 hover:text-slate-950 underline cursor-pointer"
                            >
                              + Sostituzione / Dettagli
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                          {week.daysMs.map((dayStartMs, idx) => {
                            const isToday = startOfLocalDayMs(nowMs) === dayStartMs;
                            const inSelectedMonth =
                              new Date(dayStartMs).getMonth() ===
                              monthCursor.getMonth();
                            const cov = getDayLineCoverage(
                              grp,
                              week.weekStartDate,
                              dayStartMs,
                              idx
                            );

                            return (
                              <button
                                key={dayStartMs}
                                type="button"
                                onClick={() =>
                                  openWeekModal(grp, week.weekStartDate, dayStartMs)
                                }
                                className={`text-left rounded-lg border p-2 transition-colors cursor-pointer flex flex-col justify-between min-h-[76px] ${!inSelectedMonth ? 'opacity-55' : ''
                                  } ${isToday
                                    ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                                    : cov.activeOv
                                      ? 'border-amber-300 bg-amber-50/70 hover:bg-amber-50'
                                      : cov.dayAbsences.length > 0
                                        ? 'border-red-300 bg-red-50/60 hover:bg-red-50'
                                        : 'border-slate-200 bg-white hover:bg-slate-50'
                                  }`}
                              >
                                <div className="flex items-center justify-between gap-1 text-[11px]">
                                  <span className="font-semibold text-slate-700">
                                    {WEEKDAY_SHORT_IT[idx]}{' '}
                                    {new Date(dayStartMs).getDate()}
                                  </span>
                                  {idx === 0 && shift && (
                                    <span className="font-mono text-[10px] text-slate-500">
                                      {shift.startsAt0700 ? '07:00' : '17:00'}
                                    </span>
                                  )}
                                </div>

                                <div className="mt-1 space-y-0.5">
                                  <p className="text-xs font-semibold text-slate-900 truncate">
                                    {cov.effectiveName || '—'}
                                  </p>
                                  {cov.activeOv && (
                                    <p className="text-[10px] font-semibold text-amber-900 truncate">
                                      ↻{' '}
                                      {cov.activeOv.scope === 'hourly'
                                        ? `${formatTimeIt(
                                          cov.activeOv.inizioMs
                                        )}–${formatTimeIt(cov.activeOv.fineMs)}`
                                        : 'Sostituzione'}
                                    </p>
                                  )}
                                  {cov.dayAbsences.length > 0 && (
                                    <p className="text-[10px] font-semibold text-red-700 truncate">
                                      ⚠ {cov.dayAbsences[0].tipo}
                                    </p>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* MODALE GESTIONE SETTIMANA & SOSTITUZIONI */}
      {modalState.open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-xl rounded-t-2xl sm:rounded-2xl bg-white border border-slate-200 max-h-[92vh] flex flex-col overflow-hidden shadow-xl">
            <div className="flex items-center justify-between gap-4 p-4 border-b border-slate-200 shrink-0">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-slate-900 truncate">
                  Reperibilità {ON_CALL_GROUP_LABELS[modalState.group]} · Lunedì{' '}
                  {modalState.weekStartDate}
                </h3>
                {activeModalWindow && (
                  <p className="text-xs font-mono text-slate-500">
                    Finestra: Lun {formatDateIt(activeModalWindow.inizioMs)}{' '}
                    {activeModalWindow.startsAt0700 ? '07:00' : '17:00'} → Lun{' '}
                    {formatDateIt(activeModalWindow.fineMs)} 07:00
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setModalState((prev) => ({ ...prev, open: false }))}
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer shrink-0"
                aria-label="Chiudi"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Switch rapido tra Tecnici e Assistenti (AT) direttamente nella modale */}
            <div className="px-4 pt-3 pb-2 border-b border-slate-200 bg-slate-50 grid grid-cols-2 gap-2 shrink-0">
              {(['technicians', 'coordinators'] as const).map((grp) => (
                <button
                  key={grp}
                  type="button"
                  onClick={() =>
                    openWeekModal(grp, modalState.weekStartDate, modalState.focusDayMs)
                  }
                  className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${modalState.group === grp
                      ? 'bg-slate-900 text-white border-slate-950'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                    }`}
                >
                  Linea {ON_CALL_GROUP_LABELS[grp]}
                </button>
              ))}
            </div>

            <div className="p-5 pb-24 sm:pb-6 space-y-6 overflow-y-auto">
              {/* Sezione 1: Titolare Settimana */}
              <form onSubmit={handleSaveBaseShift} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    1. Titolare Settimanale Base ({ON_CALL_GROUP_LABELS[modalState.group]})
                  </h4>
                  {isAdmin && activeModalShift && (
                    <button
                      type="button"
                      disabled={savingShift}
                      onClick={() => handleDeleteBaseShift(activeModalShift)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Rimuovi turno</span>
                    </button>
                  )}
                </div>

                {isAdmin ? (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-3">
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-slate-700">
                        {modalState.group === 'coordinators'
                          ? 'Assistente (AT) titolare *'
                          : 'Tecnico titolare *'}
                      </label>
                      <select
                        value={shiftTechEmail}
                        onChange={(e) => setShiftTechEmail(e.target.value)}
                        required
                        className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                      >
                        {modalEligibleMembers.length === 0 && (
                          <option value="">
                            Nessun profilo idoneo trovato in organico
                          </option>
                        )}
                        {modalEligibleMembers.map((m) => (
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
                        disabled={savingShift || modalEligibleMembers.length === 0}
                        className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                      >
                        {savingShift
                          ? 'Salvataggio...'
                          : activeModalShift
                            ? 'Aggiorna titolare'
                            : 'Assegna settimana'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-4">
                    <p className="text-sm font-semibold text-slate-900">
                      {activeModalShift
                        ? activeModalShift.technicianName
                        : 'Nessun titolare assegnato per questa settimana'}
                    </p>
                    {activeModalShift?.note && (
                      <p className="text-xs text-slate-600 mt-1">{activeModalShift.note}</p>
                    )}
                  </div>
                )}
              </form>

              {/* Sezione 2: Sostituzioni */}
              {activeModalShift && (
                <div className="space-y-4 pt-4 border-t border-slate-200">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    2. Sostituzioni e Scambi Turno
                  </h4>

                  {activeModalOverrides.length > 0 && (
                    <div className="space-y-2">
                      {activeModalOverrides.map((ov) => {
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
                              <p className="text-[10px] text-amber-700">
                                Registrata da {ov.createdByName || 'Operatore'}
                              </p>
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

                  {/* Form Nuova Sostituzione */}
                  <form
                    onSubmit={(e) => handleCreateSubstitution(e, activeModalShift)}
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
                        {modalState.group === 'coordinators'
                          ? 'Assistente (AT) sostituto *'
                          : 'Tecnico sostituto *'}
                      </label>
                      <select
                        value={subTechEmail}
                        onChange={(e) => setSubTechEmail(e.target.value)}
                        required
                        className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                      >
                        {modalEligibleMembers.map((m) => (
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
                        placeholder="Es. Scambio turno con collega per impegno personale"
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
      )}

      {/* MODALE GENERATORE ROTAZIONE (SOLO ADMIN) */}
      {isAdmin && rotationModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/50 backdrop-blur-xs p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl bg-white border border-slate-200 max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
            <div className="flex items-center justify-between gap-4 p-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <CalendarIcon className="w-4 h-4 text-slate-700" />
                <h3 className="text-base font-semibold text-slate-900">
                  Genera rotazione automatica
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setRotationModalOpen(false)}
                className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={handleGenerateRotation}
              className="p-5 space-y-4 overflow-y-auto"
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    Linea
                  </label>
                  <select
                    value={rotGroup}
                    onChange={(e) =>
                      handleRotationGroupChange(e.target.value as OnCallGroup)
                    }
                    className="w-full min-h-[40px] px-3 py-2 rounded-lg border border-slate-300 text-xs font-semibold"
                  >
                    <option value="technicians">Tecnici</option>
                    <option value="coordinators">Assistenti (AT)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    Primo Lunedì
                  </label>
                  <input
                    type="date"
                    value={rotStartMonday}
                    onChange={(e) => setRotStartMonday(e.target.value)}
                    required
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    Settimane
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={104}
                    value={rotWeeksCount}
                    onChange={(e) => setRotWeeksCount(Number(e.target.value))}
                    required
                    className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-mono"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-700">
                  {rotGroup === 'coordinators'
                    ? 'Assistenti (AT) inclusi nella rotazione (tecnici esclusi)'
                    : 'Tecnici inclusi nella rotazione (clicca per attivare/disattivare)'}
                </label>
                <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
                  {rotationEligibleMembers.map((m) => {
                    const em = m.email.toLowerCase();
                    const idx = rotOrderedEmails.indexOf(em);
                    const selected = idx !== -1;
                    return (
                      <button
                        key={m.memberId}
                        type="button"
                        onClick={() => {
                          setRotOrderedEmails((prev) =>
                            prev.includes(em)
                              ? prev.filter((x) => x !== em)
                              : [...prev, em]
                          );
                        }}
                        className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between cursor-pointer ${selected
                            ? 'bg-slate-900 text-white'
                            : 'bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                      >
                        <span className="font-semibold">
                          {m.cognome} {m.nome}
                        </span>
                        <span className="font-mono text-[11px]">
                          {selected ? `Turno #${idx + 1}` : 'Escluso'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setRotationModalOpen(false)}
                  className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 cursor-pointer"
                >
                  Annulla
                </button>
                <button
                  type="submit"
                  disabled={generatingRotation || rotOrderedEmails.length === 0}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 cursor-pointer disabled:opacity-50"
                >
                  {generatingRotation
                    ? 'Generazione...'
                    : `Genera ${rotWeeksCount} settimane`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
