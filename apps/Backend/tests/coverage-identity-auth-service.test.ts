import { describe, expect, it, vi } from 'vitest';
import { InMemoryAccessTokenRepository } from '../src/modules/identity/adapters/access-token-repositories.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AccessTokenService } from '../src/modules/identity/application/access-tokens.js';
import type {
  AuthCodeEntity,
  AuthCodePurpose,
  SessionEntity,
} from '../src/modules/identity/application/auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import type { EmailMessage } from '../src/modules/identity/application/email-sender.js';

function capturingSender() {
  const messages: EmailMessage[] = [];
  return {
    messages,
    sender: {
      send: (message: EmailMessage) => {
        messages.push(message);
        return Promise.resolve();
      },
    },
    lastCode: () => /code (\d{6})/.exec(messages.at(-1)?.text ?? '')?.[1] ?? '',
  };
}

async function setup() {
  const repository = new InMemoryAuthRepository();
  const mail = capturingSender();
  const service = new AuthService(repository, {
    emailSender: mail.sender,
    codeSecret: 'secret',
    sessionDurationDays: 1,
    codeDurationMinutes: 5,
  });
  const registered = await service.register({
    email: ' Ana@Example.com ',
    password: 'Password123!',
    name: ' Ana ',
  });
  return { repository, mail, service, registered };
}

