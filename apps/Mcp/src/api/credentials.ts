import { AdkApiError, HttpAdkClient } from './http-client.js';

export interface AdkUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface IssuedCredential {
  readonly token: string;
  readonly user: AdkUser;
  /** ISO date, or null for tokens without expiry. */
  readonly expiresAt: string | null;
  readonly kind: 'access-token' | 'session';
}

export interface CredentialOptions {
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

const client = (options: CredentialOptions, token?: string) =>
  new HttpAdkClient({
    baseUrl: options.apiUrl,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
    credentials: () => ({ token }),
  });

/** Validates any ADK bearer token (session or personal access token) and returns its owner. */
export async function whoIs(options: CredentialOptions, token: string): Promise<AdkUser> {
  const me = await client(options, token).request<{ user: AdkUser }>({
    method: 'GET',
    path: '/auth/me',
    withoutWorkspace: true,
  });
  return me.user;
}

/**
 * Signs in with e-mail and password and, when the API supports it, trades the short-lived session
 * for a named personal access token (the session is then revoked). Older APIs keep the session.
 */
export async function signInForClient(
  options: CredentialOptions,
  input: { email: string; password: string; tokenName: string; expiresInDays?: number },
): Promise<IssuedCredential> {
  const auth = await client(options).request<{ user: AdkUser; token: string; expiresAt: string }>({
    method: 'POST',
    path: '/auth/login',
    body: { email: input.email, password: input.password },
    withoutWorkspace: true,
  });
  const session = client(options, auth.token);
  try {
    const created = await session.request<{
      token: string;
      accessToken: { expiresAt: string | null };
    }>({
      method: 'POST',
      path: '/auth/tokens',
      body: {
        name: input.tokenName.slice(0, 100),
        scope: 'full',
        expiresInDays: input.expiresInDays ?? 90,
      },
      withoutWorkspace: true,
    });
    await session
      .request({ method: 'POST', path: '/auth/logout', withoutWorkspace: true })
      .catch(() => undefined);
    return {
      token: created.token,
      user: auth.user,
      expiresAt: created.accessToken.expiresAt,
      kind: 'access-token',
    };
  } catch (error) {
    if (error instanceof AdkApiError && [404, 405, 501, 503].includes(error.status)) {
      return { token: auth.token, user: auth.user, expiresAt: auth.expiresAt, kind: 'session' };
    }
    throw error;
  }
}
