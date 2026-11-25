import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Download,
  Edit3,
  FileUp,
  Layers,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  bulkDeleteArticles,
  bulkImportArticlesCsv,
  bulkUpdateArticlesActive,
  deleteArticleById,
  seedStarterArticles,
  upsertArticle,
} from '../../lib/firestoreService';
import { exportArticlesCsv } from '../../lib/exportUtils';
import { Article } from '../../types/domain';
import { ConfirmModal } from '../ConfirmModal';

type ArticleStatusFilter = 'active' | 'archived' | 'all';

export const AdminArticlesView: React.FC = () => {
  const { profile, articles, currentAdminUids, showToast } = useApp();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('ALL');
  const [statusFilter, setStatusFilter] =
    useState<ArticleStatusFilter>('active');

  // Multi-selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDeleteOpen, setConfirmBulkDeleteOpen] = useState(false);
  const headerCheckboxRef = useRef<HTMLInputElement | null>(null);

  // Article Modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [codiceArticolo, setCodiceArticolo] = useState('');
  const [descrizione, setDescrizione] = useState('');
  const [categoria, setCategoria] = useState('');
  const [unitaMisura, setUnitaMisura] = useState('pz');
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // Bulk CSV Modal
  const [csvModalOpen, setCsvModalOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importingCsv, setImportingCsv] = useState(false);

  // Delete Confirmation (single row)
  const [confirmDelete, setConfirmDelete] = useState<Article | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Prune removed article IDs from selection automatically
  useEffect(() => {
    const validSet = new Set(articles.map((a) => a.articleId));
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [articles]);

  const categories = useMemo(
    () =>
      Array.from(new Set(articles.map((a) => a.categoria))).sort((a, b) =>
        a.localeCompare(b, 'it')
      ),
    [articles]
  );

  const counts = useMemo(() => {
    let activeCount = 0;
    let archivedCount = 0;
    for (const a of articles) {
      if (a.active) activeCount += 1;
      else archivedCount += 1;
    }
    return {
      active: activeCount,
      archived: archivedCount,
      all: articles.length,
    };
  }, [articles]);

  const filteredArticles = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return articles.filter((a) => {
      if (statusFilter === 'active' && !a.active) return false;
      if (statusFilter === 'archived' && a.active) return false;
      if (selectedCategory !== 'ALL' && a.categoria !== selectedCategory) {
        return false;
      }
      if (!q) return true;
      return (
        a.codiceArticolo.toLowerCase().includes(q) ||
        a.descrizione.toLowerCase().includes(q) ||
        a.categoria.toLowerCase().includes(q)
      );
    });
  }, [articles, statusFilter, selectedCategory, searchTerm]);

  const selectedFilteredCount = useMemo(
    () => filteredArticles.filter((a) => selectedIds.has(a.articleId)).length,
    [filteredArticles, selectedIds]
  );

  const allFilteredSelected =
    filteredArticles.length > 0 &&
    selectedFilteredCount === filteredArticles.length;
  const someFilteredSelected =
    selectedFilteredCount > 0 && !allFilteredSelected;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someFilteredSelected;
    }
  }, [someFilteredSelected]);

  const selectedArticlesList = useMemo(
    () => articles.filter((a) => selectedIds.has(a.articleId)),
    [articles, selectedIds]
  );

  const selectedActiveCount = useMemo(
    () => selectedArticlesList.filter((a) => a.active).length,
    [selectedArticlesList]
  );
  const selectedArchivedCount =
    selectedArticlesList.length - selectedActiveCount;

  const toggleSelectRow = (articleId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(articleId)) {
        next.delete(articleId);
      } else {
        next.add(articleId);
      }
      return next;
    });
  };

  const toggleSelectAllFiltered = () => {
    if (filteredArticles.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const a of filteredArticles) {
          next.delete(a.articleId);
        }
      } else {
        for (const a of filteredArticles) {
          next.add(a.articleId);
        }
      }
      return next;
    });
  };

  const handleBulkSetActive = async (targetActive: boolean) => {
    if (!profile || selectedIds.size === 0) return;
    const idsToUpdate = selectedArticlesList
      .filter((a) => a.active !== targetActive)
      .map((a) => a.articleId);

    if (idsToUpdate.length === 0) {
      showToast(
        targetActive
          ? 'Gli articoli selezionati sono già attivi.'
          : 'Gli articoli selezionati sono già archiviati.',
        'info'
      );
      return;
    }

    setBulkBusy(true);
    try {
      const count = await bulkUpdateArticlesActive({
        articleIds: idsToUpdate,
        active: targetActive,
        adminUid: profile.uid,
        currentAdminUids,
      });
      showToast(
        targetActive
          ? `${count} articoli ripristinati come attivi.`
          : `${count} articoli spostati negli archiviati.`,
        'success'
      );
      setSelectedIds(new Set());
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore aggiornamento multiplo articoli.',
        'error'
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const handleSingleRowToggleActive = async (art: Article) => {
    if (!profile) return;
    setBulkBusy(true);
    try {
      await bulkUpdateArticlesActive({
        articleIds: [art.articleId],
        active: !art.active,
        adminUid: profile.uid,
        currentAdminUids,
      });
      showToast(
        art.active
          ? `Articolo ${art.codiceArticolo} archiviato.`
          : `Articolo ${art.codiceArticolo} ripristinato attivo.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore cambio stato articolo.',
        'error'
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDeleteConfirmed = async () => {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    try {
      const count = await bulkDeleteArticles(Array.from(selectedIds));
      showToast(`${count} articoli eliminati dal catalogo.`, 'info');
      setSelectedIds(new Set());
      setConfirmBulkDeleteOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore eliminazione multipla articoli.',
        'error'
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const openNewModal = () => {
    setEditingArticle(null);
    setCodiceArticolo('');
    setDescrizione('');
    setCategoria(selectedCategory !== 'ALL' ? selectedCategory : '');
    setUnitaMisura('pz');
    setActive(true);
    setModalOpen(true);
  };

  const openEditModal = (art: Article) => {
    setEditingArticle(art);
    setCodiceArticolo(art.codiceArticolo);
    setDescrizione(art.descrizione);
    setCategoria(art.categoria);
    setUnitaMisura(art.unitaMisura);
    setActive(art.active);
    setModalOpen(true);
  };

  const handleSaveArticle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setSaving(true);
    try {
      await upsertArticle({
        existingArticle: editingArticle || undefined,
        codiceArticolo,
        descrizione,
        categoria,
        unitaMisura,
        active,
        adminUid: profile.uid,
        currentAdminUids,
      });
      showToast(
        editingArticle
          ? 'Articolo aggiornato.'
          : 'Articolo aggiunto al catalogo.',
        'success'
      );
      setModalOpen(false);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore salvataggio articolo.',
        'error'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleBulkImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setImportingCsv(true);
    try {
      const count = await bulkImportArticlesCsv({
        csvText,
        adminUid: profile.uid,
        currentAdminUids,
      });
      showToast(`${count} articoli importati nel catalogo.`, 'success');
      setCsvModalOpen(false);
      setCsvText('');
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore importazione CSV.',
        'error'
      );
    } finally {
      setImportingCsv(false);
    }
  };

  const handleSeedStarter = async () => {
    if (!profile) return;
    setSeeding(true);
    try {
      const count = await seedStarterArticles({
        adminUid: profile.uid,
        currentAdminUids,
      });
      showToast(
        `Catalogo iniziale popolato con ${count} articoli.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore caricamento catalogo base.',
        'error'
      );
    } finally {
      setSeeding(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteArticleById(confirmDelete.articleId);
      showToast('Articolo eliminato dal catalogo.', 'info');
      setConfirmDelete(null);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : 'Errore eliminazione articolo.',
        'error'
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Cerca codice, descrizione o categoria..."
              className="w-full sm:w-64 min-h-[40px] pl-10 pr-4 py-2 rounded-lg border border-slate-300 text-xs font-normal text-slate-900"
            />
          </div>

          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-normal bg-white text-slate-900"
          >
            <option value="ALL">
              Tutte le categorie ({categories.length})
            </option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          {/* 3-State Filter: Solo attivi | Archiviati | Tutti */}
          <div
            className="inline-flex items-center gap-2"
            role="group"
            aria-label="Filtra stato articoli"
          >
            {(
              [
                { id: 'active', label: 'Solo attivi', count: counts.active },
                { id: 'archived', label: 'Archiviati', count: counts.archived },
                { id: 'all', label: 'Tutti', count: counts.all },
              ] as const
            ).map((tab) => {
              const isSelected = statusFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`min-h-[40px] px-4 py-2 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums ${isSelected
                      ? 'bg-slate-900 text-white border-slate-950'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 hover:border-slate-400'
                    }`}
                >
                  {tab.label} ({tab.count})
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={filteredArticles.length === 0}
            onClick={() =>
              exportArticlesCsv(
                selectedArticlesList.length > 0
                  ? selectedArticlesList
                  : filteredArticles
              )
            }
            className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer whitespace-nowrap disabled:opacity-40"
          >
            <Download className="w-4 h-4" />
            <span>
              {selectedArticlesList.length > 0
                ? `Esporta CSV (${selectedArticlesList.length})`
                : 'Esporta CSV'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setCsvModalOpen(true)}
            className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer whitespace-nowrap"
          >
            <FileUp className="w-4 h-4" />
            <span>Importa CSV</span>
          </button>

          <button
            type="button"
            onClick={openNewModal}
            className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Nuovo articolo</span>
          </button>
        </div>
      </div>

      {/* Contextual Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="bg-slate-900 border border-slate-950 text-white rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-mono font-semibold tabular-nums text-sm">
              {selectedIds.size}
            </span>
            <span className="font-normal">
              {selectedIds.size === 1
                ? 'articolo selezionato'
                : 'articoli selezionati'}
            </span>
            <span className="text-slate-400" aria-hidden="true">
              ·
            </span>
            <span className="text-slate-300 font-mono tabular-nums">
              {selectedActiveCount} attivi / {selectedArchivedCount} archiviati
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectedActiveCount > 0 && (
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => handleBulkSetActive(false)}
                className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <Archive className="w-4 h-4 shrink-0" />
                <span>Archivia selezionati</span>
              </button>
            )}

            {selectedArchivedCount > 0 && (
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => handleBulkSetActive(true)}
                className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-white transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
              >
                <ArchiveRestore className="w-4 h-4 shrink-0" />
                <span>Ripristina attivi</span>
              </button>
            )}

            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setConfirmBulkDeleteOpen(true)}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-red-900 bg-red-700 hover:bg-red-800 text-xs font-semibold text-white transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4 shrink-0" />
              <span>Elimina selezionati</span>
            </button>

            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setSelectedIds(new Set())}
              className="inline-flex items-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-700 bg-slate-900 text-xs font-semibold text-slate-200 hover:text-white hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
            >
              <X className="w-4 h-4 shrink-0" />
              <span>Deseleziona</span>
            </button>
          </div>
        </div>
      )}

      {/* Table or Empty State */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {articles.length === 0 ? (
          <div className="p-12 text-center max-w-lg mx-auto">
            <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 text-slate-700 flex items-center justify-center mx-auto mb-4">
              <Layers className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-slate-900">
              Il catalogo articoli è vuoto
            </h3>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                disabled={seeding}
                onClick={handleSeedStarter}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {seeding ? 'Caricamento...' : 'Carica articoli base SITE'}
              </button>
              <button
                type="button"
                onClick={() => setCsvModalOpen(true)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                Incolla da Excel / CSV
              </button>
            </div>
          </div>
        ) : filteredArticles.length === 0 ? (
          <div className="p-10 text-center max-w-md mx-auto space-y-4">
            <p className="text-sm font-semibold text-slate-900">
              Nessun articolo corrisponde ai filtri attivi
            </p>
            {statusFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setStatusFilter('all')}
                className="inline-flex items-center justify-center min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer"
              >
                Mostra tutti gli articoli ({counts.all})
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-2 pl-4 pr-2 w-10">
                    <label className="inline-flex items-center justify-center min-h-[32px] min-w-[32px] cursor-pointer">
                      <input
                        ref={headerCheckboxRef}
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllFiltered}
                        aria-label="Seleziona tutti gli articoli visibili"
                        className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 cursor-pointer"
                      />
                    </label>
                  </th>
                  <th className="py-2 px-4">Cod. articolo</th>
                  <th className="py-2 px-4">Descrizione</th>
                  <th className="py-2 px-4">Categoria</th>
                  <th className="py-2 px-4">U.M.</th>
                  <th className="py-2 px-4">Stato</th>
                  <th className="py-2 px-4 text-right">Azioni</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs font-normal">
                {filteredArticles.map((art) => {
                  const isRowSelected = selectedIds.has(art.articleId);
                  return (
                    <tr
                      key={art.articleId}
                      className={`transition-colors ${isRowSelected
                          ? 'bg-slate-100 hover:bg-slate-100'
                          : 'hover:bg-slate-50'
                        }`}
                    >
                      <td className="py-2 pl-4 pr-2 w-10">
                        <label className="inline-flex items-center justify-center min-h-[32px] min-w-[32px] cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isRowSelected}
                            onChange={() => toggleSelectRow(art.articleId)}
                            aria-label={`Seleziona articolo ${art.codiceArticolo}`}
                            className="w-4 h-4 rounded border-slate-300 text-slate-900 focus:ring-slate-900 cursor-pointer"
                          />
                        </label>
                      </td>
                      <td
                        onClick={() => toggleSelectRow(art.articleId)}
                        className="py-2 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap cursor-pointer"
                      >
                        {art.codiceArticolo}
                      </td>
                      <td
                        onClick={() => toggleSelectRow(art.articleId)}
                        className={`py-2 px-4 cursor-pointer ${art.active
                            ? 'text-slate-900 font-normal'
                            : 'text-slate-500 line-through decoration-slate-300'
                          }`}
                      >
                        {art.descrizione}
                      </td>
                      <td className="py-2 px-4 text-slate-600 whitespace-nowrap">
                        {art.categoria}
                      </td>
                      <td className="py-2 px-4 font-mono text-slate-600">
                        {art.unitaMisura}
                      </td>
                      <td className="py-2 px-4 whitespace-nowrap">
                        <span
                          className={
                            art.active
                              ? 'text-slate-900 font-semibold'
                              : 'text-slate-400 font-normal'
                          }
                        >
                          {art.active ? 'Attivo' : 'Archiviato'}
                        </span>
                      </td>
                      <td className="py-2 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-2">
                          <button
                            type="button"
                            disabled={bulkBusy}
                            onClick={() => handleSingleRowToggleActive(art)}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer disabled:opacity-40"
                            title={
                              art.active
                                ? 'Archivia articolo'
                                : 'Ripristina articolo attivo'
                            }
                            aria-label={
                              art.active
                                ? 'Archivia articolo'
                                : 'Ripristina articolo attivo'
                            }
                          >
                            {art.active ? (
                              <Archive className="w-4 h-4" />
                            ) : (
                              <ArchiveRestore className="w-4 h-4 text-slate-900" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditModal(art)}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-300 bg-white text-slate-700 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                            title="Modifica articolo"
                            aria-label="Modifica articolo"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(art)}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer"
                            title="Elimina articolo"
                            aria-label="Elimina articolo"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Article Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4">
          <form
            onSubmit={handleSaveArticle}
            className="w-full max-w-md rounded-xl bg-white border border-slate-200 p-6 animate-fluid-pop shadow-xl"
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-base font-semibold text-slate-900">
                {editingArticle ? 'Modifica articolo' : 'Nuovo articolo'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Cod. articolo *
                </label>
                <input
                  type="text"
                  required
                  value={codiceArticolo}
                  onChange={(e) => setCodiceArticolo(e.target.value)}
                  placeholder="Es. APP-ONT-01"
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-sm text-slate-900"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  Descrizione *
                </label>
                <input
                  type="text"
                  required
                  value={descrizione}
                  onChange={(e) => setDescrizione(e.target.value)}
                  placeholder="Es. ONT Fibra Ottica GPON Gigabit"
                  className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-normal text-slate-900"
                />
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Categoria *
                  </label>
                  <input
                    type="text"
                    required
                    list="existing-categories"
                    value={categoria}
                    onChange={(e) => setCategoria(e.target.value)}
                    placeholder="Es. Apparati Attivi"
                    className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-sm font-normal text-slate-900"
                  />
                  <datalist id="existing-categories">
                    {categories.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    U.M. *
                  </label>
                  <input
                    type="text"
                    required
                    value={unitaMisura}
                    onChange={(e) => setUnitaMisura(e.target.value)}
                    placeholder="pz"
                    className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 font-mono text-sm text-slate-900"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 pt-2 text-xs font-normal text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-slate-900"
                />
                <span>Articolo selezionabile dai tecnici</span>
              </label>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={saving}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {saving ? 'Salvataggio...' : 'Salva articolo'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Bulk CSV Import Modal */}
      {csvModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4">
          <form
            onSubmit={handleBulkImport}
            className="w-full max-w-lg rounded-xl bg-white border border-slate-200 p-6 animate-fluid-pop shadow-xl"
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h3 className="text-base font-semibold text-slate-900">
                Importazione articoli (CSV / Excel)
              </h3>
              <button
                type="button"
                onClick={() => setCsvModalOpen(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <p className="text-xs font-normal text-slate-600 leading-relaxed">
                Formato colonne:{' '}
                <span className="font-mono font-semibold text-slate-900">
                  CodiceArticolo;Descrizione;Categoria;UM
                </span>
              </p>

              <input
                type="file"
                accept=".csv,.txt,.tsv"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const text = await file.text();
                    setCsvText(text);
                  }
                }}
                className="block w-full text-xs text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border file:border-slate-300 file:text-xs file:font-semibold file:bg-white file:text-slate-800 hover:file:bg-slate-50"
              />

              <textarea
                rows={7}
                required
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={
                  'APP-ONT-01;ONT Fibra GPON;Apparati Attivi;pz\nFIB-PATCH-LC;Bretella Ottica 3m;Ottica;pz'
                }
                className="w-full px-4 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900 leading-relaxed"
              />
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCsvModalOpen(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
              >
                Annulla
              </button>
              <button
                type="submit"
                disabled={importingCsv}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 cursor-pointer disabled:opacity-50"
              >
                {importingCsv ? 'Importazione...' : 'Importa articoli'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Single Article Confirm Modal */}
      <ConfirmModal
        open={Boolean(confirmDelete)}
        title="Eliminare l'articolo dal catalogo?"
        description={
          confirmDelete
            ? `L'articolo "${confirmDelete.codiceArticolo} — ${confirmDelete.descrizione}" verrà rimosso dall'anagrafica.`
            : ''
        }
        confirmLabel="Elimina articolo"
        destructive
        loading={deleting}
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Bulk Delete Selected Articles Confirm Modal */}
      <ConfirmModal
        open={confirmBulkDeleteOpen}
        title={`Eliminare ${selectedIds.size} articoli selezionati?`}
        description={`I ${selectedIds.size} articoli selezionati verranno rimossi dall'anagrafica materiali.`}
        confirmLabel={`Elimina ${selectedIds.size} articoli`}
        destructive
        loading={bulkBusy}
        onConfirm={handleBulkDeleteConfirmed}
        onCancel={() => setConfirmBulkDeleteOpen(false)}
      />
    </div>
  );
};
