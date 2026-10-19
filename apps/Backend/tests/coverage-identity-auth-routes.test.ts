import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAccessTokenRepository } from '../src/modules/identity/adapters/access-token-repositories.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AccessTokenService } from '../src/modules/identity/application/access-tokens.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import type { EmailMessage } from '../src/modules/identity/application/email-sender.js';
import type {
  OAuthProfile,
  OAuthProvider,
} from '../src/modules/identity/application/oauth-provider.js';

const STATE_SECRET = 'state-secret';
const FRONTEND = 'https://front.test/app';

function fakeProvider(profile?: Partial<OAuthProfile>): OAuthProvider & {
  exchangeCode: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'github',
    createAuthorizationUrl: (state: string) =>
      `https://idp.test/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: vi.fn().mockResolvedValue({
      provider: 'github',
      providerUserId: '42',
      email: 'octo@example.com',
      name: 'Octo',
      emailVerified: true,
      ...profile,
    }),
  };
}

function sign(payload: unknown, secret = STATE_SECRET, rawBody?: string): string {
  const body = rawBody ?? Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function oauthApp(secureCookies = false) {
  const provider = fakeProvider();
  const authService = new AuthService(new InMemoryAuthRepository());
  const app = createApp({
    authService,
    authRouterOptions: {
      oauthProviders: [provider],
      oauthStateSecret: STATE_SECRET,
      frontendUrl: FRONTEND,
      secureCookies,
    },
  });
  return { app, provider };
}

async function startFlow(app: ReturnType<typeof createApp>) {
  const response = await request(app).get('/auth/oauth/github/start');
  const location = new URL(response.headers.location as string);
  const state = location.searchParams.get('state')!;
  const cookie = (response.headers['set-cookie'] as unknown as string[])[0]!;
  return { response, state, cookie: cookie.split(';')[0]! };
}

describe('auth routes: OAuth', () => {
  it('lists configured providers', async () => {
    const { app } = oauthApp();
    const response = await request(app).get('/auth/options');
    expect(response.body).toEqual({ oauthProviders: ['github'] });
    expect((await request(createApp()).get('/auth/options')).body).toEqual({ oauthProviders: [] });
  });

  it('rejects unconfigured providers on start and callback', async () => {
    const plain = createApp();
    expect((await request(plain).get('/auth/oauth/github/start')).status).toBe(503);
    expect((await request(plain).get('/auth/oauth/github/callback')).body.code).toBe(
      'OAUTH_UNAVAILABLE',
    );
    const noSecret = createApp({ authRouterOptions: { oauthProviders: [fakeProvider()] } });
    expect((await request(noSecret).get('/auth/oauth/github/start')).status).toBe(503);
    const noFrontend = createApp({
      authRouterOptions: { oauthProviders: [fakeProvider()], oauthStateSecret: STATE_SECRET },
    });
    expect((await request(noFrontend).get('/auth/oauth/github/callback')).status).toBe(503);
  });

  it('redirects to the provider with a signed state and nonce cookie', async () => {
    const { app } = oauthApp();
    const { response, cookie } = await startFlow(app);
    expect(response.status).toBe(302);
    expect(response.headers.location).toMatch(/^https:\/\/idp\.test\/authorize\?state=/);
    const setCookie = (response.headers['set-cookie'] as unknown as string[])[0]!;
    expect(setCookie).toContain('HttpOnly; SameSite=Lax; Path=/auth/oauth; Max-Age=600');
    expect(setCookie).not.toContain('Secure');
    expect(cookie.startsWith('oauth_state=')).toBe(true);

    const secure = await startFlow(oauthApp(true).app);
    expect((secure.response.headers['set-cookie'] as unknown as string[])[0]).toContain('; Secure');
  });

  it('completes the callback and redirects to the frontend with a session token', async () => {
    const { app, provider } = oauthApp();
    const { state, cookie } = await startFlow(app);
    const response = await request(app)
      .get('/auth/oauth/github/callback')
      .query({ code: 'abc', state })
      .set('Cookie', `other=1; ${cookie}`);
    expect(response.status).toBe(302);
    expect(provider.exchangeCode).toHaveBeenCalledWith('abc');
    const destination = new URL(response.headers.location as string);
    expect(destination.origin + destination.pathname).toBe(FRONTEND);
    const token = new URLSearchParams(destination.hash.slice(1)).get('oauth_token');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((response.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.body.user.email).toBe('octo@example.com');
  });

  it('rejects invalid or tampered OAuth state', async () => {
    const { app, provider } = oauthApp();
    const { state, cookie } = await startFlow(app);
    const nonce = decodeURIComponent(cookie.slice('oauth_state='.length));
    const callback = (query: Record<string, string>, cookieHeader?: string) => {
      const pending = request(app).get('/auth/oauth/github/callback').query(query);
      return cookieHeader ? pending.set('Cookie', cookieHeader) : pending;
    };
    const expectInvalid = async (response: request.Response) => {
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_OAUTH_STATE');
    };

    await expectInvalid(await callback({}, cookie));
    await expectInvalid(await callback({ code: 'c', state: `${state}x` }, cookie));
    await expectInvalid(await callback({ code: 'c', state: sign(null, STATE_SECRET, 'not-json') }));
    await expectInvalid(await callback({ code: '', state }, cookie));
    await expectInvalid(
      await callback(
        {
          code: 'c',
          state: sign({ provider: 'google', nonce, expiresAt: Date.now() + 60_000 }),
        },
        cookie,
      ),
    );
    await expectInvalid(
      await callback(
        { code: 'c', state: sign({ provider: 'github', nonce, expiresAt: Date.now() - 1 }) },
        cookie,
      ),
    );
    await expectInvalid(await callback({ code: 'c', state }));
    await expectInvalid(await callback({ code: 'c', state }, 'oauth_state=different'));
    await expectInvalid(
      await request(app)
        .get('/auth/oauth/github/callback?code=a&code=b&state[x]=1')
        .set('Cookie', cookie),
    );
    expect(provider.exchangeCode).not.toHaveBeenCalled();
  });
});

describe('auth routes: password reset', () => {
  it('sends a reset code and accepts it', async () => {
    const messages: EmailMessage[] = [];
    const authService = new AuthService(new InMemoryAuthRepository(), {
      emailSender: { send: (message) => (messages.push(message), Promise.resolve()) },
    });
    const app = createApp({ authService });
    await request(app)
      .post('/auth/register')
      .send({ email: 'r@example.com', password: 'Password123!', name: 'R' });

    const forgot = await request(app)
      .post('/auth/password/forgot')
      .send({ email: 'r@example.com' });
    expect(forgot.status).toBe(202);
    expect(forgot.body).toEqual({ success: true });
    const code = /code (\d{6})/.exec(messages[0]!.text)![1]!;

    const reset = await request(app)
      .post('/auth/password/reset')
      .send({ email: 'r@example.com', code, password: 'NewPassword123!' });
    expect(reset.status).toBe(200);
    expect(reset.body.user.email).toBe('r@example.com');

    expect((await request(app).post('/auth/password/forgot').send({})).status).toBe(400);
    const bad = await request(app)
      .post('/auth/password/reset')
      .send({ email: 'r@example.com', code: '000000', password: 'NewPassword123!' });
    expect(bad.status).toBe(400);
  });
});

describe('auth routes: access tokens and logout', () => {
  async function tokensApp(withTokens = true) {
    const repository = new InMemoryAuthRepository();
    const accessTokens = new AccessTokenService(new InMemoryAccessTokenRepository(), repository);
    const authService = new AuthService(repository, { accessTokens });
    const app = createApp(
      withTokens
        ? { authService, authRouterOptions: { accessTokens } }
        : { authService: new AuthService(repository) },
    );
    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'tok@example.com', password: 'Password123!', name: 'Tok' });
    return { app, session: registered.body.token as string };
  }

  it('creates, lists and revokes access tokens from a session', async () => {
    const { app, session } = await tokensApp();
    const auth = { Authorization: `Bearer ${session}` };

    expect((await request(app).get('/auth/tokens')).status).toBe(401);
    expect(
      (await request(app).get('/auth/tokens').set('Authorization', 'Bearer nope')).status,
    ).toBe(401);

    const created = await request(app).post('/auth/tokens').set(auth).send({ name: 'CLI' });
    expect(created.status).toBe(201);
    expect(created.body.accessToken.name).toBe('CLI');

    const fromToken = await request(app)
      .post('/auth/tokens')
      .set('Authorization', `Bearer ${created.body.token}`)
      .send({ name: 'nested' });
    expect(fromToken.status).toBe(403);
    expect(fromToken.body.code).toBe('SESSION_TOKEN_REQUIRED');

    const listed = await request(app)
      .get('/auth/tokens')
      .set('Authorization', `Bearer ${created.body.token}`);
    expect(listed.body.tokens).toHaveLength(1);

    const revoked = await request(app)
      .delete(`/auth/tokens/${created.body.accessToken.id}`)
      .set(auth);
    expect(revoked.status).toBe(204);
    expect((await request(app).get('/auth/tokens').set(auth)).body.tokens).toHaveLength(0);
    expect((await request(app).delete('/auth/tokens/missing').set(auth)).status).toBe(404);
  });

  it('reports when access tokens are disabled', async () => {
    const { app, session } = await tokensApp(false);
    const response = await request(app)
      .get('/auth/tokens')
      .set('Authorization', `Bearer ${session}`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ACCESS_TOKENS_UNAVAILABLE');
  });

  it('logs out with or without a token', async () => {
    const { app, session } = await tokensApp();
    expect((await request(app).post('/auth/logout')).body).toEqual({ success: true });
    const out = await request(app).post('/auth/logout').set('Authorization', `Bearer ${session}`);
    expect(out.status).toBe(200);
    expect(
      (await request(app).get('/auth/me').set('Authorization', `Bearer ${session}`)).status,
    ).toBe(401);
  });

  it('logs in and requires a bearer token for the profile', async () => {
    const { app } = await tokensApp();
    expect((await request(app).post('/auth/login').send({})).status).toBe(400);
    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'tok@example.com', password: 'Password123!' });
    expect(login.status).toBe(200);
    const me = await request(app).get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('UNAUTHORIZED');
    const profile = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(profile.body.user.email).toBe('tok@example.com');
  });

  it('forwards logout failures to the error handler', async () => {
    const authService = new AuthService(new InMemoryAuthRepository());
    vi.spyOn(authService, 'logout').mockRejectedValue(new Error('store down'));
    const response = await request(createApp({ authService }))
      .post('/auth/logout')
      .set('Authorization', 'Bearer abc');
    expect(response.status).toBe(500);
  });
});
