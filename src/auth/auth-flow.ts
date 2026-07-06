// OAuth sign-in orchestration. DI (post/getJson injected) so it unit-tests in Node;
// main supplies requestUrl-backed post/getJson + window.open. Composes pkce + oauth +
// discovery + token-store.
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  parseCallbackParams,
} from './pkce';
import {
  exchangeAuthCode,
  isTokenExpired,
  OAuthHttpError,
  refreshTokens,
  registerClient,
  revokeToken,
  REDIRECT_URI,
  type HttpPost,
  type OAuthEndpoints,
} from './oauth';
import { discoverEndpoints, type GetJson } from './discovery';
import type { AuthStore } from './token-store';

export const CALLBACK_ACTION = 'agentage-memory-cb';

// A running localhost redirect listener (RFC 8252). Desktop main supplies the factory;
// when present, sign-in uses loopback instead of the `obsidian://` deep link (which snap/
// flatpak Obsidian drop). `waitForCode` resolves with the OAuth query params.
export interface LoopbackHandle {
  redirectUri: string;
  waitForCode: Promise<Record<string, string>>;
  close: () => void;
}

export interface AuthFlowDeps {
  store: AuthStore;
  post: HttpPost; // requestUrl POST (main) / mock (tests)
  getJson: GetJson; // requestUrl GET
  authOrigin: () => string; // https://auth.agentage.io | http://localhost:3010
  notify: (msg: string) => void;
  openExternal: (url: string) => void;
  now: () => number;
  onChange?: () => void;
  loopback?: () => Promise<LoopbackHandle>; // desktop: localhost redirect; absent → obsidian://
}

export interface AuthFlow {
  startSignIn(): Promise<void>;
  handleCallback(params: Record<string, string>): Promise<void>;
  disconnect(): Promise<void>;
  isSignedIn(): boolean;
  getValidToken(): Promise<string | null>;
}

