import { User } from 'firebase/auth';
import { auth } from './firebase';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 500, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const RETRY_DELAYS_MS = [600, 1350, 2400];

let activeMutationCount = 0;
let seenServerApiVersion: string | null = null;
let lastSwAlignmentAt = 0;
let swAlignmentPromise: Promise<void> | null = null;
let swLifecycleInitialized = false;

const recoverySyncCallbacks = new Set<() => void>();

export function registerRecoverySyncCallback(cb: () => void): () => void {
  recoverySyncCallbacks.add(cb);
  return () => {
    recoverySyncCallbacks.delete(cb);
  };
}

function notifyRecoverySync(): void {
  for (const cb of recoverySyncCallbacks) {
    try {
      cb();
    } catch {
      // Ignore callback error
    }
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function purgeAccidentalApiCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  try {
    const cacheNames = await window.caches.keys();
    await Promise.all(
      cacheNames.map(async (cacheName) => {
        try {
          const cache = await window.caches.open(cacheName);
          const keys = await cache.keys();
          await Promise.all(
            keys.map(async (req) => {
              try {
                const url = new URL(req.url, window.location.origin);
                if (url.pathname.startsWith('/api/')) {
                  await cache.delete(req);
                }
              } catch {
                // Ignore malformed cache request URL
              }
            })
          );
        } catch {
          // Ignore individual cache open error
        }
      })
    );
  } catch {
    // Ignore CacheStorage access restrictions
  }
}

/**
 * Silently checks for a newer Service Worker registration and removes any stale
 * `/api/*` cache entries without reloading the page or interrupting open modals.
 */
export async function alignServiceWorkerAndCaches(
  force = false
): Promise<void> {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (!force && now - lastSwAlignmentAt < 30_000) {
    return;
  }
  if (swAlignmentPromise) {
    return swAlignmentPromise;
  }

  lastSwAlignmentAt = now;
  const work = (async () => {
    await purgeAccidentalApiCaches();
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(
          regs.map((reg) =>
            reg.update().catch(() => {
              // Ignore offline or transient SW script check failure
            })
          )
        );
      } catch {
        // Ignore SW registration lookup failure
      }
    }
  })();

  swAlignmentPromise = Promise.race([work, sleepMs(1500)]).finally(() => {
    swAlignmentPromise = null;
  });

  return swAlignmentPromise;
}

/**
 * Initializes non-disruptive Service Worker background updates on app boot,
 * foreground visibility, connectivity recovery, and Vite chunk preload errors.
 */
export function initServiceWorkerAutoAlignment(): void {
  if (typeof window === 'undefined' || swLifecycleInitialized) return;
  swLifecycleInitialized = true;

  // Recover automatically if a lazy-loaded JS/CSS asset hash changed after a deploy
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    void alignServiceWorkerAndCaches(true).finally(() => {
      if (activeMutationCount === 0) {
        window.location.reload();
      }
    });
  });

  // Initial silent SW alignment shortly after boot
  window.setTimeout(() => {
    void alignServiceWorkerAndCaches(false);
  }, 1500);

  const handleVisibilityOrOnline = () => {
    if (document.visibilityState === 'visible') {
      void alignServiceWorkerAndCaches(false);
    }
  };

  document.addEventListener('visibilitychange', handleVisibilityOrOnline);
  window.addEventListener('online', () => {
    void alignServiceWorkerAndCaches(true);
  });
}

