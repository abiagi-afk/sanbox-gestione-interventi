import { auth } from './firebase';
import { fetchApiJson } from './apiClient';

const SOUND_MUTED_STORAGE_KEY = 'site_interventi_sound_muted_v1';

let sharedAudioCtx: AudioContext | null = null;

function getOrCreateAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtxCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtxCtor) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioCtxCtor();
  }
  return sharedAudioCtx;
}

/**
 * Unlocks the browser AudioContext on the first user gesture so real-time
 * Firestore task-completion events can play the desktop chime immediately.
 */
export function unlockNotificationAudio(): void {
  try {
    const ctx = getOrCreateAudioContext();
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume();
    }
  } catch {
    // Ignore audio context restrictions
  }
}

export function isCompletionSoundMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SOUND_MUTED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCompletionSoundMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (muted) {
      window.localStorage.setItem(SOUND_MUTED_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(SOUND_MUTED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Synthesizes a crisp, non-intrusive two-note harmonic chime (C5 -> G5 + C6 shimmer)
 * via Web Audio API with zero external audio asset dependencies.
 */
export function playTaskCompletedChime(options?: { ignoreMute?: boolean }): void {
  if (!options?.ignoreMute && isCompletionSoundMuted()) return;
  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches &&
    !options?.ignoreMute
  ) {
    // Still play gentle single tone, no rapid modulation
  }

  try {
    const ctx = getOrCreateAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const now = ctx.currentTime;
    const notes = [
      { freq: 587.33, start: 0, duration: 0.16, peak: 0.14 }, // D5
      { freq: 880.0, start: 0.12, duration: 0.34, peak: 0.16 }, // A5
      { freq: 1174.66, start: 0.13, duration: 0.28, peak: 0.06 }, // D6 harmonic
    ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.start);

      gain.gain.setValueAtTime(0.0001, now + n.start);
      gain.gain.exponentialRampToValueAtTime(n.peak, now + n.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        now + n.start + n.duration
      );

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.start);
      osc.stop(now + n.start + n.duration + 0.02);
    }
  } catch {
    // Ignore if browser blocks autoplay before first interaction
  }
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return (
    /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isRunningStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function isIosNonStandalone(): boolean {
  return isIosDevice() && !isRunningStandalonePwa();
}

export function isWebPushSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function detectSyntheticDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Dispositivo Admin';
  const ua = navigator.userAgent;
  const standalone = isRunningStandalonePwa() ? ' · App' : '';
  if (/Android/i.test(ua)) return `Smartphone Android${standalone}`;
  if (/iPhone|iPad|iPod/i.test(ua)) return `iPhone / iPad${standalone}`;
  if (/Windows/i.test(ua)) return `PC Windows${standalone}`;
  if (/Macintosh|Mac OS X/i.test(ua)) return `Mac Desktop${standalone}`;
  if (/Linux/i.test(ua)) return `PC Linux${standalone}`;
  return `Dispositivo Web${standalone}`;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function computePushSubId(endpoint: string): Promise<string> {
  const enc = new TextEncoder().encode(endpoint.trim());
  const hashBuf = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 28);
  return `push_${hex}`;
}

async function getReadyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) {
    await navigator.serviceWorker.ready;
    return existing;
  }
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
    ]);
  } catch {
    return null;
  }
}

export async function getCurrentBrowserPushSubscription(): Promise<{
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscription: PushSubscription | null;
  subId: string | null;
}> {
  if (!isWebPushSupported()) {
    return {
      supported: false,
      permission:
        typeof Notification !== 'undefined'
          ? Notification.permission
          : 'unsupported',
      subscription: null,
      subId: null,
    };
  }

  const reg = await getReadyServiceWorkerRegistration();
  if (!reg) {
    return {
      supported: true,
      permission: Notification.permission,
      subscription: null,
      subId: null,
    };
  }

  const sub = await reg.pushManager.getSubscription();
  const subId = sub ? await computePushSubId(sub.endpoint) : null;
  return {
    supported: true,
    permission: Notification.permission,
    subscription: sub,
    subId,
  };
}

export interface BrowserPushCredentials {
  subId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string;
}

/**
 * Requests notification permission, fetches the server's VAPID public key,
 * and subscribes the PWA Service Worker to RFC 8030 Web Push.
 */
