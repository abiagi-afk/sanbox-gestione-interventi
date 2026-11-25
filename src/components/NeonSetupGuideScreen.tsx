import React from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { NeonDatabaseStatus } from '../lib/firestoreService';

interface NeonSetupGuideScreenProps {
  status: NeonDatabaseStatus | null;
  checking: boolean;
  onRetryConnection: () => void;
}

export const NeonSetupGuideScreen: React.FC<NeonSetupGuideScreenProps> = ({
  status,
  checking,
  onRetryConnection,
}) => {
  const hasConnectionError = Boolean(
    status?.configured && !status?.connected && status?.error
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      <header className="w-full border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <span className="font-display text-base font-semibold tracking-tight text-slate-900">
            Gestione Interventi SITE
          </span>
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
            <Database className="w-4 h-4 text-slate-700" />
            <span>Database PostgreSQL Serverless (Neon)</span>
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-6 py-10">
        <div className="max-w-2xl w-full bg-white border border-slate-200 rounded-xl p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
              <Database className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h1 className="font-display text-xl font-semibold text-slate-900">
                {hasConnectionError
                  ? 'Verifica stringa di connessione Neon'
                  : 'Collega il database gratuito Neon PostgreSQL'}
              </h1>
              <p className="text-sm font-normal text-slate-600 leading-relaxed">
                Il sistema è stato migrato a PostgreSQL Serverless per garantire
                letture e scritture illimitate senza alcun profilo di
                fatturazione o carta di credito.
              </p>
            </div>
          </div>

          {hasConnectionError && status?.error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-xs font-normal text-red-900 leading-relaxed">
              {status.error}
            </div>
          )}

          <div className="space-y-4 border-t border-b border-slate-100 py-5 text-xs text-slate-700 leading-relaxed">
            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono font-semibold flex items-center justify-center shrink-0">
                1
              </span>
              <div className="space-y-1.5">
                <p className="font-semibold text-slate-900">
                  Crea un progetto gratuito su Neon (senza carta di credito)
                </p>
                <p className="text-slate-600">
                  Accedi su{' '}
                  <a
                    href="https://console.neon.tech"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-semibold text-slate-900 underline underline-offset-2"
                  >
                    <span>console.neon.tech</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>{' '}
                  (anche tramite account Google), clicca su{' '}
                  <span className="font-semibold">New Project</span> e scegli
                  una regione europea (es.{' '}
                  <span className="font-mono">AWS Europe · Frankfurt</span>).
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono font-semibold flex items-center justify-center shrink-0">
                2
              </span>
              <div className="space-y-1.5">
                <p className="font-semibold text-slate-900">
                  Copia la Connection String PostgreSQL
                </p>
                <p className="text-slate-600">
                  Nella finestra <span className="font-semibold">Connect</span>{' '}
                  di Neon seleziona{' '}
                  <span className="font-semibold">Connection string</span> e
                  copia l’indirizzo che inizia con{' '}
                  <span className="font-mono text-slate-900">
                    postgresql://...
                  </span>
                  .
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="w-6 h-6 rounded-full bg-slate-900 text-white font-mono font-semibold flex items-center justify-center shrink-0">
                3
              </span>
              <div className="space-y-1.5">
                <p className="font-semibold text-slate-900">
                  Salva il segreto in AI Studio
                </p>
                <p className="text-slate-600">
                  Apri il pannello{' '}
                  <span className="font-semibold">Secrets (Segreti)</span> di AI
                  Studio (dove hai già inserito{' '}
                  <span className="font-mono">SMTP_PASS</span>), aggiungi una
                  nuova variabile con nome esatto{' '}
                  <span className="px-1.5 py-0.5 rounded bg-slate-100 border border-slate-300 font-mono font-semibold text-slate-900">
                    NEON_DATABASE_URL
                  </span>{' '}
                  e incolla la Connection String.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <ShieldCheck className="w-4 h-4 text-slate-700 shrink-0" />
              <span>
                Creazione automatica delle tabelle al primo collegamento
              </span>
            </div>

            <button
              type="button"
              disabled={checking}
              onClick={onRetryConnection}
              className="inline-flex items-center justify-center gap-2 min-h-[42px] px-5 py-2.5 rounded-lg bg-slate-900 border border-slate-950 text-white text-xs font-semibold hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {checking ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>
                {checking
                  ? 'Verifica in corso...'
                  : 'Verifica connessione database'}
              </span>
            </button>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white py-4 px-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs font-normal text-slate-500">
          <span>Gestione Interventi · Gruppo Apparati SITE Bologna</span>
          <span>Google Login, Google Drive e SMTP già preservati</span>
        </div>
      </footer>
    </div>
  );
};
