import { Hono } from 'hono';
import firebaseConfig from '../firebase-applet-config.json';
import { createDataRouter, type VerifiedServerUser } from './server/dataRouter.ts';
import {
  enqueueEmailOutboxEntry,
  fetchActivePushSubscriptionsFromNeon,
  fetchPendingEmailOutboxSummary,
  isVerifiedAdminInNeon,
  markEmailOutboxError,
  markEmailOutboxSent,
  runWithD1Context,
} from './server/d1Db.ts';

export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  VAPID_SUBJECT?: string;
}

const DEFAULT_OWNER_EMAIL = 'a.biagi@sitespa.it';
const API_REVISION = '2026.11.18-cf-google-r2';

const app = new Hono<{ Bindings: WorkerEnv }>();

// Cache in-memory dell'Access Token Google scambiato dal Refresh Token (valido ~55 min)
let cachedServiceGmailToken: { token: string; expiresAtMs: number } | null = null;
// Cache in-memory opzionale del token Workspace inviato dal browser dell'owner
let ownerGmailSession: { accessToken: string; expiresAtMs: number } | null = null;

function saveOwnerGmailTokenInRam(rawToken: string): void {
  const clean = String(rawToken || '').trim();
  if (!clean) {
    ownerGmailSession = null;
    return;
  }
  ownerGmailSession = {
    accessToken: clean,
    expiresAtMs: Date.now() + 50 * 60 * 1000,
  };
}

function getValidOwnerGmailTokenFromRam(): string | null {
  if (!ownerGmailSession) return null;
  if (Date.now() >= ownerGmailSession.expiresAtMs) {
    ownerGmailSession = null;
    return null;
  }
  return ownerGmailSession.accessToken;
}


const VAPID_KEYS: { publicKey: string; privateJWK: JsonWebKey } = {
  publicKey:
    'BHwA90sfT0F1RsVBmIYBRVKsrx7-fLkzsyt9hj7WNRlGLK4ZevLvzvcLGDgIo1mAxb0g63s_nD8MtKrJBd-Sj3I',
  privateJWK: {
    kty: 'EC',
    crv: 'P-256',
    d: 'X0IVmOL8En0keWLadGVQ6Wzw7ZOYkdGY0TGCGEEWC7s',
    x: 'fAD3Sx9PQXVGxUGYhgFFUqyvHv58uTOzK32GPtY1GUY',
    y: 'LK4ZevLvzvcLGDgIo1mAxb0g63s_nD8MtKrJBd-Sj3I',
  },
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

// Invio Web Push RFC 8291 (aes128gcm) + RFC 8292 (VAPID ES256) nativo con Web Crypto API
async function sendWebPushNative(
  endpoint: string,
  keys: { p256dh: string; auth: string },
  adminSubject: string,
  payloadJson: string
): Promise<boolean> {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const enc = new TextEncoder();

  // 1. Firma VAPID JWT (ES256)
  const headerB64 = bytesToBase64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claimB64 = bytesToBase64Url(
    enc.encode(JSON.stringify({ aud: audience, exp, sub: adminSubject }))
  );
  const unsignedJwt = `${headerB64}.${claimB64}`;

  const vapidPrivKey = await crypto.subtle.importKey(
    'jwk',
    VAPID_KEYS.privateJWK,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const jwtSig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      vapidPrivKey,
      enc.encode(unsignedJwt)
    )
  );
  const jwt = `${unsignedJwt}.${bytesToBase64Url(jwtSig)}`;

  // 2. Cifratura payload RFC 8291 (aes128gcm)
  const uaPublicBytes = base64UrlToBytes(keys.p256dh);
  const authSecretBytes = base64UrlToBytes(keys.auth);

  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPublicBytes,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ephemeralPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const asPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeralPair.publicKey)
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaPublicKey },
      ephemeralPair.privateKey,
      256
    )
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prkKey = await hmacSha256(authSecretBytes, ecdhSecret);
  const keyInfo = concatBytes(
    enc.encode('WebPush: info\0'),
    uaPublicBytes,
    asPublicBytes,
    new Uint8Array([1])
  );
  const ikm = await hmacSha256(prkKey, keyInfo);
  const prk = await hmacSha256(salt, ikm);

  const cekFull = await hmacSha256(
    prk,
    concatBytes(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1]))
  );
  const nonceFull = await hmacSha256(
    prk,
    concatBytes(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1]))
  );
  const cek = cekFull.subarray(0, 16);
  const nonce = nonceFull.subarray(0, 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const paddedPlaintext = concatBytes(enc.encode(payloadJson), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPlaintext)
  );

  // Header RFC 8188: salt (16) || rs (4 BE) || idlen (1 = 65) || asPublic (65) || ciphertext
  const recordHeader = new Uint8Array(21);
  recordHeader.set(salt, 0);
  new DataView(recordHeader.buffer).setUint32(16, 4096, false);
  recordHeader[20] = asPublicBytes.length;

  const bodyBytes = concatBytes(recordHeader, asPublicBytes, ciphertext);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${VAPID_KEYS.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
    },
    body: bodyBytes,
  });

  return res.ok;
}