export async function subscribeBrowserToWebPush(): Promise<BrowserPushCredentials> {
  if (isIosNonStandalone()) {
    throw new Error(
      'Su iPhone/iPad aggiungi prima l\'app alla schermata Home (Condividi -> Aggiungi alla schermata Home) per ricevere notifiche Push.'
    );
  }
  if (!isWebPushSupported()) {
    throw new Error(
      'Questo browser non supporta le notifiche Web Push in background.'
    );
  }

  unlockNotificationAudio();

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      'Permesso notifiche negato dal browser. Abilita le notifiche nelle impostazioni del sito.'
    );
  }

  const { publicKey } = await fetchApiJson<{ publicKey?: string }>(
    '/api/push/vapid-public-key',
    {
      method: 'GET',
      optionalAuth: true,
      maxRetries: 2,
    }
  );
  if (!publicKey) {
    throw new Error('Chiave pubblica VAPID mancante sul server.');
  }

  const reg = await getReadyServiceWorkerRegistration();
  if (!reg) {
    throw new Error(
      'Service Worker non ancora pronto. Ricarica la pagina e riprova.'
    );
  }

  let sub = await reg.pushManager.getSubscription();
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  if (sub) {
    // Verify existing key matches current VAPID public key; resubscribe if rotated
    const existingKey = sub.options.applicationServerKey
      ? new Uint8Array(sub.options.applicationServerKey)
      : null;
    const sameKey =
      existingKey &&
      existingKey.length === applicationServerKey.length &&
      existingKey.every((v, i) => v === applicationServerKey[i]);
    if (!sameKey) {
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh || '';
  const authSecret = json.keys?.auth || '';
  if (!sub.endpoint || !p256dh || !authSecret) {
    throw new Error('Sottoscrizione Push incompleta restituita dal browser.');
  }

  const subId = await computePushSubId(sub.endpoint);
  return {
    subId,
    endpoint: sub.endpoint,
    p256dh,
    auth: authSecret,
    deviceLabel: detectSyntheticDeviceLabel(),
  };
}

export async function unsubscribeBrowserFromWebPush(): Promise<string | null> {
  if (!isWebPushSupported()) return null;
  const reg = await getReadyServiceWorkerRegistration();
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const subId = await computePushSubId(sub.endpoint);
  await sub.unsubscribe().catch(() => undefined);
  return subId;
}

/**
 * Shows a native OS desktop notification when the tab is open on PC and Push SW
 * has not already registered a subscription (uses identical `tag` to avoid duplicates).
 */
export async function showForegroundDesktopNotification(params: {
  title: string;
  body: string;
  taskId: string;
  onClickTask: (taskId: string) => void;
}): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    const state = await getCurrentBrowserPushSubscription();
    // If Web Push SW is active on this browser, the SW `push` event handles the OS banner
    if (state.subscription) return;

    const notif = new Notification(params.title, {
      body: params.body,
      icon: '/pwa-192x192.png',
      tag: `site-task-completed-${params.taskId}`,
    });
    notif.onclick = () => {
      window.focus();
      params.onClickTask(params.taskId);
      notif.close();
    };
  } catch {
    // Ignore environments where `new Notification` is restricted in favor of SW
  }
}

/**
 * Triggers server-side RFC 8030 Web Push delivery to all registered active Admin devices
 * (smartphones & PCs, working even when all Admin PCs are powered off).
 */
export async function triggerTaskCompletedWebPush(params: {
  taskId: string;
  commessa: string;
  descrizione: string;
  completedByName: string;
  pendingAdminReview?: boolean;
  noteSummary?: string;
}): Promise<void> {
  try {
    if (!auth.currentUser) return;
    await fetchApiJson('/api/push/notify-task-completed', {
      method: 'POST',
      body: params,
      maxRetries: 2,
    });
  } catch {
    // Non-blocking: never fail task completion if offline or push server unreachable
  }
}

export async function sendTestWebPush(): Promise<{
  sent: number;
  activeDevices: number;
}> {
  if (!auth.currentUser) {
    throw new Error('Utente non autenticato.');
  }
  const data = await fetchApiJson<{
    sent?: number;
    activeDevices?: number;
  }>('/api/push/test', {
    method: 'POST',
    body: {},
    maxRetries: 2,
  });
  return {
    sent: data.sent ?? 0,
    activeDevices: data.activeDevices ?? 0,
  };
}
