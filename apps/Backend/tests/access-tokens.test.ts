import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import {
  InMemoryAccessTokenRepository,
  PrismaAccessTokenRepository,
  type PrismaAccessTokenClient,
} from '../src/modules/identity/adapters/access-token-repositories.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import {
  AccessTokenService,
  hashAccessToken,
  isAccessToken,
} from '../src/modules/identity/application/access-tokens.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';

async function setup(now = () => new Date()) {
  const users = new InMemoryAuthRepository();
  const repository = new InMemoryAccessTokenRepository();
  const tokens = new AccessTokenService(repository, users, now);
  const auth = new AuthService(users, { accessTokens: tokens });
  const session = await auth.register({
    email: 'ana@example.com',
    password: 'Password123!',
    name: 'Ana',
  });
  return { users, repository, tokens, auth, session };
}

describe('AccessTokenService', () => {
  it('creates a token shown once, stores only its hash and verifies it', async () => {
    const { tokens, repository, session } = await setup();
    const created = await tokens.create(session.user.id, {
      name: ' MCP ',
      scope: 'read',
      expiresInDays: 30,
    });
    expect(isAccessToken(created.token)).toBe(true);
    expect(created.accessToken).toMatchObject({ name: 'MCP', scope: 'read', lastUsedAt: null });
    expect(created.token.startsWith(created.accessToken.tokenPrefix)).toBe(true);
    const [stored] = await repository.listByUser(session.user.id);
    expect(stored!.tokenHash).toBe(hashAccessToken(created.token));
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const verified = await tokens.verify(created.token);
    expect(verified).toMatchObject({ scope: 'read', user: { id: session.user.id } });
    expect((await tokens.list(session.user.id))[0]!.lastUsedAt).not.toBeNull();
  });

  it('rejects unknown, revoked, expired and orphaned tokens', async () => {
    let clock = new Date('2026-09-25T00:00:00Z');
    const { tokens, users, session } = await setup(() => clock);
    expect(await tokens.verify('session-token')).toBeNull();
    expect(await tokens.verify('adk_pat_unknown')).toBeNull();

    const revoked = await tokens.create(session.user.id, {
      name: 'a',
      scope: 'full',
      expiresInDays: null,
    });
    expect(revoked.accessToken.expiresAt).toBeNull();
    await tokens.revoke(session.user.id, revoked.accessToken.id);
    expect(await tokens.verify(revoked.token)).toBeNull();
    await expect(tokens.revoke(session.user.id, revoked.accessToken.id)).rejects.toMatchObject({
      code: 'ACCESS_TOKEN_NOT_FOUND',
    });
    await expect(tokens.revoke('someone-else', 'x')).rejects.toMatchObject({ statusCode: 404 });

    const expiring = await tokens.create(session.user.id, {
      name: 'b',
      scope: 'full',
      expiresInDays: 1,
    });
    clock = new Date('2026-09-27T00:00:00Z');
    expect(await tokens.verify(expiring.token)).toBeNull();
    expect(await tokens.list(session.user.id)).toEqual([]);

    const orphan = await tokens.create(session.user.id, {
      name: 'c',
      scope: 'full',
      expiresInDays: 5,
    });
    await users.deleteUser(session.user.id);
    expect(await tokens.verify(orphan.token)).toBeNull();
  });

  it('throttles last-used updates and caps active tokens per user', async () => {
    let clock = new Date('2026-09-25T00:00:00Z');
    const { tokens, repository, session } = await setup(() => clock);
    const touch = vi.spyOn(repository, 'touch');
    const { token } = await tokens.create(session.user.id, {
      name: 'a',
      scope: 'full',
      expiresInDays: 90,
    });
    await tokens.verify(token);
    await tokens.verify(token);
    expect(touch).toHaveBeenCalledTimes(1);
    clock = new Date('2026-09-25T00:05:00Z');
    await tokens.verify(token);
    expect(touch).toHaveBeenCalledTimes(2);

    for (let index = 1; index < 50; index += 1) {
      await tokens.create(session.user.id, { name: `t${index}`, scope: 'full', expiresInDays: 90 });
    }
    await expect(
      tokens.create(session.user.id, { name: 'over', scope: 'full', expiresInDays: 90 }),
    ).rejects.toMatchObject({ code: 'ACCESS_TOKEN_LIMIT_REACHED' });
    const listed = await tokens.list(session.user.id);
    expect(listed).toHaveLength(50);
  });

  it('lets AuthService authenticate sessions and access tokens', async () => {
    const { auth, tokens, session } = await setup();
    expect(await auth.authenticate(session.token)).toMatchObject({
      kind: 'session',
      scope: 'full',
    });
    const { token } = await tokens.create(session.user.id, {
      name: 'a',
      scope: 'read',
      expiresInDays: 90,
    });
    expect(await auth.authenticate(token)).toMatchObject({ kind: 'access-token', scope: 'read' });
    expect(await auth.authenticateToken(token)).toMatchObject({ id: session.user.id });
    expect(await auth.authenticate('  ')).toBeNull();

    const withoutTokens = new AuthService(new InMemoryAuthRepository());
    expect(await withoutTokens.authenticate(token)).toBeNull();
  });
});

