import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readable = error.message || 'Errore imprevisto nell’applicazione.';
    try {
      const parsed = JSON.parse(error.message) as {
        error?: string;
        operationType?: string;
        path?: string;
      };
      if (parsed && parsed.error) {
        readable = `Errore accesso dati (${parsed.operationType || 'operazione'} su ${parsed.path || 'database'
          }): ${parsed.error}`;
      }
    } catch {
      // Keep raw error message
    }
    return { hasError: true, message: readable };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6">
            <div className="w-10 h-10 rounded-lg bg-slate-100 border border-slate-200 text-slate-800 flex items-center justify-center mb-4">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h1 className="text-lg font-semibold text-slate-900">
              Si è verificato un problema
            </h1>
            <p className="mt-2 text-sm font-normal text-slate-600 break-words leading-relaxed">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg bg-slate-900 border border-slate-950 text-white text-xs font-semibold hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Ricarica applicazione</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
