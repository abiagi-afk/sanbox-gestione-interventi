import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  setPersistence,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { FirestoreErrorInfo, OperationType } from '../types/domain';

// Single shared Firebase App instance used ONLY for Google Sign-In Auth and Google Drive OAuth.
// Primary database storage runs on Neon Serverless PostgreSQL (/api/data/*) with zero Firestore quota limits.
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

// Garantisce che la sessione resti salvata su IndexedDB/LocalStorage anche chiudendo la PWA su Android
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('Impossibile impostare browserLocalPersistence:', err);
});

// Google Workspace Scopes configured via set_up_oauth (Drive + Sheets + Gmail Send)
export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/gmail.send',
];

function createGoogleProvider(options?: {
  promptConsent?: boolean;
  forceAccountPicker?: boolean;
  loginHint?: string;
}): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of SCOPES) {
    provider.addScope(scope);
  }
  const customParams: Record<string, string> = {};
  if (options?.loginHint) {
    customParams.login_hint = options.loginHint;
  }
  if (options?.promptConsent) {
    customParams.prompt = 'consent select_account';
  } else if (options?.forceAccountPicker || !options?.loginHint) {
    customParams.prompt = 'select_account';
  }
  if (Object.keys(customParams).length > 0) {
    provider.setCustomParameters(customParams);
  }
  return provider;
}

// In-memory cache ONLY for Google Workspace OAuth access token (never persisted to Web Storage)
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedTokenExpiryMs = 0;

export const initAuth = (
  onUserChanged: (user: User | null, hasToken: boolean) => void
) => {
  return onAuthStateChanged(auth, (user: User | null) => {
    if (!user) {
      cachedAccessToken = null;
      cachedTokenExpiryMs = 0;
      onUserChanged(null, false);
      return;
    }
    const tokenValid = Boolean(
      cachedAccessToken && Date.now() < cachedTokenExpiryMs
    );
    if (!tokenValid && !isSigningIn) {
      cachedAccessToken = null;
      cachedTokenExpiryMs = 0;
    }
    onUserChanged(user, tokenValid);
  });
};

export const googleSignIn = async (options?: {
  forceConsent?: boolean;
  forceAccountPicker?: boolean;
  loginHint?: string;
}): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    const hint = options?.forceAccountPicker
      ? undefined
      : options?.loginHint || auth.currentUser?.email || undefined;
    const provider = createGoogleProvider({
      promptConsent: options?.forceConsent,
      forceAccountPicker: options?.forceAccountPicker,
      loginHint: hint,
    });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        'Impossibile ottenere il token di accesso Google Workspace.'
      );
    }
    cachedAccessToken = credential.accessToken;
    // Standard OAuth2 access tokens expire in ~3600s; refresh proactively at 55 min
    cachedTokenExpiryMs = Date.now() + 55 * 60 * 1000;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = (): string | null => {
  if (!cachedAccessToken || Date.now() >= cachedTokenExpiryMs) {
    cachedAccessToken = null;
    return null;
  }
  return cachedAccessToken;
};

export const ensureWorkspaceAccessToken = async (options?: {
  forceConsent?: boolean;
}): Promise<string> => {
  if (!options?.forceConsent) {
    const current = getAccessToken();
    if (current) return current;
  }
  const result = await googleSignIn({
    forceConsent: options?.forceConsent,
    loginHint: auth.currentUser?.email || undefined,
  });
  return result.accessToken;
};

export const logout = async (): Promise<void> => {
  cachedAccessToken = null;
  cachedTokenExpiryMs = 0;
  await auth.signOut();
};

/**
 * Lazy, on-demand Firestore accessor used ONLY if an Admin explicitly clicks
 * "Importa dati storici da Firebase" after daily Spark quota resets.
 * Never invoked during normal application boot or usage.
 */
export async function getLegacyFirestoreDbOnDemand() {
  const firestoreMod = await import('firebase/firestore');
  const resolvedDatabaseId =
    (firebaseConfig as { firestoreDatabaseId?: string }).firestoreDatabaseId ||
    'ai-studio-b7b5a9c9-dd44-4c6e-987d-95bae64ae9b5';
  return {
    legacyDb: firestoreMod.getFirestore(app, resolvedDatabaseId),
    firestoreMod,
  };
}

export async function validateFirestoreConnection(): Promise<void> {
  // No-op: database storage migrated to Neon PostgreSQL (/api/data/*)
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Data Error: ', JSON.stringify(errInfo));
  throw new Error(errInfo.error);
}