function isValidSimpleEmail(val: string): boolean {
  const clean = val.trim().toLowerCase();
  return (
    clean.length >= 3 &&
    clean.length <= 254 &&
    /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(clean)
  );
}

function isLoginOnlyIdEmail(val: string): boolean {
  return val.trim().toLowerCase().endsWith('.id@sitespa.it');
}

function sanitizeHeaderDisplayName(raw?: string): string {
  return String(raw || '')
    .replace(/[\r\n"<>\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function buildBiagiAttributedSenderName(rawOperatorName?: string): string {
  const clean = sanitizeHeaderDisplayName(rawOperatorName);
  if (!clean) return 'Andrea Biagi · SITE Interventi';
  const lower = clean.toLowerCase();
  if (lower.includes('biagi') || lower === DEFAULT_OWNER_EMAIL) {
    return 'Andrea Biagi · SITE Interventi';
  }
  return sanitizeHeaderDisplayName(`${clean} · Andrea Biagi (SITE)`);
}

function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toBase64UrlUtf8(str: string): string {
  return toBase64Utf8(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeMimeHeaderUtf8(val: string): string {
  const clean = String(val || '').replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return '';
  return `=?UTF-8?B?${toBase64Utf8(clean)}?=`;
}

function buildGmailRawMessageBase64Url(params: {
  senderEmail: string;
  senderDisplayLabel: string;
  to: string[];
  cc: string[];
  replyTo?: string;
  subject: string;
  bodyText: string;
}): string {
  const encodedFromName = encodeMimeHeaderUtf8(params.senderDisplayLabel);
  const fromHeader = encodedFromName
    ? `${encodedFromName} <${params.senderEmail}>`
    : `<${params.senderEmail}>`;
  const bodyB64 = toBase64Utf8(params.bodyText).match(/.{1,76}/g)?.join('\r\n') || '';

  const lines = [
    `From: ${fromHeader}`,
    `To: ${params.to.join(', ')}`,
    ...(params.cc.length > 0 ? [`Cc: ${params.cc.join(', ')}`] : []),
    ...(params.replyTo ? [`Reply-To: ${params.replyTo}`] : []),
    `Subject: ${encodeMimeHeaderUtf8(params.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    bodyB64,
  ];
  return toBase64UrlUtf8(lines.join('\r\n'));
}

function hasGoogleOAuthSecrets(env: WorkerEnv): boolean {
  return Boolean(
    env.GMAIL_CLIENT_ID?.trim() &&
      env.GMAIL_CLIENT_SECRET?.trim() &&
      env.GMAIL_REFRESH_TOKEN?.trim()
  );
}

async function getGoogleServiceAccessToken(
  env: WorkerEnv,
  forceRefresh = false
): Promise<string | null> {
  if (!hasGoogleOAuthSecrets(env)) {
    return null;
  }
  if (!forceRefresh && cachedServiceGmailToken && Date.now() < cachedServiceGmailToken.expiresAtMs) {
    return cachedServiceGmailToken.token;
  }

  let cleanRefreshToken = env.GMAIL_REFRESH_TOKEN.trim().replace(/^['"]+|['"]+$/g, '');
  if (cleanRefreshToken.includes('%2F')) {
    try {
      cleanRefreshToken = decodeURIComponent(cleanRefreshToken);
    } catch {
      // Mantieni originale se non decodificabile
    }
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID.trim(),
      client_secret: env.GMAIL_CLIENT_SECRET.trim(),
      refresh_token: cleanRefreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Errore rinnovo token Google OAuth2 (${res.status}): ${errText}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;

  const ttlMs = Math.max(60, (data.expires_in || 3600) - 300) * 1000;
  cachedServiceGmailToken = {
    token: data.access_token,
    expiresAtMs: Date.now() + ttlMs,
  };
  return data.access_token;
}

async function sendViaGmailRestApi(
  accessToken: string,
  payload: {
    senderEmail: string;
    senderDisplayLabel: string;
    to: string[];
    cc: string[];
    replyTo?: string;
    subject: string;
    bodyText: string;
  }
): Promise<{ messageId: string }> {
  const raw = buildGmailRawMessageBase64Url(payload);
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errJson = (await resp.json()) as { error?: { message?: string } };
      detail = errJson.error?.message || '';
    } catch {
      detail = await resp.text().catch(() => '');
    }
    throw new Error(`Errore invio Gmail API (${resp.status}): ${detail || 'risposta non valida'}`);
  }

  const data = (await resp.json()) as { id?: string };
  return { messageId: String(data.id || '') };
}

const verifiedTokenCache = new Map<string, { user: VerifiedServerUser; expiresAt: number }>();

async function verifyBearerToken(
  authHeader?: string
): Promise<{ token: string; user: VerifiedServerUser } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7).trim();
  if (!idToken) return null;

  const now = Date.now();
  const cached = verifiedTokenCache.get(idToken);
  if (cached && cached.expiresAt > now) {
    return { token: idToken, user: cached.user };
  }

  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseConfig.apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!resp.ok) return null;

  const data = (await resp.json()) as {
    users?: Array<{ localId?: string; email?: string; emailVerified?: boolean }>;
  };
  const u = data.users?.[0];
  if (!u?.localId || !u?.email) return null;

  const user: VerifiedServerUser = {
    uid: u.localId,
    email: u.email.trim().toLowerCase(),
    emailVerified: Boolean(u.emailVerified),
  };
  verifiedTokenCache.set(idToken, { user, expiresAt: now + 5 * 60 * 1000 });
  return { token: idToken, user };
}

// Middleware globale: collega il database Cloudflare D1 della richiesta al contesto AsyncLocalStorage
app.use('/api/*', async (c, next) => {
  c.header('X-API-Revision', API_REVISION);
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate');

  await runWithD1Context(c.env.DB, async () => {
    await next();
  });
});

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    runtime: 'cloudflare-workers',
    emailProvider: 'google-gmail-api',
    apiRevision: API_REVISION,
  })
);

// Monta tutte le rotte /api/data/*
const dataRouter = createDataRouter({
  verifyBearerToken,
  broadcastSync: () => {},
});
app.route('/api/data', dataRouter);

// Ponte token owner opzionale
app.post('/api/email/owner-token', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  if (verified.user.email !== DEFAULT_OWNER_EMAIL) {
    return c.json(
      { error: `Solo l'account principale ${DEFAULT_OWNER_EMAIL} può sincronizzare il ponte Gmail.` },
      403
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as { workspaceAccessToken?: string };
  saveOwnerGmailTokenInRam(String(body.workspaceAccessToken || '').trim());
  return c.json({
    ok: true,
    ownerGmailBridgeActive: Boolean(
      hasGoogleOAuthSecrets(c.env) || getValidOwnerGmailTokenFromRam()
    ),
  });
});

// Stato motore email Google Gmail API
app.get('/api/email/status', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  const oauthConfigured = hasGoogleOAuthSecrets(c.env);
  let usable = oauthConfigured;
  let errorMsg = oauthConfigured
    ? ''
    : 'Segreti GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET o GMAIL_REFRESH_TOKEN mancanti su Cloudflare.';

  if (oauthConfigured && c.req.query('refresh') === '1') {
    try {
      await getGoogleServiceAccessToken(c.env, true);
      usable = true;
      errorMsg = '';
    } catch (err) {
      usable = false;
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  }

  const outboxSummary = await fetchPendingEmailOutboxSummary(10).catch(() => ({
    pendingCount: 0,
    items: [],
  }));

  return c.json({
    configured: usable,
    smtpConfigured: oauthConfigured,
    smtpUsable: usable,
    smtpAuthRevoked: false,
    smtpError: errorMsg,
    gmailBackupEnabled: true,
    gmailOwnerEmail: DEFAULT_OWNER_EMAIL,
    ownerGmailBridgeActive: Boolean(usable || getValidOwnerGmailTokenFromRam()),
    host: 'gmail.googleapis.com',
    port: 443,
    secure: true,
    senderEmail: DEFAULT_OWNER_EMAIL,
    pendingOutboxCount: outboxSummary.pendingCount,
    pendingOutboxPreview: outboxSummary.items.map((item) => ({
      outboxId: item.outboxId,
      subject: item.subject,
      to: item.to,
      cc: item.cc,
      senderDisplayName: item.senderDisplayName,
      createdAtIso: item.createdAtIso,
      lastError: item.lastError,
    })),
    runtimeEnv: 'production',
  });
});

// Invio email via Google Gmail API (Refresh Token H24 -> Token Workspace -> Coda Neon)
app.post('/api/email/send', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    to?: string[] | string;
    cc?: string[] | string;
    subject?: string;
    bodyText?: string;
    senderDisplayName?: string;
    replyTo?: string;
    workspaceAccessToken?: string;
    skipGmailApi?: boolean;
  };

  const rawToTokens = (
    Array.isArray(body.to)
      ? body.to
      : typeof body.to === 'string'
      ? body.to.split(/[,;]+/)
      : []
  )
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);

  const rawCcTokens = (
    Array.isArray(body.cc)
      ? body.cc
      : typeof body.cc === 'string'
      ? body.cc.split(/[,;]+/)
      : []
  )
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);

  const allTokens = [...rawToTokens, ...rawCcTokens];
  const loginOnlyBlocked = allTokens.filter((addr) => isLoginOnlyIdEmail(addr));
  if (loginOnlyBlocked.length > 0) {
    return c.json(
      {
        code: 'LOGIN_ONLY_EMAIL_BLOCKED',
        error: `Invio bloccato: ${Array.from(new Set(loginOnlyBlocked)).join(
          ', '
        )} è un account di solo accesso (.id@sitespa.it) privo di casella email.`,
      },
      400
    );
  }

  const malformed = allTokens.filter((addr) => !isValidSimpleEmail(addr));
  if (malformed.length > 0) {
    return c.json({ error: `Formato indirizzo email non valido: ${malformed.join(', ')}.` }, 400);
  }

  const recipients = Array.from(new Set(rawToTokens)).slice(0, 20);
  if (recipients.length === 0) {
    return c.json({ error: 'Nessun destinatario principale (A:) valido specificato.' }, 400);
  }

  const ccRecipients = Array.from(new Set(rawCcTokens))
    .filter((addr) => !recipients.includes(addr))
    .slice(0, 20);

  const cleanSubject = String(body.subject || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
  if (!cleanSubject) {
    return c.json({ error: "L'oggetto dell'email è obbligatorio." }, 400);
  }

  const cleanBody = String(body.bodyText || '').slice(0, 30_000);
  const cleanSenderName = sanitizeHeaderDisplayName(
    body.senderDisplayName || verified.user.email
  );
  const senderDisplayLabel = buildBiagiAttributedSenderName(cleanSenderName);
  const cleanReplyTo = String(body.replyTo || '').trim().toLowerCase();
  const validReplyTo =
    isValidSimpleEmail(cleanReplyTo) && !isLoginOnlyIdEmail(cleanReplyTo)
      ? cleanReplyTo
      : undefined;

  const errors: string[] = [];

  // 1. Canale primario H24: Google OAuth2 Refresh Token di a.biagi@sitespa.it
  try {
    const serviceToken = await getGoogleServiceAccessToken(c.env);
    if (serviceToken) {
      const sent = await sendViaGmailRestApi(serviceToken, {
        senderEmail: DEFAULT_OWNER_EMAIL,
        senderDisplayLabel,
        to: recipients,
        cc: ccRecipients,
        replyTo: validReplyTo,
        subject: cleanSubject,
        bodyText: cleanBody,
      });
      return c.json({
        ok: true,
        sent: true,
        queued: false,
        channel: 'gmail_api',
        sentTo: recipients,
        sentCc: ccRecipients,
        messageId: sent.messageId,
      });
    } else {
      errors.push('Credenziali Google OAuth2 (GMAIL_REFRESH_TOKEN) non configurate su Cloudflare.');
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // 2. Canale di backup: token OAuth Workspace del chiamante
  const cleanWsToken = String(body.workspaceAccessToken || '').trim();
  if (!body.skipGmailApi && cleanWsToken && !isLoginOnlyIdEmail(verified.user.email)) {
    try {
      const senderAddr =
        verified.user.email === DEFAULT_OWNER_EMAIL ? DEFAULT_OWNER_EMAIL : verified.user.email;
      const sent = await sendViaGmailRestApi(cleanWsToken, {
        senderEmail: senderAddr,
        senderDisplayLabel,
        to: recipients,
        cc: ccRecipients,
        replyTo: validReplyTo || senderAddr,
        subject: cleanSubject,
        bodyText: cleanBody,
      });
      if (senderAddr === DEFAULT_OWNER_EMAIL) {
        saveOwnerGmailTokenInRam(cleanWsToken);
      }
      return c.json({
        ok: true,
        sent: true,
        queued: false,
        channel: 'gmail_api',
        sentTo: recipients,
        sentCc: ccRecipients,
        messageId: sent.messageId,
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // 3. Coda di sicurezza PostgreSQL Neon (zero perdita dati)
  const combinedError = errors.join(' · ') || 'Invio Gmail temporaneamente non disponibile.';
  const randHex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
const outboxId = `outbox_${Date.now()}_${randHex}`;
  await enqueueEmailOutboxEntry({
    outboxId,
    to: recipients,
    cc: ccRecipients,
    replyTo: validReplyTo,
    senderDisplayName: cleanSenderName,
    subject: cleanSubject,
    bodyText: cleanBody,
    createdByUid: verified.user.uid,
    createdByEmail: verified.user.email,
    lastError: combinedError,
  });

  return c.json({
    ok: true,
    sent: false,
    queued: true,
    outboxId,
    channel: 'outbox_queue',
    sentTo: recipients,
    sentCc: ccRecipients,
    messageId: '',
    queueReason: combinedError,
  });
});

// Test invio Gmail API H24
app.post('/api/email/test', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { recipientEmail?: string };
  const requested = String(body.recipientEmail || '').trim().toLowerCase();
  const target =
    isValidSimpleEmail(requested) && !isLoginOnlyIdEmail(requested)
      ? requested
      : DEFAULT_OWNER_EMAIL;

  try {
    const serviceToken = await getGoogleServiceAccessToken(c.env, true);
    if (!serviceToken) {
      return c.json(
        {
          code: 'EMAIL_CONFIG_ERROR',
          error:
            'Segreti GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET o GMAIL_REFRESH_TOKEN non configurati su Cloudflare.',
        },
        500
      );
    }

    const nowFormatted = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    const sent = await sendViaGmailRestApi(serviceToken, {
      senderEmail: DEFAULT_OWNER_EMAIL,
      senderDisplayLabel: 'Andrea Biagi · SITE Interventi',
      to: [target],
      cc: [],
      replyTo: DEFAULT_OWNER_EMAIL,
      subject: '[SITE Interventi] Test motore Google Gmail API (Cloudflare H24)',
      bodyText: [
        'Riepilogo Test Google Gmail API — Gestione Interventi SITE (Cloudflare)',
        '----------------------------------------------------------------------',
        'Endpoint: https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
        `Mittente autenticato: ${DEFAULT_OWNER_EMAIL}`,
        `Test avviato da: ${verified.user.email}`,
        `Data e ora: ${nowFormatted}`,
        '',
        'Il token OAuth2 Google è valido e attivo H24 per tutti i tecnici.',
      ].join('\n'),
    });

    return c.json({
      ok: true,
      recipient: target,
      channel: 'gmail_api',
      messageId: sent.messageId,
    });
  } catch (err) {
    return c.json(
      {
        code: 'EMAIL_CONFIG_ERROR',
        error: err instanceof Error ? err.message : String(err),
      },
      500
    );
  }
});

// Svuotamento coda outbox
app.post('/api/email/outbox/flush', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  const isAdmin = await isVerifiedAdminInNeon(verified.user.uid, verified.user.email);
  if (!isAdmin) {
    return c.json({ error: 'Solo gli amministratori possono inviare i riepiloghi in coda.' }, 403);
  }

  let serviceToken: string | null = null;
  try {
    serviceToken = await getGoogleServiceAccessToken(c.env);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  if (!serviceToken) {
    return c.json({ error: 'Token OAuth2 Google non configurato su Cloudflare.' }, 500);
  }

  const { items } = await fetchPendingEmailOutboxSummary(25);
  let sentCount = 0;
  let failedCount = 0;
  let lastError = '';

  for (const item of items) {
    try {
      await sendViaGmailRestApi(serviceToken, {
        senderEmail: DEFAULT_OWNER_EMAIL,
        senderDisplayLabel: buildBiagiAttributedSenderName(item.senderDisplayName),
        to: item.to,
        cc: item.cc,
        replyTo: item.replyTo || undefined,
        subject: item.subject,
        bodyText: item.bodyText,
      });
      await markEmailOutboxSent(item.outboxId, 'gmail_api');
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      lastError = err instanceof Error ? err.message : String(err);
      await markEmailOutboxError(item.outboxId, lastError);
    }
  }

  const updated = await fetchPendingEmailOutboxSummary(1);
  return c.json({
    ok: true,
    sentCount,
    failedCount,
    remainingCount: updated.pendingCount,
    channelUsed: sentCount > 0 ? 'gmail_api' : 'none',
    ...(lastError ? { lastError } : {}),
  });
});

// Web Push nativo con Web Crypto API (RFC 8291 + RFC 8292)
app.get('/api/push/vapid-public-key', (c) =>
  c.json({ publicKey: VAPID_KEYS.publicKey })
);

async function dispatchWebPushToSubscribers(
  subject: string,
  payloadObj: Record<string, unknown>
): Promise<{ sent: number; failed: number; activeDevices: number; lastError?: string }> {
  const deadEndpoints = new Set<string>();
  const subs = await fetchActivePushSubscriptionsFromNeon(deadEndpoints);
  const payloadJson = JSON.stringify(payloadObj);
  let sent = 0;
  let failed = 0;
  let lastError = '';

  for (const sub of subs) {
    try {
      const p256dh = sub.p256dh;
      const auth = sub.auth;
      const ok = await sendWebPushNative(
        sub.endpoint,
        { p256dh, auth },
        subject,
        payloadJson
      );
      if (ok) {
        sent += 1;
      } else {
        failed += 1;
        lastError = `Push endpoint ha risposto con errore per ${sub.deviceLabel}`;
      }
    } catch (err) {
      failed += 1;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    sent,
    failed,
    activeDevices: subs.length,
    ...(lastError ? { lastError } : {}),
  };
}

app.post('/api/push/notify-task-completed', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    taskId?: string;
    commessa?: string;
    descrizione?: string;
    completedByName?: string;
    pendingAdminReview?: boolean;
    noteSummary?: string;
    title?: string;
    body?: string;
    url?: string;
  };

  const taskId = String(body.taskId || '').trim();
  const commessa = String(body.commessa || '').trim();
  const descrizione = String(body.descrizione || '').trim();
  const completedByName = String(body.completedByName || verified.user.email).trim();
  const noteSummary = String(body.noteSummary || '').trim();

  const computedTitle =
    body.title ||
    (body.pendingAdminReview
      ? `Completato (Da revisionare) · ${completedByName}`
      : commessa
      ? `Task Completato · ${commessa}`
      : `Task Completato · ${completedByName}`);

  const computedBody =
    body.body ||
    [
      `${completedByName}${descrizione ? ` — ${descrizione}` : ''}`,
      noteSummary ? `Note: ${noteSummary}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 240);

  const targetUrl =
    body.url || (taskId ? `/?taskId=${encodeURIComponent(taskId)}` : '/');

  const subject = c.env.VAPID_SUBJECT || `mailto:${DEFAULT_OWNER_EMAIL}`;
  const result = await dispatchWebPushToSubscribers(subject, {
    title: computedTitle,
    body: computedBody || 'Un intervento è stato contrassegnato come Completato.',
    url: targetUrl,
    taskId,
  });
  return c.json(result);
});

app.post('/api/push/test', async (c) => {
  const verified = await verifyBearerToken(c.req.header('authorization'));
  if (!verified) return c.json({ error: 'Autenticazione richiesta.' }, 401);

  const subject = c.env.VAPID_SUBJECT || `mailto:${DEFAULT_OWNER_EMAIL}`;
  const result = await dispatchWebPushToSubscribers(subject, {
    title: 'Test Notifiche SITE Interventi',
    body: `Notifica Push attiva su Cloudflare (${verified.user.email})`,
    url: '/',
  });
  return c.json(result);
});

app.onError((err, c) => {
  console.error('Worker unhandled error:', err);
  if (c.req.path.startsWith('/api/')) {
    return c.json(
      {
        error:
          err instanceof Error
            ? err.message
            : 'Errore interno del server API.',
      },
      500
    );
  }
  return c.text('Errore interno del server.', 500);
});

app.all('/api/*', (c) =>
  c.json(
    {
      code: 'API_ENDPOINT_NOT_FOUND',
      error: `Endpoint API non trovato (${c.req.method} ${c.req.path}).`,
    },
    404
  )
);

// Serve tutti i file statici React/PWA e il fallback SPA da Cloudflare Assets
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