describe('PrismaAccessTokenRepository', () => {
  it('maps rows and delegates every operation', async () => {
    const row = {
      id: 'id-1',
      userId: 'u1',
      name: 'n',
      tokenHash: 'h',
      tokenPrefix: 'adk_pat_ab',
      scope: 'unexpected',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    const delegate = {
      create: vi.fn().mockResolvedValue({ ...row, scope: 'read' }),
      findMany: vi.fn().mockResolvedValue([row]),
      findUnique: vi.fn().mockResolvedValueOnce(row).mockResolvedValueOnce(null),
      update: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
    };
    const repository = new PrismaAccessTokenRepository({
      personalAccessTokenRecord: delegate,
    } as PrismaAccessTokenClient);
    const input = {
      userId: 'u1',
      name: 'n',
      tokenHash: 'h',
      tokenPrefix: 'p',
      scope: 'read' as const,
      expiresAt: null,
    };
    expect((await repository.create(input)).scope).toBe('read');
    expect((await repository.listByUser('u1'))[0]!.scope).toBe('full');
    expect(await repository.findByHash('h')).toMatchObject({ id: 'id-1' });
    expect(await repository.findByHash('x')).toBeNull();
    await repository.touch('id-1', new Date(0));
    expect(delegate.update).toHaveBeenCalledWith({
      where: { id: 'id-1' },
      data: { lastUsedAt: new Date(0) },
    });
    expect(await repository.revoke('id-1', 'u1', new Date())).toBe(true);
    expect(await repository.revoke('id-1', 'u1', new Date())).toBe(false);
    expect(delegate.updateMany.mock.calls[0]![0].where).toEqual({
      id: 'id-1',
      userId: 'u1',
      revokedAt: null,
    });
  });

  it('ignores touches of unknown in-memory tokens', async () => {
    const repository = new InMemoryAccessTokenRepository();
    await expect(repository.touch('missing', new Date())).resolves.toBeUndefined();
  });
});

describe('access token HTTP routes', () => {
  async function signedIn() {
    const app = createApp();
    const registered = await request(app)
      .post('/auth/register')
      .send({ email: 'bob@example.com', password: 'Password123!', name: 'Bob' });
    return { app, session: registered.body.token as string };
  }

  it('creates, lists and revokes tokens from a session', async () => {
    const { app, session } = await signedIn();
    const auth = { authorization: `Bearer ${session}` };
    const created = await request(app).post('/auth/tokens').set(auth).send({ name: 'Claude Code' });
    expect(created.status).toBe(201);
    expect(created.body.accessToken).toMatchObject({ name: 'Claude Code', scope: 'full' });
    expect(created.body.token).toMatch(/^adk_pat_/);

    const listed = await request(app).get('/auth/tokens').set(auth);
    expect(listed.body.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    const me = await request(app)
      .get('/auth/me')
      .set({ authorization: `Bearer ${created.body.token}` });
    expect(me.body.user.email).toBe('bob@example.com');

    expect(
      (await request(app).delete(`/auth/tokens/${created.body.accessToken.id}`).set(auth)).status,
    ).toBe(204);
    const revoked = await request(app)
      .get('/auth/me')
      .set({ authorization: `Bearer ${created.body.token}` });
    expect(revoked.status).toBe(401);
  });

  it('forbids creating tokens with a token and enforces read-only scope', async () => {
    const { app, session } = await signedIn();
    const read = await request(app)
      .post('/auth/tokens')
      .set({ authorization: `Bearer ${session}` })
      .send({ name: 'Viewer', scope: 'read', expiresInDays: null });
    const readAuth = { authorization: `Bearer ${read.body.token}` };

    const nested = await request(app).post('/auth/tokens').set(readAuth).send({ name: 'x' });
    expect(nested.status).toBe(403);
    expect(nested.body.code).toBe('ACCESS_TOKEN_READ_ONLY');
    expect((await request(app).get('/workspaces').set(readAuth)).status).toBe(200);
    const write = await request(app).post('/workspaces').set(readAuth).send({ name: 'Nope' });
    expect(write.body.code).toBe('ACCESS_TOKEN_READ_ONLY');

    const full = await request(app)
      .post('/auth/tokens')
      .set({ authorization: `Bearer ${session}` })
      .send({ name: 'Full' });
    const fromToken = await request(app)
      .post('/auth/tokens')
      .set({ authorization: `Bearer ${full.body.token}` })
      .send({ name: 'Nested' });
    expect(fromToken.status).toBe(403);
    expect(fromToken.body.code).toBe('SESSION_TOKEN_REQUIRED');
    expect(
      (
        await request(app)
          .get('/auth/tokens')
          .set({ authorization: `Bearer ${full.body.token}` })
      ).status,
    ).toBe(200);
  });

  it('requires authentication, validates input and reports when tokens are disabled', async () => {
    const { app, session } = await signedIn();
    expect((await request(app).get('/auth/tokens')).status).toBe(401);
    expect(
      (await request(app).get('/auth/tokens').set({ authorization: 'Bearer wrong' })).status,
    ).toBe(401);
    const invalid = await request(app)
      .post('/auth/tokens')
      .set({ authorization: `Bearer ${session}` })
      .send({ name: '', expiresInDays: 999 });
    expect(invalid.status).toBe(400);
    expect(
      (
        await request(app)
          .delete('/auth/tokens/missing')
          .set({ authorization: `Bearer ${session}` })
      ).status,
    ).toBe(404);

    const users = new InMemoryAuthRepository();
    const disabled = createApp({ authService: new AuthService(users) });
    const registered = await request(disabled)
      .post('/auth/register')
      .send({ email: 'c@example.com', password: 'Password123!', name: 'C' });
    const response = await request(disabled)
      .get('/auth/tokens')
      .set({ authorization: `Bearer ${registered.body.token}` });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('ACCESS_TOKENS_UNAVAILABLE');
  });
});
