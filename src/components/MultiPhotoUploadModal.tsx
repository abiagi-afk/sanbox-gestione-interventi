import React, { useEffect, useMemo, useRef } from 'react';
import { FolderOpen, ImagePlus, Trash2, UploadCloud, X } from 'lucide-react';
import { BatchPhotoUploadProgress } from '../lib/workspaceApi';
import { MASTER_DRIVE_OWNER_EMAIL } from '../types/domain';

interface MultiPhotoUploadModalProps {
  open: boolean;
  files: File[];
  driveFolderPath: string;
  caption: string;
  onCaptionChange: (value: string) => void;
  onRemoveFile: (index: number) => void;
  onAppendFiles: (extraFiles: File[]) => void;
  onConfirm: () => void;
  onCancel: () => void;
  uploading: boolean;
  progress: BatchPhotoUploadProgress | null;
  technicianLabel?: string;
}

function formatBytesCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MultiPhotoUploadModal: React.FC<MultiPhotoUploadModalProps> = ({
  open,
  files,
  driveFolderPath,
  caption,
  onCaptionChange,
  onRemoveFile,
  onAppendFiles,
  onConfirm,
  onCancel,
  uploading,
  progress,
  technicianLabel,
}) => {
  const addMoreInputRef = useRef<HTMLInputElement | null>(null);

  const previews = useMemo(
    () =>
      files.map((f) => ({
        file: f,
        url: URL.createObjectURL(f),
      })),
    [files]
  );

  useEffect(() => {
    return () => {
      previews.forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, [previews]);

  if (!open || files.length === 0) return null;

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 backdrop-blur-xs p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden animate-fluid-pop shadow-xl">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Carica foto su Google Drive
            </h3>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              {files.length}{' '}
              {files.length === 1 ? 'foto selezionata' : 'foto selezionate'}
              {technicianLabel ? ` · ${technicianLabel}` : ''}
            </p>
          </div>
          <button
            type="button"
            disabled={uploading}
            onClick={onCancel}
            className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer disabled:opacity-40"
            aria-label="Chiudi finestra"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 flex items-start gap-2">
            <FolderOpen className="w-4 h-4 text-slate-600 shrink-0" />
            <div className="min-w-0 text-xs space-y-2">
              <p className="text-slate-600">
                Cartella Google Drive ({MASTER_DRIVE_OWNER_EMAIL})
              </p>
              <p className="font-mono font-semibold text-slate-900 break-all">
                {driveFolderPath}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-700">
                File selezionati
              </span>
              {!uploading && (
                <button
                  type="button"
                  onClick={() => addMoreInputRef.current?.click()}
                  className="inline-flex items-center gap-2 min-h-[36px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer"
                >
                  <ImagePlus className="w-3.5 h-3.5" />
                  <span>Aggiungi altre</span>
                </button>
              )}
            </div>

            <div className="max-h-52 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-200">
              {previews.map((item, idx) => (
                <div
                  key={`${item.file.name}_${item.file.lastModified}_${idx}`}
                  className="p-2 flex items-center justify-between gap-2 bg-white"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 overflow-hidden shrink-0 flex items-center justify-center">
                      <img
                        src={item.url}
                        alt={item.file.name}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">
                        {item.file.name}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                        {formatBytesCompact(item.file.size)}
                      </p>
                    </div>
                  </div>

                  {!uploading && (
                    <button
                      type="button"
                      onClick={() => onRemoveFile(idx)}
                      className="w-10 h-10 flex items-center justify-center rounded-lg border border-red-300 bg-white text-red-700 hover:bg-red-50 hover:border-red-400 cursor-pointer shrink-0"
                      aria-label={`Rimuovi ${item.file.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Didascalia opzionale
            </label>
            <input
              type="text"
              disabled={uploading}
              value={caption}
              onChange={(e) => onCaptionChange(e.target.value)}
              placeholder="Es. Collaudo ottico e permutazioni armadio"
              className="w-full min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:border-slate-900 disabled:bg-slate-50"
            />
          </div>

          {uploading && progress && (
            <div className="rounded-xl bg-slate-900 text-white p-4 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs font-mono tabular-nums">
                <span className="truncate">
                  Caricamento {progress.current} di {progress.total} ·{' '}
                  {progress.fileName}
                </span>
                <span className="font-semibold shrink-0">{pct}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
                <div
                  className="h-full bg-white transition-transform duration-150 origin-left"
                  style={{ transform: `scaleX(${Math.max(0.05, pct / 100)})` }}
                />
              </div>
            </div>
          )}
        </div>

        <input
          ref={addMoreInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const selected = e.target.files ? Array.from(e.target.files) : [];
            e.target.value = '';
            if (selected.length > 0) {
              onAppendFiles(selected);
            }
          }}
        />

        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            disabled={uploading}
            onClick={onCancel}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 cursor-pointer disabled:opacity-50"
          >
            Annulla
          </button>
          <button
            type="button"
            disabled={uploading || files.length === 0}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 hover:bg-slate-800 text-xs font-semibold text-white cursor-pointer disabled:opacity-50"
          >
            <UploadCloud className="w-4 h-4" />
            <span>
              {uploading
                ? 'Caricamento in corso...'
                : files.length === 1
                  ? 'Carica 1 foto su Drive'
                  : `Carica ${files.length} foto su Drive`}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
