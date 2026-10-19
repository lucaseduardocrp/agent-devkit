import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubOAuthProvider,
  GoogleOAuthProvider,
} from '../src/modules/identity/adapters/oauth-providers.js';

const options = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  callbackUrl: 'https://app.test/auth/oauth/callback',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes fake responses by URL; no real network access. */
function stubFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const handler = routes[url];
    return Promise.resolve(handler ? handler() : new Response('not found', { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GoogleOAuthProvider', () => {
  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const userUrl = 'https://openidconnect.googleapis.com/v1/userinfo';

  it('builds an authorization URL with the state', () => {
    const url = new URL(new GoogleOAuthProvider(options).createAuthorizationUrl('st4te'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-id',
      redirect_uri: options.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state: 'st4te',
      prompt: 'select_account',
    });
  });

  it('exchanges a code for a verified profile', async () => {
    const fetchMock = stubFetch({
      [tokenUrl]: () => json({ access_token: 'at' }),
      [userUrl]: () =>
        json({ sub: 'g-1', email: 'ana@example.com', email_verified: true, name: 'Ana' }),
    });
    const profile = await new GoogleOAuthProvider(options).exchangeCode('the-code');
    expect(profile).toEqual({
      provider: 'google',
      providerUserId: 'g-1',
      email: 'ana@example.com',
      name: 'Ana',
      emailVerified: true,
    });
    const tokenCall = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(String(tokenCall.body)).toContain('code=the-code');
    expect(String(tokenCall.body)).toContain('grant_type=authorization_code');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toEqual({
      authorization: 'Bearer at',
    });
  });

  it('falls back to the email prefix or a generic name', async () => {
    stubFetch({
      [tokenUrl]: () => json({ access_token: 'at' }),
      [userUrl]: () => json({ sub: 'g-2', email: 'bob@example.com' }),
    });
    expect(await new GoogleOAuthProvider(options).exchangeCode('c')).toMatchObject({
      name: 'bob',
      emailVerified: false,
    });

    stubFetch({
      [tokenUrl]: () => json({ access_token: 'at' }),
      [userUrl]: () => json({ sub: 'g-3', email: '@example.com', email_verified: false }),
    });
    expect((await new GoogleOAuthProvider(options).exchangeCode('c')).name).toBe('Google user');
  });

  it('fails when Google rejects the token or profile request', async () => {
    stubFetch({ [tokenUrl]: () => json({ error: 'bad' }, 400) });
    await expect(new GoogleOAuthProvider(options).exchangeCode('c')).rejects.toMatchObject({
      code: 'OAUTH_FAILED',
      statusCode: 401,
      message: 'Google authentication failed.',
    });

    stubFetch({
      [tokenUrl]: () => json({ access_token: 'at' }),
      [userUrl]: () => json({}, 401),
    });
    await expect(new GoogleOAuthProvider(options).exchangeCode('c')).rejects.toMatchObject({
      code: 'OAUTH_FAILED',
    });
  });
});

describe('GitHubOAuthProvider', () => {
  const tokenUrl = 'https://github.com/login/oauth/access_token';
  const userUrl = 'https://api.github.com/user';
  const emailsUrl = 'https://api.github.com/user/emails';

  it('builds an authorization URL with the state', () => {
    const url = new URL(new GitHubOAuthProvider(options).createAuthorizationUrl('xyz'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'client-id',
      redirect_uri: options.callbackUrl,
      scope: 'read:user user:email',
      state: 'xyz',
    });
  });

  it('exchanges a code and picks the primary verified email', async () => {
    const fetchMock = stubFetch({
      [tokenUrl]: () => json({ access_token: 'gh' }),
      [userUrl]: () => json({ id: 7, name: 'Octo Cat', login: 'octocat' }),
      [emailsUrl]: () =>
        json([
          { email: 'other@example.com', primary: false, verified: true },
          { email: 'octo@example.com', primary: true, verified: true },
        ]),
    });
    expect(await new GitHubOAuthProvider(options).exchangeCode('code')).toEqual({
      provider: 'github',
      providerUserId: '7',
      email: 'octo@example.com',
      name: 'Octo Cat',
      emailVerified: true,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'code',
    });
  });

  it('uses the login when the user has no display name', async () => {
    stubFetch({
      [tokenUrl]: () => json({ access_token: 'gh' }),
      [userUrl]: () => json({ id: 8, login: 'noname' }),
      [emailsUrl]: () => json([{ email: 'n@example.com', primary: true, verified: true }]),
    });
    expect((await new GitHubOAuthProvider(options).exchangeCode('c')).name).toBe('noname');
  });

  it('requires a verified primary email', async () => {
    stubFetch({
      [tokenUrl]: () => json({ access_token: 'gh' }),
      [userUrl]: () => json({ id: 9, login: 'x' }),
      [emailsUrl]: () => json([{ email: 'x@example.com', primary: true, verified: false }]),
    });
    await expect(new GitHubOAuthProvider(options).exchangeCode('c')).rejects.toMatchObject({
      code: 'OAUTH_EMAIL_REQUIRED',
      statusCode: 422,
    });
  });

  it('fails when GitHub rejects any request', async () => {
    stubFetch({ [tokenUrl]: () => json({}, 500) });
    await expect(new GitHubOAuthProvider(options).exchangeCode('c')).rejects.toMatchObject({
      code: 'OAUTH_FAILED',
      message: 'GitHub authentication failed.',
    });

    stubFetch({
      [tokenUrl]: () => json({ access_token: 'gh' }),
      [userUrl]: () => json({ id: 1, login: 'a' }),
      [emailsUrl]: () => json({}, 403),
    });
    await expect(new GitHubOAuthProvider(options).exchangeCode('c')).rejects.toMatchObject({
      code: 'OAUTH_FAILED',
    });
  });
});
