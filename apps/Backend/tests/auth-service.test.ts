import { describe, expect, it } from 'vitest';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';

describe('AuthService', () => {
  it('registers a new user and issues a session token', async () => {
    const repo = new InMemoryAuthRepository();
    const service = new AuthService(repo);

    const response = await service.register({
      email: ' NewUser@example.com ',
      name: 'New User',
      password: 'StrongPassword123!',
    });

    expect(response.user.email).toBe('newuser@example.com');
    expect(response.user.name).toBe('New User');
    expect(response.token).toHaveLength(64);
    expect(new Date(response.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Cannot register duplicate
    await expect(
      service.register({
        email: 'newuser@example.com',
        name: 'Another',
        password: 'StrongPassword123!',
      }),
    ).rejects.toMatchObject({
      code: 'IDENTITY_EXISTS',
      statusCode: 409,
    });
  });

  it('authenticates valid credentials and rejects invalid ones', async () => {
    const repo = new InMemoryAuthRepository();
    const service = new AuthService(repo);

    await service.register({
      email: 'user@example.com',
      name: 'User',
      password: 'ValidPassword123!',
    });

    const loginResponse = await service.login({
      email: 'USER@example.com',
      password: 'ValidPassword123!',
    });

    expect(loginResponse.user.email).toBe('user@example.com');
    expect(loginResponse.token).toHaveLength(64);

    // Wrong password
    await expect(
      service.login({
        email: 'user@example.com',
        password: 'WrongPassword!',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      statusCode: 401,
    });

    // Non-existent user
    await expect(
      service.login({
        email: 'nonexistent@example.com',
        password: 'ValidPassword123!',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      statusCode: 401,
    });
  });

  it('manages sessions with getMe, logout, and expiration', async () => {
    const repo = new InMemoryAuthRepository();
    const service = new AuthService(repo);

    const { token, user } = await service.register({
      email: 'session@example.com',
      name: 'Session Guy',
      password: 'Password123!',
    });

    const profile = await service.getMe(token);
    expect(profile.id).toBe(user.id);
    expect(profile.email).toBe('session@example.com');

    // Invalid token for getMe
    await expect(service.getMe('invalid-token')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });

    // Logout
    await service.logout(token);
    await expect(service.getMe(token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      statusCode: 401,
    });

    // Logout with empty token is a no-op
    await expect(service.logout('   ')).resolves.toBeUndefined();
  });

  it('handles expired tokens in authenticateToken', async () => {
    const repo = new InMemoryAuthRepository();
    const service = new AuthService(repo);

    const createdUser = await repo.createUser({
      email: 'expired@example.com',
      name: 'Expired',
      passwordHash: 'hash',
    });

    // Expired session
    await repo.createSession({
      userId: createdUser.id,
      token: 'expired-session-token',
      expiresAt: new Date(Date.now() - 5000),
    });

    expect(await service.authenticateToken('expired-session-token')).toBeNull();
    expect(await service.authenticateToken('')).toBeNull();
  });

  it('resolves user via userId fallback when user is not embedded in session', async () => {
    const repo = new InMemoryAuthRepository();
    const service = new AuthService(repo);

    const createdUser = await repo.createUser({
      email: 'standalone@example.com',
      name: 'Standalone',
      passwordHash: 'hash',
    });

    // Create session directly with no embedded user
    const future = new Date(Date.now() + 60000);
    await repo.createSession({
      userId: createdUser.id,
      token: 'custom-token',
      expiresAt: future,
    });

    // Mock findSessionByToken to return session without user property
    const originalFind = repo.findSessionByToken.bind(repo);
    repo.findSessionByToken = async (token: string) => {
      const s = await originalFind(token);
      if (!s) return null;
      return {
        id: s.id,
        userId: s.userId,
        token: s.token,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      };
    };

    const authenticated = await service.authenticateToken('custom-token');
    expect(authenticated?.id).toBe(createdUser.id);
  });
});
