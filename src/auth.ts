/**
 * Auth seam for the sync layer. The fetch wrapper asks an `AuthProvider` for
 * the `Authorization` header on every request, so swapping Basic creds for an
 * OAuth bearer token (a follow-up PR) is a one-line change at the call site.
 * `authHeader` is async so a future provider can refresh a token first.
 */
export interface AuthProvider {
  /** The `Authorization` header value, or `null` to send the request unauthenticated. */
  authHeader(): Promise<string | null>;
}

/** Provider for HTTP Basic auth (local-dev CouchDB credentials). */
export function basicAuthProvider(username: string, password: string): AuthProvider {
  const header = 'Basic ' + btoa(`${username}:${password}`);
  return {
    authHeader: async () => header,
  };
}

/**
 * Provider for an OAuth/CouchDB bearer token. `getToken` is read on every
 * request so the controller can refresh the short-lived sync token (from
 * `/api/sync/bootstrap`) without rebuilding the provider; returns `null` (send
 * unauthenticated) when there's no current token.
 */
export function bearerAuthProvider(getToken: () => string | null): AuthProvider {
  return {
    authHeader: async () => {
      const token = getToken();
      return token ? `Bearer ${token}` : null;
    },
  };
}
