/**
 * OAuth sign-in orchestration. Obsidian/Electron-coupled (requestUrl, external
 * browser, protocol callback), so coverage-excluded; the PKCE crypto, token
 * exchange, and storage it composes are unit-tested in their own modules.
 */
import { requestUrl } from 'obsidian';
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  parseCallbackParams,
} from './pkce';
import {
  exchangeAuthCode,
  isTokenExpired,
  refreshTokens,
  type HttpPost,
  type OAuthConfig,
} from './oauth';
import { clearTokens, loadTokens, saveTokens } from './token-store';
import { describeErr } from './errors';
import type { SecretStore } from './credentials';

/** Obsidian custom-protocol action; the full callback is `obsidian://<action>`. */
export const CALLBACK_ACTION = 'agentage-memory-cb';
export const REDIRECT_URI = `obsidian://${CALLBACK_ACTION}`;

export interface AuthFlowDeps {
  secrets: SecretStore;
  /** Current OAuth config (authBase + anonKey come from settings). */
  config: () => OAuthConfig;
  /** Surface a short message to the user (Notice). */
  notify: (message: string) => void;
  /** Open a URL in the system browser. */
  openExternal: (url: string) => void;
  /** Current epoch ms (injected for testability). */
  now: () => number;
  /** Called after sign-in/sign-out so the UI can refresh. */
  onChange?: () => void;
}

export interface AuthFlow {
  startSignIn(): Promise<void>;
  handleCallback(params: Record<string, string>): Promise<void>;
  signOut(): void;
  isSignedIn(): boolean;
  /** A non-expired access token, refreshing if needed; null when signed out. */
  getValidAccessToken(): Promise<string | null>;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createAuthFlow(deps: AuthFlowDeps): AuthFlow {
  const post: HttpPost = async (url, init) => {
    const res = await requestUrl({
      url,
      method: 'POST',
      headers: init.headers,
      body: init.body,
      throw: false,
    });
    return { status: res.status, json: safeJson(res.text) };
  };

  // The verifier bridges startSignIn → handleCallback within this process.
  let pendingVerifier: string | null = null;

  const startSignIn = async (): Promise<void> => {
    const cfg = deps.config();
    if (!cfg.anonKey) {
      deps.notify('Set the Agentage auth key in settings before signing in.');
      return;
    }
    const verifier = generateCodeVerifier();
    pendingVerifier = verifier;
    const codeChallenge = await deriveCodeChallenge(verifier);
    deps.openExternal(
      buildAuthorizeUrl({
        authBase: cfg.authBase,
        redirectUri: cfg.redirectUri,
        provider: 'github',
        codeChallenge,
      })
    );
  };

  const handleCallback = async (params: Record<string, string>): Promise<void> => {
    const result = parseCallbackParams(params);
    if ('error' in result) {
      deps.notify(`Sign-in failed: ${result.error}`);
      return;
    }
    if (!pendingVerifier) {
      deps.notify('Sign-in callback arrived without a pending request.');
      return;
    }
    try {
      const tokens = await exchangeAuthCode(
        post,
        deps.config(),
        result.code,
        pendingVerifier,
        deps.now()
      );
      saveTokens(deps.secrets, tokens);
      pendingVerifier = null;
      deps.notify('Signed in to Agentage.');
      deps.onChange?.();
    } catch (err) {
      console.error('[Agentage Memory] token exchange failed', describeErr(err));
      deps.notify(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const signOut = (): void => {
    clearTokens(deps.secrets);
    deps.onChange?.();
    deps.notify('Signed out of Agentage.');
  };

  const isSignedIn = (): boolean => loadTokens(deps.secrets) !== null;

  const getValidAccessToken = async (): Promise<string | null> => {
    const tokens = loadTokens(deps.secrets);
    if (!tokens) return null;
    if (!isTokenExpired(tokens, deps.now())) return tokens.accessToken;
    try {
      const refreshed = await refreshTokens(post, deps.config(), tokens.refreshToken, deps.now());
      saveTokens(deps.secrets, refreshed);
      return refreshed.accessToken;
    } catch (err) {
      console.error('[Agentage Memory] token refresh failed', describeErr(err));
      return null;
    }
  };

  return { startSignIn, handleCallback, signOut, isSignedIn, getValidAccessToken };
}
