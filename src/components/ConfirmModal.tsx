import React from 'react';
import { X } from 'lucide-react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  title,
  description,
  confirmLabel = 'Conferma',
  cancelLabel = 'Annulla',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 animate-fluid-pop shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h3
            id="confirm-modal-title"
            className="text-base font-semibold text-slate-900"
          >
            {title}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer shrink-0 interactive-press"
            aria-label="Chiudi finestra"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="mt-4 text-sm text-slate-600 leading-relaxed whitespace-pre-line">
          {description}
        </p>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 hover:border-slate-400 whitespace-nowrap cursor-pointer disabled:opacity-50 interactive-press"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`min-h-[44px] px-4 py-2 rounded-lg border text-xs font-semibold text-white whitespace-nowrap cursor-pointer disabled:opacity-50 interactive-press shadow-xs ${destructive
                ? 'bg-red-700 border-red-900 hover:bg-red-800'
                : 'bg-slate-900 border-slate-950 hover:bg-slate-800'
              }`}
          >
            {loading ? 'Elaborazione...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
