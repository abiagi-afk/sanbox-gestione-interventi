/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { OfflineIndicator } from './components/OfflineIndicator';
import { LoginScreen } from './components/LoginScreen';
import { NeonSetupGuideScreen } from './components/NeonSetupGuideScreen';
import { AdminPortal } from './components/admin/AdminPortal';
import { TechnicianMobileApp } from './components/mobile/TechnicianMobileApp';
import { TechnicianWebPortal } from './components/technician/TechnicianWebPortal';

const AppShell: React.FC = () => {
  const {
    authReady,
    dataLoading,
    neonStatus,
    neonSetupRequired,
    checkingNeonStatus,
    refreshNeonStatus,
    firebaseUser,
    profile,
    hasWorkspaceToken,
    viewMode,
    toasts,
    dismissToast,
  } = useApp();

  const [isSmartphoneViewport, setIsSmartphoneViewport] = useState<boolean>(
    () => (typeof window !== 'undefined' ? window.innerWidth < 1024 : false)
  );
  const [adminForceSmartphonePreview, setAdminForceSmartphonePreview] =
    useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 1023px)');
    const handleChange = () => setIsSmartphoneViewport(mq.matches);
    handleChange();
    mq.addEventListener('change', handleChange);
    return () => mq.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (viewMode === 'admin') {
      setAdminForceSmartphonePreview(false);
    }
  }, [viewMode]);

  if (
    !authReady ||
    (checkingNeonStatus && !neonStatus) ||
    (!neonSetupRequired && firebaseUser && !profile && dataLoading)
  ) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-6">
        <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center mb-4">
          <div className="grid grid-cols-2 gap-0 w-4 h-4 animate-pulse">
            <span className="bg-slate-400 rounded-[1px]" />
            <span className="bg-white rounded-[1px]" />
            <span className="bg-white rounded-[1px]" />
            <span className="bg-slate-400 rounded-[1px]" />
          </div>
        </div>
        <p className="text-xs font-normal text-slate-600">
          Caricamento Gestione Interventi SITE...
        </p>
      </div>
    );
  }

  return (
    <>
      <OfflineIndicator />

      {neonSetupRequired ? (
        <NeonSetupGuideScreen
          status={neonStatus}
          checking={checkingNeonStatus}
          onRetryConnection={() => {
            void refreshNeonStatus();
          }}
        />
      ) : !firebaseUser || !profile ? (
        <LoginScreen />
      ) : profile.role === 'admin' && viewMode === 'admin' ? (
        <AdminPortal />
      ) : isSmartphoneViewport ||
        (profile.role === 'admin' && adminForceSmartphonePreview) ? (
        <TechnicianMobileApp
          onExitSmartphonePreview={
            !isSmartphoneViewport && profile.role === 'admin'
              ? () => setAdminForceSmartphonePreview(false)
              : undefined
          }
        />
      ) : (
        <TechnicianWebPortal
          onToggleSmartphonePreview={
            profile.role === 'admin'
              ? () => setAdminForceSmartphonePreview(true)
              : undefined
          }
        />
      )}

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-20 lg:bottom-6 right-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] pointer-events-none"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              className="pointer-events-auto flex items-start justify-between gap-2 rounded-xl bg-slate-900 text-white p-4 text-xs border border-slate-800"
            >
              <div className="flex items-start gap-2 min-w-0">
                {t.tone === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-slate-200 shrink-0" />
                ) : t.tone === 'error' ? (
                  <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                ) : (
                  <Info className="w-4 h-4 text-slate-300 shrink-0" />
                )}
                <div className="min-w-0 space-y-2">
                  <p className="leading-relaxed break-words">{t.message}</p>
                  {t.actionLabel && t.onAction && (
                    <button
                      type="button"
                      onClick={() => {
                        t.onAction?.();
                        dismissToast(t.id);
                      }}
                      className="inline-flex items-center px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-white font-semibold text-xs transition-colors cursor-pointer whitespace-nowrap"
                    >
                      {t.actionLabel}
                    </button>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:text-white hover:border-slate-500 shrink-0 cursor-pointer"
                aria-label="Chiudi notifica"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppShell />
      </AppProvider>
    </ErrorBoundary>
  );
}
