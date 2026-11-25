import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  BellRing,
  Send,
  Smartphone,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import {
  detectSyntheticDeviceLabel,
  getCurrentBrowserPushSubscription,
  isCompletionSoundMuted,
  isIosNonStandalone,
  isWebPushSupported,
  playTaskCompletedChime,
  sendTestWebPush,
  setCompletionSoundMuted,
  subscribeBrowserToWebPush,
  unsubscribeBrowserFromWebPush,
} from '../lib/notificationService';
import {
  deactivatePushSubscriptionRecord,
  upsertPushSubscriptionRecord,
} from '../lib/firestoreService';

interface AdminNotificationControlProps {
  variant?: 'header' | 'mobile-header' | 'panel';
}

export const AdminNotificationControl: React.FC<
  AdminNotificationControlProps
> = ({ variant = 'header' }) => {
  const { profile, currentAdminUids, showToast } = useApp();

  const [open, setOpen] = useState(false);
  const [pushActive, setPushActive] = useState(false);
  const [pushSupported, setPushSupported] = useState(true);
  const [iosNeedsHomeScreen, setIosNeedsHomeScreen] = useState(false);
  const [soundMuted, setSoundMuted] = useState<boolean>(() =>
    isCompletionSoundMuted()
  );
  const [busyPush, setBusyPush] = useState(false);
  const [busyTest, setBusyTest] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refreshPushState = useCallback(async () => {
    setIosNeedsHomeScreen(isIosNonStandalone());
    const supported = isWebPushSupported();
    setPushSupported(supported);
    if (!supported) {
      setPushActive(false);
      return;
    }
    try {
      const current = await getCurrentBrowserPushSubscription();
      setPushActive(
        Boolean(current.subscription && current.permission === 'granted')
      );
    } catch {
      setPushActive(false);
    }
  }, []);

  useEffect(() => {
    void refreshPushState();
  }, [refreshPushState]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  if (!profile || profile.role !== 'admin') {
    return null;
  }

  const handleToggleSound = () => {
    const nextMuted = !soundMuted;
    setCompletionSoundMuted(nextMuted);
    setSoundMuted(nextMuted);
    if (!nextMuted) {
      playTaskCompletedChime({ ignoreMute: true });
      showToast('Suono completamento task attivato.', 'info');
    } else {
      showToast('Suono completamento task disattivato su questo browser.', 'info');
    }
  };

  const handleEnablePush = async () => {
    setBusyPush(true);
    try {
      const credentials = await subscribeBrowserToWebPush();
      await upsertPushSubscriptionRecord({
        credentials,
        adminUid: profile.uid,
        currentAdminUids,
      });
      setPushActive(true);
      playTaskCompletedChime({ ignoreMute: true });
      showToast(
        `Notifiche Push attive su ${credentials.deviceLabel}.`,
        'success'
      );
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Impossibile attivare le notifiche Push su questo dispositivo.',
        'error'
      );
    } finally {
      setBusyPush(false);
    }
  };

  const handleDisablePush = async () => {
    setBusyPush(true);
    try {
      const current = await getCurrentBrowserPushSubscription();
      const subId = await unsubscribeBrowserFromWebPush();
      const targetSubId = subId || current.subId;
      if (targetSubId) {
        await deactivatePushSubscriptionRecord(targetSubId);
      }
      setPushActive(false);
      showToast('Notifiche Push disattivate su questo dispositivo.', 'info');
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore disattivazione notifiche Push.',
        'error'
      );
    } finally {
      setBusyPush(false);
    }
  };

  const handleSendTestPush = async () => {
    setBusyTest(true);
    try {
      playTaskCompletedChime({ ignoreMute: true });
      const res = await sendTestWebPush();
      if (res.activeDevices === 0) {
        showToast(
          'Nessun dispositivo Admin ha ancora attivato le notifiche Push.',
          'info'
        );
      } else {
        showToast(
          `Notifica Push di prova inviata (${res.sent}/${res.activeDevices} dispositivi Admin attivi).`,
          'success'
        );
      }
    } catch (err) {
      showToast(
        err instanceof Error
          ? err.message
          : 'Errore invio notifica Push di prova.',
        'error'
      );
    } finally {
      setBusyTest(false);
    }
  };

  const deviceName = detectSyntheticDeviceLabel();

  if (variant === 'panel') {
    return (
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold text-slate-900">
            Notifiche completamento task
          </h2>
          <BellRing className="w-4 h-4 text-slate-700 shrink-0" />
        </div>

        <div className="pt-4 border-t border-slate-100 space-y-4 text-xs">
          <div className="flex items-center justify-between gap-2 text-slate-700">
            <span>Dispositivo corrente:</span>
            <span className="font-mono font-semibold text-slate-900 truncate">
              {deviceName}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 text-slate-700">
            <span>Web Push in background:</span>
            <span className="font-semibold text-slate-900">
              {pushActive ? 'Attivo su questo dispositivo' : 'Non attivo'}
            </span>
          </div>

          {iosNeedsHomeScreen && (
            <div className="rounded-lg bg-slate-50 border border-slate-300 p-4 text-xs font-normal text-slate-800 leading-relaxed flex items-start gap-2">
              <Smartphone className="w-4 h-4 text-slate-700 shrink-0" />
              <span>
                Su iPhone/iPad usa Condividi e scegli Aggiungi alla schermata Home per abilitare le notifiche Push.
              </span>
            </div>
          )}

          {!iosNeedsHomeScreen && !pushSupported && (
            <p className="text-slate-500 font-normal leading-relaxed">
              Web Push in background non supportato su questo browser; resta attivo l&apos;avviso sonoro a portale aperto.
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            {pushActive ? (
              <button
                type="button"
                disabled={busyPush}
                onClick={handleDisablePush}
                className="flex-1 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <BellOff className="w-4 h-4 shrink-0" />
                <span>
                  {busyPush ? 'Aggiornamento...' : 'Disattiva Push qui'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled={busyPush || iosNeedsHomeScreen || !pushSupported}
                onClick={handleEnablePush}
                className="flex-1 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 text-xs font-semibold text-white cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <BellRing className="w-4 h-4 shrink-0" />
                <span>
                  {busyPush
                    ? 'Attivazione...'
                    : 'Attiva Push su questo dispositivo'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={handleToggleSound}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
            >
              {soundMuted ? (
                <>
                  <VolumeX className="w-4 h-4 text-slate-500 shrink-0" />
                  <span>Suono muto</span>
                </>
              ) : (
                <>
                  <Volume2 className="w-4 h-4 text-slate-900 shrink-0" />
                  <span>Suono attivo</span>
                </>
              )}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => playTaskCompletedChime({ ignoreMute: true })}
              className="flex-1 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap"
            >
              <Volume2 className="w-4 h-4 shrink-0" />
              <span>Prova suono</span>
            </button>
            <button
              type="button"
              disabled={busyTest}
              onClick={handleSendTestPush}
              className="flex-1 inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 text-xs font-semibold text-slate-800 cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              <Send className="w-4 h-4 shrink-0" />
              <span>{busyTest ? 'Invio...' : 'Test Push Admin'}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isMobileTouch = variant === 'mobile-header';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer font-semibold ${isMobileTouch
            ? 'min-h-[44px] min-w-[44px] px-2 text-xs'
            : 'min-h-[40px] px-4 py-2 text-xs'
          } ${pushActive
            ? 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50 hover:border-slate-400'
            : 'border-slate-950 bg-slate-900 text-white hover:bg-slate-800'
          }`}
        aria-label="Impostazioni notifiche e suono completamento task"
        aria-expanded={open}
      >
        {pushActive ? (
          <BellRing className="w-4 h-4 text-slate-900 shrink-0" />
        ) : (
          <Bell className="w-4 h-4 shrink-0" />
        )}
        {!isMobileTouch && (
          <span>{pushActive ? 'Notifiche attive' : 'Attiva notifiche'}</span>
        )}
        {soundMuted && (
          <VolumeX
            className={`w-4 h-4 shrink-0 ${pushActive ? 'text-slate-400' : 'text-white/75'
              }`}
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 rounded-xl bg-white border border-slate-300 p-4 z-50 space-y-4 text-xs">
          <div className="flex items-start justify-between gap-2 pb-2 border-b border-slate-100">
            <div className="min-w-0">
              <p className="font-semibold text-slate-900">
                Avvisi completamento task
              </p>
              <p className="text-[11px] text-slate-500 font-mono truncate">
                {deviceName}
              </p>
            </div>
            <span className="text-[11px] font-semibold text-slate-700 whitespace-nowrap">
              {pushActive ? 'Push attivo' : 'Push spento'}
            </span>
          </div>

          {iosNeedsHomeScreen && (
            <div className="rounded-lg bg-slate-50 border border-slate-300 p-2 text-[11px] font-normal text-slate-800 leading-relaxed">
              Su iPhone/iPad usa Condividi e poi Aggiungi alla schermata Home per ricevere notifiche Push.
            </div>
          )}

          <div className="space-y-2">
            {pushActive ? (
              <button
                type="button"
                disabled={busyPush}
                onClick={handleDisablePush}
                className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 font-semibold text-slate-800 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <BellOff className="w-4 h-4" />
                <span>
                  {busyPush
                    ? 'Disattivazione...'
                    : 'Disattiva Push su questo dispositivo'}
                </span>
              </button>
            ) : (
              <button
                type="button"
                disabled={busyPush || iosNeedsHomeScreen || !pushSupported}
                onClick={handleEnablePush}
                className="w-full min-h-[40px] px-4 py-2 rounded-lg border border-slate-950 bg-slate-900 hover:bg-slate-800 font-semibold text-white flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
              >
                <BellRing className="w-4 h-4" />
                <span>
                  {busyPush
                    ? 'Attivazione...'
                    : 'Attiva Push su questo dispositivo'}
                </span>
              </button>
            )}

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleToggleSound}
                className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 font-semibold text-slate-800 flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap"
              >
                {soundMuted ? (
                  <>
                    <VolumeX className="w-4 h-4 text-slate-500" />
                    <span>Suono muto</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="w-4 h-4 text-slate-900" />
                    <span>Suono attivo</span>
                  </>
                )}
              </button>

              <button
                type="button"
                disabled={busyTest}
                onClick={handleSendTestPush}
                className="min-h-[40px] px-2 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 hover:border-slate-400 font-semibold text-slate-800 flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>{busyTest ? 'Invio...' : 'Prova avviso'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
