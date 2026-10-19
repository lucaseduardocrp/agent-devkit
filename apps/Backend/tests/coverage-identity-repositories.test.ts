import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import {
  PrismaAuthRepository,
  type PrismaAuthClient,
} from '../src/modules/identity/adapters/prisma-auth-repository.js';
import type {
  AuthCodeEntity,
  UserEntity,
} from '../src/modules/identity/application/auth-repository.js';
import { UnavailableEmailSender } from '../src/modules/identity/application/email-sender.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const user: UserEntity = {
  id: 'user-1',
  email: 'ana@example.com',
  passwordHash: 'hash',
  name: 'Ana',
  emailVerifiedAt: now,
  createdAt: now,
  updatedAt: now,
};
const authCode: AuthCodeEntity = {
  id: 'code-1',
  email: 'ana@example.com',
  purpose: 'RESET_PASSWORD',
  codeHash: 'abc',
  expiresAt: now,
  attempts: 0,
  consumedAt: null,
  createdAt: now,
};

function fakeClient() {
  const session = {
    id: 's1',
    userId: user.id,
    token: 'tok',
    expiresAt: now,
    createdAt: now,
    user,
  };
  return {
    userRecord: {
      findUnique: vi.fn().mockResolvedValue(user),
      create: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue({ ...user, name: 'Updated' }),
      delete: vi.fn().mockResolvedValue(user),
    },
    sessionRecord: {
      create: vi.fn().mockResolvedValue(session),
      findUnique: vi.fn().mockResolvedValue(session),
      deleteMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
    authCodeRecord: {
      create: vi.fn().mockResolvedValue(authCode),
      findFirst: vi.fn().mockResolvedValue(authCode),
      update: vi.fn().mockResolvedValue(authCode),
    },
    oAuthIdentityRecord: {
      findUnique: vi.fn().mockResolvedValue({ user }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('PrismaAuthRepository', () => {
  it('maps user operations to the user delegate', async () => {
    const client = fakeClient();
    const repository = new PrismaAuthRepository(client);

    expect(await repository.findByEmail('  ANA@Example.com ')).toBe(user);
    expect(client.userRecord.findUnique).toHaveBeenCalledWith({
      where: { email: 'ana@example.com' },
    });
    expect(await repository.findById('user-1')).toBe(user);
    expect(client.userRecord.findUnique).toHaveBeenLastCalledWith({ where: { id: 'user-1' } });

    await repository.createUser({
      email: ' ANA@example.com ',
      passwordHash: null,
      name: 'Ana',
      emailVerifiedAt: now,
    });
    expect(client.userRecord.create).toHaveBeenCalledWith({
      data: { email: 'ana@example.com', passwordHash: null, name: 'Ana', emailVerifiedAt: now },
    });

    await repository.deleteUser('user-1');
    expect(client.userRecord.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });

    expect((await repository.updateUser('user-1', { passwordHash: 'new' })).name).toBe('Updated');
    expect(client.userRecord.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { passwordHash: 'new' },
    });
  });

  it('maps auth code, OAuth and session operations to their delegates', async () => {
    const client = fakeClient();
    const repository = new PrismaAuthRepository(client);
    const input = {
      email: 'ana@example.com',
      purpose: 'RESET_PASSWORD' as const,
      codeHash: 'abc',
      expiresAt: now,
    };

    expect(await repository.createAuthCode(input)).toBe(authCode);
    expect(client.authCodeRecord.create).toHaveBeenCalledWith({ data: input });
    expect(await repository.findLatestAuthCode(' ANA@example.com', 'RESET_PASSWORD')).toBe(
      authCode,
    );
    expect(client.authCodeRecord.findFirst).toHaveBeenCalledWith({
      where: { email: 'ana@example.com', purpose: 'RESET_PASSWORD', consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    await repository.incrementAuthCodeAttempts('code-1');
    expect(client.authCodeRecord.update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: { attempts: { increment: 1 } },
    });
    await repository.consumeAuthCode('code-1', now);
    expect(client.authCodeRecord.update).toHaveBeenLastCalledWith({
      where: { id: 'code-1' },
      data: { consumedAt: now },
    });

    expect(await repository.findUserByOAuth('github', '42')).toBe(user);
    client.oAuthIdentityRecord.findUnique.mockResolvedValueOnce(null);
    expect(await repository.findUserByOAuth('github', '43')).toBeNull();
    await repository.linkOAuthIdentity('user-1', 'github', '42');
    expect(client.oAuthIdentityRecord.upsert).toHaveBeenCalledWith({
      where: { provider_providerUserId: { provider: 'github', providerUserId: '42' } },
      create: { userId: 'user-1', provider: 'github', providerUserId: '42' },
      update: {},
    });

    const session = await repository.createSession({
      userId: 'user-1',
      token: 'tok',
      expiresAt: now,
    });
    expect(session.token).toBe('tok');
    expect(client.sessionRecord.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', token: 'tok', expiresAt: now },
      include: { user: true },
    });
    expect((await repository.findSessionByToken('tok'))?.user).toBe(user);
    await repository.deleteSessionByToken('tok');
    expect(client.sessionRecord.deleteMany).toHaveBeenCalledWith({ where: { token: 'tok' } });
    expect(await repository.deleteExpiredSessions(now)).toBe(3);
    expect(client.sessionRecord.deleteMany).toHaveBeenLastCalledWith({
      where: { expiresAt: { lte: now } },
    });
    expect(await repository.deleteExpiredSessions()).toBe(3);
  });

  it('fails clearly when optional delegates are not available', async () => {
    const full = fakeClient();
    const client: PrismaAuthClient = {
      userRecord: {
        findUnique: full.userRecord.findUnique,
        create: full.userRecord.create,
        delete: full.userRecord.delete,
      },
      sessionRecord: full.sessionRecord,
    };
    const repository = new PrismaAuthRepository(client);

    await expect(repository.updateUser('user-1', {})).rejects.toThrow(
      'Auth repository does not support user updates.',
    );
    await expect(
      repository.createAuthCode({
        email: 'a@b.c',
        purpose: 'RESET_PASSWORD',
        codeHash: 'x',
        expiresAt: now,
      }),
    ).rejects.toThrow('does not support codes');
    await expect(repository.findLatestAuthCode('a@b.c', 'RESET_PASSWORD')).rejects.toThrow(
      'does not support codes',
    );
    await expect(repository.incrementAuthCodeAttempts('x')).rejects.toThrow(
      'does not support codes',
    );
    await expect(repository.consumeAuthCode('x', now)).rejects.toThrow('does not support codes');
    expect(await repository.findUserByOAuth('github', '1')).toBeNull();
    await expect(repository.linkOAuthIdentity('u', 'github', '1')).rejects.toThrow(
      'Auth repository does not support OAuth.',
    );
  });
});

describe('InMemoryAuthRepository', () => {
  it('handles missing records and code bookkeeping', async () => {
    const repository = new InMemoryAuthRepository();
    expect(() => repository.updateUser('missing', {})).toThrow('User not found.');

    // Missing ids are ignored.
    await repository.incrementAuthCodeAttempts('missing');
    await repository.consumeAuthCode('missing', now);
    expect(await repository.findSessionByToken('missing')).toBeNull();
    expect(await repository.findById('missing')).toBeNull();

    const created = await repository.createUser({
      email: ' Bob@Example.com ',
      passwordHash: null,
      name: 'Bob',
    });
    expect(created.email).toBe('bob@example.com');
    expect(created.emailVerifiedAt).toBeNull();

    const code = await repository.createAuthCode({
      email: 'BOB@example.com',
      purpose: 'RESET_PASSWORD',
      codeHash: 'h',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repository.incrementAuthCodeAttempts(code.id);
    expect(
      (await repository.findLatestAuthCode('bob@example.com', 'RESET_PASSWORD'))?.attempts,
    ).toBe(1);
    await repository.consumeAuthCode(code.id, now);
    expect(await repository.findLatestAuthCode('bob@example.com', 'RESET_PASSWORD')).toBeNull();

    await repository.linkOAuthIdentity(created.id, 'github', '7');
    expect((await repository.findUserByOAuth('github', '7'))?.id).toBe(created.id);
    expect(await repository.findUserByOAuth('github', 'unknown')).toBeNull();
    await repository.deleteUser(created.id);
    expect(await repository.findUserByOAuth('github', '7')).toBeNull();
  });

  it('deletes expired sessions using the current time by default', async () => {
    const repository = new InMemoryAuthRepository();
    const owner = await repository.createUser({ email: 'c@d.e', passwordHash: null, name: 'C' });
    await repository.createSession({
      userId: owner.id,
      token: 'old',
      expiresAt: new Date(Date.now() - 1000),
    });
    await repository.createSession({
      userId: owner.id,
      token: 'fresh',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await repository.deleteExpiredSessions()).toBe(1);
    expect(await repository.findSessionByToken('old')).toBeNull();
    expect((await repository.findSessionByToken('fresh'))?.user?.id).toBe(owner.id);
  });
});

describe('UnavailableEmailSender', () => {
  it('rejects because SMTP is not configured', async () => {
    await expect(new UnavailableEmailSender().send()).rejects.toThrow('SMTP is not configured.');
  });
});