function buildSameOriginApiUrl(
  endpointPath: string,
  cacheBustAttempt: number
): string {
  const normalizedPath = (
    endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`
  ).replace(/\/{2,}/g, '/');

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : '';

  if (cacheBustAttempt <= 0) {
    return `${origin}${normalizedPath}`;
  }

  const sep = normalizedPath.includes('?') ? '&' : '?';
  return `${origin}${normalizedPath}${sep}_rt=${Date.now()}_${cacheBustAttempt}`;
}

async function resolveBearerToken(
  explicitUser: User | null | undefined,
  optionalAuth: boolean,
  forceRefresh: boolean
): Promise<string | null> {
  const targetUser = explicitUser || auth.currentUser;
  if (!targetUser) {
    if (optionalAuth) return null;
    throw new ApiError(
      'Sessione Google scaduta. Effettua nuovamente l’accesso.',
      401,
      'AUTH_REQUIRED'
    );
  }

  try {
    const token = await targetUser.getIdToken(forceRefresh);
    return `Bearer ${token}`;
  } catch {
    if (optionalAuth) return null;
    throw new ApiError(
      'Impossibile rinnovare la sessione Google. Verifica la connessione e riprova.',
      401,
      'AUTH_TOKEN_FAILED'
    );
  }
}

function isTransientRetryableFailure(
  status: number,
  code: string,
  errorMessage: string
): boolean {
  if (
    code === 'SMTP_NOT_CONFIGURED' ||
    code === 'SMTP_AUTH_FAILED' ||
    code === 'GMAIL_CONSENT_REQUIRED' ||
    code === 'EMAIL_CONFIG_ERROR' ||
    code === 'NEON_NOT_CONFIGURED' ||
    code === 'LOGIN_ONLY_EMAIL_BLOCKED'
  ) {
    return false;
  }

  const lowerMsg = errorMessage.toLowerCase();
  if (
    status === 404 &&
    (code === 'API_ENDPOINT_NOT_FOUND' ||
      lowerMsg.includes('endpoint api non trovato') ||
      lowerMsg.includes('temporaneamente non raggiungibile'))
  ) {
    return true;
  }

  if (code === 'NEON_CONNECTION_ERROR') {
    return true;
  }

  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export interface FetchApiJsonOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  explicitUser?: User | null;
  optionalAuth?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Executes an API call against `/api/*` with:
 * - Guaranteed `no-store` network bypass and JSON content-type verification
 * - Silent Firebase ID token refresh on 401 expiration
 * - Automatic Service Worker alignment + immediate transparent retry on
 *   transient 404 (`API_ENDPOINT_NOT_FOUND`), 502/503/504 cold-start, HTML warmup
 *   responses, or momentary mobile network drops.
 */
export async function fetchApiJson<T>(
  endpointPath: string,
  options?: FetchApiJsonOptions
): Promise<T> {
  const method = options?.method || 'POST';
  const optionalAuth = Boolean(options?.optionalAuth);
  const maxRetries = options?.maxRetries ?? 3;
  const timeoutMs = options?.timeoutMs ?? 22_000;
  const isMutation = method !== 'GET';

  if (isMutation) {
    activeMutationCount += 1;
  }

  let forceTokenRefresh = false;
  let refreshedAuthOnce = false;
  let recoveredAfterRetry = false;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Cache-Control': 'no-cache, no-store',
        Pragma: 'no-cache',
      };

      if (attempt > 0) {
        headers['X-Site-Client-Retry'] = String(attempt);
      }

      const bearer = await resolveBearerToken(
        options?.explicitUser,
        optionalAuth,
        forceTokenRefresh
      );
      forceTokenRefresh = false;
      if (bearer) {
        headers.Authorization = bearer;
      }

      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }

      const controller = new AbortController();
      const timeoutHandle = globalThis.setTimeout(
        () => controller.abort(),
        timeoutMs
      );

      let resp: Response;
      try {
        resp = await fetch(buildSameOriginApiUrl(endpointPath, attempt), {
          method,
          cache: 'no-store',
          credentials: 'same-origin',
          headers,
          signal: controller.signal,
          ...(method === 'POST'
            ? { body: JSON.stringify(options?.body ?? {}) }
            : {}),
        });
      } catch (networkErr: unknown) {
        globalThis.clearTimeout(timeoutHandle);
        if (attempt < maxRetries) {
          recoveredAfterRetry = true;
          await alignServiceWorkerAndCaches(attempt === 0);
          await sleepMs(
            RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
          );
          continue;
        }
        const isOffline =
          typeof navigator !== 'undefined' && navigator.onLine === false;
        throw new ApiError(
          isOffline
            ? 'Connessione Internet assente. Verifica la rete del dispositivo e riprova.'
            : networkErr instanceof Error && networkErr.name === 'AbortError'
            ? 'Il server sta impiegando più tempo del previsto a rispondere. Riprova tra un istante.'
            : 'Connessione temporaneamente instabile verso il server. Riprova tra un istante.',
          0,
          'NETWORK_ERROR'
        );
      } finally {
        globalThis.clearTimeout(timeoutHandle);
      }

      const respApiVersion = resp.headers.get('x-site-api-version');
      if (respApiVersion) {
        if (
          seenServerApiVersion &&
          seenServerApiVersion !== respApiVersion
        ) {
          void alignServiceWorkerAndCaches(true);
        }
        seenServerApiVersion = respApiVersion;
      }

      const contentType = (resp.headers.get('content-type') || '').toLowerCase();
      const isJson = contentType.includes('application/json');

      // Non-JSON response (e.g. Cloud Run warmup HTML or stale SW fallback HTML)
      if (!isJson) {
        if (attempt < maxRetries) {
          recoveredAfterRetry = true;
          await alignServiceWorkerAndCaches(true);
          await sleepMs(
            RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
          );
          continue;
        }
        throw new ApiError(
          'Il servizio condiviso si sta riavviando. Attendi qualche secondo e riprova.',
          resp.status || 503,
          'NON_JSON_UPSTREAM'
        );
      }

      let data: Record<string, unknown> = {};
      try {
        data = (await resp.json()) as Record<string, unknown>;
      } catch {
        if (attempt < maxRetries) {
          recoveredAfterRetry = true;
          await alignServiceWorkerAndCaches(true);
          await sleepMs(
            RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
          );
          continue;
        }
        throw new ApiError(
          'Risposta incompleta dal server durante il riavvio. Riprova tra un istante.',
          resp.status || 502,
          'INVALID_JSON_UPSTREAM'
        );
      }

      if (!resp.ok) {
        const code = String(data.code || '');
        const rawErr = String(data.error || '');

        // Silent 401 token refresh & immediate retry if user is still signed in
        if (
          resp.status === 401 &&
          !refreshedAuthOnce &&
          Boolean(options?.explicitUser || auth.currentUser)
        ) {
          refreshedAuthOnce = true;
          forceTokenRefresh = true;
          recoveredAfterRetry = true;
          await sleepMs(150);
          continue;
        }

        if (
          attempt < maxRetries &&
          isTransientRetryableFailure(resp.status, code, rawErr)
        ) {
          recoveredAfterRetry = true;
          if (resp.status === 404) {
            await alignServiceWorkerAndCaches(true);
          }
          await sleepMs(
            RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
          );
          continue;
        }

        const friendlyError =
          code === 'API_ENDPOINT_NOT_FOUND' ||
          rawErr.toLowerCase().includes('endpoint api non trovato')
            ? 'Servizio in fase di allineamento automatico sul link condiviso. Riprova tra pochi secondi.'
            : rawErr || `Errore comunicazione server (${resp.status}).`;

        throw new ApiError(friendlyError, resp.status, code);
      }

      if (recoveredAfterRetry && isMutation) {
        notifyRecoverySync();
      }

      return data as T;
    }

    throw new ApiError(
      'Impossibile completare la richiesta dopo i tentativi automatici. Riprova.',
      503,
      'RETRY_EXHAUSTED'
    );
  } finally {
    if (isMutation) {
      activeMutationCount = Math.max(0, activeMutationCount - 1);
    }
  }
}