export function createAuthFlow(deps: AuthFlowDeps): AuthFlow {
  let endpoints: OAuthEndpoints | null = null;
  let pending: { verifier: string; state: string } | null = null;

  async function ensureEndpoints(): Promise<OAuthEndpoints> {
    if (!endpoints) endpoints = await discoverEndpoints(deps.authOrigin(), deps.getJson);
    return endpoints;
  }

  async function ensureClientId(ep: OAuthEndpoints): Promise<string> {
    const existing = deps.store.getClientId();
    if (existing) return existing;
    const id = await registerClient(deps.post, ep.registrationEndpoint, REDIRECT_URI);
    deps.store.setClientId(id);
    return id;
  }

  // Shared tail of both redirect paths: exchange the code (against the SAME redirect_uri the
  // authorize request used) → persist → announce. Throwing is the caller's to surface.
  async function exchangeAndStore(
    ep: OAuthEndpoints,
    clientId: string,
    code: string,
    verifier: string,
    redirectUri: string
  ): Promise<void> {
    const tokens = await exchangeAuthCode(
      deps.post,
      ep.tokenEndpoint,
      clientId,
      code,
      verifier,
      deps.now(),
      redirectUri
    );
    await deps.store.save(tokens);
    deps.notify('Signed in to Agentage.');
    deps.onChange?.();
  }

  // Desktop loopback (RFC 8252): bind localhost, DCR with the exact bound redirect, open the
  // browser, then await the callback ON that listener - no OS protocol handler in the loop.
  async function signInViaLoopback(ep: OAuthEndpoints): Promise<void> {
    const lb = await deps.loopback!();
    try {
      const clientId = await registerClient(deps.post, ep.registrationEndpoint, lb.redirectUri);
      deps.store.setClientId(clientId);
      const verifier = generateCodeVerifier();
      const state = generateState();
      const codeChallenge = await deriveCodeChallenge(verifier);
      deps.openExternal(
        buildAuthorizeUrl({
          authorizationEndpoint: ep.authorizationEndpoint,
          clientId,
          redirectUri: lb.redirectUri,
          codeChallenge,
          state,
        })
      );
      deps.notify('Opening agentage sign-in in your browser…');
      const result = parseCallbackParams(await lb.waitForCode);
      if ('error' in result) return deps.notify(`Sign-in failed: ${result.error}`);
      if (result.state !== state) return deps.notify('Sign-in failed: state mismatch.');
      await exchangeAndStore(ep, clientId, result.code, verifier, lb.redirectUri);
    } finally {
      lb.close();
    }
  }

  const startSignIn = async (): Promise<void> => {
    try {
      const ep = await ensureEndpoints();
      if (deps.loopback) return await signInViaLoopback(ep);
      // Fallback: `obsidian://` custom scheme + the protocol handler (handleCallback).
      const clientId = await ensureClientId(ep);
      const verifier = generateCodeVerifier();
      const state = generateState();
      pending = { verifier, state };
      const codeChallenge = await deriveCodeChallenge(verifier);
      deps.openExternal(
        buildAuthorizeUrl({
          authorizationEndpoint: ep.authorizationEndpoint,
          clientId,
          redirectUri: REDIRECT_URI,
          codeChallenge,
          state,
        })
      );
      deps.notify('Opening agentage sign-in in your browser…');
    } catch (e) {
      deps.notify(`Sign-in could not start: ${(e as Error).message}`);
    }
  };

  const handleCallback = async (params: Record<string, string>): Promise<void> => {
    const result = parseCallbackParams(params);
    if ('error' in result) return deps.notify(`Sign-in failed: ${result.error}`);
    if (!pending) return deps.notify('Sign-in callback arrived without a pending request.');
    if (result.state !== pending.state) {
      pending = null;
      return deps.notify('Sign-in failed: state mismatch.');
    }
    try {
      const ep = await ensureEndpoints();
      const clientId = deps.store.getClientId();
      if (!clientId) return deps.notify('Sign-in failed: missing client registration.');
      const verifier = pending.verifier;
      pending = null;
      await exchangeAndStore(ep, clientId, result.code, verifier, REDIRECT_URI);
    } catch (e) {
      deps.notify(`Sign-in failed: ${(e as Error).message}`);
    }
  };

  const disconnect = async (): Promise<void> => {
    try {
      const t = deps.store.load();
      if (t && endpoints?.revocationEndpoint)
        await revokeToken(deps.post, endpoints.revocationEndpoint, t.refreshToken);
    } catch {
      /* revoke is best-effort */
    }
    await deps.store.clear();
    deps.onChange?.();
    deps.notify('Disconnected from Agentage.');
  };

  const isSignedIn = (): boolean => deps.store.load() !== null;

  const getValidToken = async (): Promise<string | null> => {
    const t = deps.store.load();
    if (!t) return null;
    if (!isTokenExpired(t, deps.now())) return t.accessToken;
    try {
      const ep = await ensureEndpoints();
      const clientId = deps.store.getClientId();
      if (!clientId) return null;
      const refreshed = await refreshTokens(
        deps.post,
        ep.tokenEndpoint,
        clientId,
        t.refreshToken,
        deps.now()
      );
      await deps.store.save(refreshed);
      return refreshed.accessToken;
    } catch (e) {
      // A rejected refresh (4xx: invalid/expired/revoked refresh token) means the session is
      // dead — clear it so the UI flips to signed-out instead of a green dot that fails every
      // sync. Keep tokens on transient/server errors (5xx/network) so a blip isn't a sign-out.
      if (e instanceof OAuthHttpError && e.status >= 400 && e.status < 500) {
        await deps.store.clear();
        deps.onChange?.();
        deps.notify('Your Agentage session expired — sign in again.');
      }
      return null;
    }
  };

  return { startSignIn, handleCallback, disconnect, isSignedIn, getValidToken };
}
