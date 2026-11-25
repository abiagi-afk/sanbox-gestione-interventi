import React from 'react';
import { CalendarCheck, Camera, ClipboardList, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { PWAInstallButton } from './PWAInstallButton';

export const LoginScreen: React.FC = () => {
  const {
    firebaseUser,
    signInWithGoogle,
    signOutUser,
    isSigningInUser,
    authError,
  } = useApp();

  const isSessionResume = Boolean(firebaseUser?.email);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      {/* Top 3-zone header */}
      <header className="w-full border-b border-slate-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <span className="font-display text-base font-semibold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            Gestione Interventi SITE
          </span>
          <div className="hidden md:flex items-center gap-6 text-xs font-normal text-slate-500">
            <span className="whitespace-nowrap">Pianificazione task</span>
            <span className="whitespace-nowrap">Squadre in campo</span>
            <span className="whitespace-nowrap">Consuntivo materiali</span>
            <span className="whitespace-nowrap">Archivio foto Drive</span>
          </div>
          <div className="shrink-0">
            <PWAInstallButton compact />
          </div>
        </div>
      </header>

      {/* Main Centered Split Workspace */}
      <main className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="max-w-5xl w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Column: Operational Overview */}
          <div className="lg:col-span-7 flex flex-col justify-center">
            <p className="text-xs font-semibold text-slate-600">
              Gruppo Apparati · Sede Operativa Bologna
            </p>
            <h1
              className="mt-2 font-display text-3xl sm:text-4xl font-semibold text-slate-900 tracking-tight leading-tight"
              style={{ textWrap: 'balance' }}
            >
              Coordinamento interventi tecnici, materiali impiegati e documentazione fotografica.
            </h1>

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4 pt-6 border-t border-slate-200">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-800 shrink-0">
                  <CalendarCheck className="w-4 h-4" />
                </div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Calendario e squadre
                </h2>
              </div>

              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-800 shrink-0">
                  <ClipboardList className="w-4 h-4" />
                </div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Materiali nei task
                </h2>
              </div>

              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-800 shrink-0">
                  <Camera className="w-4 h-4" />
                </div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Google Drive e Gmail
                </h2>
              </div>

              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-800 shrink-0">
                  <ShieldCheck className="w-4 h-4" />
                </div>
                <h2 className="text-sm font-semibold text-slate-900">
                  Accesso per ruolo
                </h2>
              </div>
            </div>
          </div>

          {/* Right Column: Sign-In Card */}
          <div className="lg:col-span-5 flex flex-col justify-center">
            <div className="bg-white border border-slate-200 rounded-xl p-8">
              <div className="w-10 h-10 rounded-lg bg-slate-900 flex items-center justify-center mb-6">
                <div className="grid grid-cols-2 gap-0 w-4 h-4">
                  <span className="bg-slate-400 rounded-[1px]" />
                  <span className="bg-white rounded-[1px]" />
                  <span className="bg-white rounded-[1px]" />
                  <span className="bg-slate-400 rounded-[1px]" />
                </div>
              </div>

              <h2 className="font-display text-xl font-semibold text-slate-900">
                {isSessionResume ? 'Riprendi sessione Google' : 'Accedi al portale'}
              </h2>
              <p className="mt-2 text-sm font-normal text-slate-600 leading-relaxed">
                {isSessionResume ? (
                  <>
                    Conferma l’accesso come{' '}
                    <span className="font-mono font-semibold text-slate-900">
                      {firebaseUser?.email}
                    </span>
                    .
                  </>
                ) : (
                  'Accedi con il tuo account Google aziendale.'
                )}
              </p>

              {authError && (
                <div className="mt-4 rounded-lg bg-slate-50 border border-slate-400 p-4 text-xs font-normal text-slate-900 leading-relaxed">
                  {authError}
                </div>
              )}

              <div className="mt-6 space-y-4">
                <button
                  type="button"
                  onClick={() => signInWithGoogle(false)}
                  disabled={isSigningInUser}
                  className="gsi-material-button"
                >
                  <div className="gsi-material-button-state" />
                  <div className="gsi-material-button-content-wrapper">
                    <div className="gsi-material-button-icon">
                      <svg
                        version="1.1"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 48 48"
                        className="block w-5 h-5"
                      >
                        <path
                          fill="#EA4335"
                          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                        />
                        <path
                          fill="#4285F4"
                          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                        />
                        <path
                          fill="#34A853"
                          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                        />
                        <path fill="none" d="M0 0h48v48H0z" />
                      </svg>
                    </div>
                    <span className="gsi-material-button-contents">
                      {isSigningInUser
                        ? 'Sincronizzazione in corso...'
                        : isSessionResume
                          ? 'Continua con Google'
                          : 'Accedi con Google'}
                    </span>
                  </div>
                </button>

                {isSessionResume && (
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <button
                      type="button"
                      disabled={isSigningInUser}
                      onClick={() => signInWithGoogle(true)}
                      className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400 font-semibold cursor-pointer whitespace-nowrap"
                    >
                      Usa un altro account
                    </button>
                    <button
                      type="button"
                      disabled={isSigningInUser}
                      onClick={() => signOutUser()}
                      className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400 font-semibold cursor-pointer whitespace-nowrap"
                    >
                      Disconnetti
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white py-4 px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs font-normal text-slate-500">
          <span>Gestione Interventi · Gruppo Apparati SITE Bologna</span>
          <span>Portale Web e App Tecnici</span>
        </div>
      </footer>
    </div>
  );
};