describe('AuthService registration and login', () => {
  it('normalizes registration data and rejects duplicates', async () => {
    const { service, registered } = await setup();
    expect(registered.user).toMatchObject({ email: 'ana@example.com', name: 'Ana' });
    await expect(
      service.register({ email: 'ANA@example.com', password: 'Password123!', name: 'X' }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EXISTS', statusCode: 409 });
  });

  it('rejects unknown users, OAuth-only users and wrong passwords', async () => {
    const { service, repository } = await setup();
    await expect(
      service.login({ email: 'nobody@example.com', password: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await repository.createUser({ email: 'oauth@example.com', passwordHash: null, name: 'O' });
    await expect(
      service.login({ email: 'oauth@example.com', password: 'x' }),
    ).rejects.toMatchObject({ code: 'PASSWORD_LOGIN_UNAVAILABLE' });
    await expect(
      service.login({ email: 'ana@example.com', password: 'Wrong123!' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const ok = await service.login({ email: 'ana@example.com', password: 'Password123!' });
    expect(ok.user.email).toBe('ana@example.com');
  });
});

describe('AuthService password reset', () => {
  it('ignores unknown emails and throttles repeated requests', async () => {
    const { service, mail } = await setup();
    await service.requestPasswordReset('unknown@example.com');
    expect(mail.messages).toHaveLength(0);

    await service.requestPasswordReset(' ANA@example.com ');
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0]).toMatchObject({ to: 'ana@example.com' });
    expect(mail.messages[0]!.text).toContain('expires in 5 minutes');
    expect(mail.messages[0]!.html).toContain(mail.lastCode());

    await service.requestPasswordReset('ana@example.com');
    expect(mail.messages).toHaveLength(1);
  });

  it('reports email delivery failures with the default sender', async () => {
    const repository = new InMemoryAuthRepository();
    const service = new AuthService(repository);
    await service.register({ email: 'a@example.com', password: 'Password123!', name: 'A' });
    await expect(service.requestPasswordReset('a@example.com')).rejects.toMatchObject({
      code: 'EMAIL_DELIVERY_FAILED',
      statusCode: 503,
    });
  });

  it('resets the password with a valid code and counts wrong attempts', async () => {
    const { service, mail, repository } = await setup();
    await expect(
      service.resetPassword('ana@example.com', '000000', 'New12345!'),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });

    await service.requestPasswordReset('ana@example.com');
    const code = mail.lastCode();
    const wrong = code === '111111' ? '222222' : '111111';
    await expect(
      service.resetPassword('ana@example.com', wrong, 'New12345!'),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });
    expect(
      (await repository.findLatestAuthCode('ana@example.com', 'RESET_PASSWORD'))?.attempts,
    ).toBe(1);

    const result = await service.resetPassword(' ANA@example.com', ` ${code} `, 'New12345!');
    expect(result.user.email).toBe('ana@example.com');
    await expect(
      service.login({ email: 'ana@example.com', password: 'New12345!' }),
    ).resolves.toBeDefined();
    // The code is consumed.
    await expect(service.resetPassword('ana@example.com', code, 'Other123!')).rejects.toMatchObject(
      { code: 'INVALID_CODE' },
    );
  });

  it('rejects expired, exhausted and malformed challenges', async () => {
    const repository = new InMemoryAuthRepository();
    let challenge: AuthCodeEntity | null = null;
    vi.spyOn(repository, 'findLatestAuthCode').mockImplementation(() => Promise.resolve(challenge));
    const increment = vi.spyOn(repository, 'incrementAuthCodeAttempts');
    const service = new AuthService(repository, { codeSecret: 's' });
    const base: AuthCodeEntity = {
      id: 'c',
      email: 'x@example.com',
      purpose: 'RESET_PASSWORD' as AuthCodePurpose,
      codeHash: 'ab',
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    };

    challenge = { ...base, expiresAt: new Date(Date.now() - 1) };
    await expect(service.resetPassword('x@example.com', '1', 'P')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    challenge = { ...base, attempts: 5 };
    await expect(service.resetPassword('x@example.com', '1', 'P')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    // Stored hash with a different length than an HMAC digest.
    challenge = base;
    await expect(service.resetPassword('x@example.com', '1', 'P')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
    expect(increment).toHaveBeenCalledWith('c');
  });

  it('fails when the user disappears and keeps an existing verification date otherwise', async () => {
    const repository = new InMemoryAuthRepository();
    const mail = capturingSender();
    const service = new AuthService(repository, { emailSender: mail.sender });
    const unverified = await repository.createUser({
      email: 'u@example.com',
      passwordHash: null,
      name: 'U',
    });
    await service.requestPasswordReset('u@example.com');
    const result = await service.resetPassword('u@example.com', mail.lastCode(), 'New12345!');
    expect(result.user.id).toBe(unverified.id);
    expect((await repository.findById(unverified.id))?.emailVerifiedAt).toBeInstanceOf(Date);

    const ghost = await repository.createUser({
      email: 'g@example.com',
      passwordHash: null,
      name: 'G',
    });
    await service.requestPasswordReset('g@example.com');
    const code = mail.lastCode();
    await repository.deleteUser(ghost.id);
    await expect(service.resetPassword('g@example.com', code, 'New12345!')).rejects.toMatchObject({
      code: 'INVALID_CODE',
    });
  });
});

describe('AuthService OAuth login', () => {
  const profile = {
    provider: 'github' as const,
    providerUserId: '42',
    email: 'New@Example.com',
    name: 'New User',
    emailVerified: true,
  };

  it('requires a verified email', async () => {
    const { service } = await setup();
    await expect(
      service.loginWithOAuth({ ...profile, emailVerified: false }),
    ).rejects.toMatchObject({ code: 'OAUTH_EMAIL_REQUIRED', statusCode: 422 });
  });

  it('creates new users, then reuses the linked identity', async () => {
    const { service, repository } = await setup();
    const first = await service.loginWithOAuth({ ...profile, name: '   ' });
    expect(first.user).toMatchObject({ email: 'new@example.com', name: 'New@Example.com' });
    const second = await service.loginWithOAuth(profile);
    expect(second.user.id).toBe(first.user.id);
    expect((await repository.findUserByOAuth('github', '42'))?.id).toBe(first.user.id);
  });

  it('links to existing accounts and verifies unverified ones', async () => {
    const { service, repository, registered } = await setup();
    const linked = await service.loginWithOAuth({ ...profile, email: 'ana@example.com' });
    expect(linked.user.id).toBe(registered.user.id);

    const unverified = await repository.createUser({
      email: 'late@example.com',
      passwordHash: null,
      name: 'Late',
    });
    await service.loginWithOAuth({
      ...profile,
      providerUserId: '99',
      provider: 'google',
      email: 'late@example.com',
    });
    expect((await repository.findById(unverified.id))?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await repository.findUserByOAuth('google', '99'))?.id).toBe(unverified.id);
  });
});

describe('AuthService sessions and tokens', () => {
  it('resolves sessions, expired sessions and sessions without an embedded user', async () => {
    const { service, repository, registered } = await setup();
    expect(await service.authenticate('   ')).toBeNull();
    expect(await service.authenticate('unknown')).toBeNull();
    await expect(service.getMe('unknown')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await service.getMe(registered.token)).email).toBe('ana@example.com');

    const original = repository.findSessionByToken.bind(repository);
    vi.spyOn(repository, 'findSessionByToken').mockImplementation(async (token) => {
      const session = await original(token);
      return session ? ({ ...session, user: undefined } as SessionEntity) : null;
    });
    expect((await service.authenticateToken(registered.token))?.id).toBe(registered.user.id);
    vi.restoreAllMocks();

    await repository.createSession({
      userId: registered.user.id,
      token: 'expired',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await service.authenticate('expired')).toBeNull();
    expect(await repository.findSessionByToken('expired')).toBeNull();
  });

  it('logs out only non-blank tokens', async () => {
    const { service, repository, registered } = await setup();
    const remove = vi.spyOn(repository, 'deleteSessionByToken');
    await service.logout('   ');
    expect(remove).not.toHaveBeenCalled();
    await service.logout(` ${registered.token} `);
    expect(remove).toHaveBeenCalledWith(registered.token);
    expect(await service.authenticate(registered.token)).toBeNull();
  });

  it('verifies access tokens only when the token service is configured', async () => {
    const repository = new InMemoryAuthRepository();
    const accessTokens = new AccessTokenService(new InMemoryAccessTokenRepository(), repository);
    const withTokens = new AuthService(repository, { accessTokens });
    const withoutTokens = new AuthService(repository);
    const session = await withTokens.register({
      email: 't@example.com',
      password: 'Password123!',
      name: 'T',
    });
    const created = await accessTokens.create(session.user.id, {
      name: 'cli',
      scope: 'read',
      expiresInDays: null,
    });
    expect(await withTokens.authenticate(created.token)).toMatchObject({
      kind: 'access-token',
      scope: 'read',
    });
    expect(await withTokens.authenticate('adk_pat_invalid')).toBeNull();
    expect(await withoutTokens.authenticate(created.token)).toBeNull();
  });
});
