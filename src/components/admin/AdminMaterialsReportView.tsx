import React, { useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Mail, Search } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  exportUsedMaterialsCsv,
  exportUsedMaterialsExcel,
  formatDateTimeIt,
} from '../../lib/exportUtils';
import { BOOTSTRAPPED_ADMIN_EMAILS, Task } from '../../types/domain';
import { EmailDraftConfig } from '../EmailNotificationModal';

interface AdminMaterialsReportViewProps {
  onOpenEmailModal: (draft: EmailDraftConfig) => void;
}

export const AdminMaterialsReportView: React.FC<
  AdminMaterialsReportViewProps
> = ({ onOpenEmailModal }) => {
  const { usedMaterials, tasks } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [commessaFilter, setCommessaFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [techFilter, setTechFilter] = useState('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [groupMode, setGroupMode] = useState<'detail' | 'aggregated'>('detail');

  const tasksById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of tasks) {
      map.set(t.taskId, t);
    }
    return map;
  }, [tasks]);

  const distinctCommesse = useMemo(
    () =>
      Array.from(new Set(usedMaterials.map((m) => m.commessa))).sort((a, b) =>
        a.localeCompare(b, 'it')
      ),
    [usedMaterials]
  );

  const distinctCategories = useMemo(
    () =>
      Array.from(new Set(usedMaterials.map((m) => m.categoria))).sort((a, b) =>
        a.localeCompare(b, 'it')
      ),
    [usedMaterials]
  );

  const distinctTechs = useMemo(
    () =>
      Array.from(new Set(usedMaterials.map((m) => m.technicianName))).sort(
        (a, b) => a.localeCompare(b, 'it')
      ),
    [usedMaterials]
  );

  const filteredMaterials = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    return usedMaterials
      .filter((m) => {
        if (commessaFilter !== 'ALL' && m.commessa !== commessaFilter) {
          return false;
        }
        if (categoryFilter !== 'ALL' && m.categoria !== categoryFilter) {
          return false;
        }
        if (techFilter !== 'ALL' && m.technicianName !== techFilter) {
          return false;
        }
        const parentTask = tasksById.get(m.taskId);
        const taskMs = parentTask?.inizioMs || null;
        if (fromMs !== null && taskMs !== null && taskMs < fromMs) {
          return false;
        }
        if (toMs !== null && taskMs !== null && taskMs > toMs) {
          return false;
        }
        if (!q) return true;
        return (
          m.codiceArticolo.toLowerCase().includes(q) ||
          m.descrizioneArticolo.toLowerCase().includes(q) ||
          m.commessa.toLowerCase().includes(q) ||
          m.technicianName.toLowerCase().includes(q) ||
          (parentTask?.taskCode.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => {
        const tA = tasksById.get(a.taskId)?.inizioMs || 0;
        const tB = tasksById.get(b.taskId)?.inizioMs || 0;
        return tB - tA;
      });
  }, [
    usedMaterials,
    commessaFilter,
    categoryFilter,
    techFilter,
    dateFrom,
    dateTo,
    searchQuery,
    tasksById,
  ]);

  const aggregatedRows = useMemo(() => {
    const map = new Map<
      string,
      {
        commessa: string;
        codiceArticolo: string;
        descrizioneArticolo: string;
        categoria: string;
        unitaMisura: string;
        totaleQuantita: number;
        occorrenze: number;
      }
    >();

    for (const m of filteredMaterials) {
      const key = `${m.commessa}__${m.codiceArticolo}`;
      const prev = map.get(key);
      if (prev) {
        prev.totaleQuantita =
          Math.round((prev.totaleQuantita + m.quantita) * 100) / 100;
        prev.occorrenze += 1;
      } else {
        map.set(key, {
          commessa: m.commessa,
          codiceArticolo: m.codiceArticolo,
          descrizioneArticolo: m.descrizioneArticolo,
          categoria: m.categoria,
          unitaMisura: m.unitaMisura,
          totaleQuantita: m.quantita,
          occorrenze: 1,
        });
      }
    }

    return Array.from(map.values()).sort(
      (a, b) =>
        a.commessa.localeCompare(b.commessa, 'it') ||
        a.codiceArticolo.localeCompare(b.codiceArticolo, 'it')
    );
  }, [filteredMaterials]);

  const totalUnits = useMemo(
    () =>
      Math.round(
        filteredMaterials.reduce((acc, item) => acc + item.quantita, 0) * 100
      ) / 100,
    [filteredMaterials]
  );

  return (
    <div className="space-y-6">
      {/* KPI Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-normal text-slate-500">Righe consuntivate</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {filteredMaterials.length}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-normal text-slate-500">Quantità totale</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {totalUnits}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-normal text-slate-500">Commesse coinvolte</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {new Set(filteredMaterials.map((m) => m.commessa)).size}
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <p className="text-xs font-normal text-slate-500">Articoli distinti</p>
          <p className="mt-2 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {new Set(filteredMaterials.map((m) => m.codiceArticolo)).size}
          </p>
        </div>
      </div>

      {/* Filter & Export Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="inline-flex items-center gap-2 self-start">
            <button
              type="button"
              onClick={() => setGroupMode('detail')}
              className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${groupMode === 'detail'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                }`}
            >
              Dettaglio per intervento
            </button>
            <button
              type="button"
              onClick={() => setGroupMode('aggregated')}
              className={`min-h-[40px] px-4 py-2 text-xs font-semibold rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${groupMode === 'aggregated'
                  ? 'bg-slate-900 text-white border-slate-950'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                }`}
            >
              Riepilogo per commessa
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={filteredMaterials.length === 0}
              onClick={() => exportUsedMaterialsExcel(filteredMaterials, tasksById)}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>Esporta Excel (.xls)</span>
            </button>

            <button
              type="button"
              disabled={filteredMaterials.length === 0}
              onClick={() => exportUsedMaterialsCsv(filteredMaterials, tasksById)}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <Download className="w-4 h-4" />
              <span>Esporta CSV</span>
            </button>

            <button
              type="button"
              disabled={filteredMaterials.length === 0}
              onClick={() => {
                const lines = aggregatedRows
                  .map(
                    (r) =>
                      `- Commessa ${r.commessa} | ${r.codiceArticolo} (${r.descrizioneArticolo}): ${r.totaleQuantita} ${r.unitaMisura}`
                  )
                  .join('\n');
                onOpenEmailModal({
                  to: BOOTSTRAPPED_ADMIN_EMAILS.join(', '),
                  subject: `[SITE Consuntivo Materiali] Report ${commessaFilter !== 'ALL'
                      ? `Commessa ${commessaFilter}`
                      : 'Generale'
                    }`,
                  contextTitle: `${filteredMaterials.length} movimenti materiali selezionati`,
                  bodyText: `Riepilogo Materiali Utilizzati nei Task:\n\n${lines}`,
                });
              }}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-40"
            >
              <Mail className="w-4 h-4" />
              <span>Invia report Gmail</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 pt-4 border-t border-slate-100">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cerca codice o articolo..."
              className="w-full min-h-[40px] pl-10 pr-4 py-2 rounded-lg border border-slate-300 text-xs font-normal text-slate-900"
            />
          </div>

          <select
            value={commessaFilter}
            onChange={(e) => setCommessaFilter(e.target.value)}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-normal bg-white text-slate-900"
          >
            <option value="ALL">Tutte le commesse</option>
            {distinctCommesse.map((c) => (
              <option key={c} value={c}>
                Commessa {c}
              </option>
            ))}
          </select>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-normal bg-white text-slate-900"
          >
            <option value="ALL">Tutte le categorie</option>
            {distinctCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            value={techFilter}
            onChange={(e) => setTechFilter(e.target.value)}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-normal bg-white text-slate-900"
          >
            <option value="ALL">Tutti i tecnici</option>
            {distinctTechs.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
              title="Data inizio filtro"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
              title="Data fine filtro"
            />
          </div>
        </div>
      </div>

      {/* Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {filteredMaterials.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-semibold text-slate-700">
              Nessun materiale registrato nei task selezionati.
            </p>
          </div>
        ) : groupMode === 'detail' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2 px-4">Task e data</th>
                  <th className="py-2 px-4">Commessa</th>
                  <th className="py-2 px-4">Tecnico</th>
                  <th className="py-2 px-4">Cod. articolo</th>
                  <th className="py-2 px-4">Descrizione</th>
                  <th className="py-2 px-4">Categoria</th>
                  <th className="py-2 px-4 text-right">Quantità</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs font-normal">
                {filteredMaterials.map((m) => {
                  const task = tasksById.get(m.taskId);
                  return (
                    <tr key={m.usedId} className="hover:bg-slate-50">
                      <td className="py-2 px-4 font-mono tabular-nums whitespace-nowrap">
                        <p className="font-semibold text-slate-900">
                          {task?.taskCode || m.taskId}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          {task ? formatDateTimeIt(task.inizioMs) : '—'}
                        </p>
                      </td>
                      <td className="py-2 px-4 font-mono font-semibold text-slate-800 tabular-nums whitespace-nowrap">
                        {m.commessa}
                      </td>
                      <td className="py-2 px-4 text-slate-700 whitespace-nowrap">
                        {m.technicianName}
                      </td>
                      <td className="py-2 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {m.codiceArticolo}
                      </td>
                      <td className="py-2 px-4 text-slate-800">
                        {m.descrizioneArticolo}
                      </td>
                      <td className="py-2 px-4 text-slate-600 whitespace-nowrap">
                        {m.categoria}
                      </td>
                      <td className="py-2 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                        {m.quantita} {m.unitaMisura}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2 px-4">Commessa</th>
                  <th className="py-2 px-4">Cod. articolo</th>
                  <th className="py-2 px-4">Descrizione</th>
                  <th className="py-2 px-4">Categoria</th>
                  <th className="py-2 px-4 text-right">N. inserimenti</th>
                  <th className="py-2 px-4 text-right">Totale utilizzato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs font-normal">
                {aggregatedRows.map((row) => (
                  <tr
                    key={`${row.commessa}_${row.codiceArticolo}`}
                    className="hover:bg-slate-50"
                  >
                    <td className="py-2 px-4 font-mono font-semibold text-slate-900 tabular-nums">
                      {row.commessa}
                    </td>
                    <td className="py-2 px-4 font-mono font-semibold text-slate-900">
                      {row.codiceArticolo}
                    </td>
                    <td className="py-2 px-4 text-slate-800">
                      {row.descrizioneArticolo}
                    </td>
                    <td className="py-2 px-4 text-slate-600">{row.categoria}</td>
                    <td className="py-2 px-4 text-right font-mono text-slate-600 tabular-nums">
                      {row.occorrenze}
                    </td>
                    <td className="py-2 px-4 text-right font-mono font-semibold text-slate-900 tabular-nums">
                      {row.totaleQuantita} {row.unitaMisura}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
