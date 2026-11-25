import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, isAndroid, install } =
    usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className={`inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 text-white border border-slate-950 font-semibold hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${compact
            ? 'min-h-[36px] px-4 py-2 text-xs'
            : 'min-h-[44px] px-4 py-2 text-xs'
          }`}
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>Installa App</span>
      </button>
    );
  }

  if (isIOS || isAndroid) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className={`inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white text-slate-800 font-semibold hover:bg-slate-50 hover:border-slate-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${compact
              ? 'min-h-[36px] px-4 py-2 text-xs'
              : 'min-h-[44px] px-4 py-2 text-xs'
            }`}
        >
          <Smartphone className="w-4 h-4 shrink-0" />
          <span>Installa su Telefono</span>
        </button>

        {showGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 backdrop-blur-xs p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white border border-slate-200 p-6">
              <div className="flex items-center justify-between gap-4">
                <h3 className="text-base font-semibold text-slate-900">
                  Installa Gestione Interventi
                </h3>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  className="w-10 h-10 flex items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 cursor-pointer"
                  aria-label="Chiudi guida installazione"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {isIOS ? (
                <p className="mt-4 text-sm text-slate-600 leading-relaxed">
                  1. Tocca <span className="font-semibold text-slate-900">Condividi</span> nella barra di Safari.
                  <br />
                  2. Seleziona <span className="font-semibold text-slate-900">Aggiungi alla schermata Home</span>.
                </p>
              ) : (
                <p className="mt-4 text-sm text-slate-600 leading-relaxed">
                  1. Apri il menu di Chrome in alto a destra.
                  <br />
                  2. Seleziona <span className="font-semibold text-slate-900">Installa app</span> o <span className="font-semibold text-slate-900">Aggiungi a schermata Home</span>.
                </p>
              )}
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="mt-6 w-full min-h-[44px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-xs font-semibold text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                Chiudi
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
