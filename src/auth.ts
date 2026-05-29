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
