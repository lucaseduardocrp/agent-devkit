import { describe, expect, it } from 'vitest';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import {
  PrismaAuthRepository,
  type PrismaAuthClient,
} from '../src/modules/identity/adapters/prisma-auth-repository.js';

describe('Auth Repositories', () => {
  describe('InMemoryAuthRepository', () => {
    it('creates and finds users by email and id', async () => {
      const repo = new InMemoryAuthRepository();
      const user = await repo.createUser({
        email: ' Test@example.com ',
        name: 'Test User',
        passwordHash: 'hash:123',
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');

      const foundByEmail = await repo.findByEmail('TEST@EXAMPLE.COM');
      expect(foundByEmail?.id).toBe(user.id);

      const foundById = await repo.findById(user.id);
      expect(foundById?.email).toBe('test@example.com');

      const notFoundEmail = await repo.findByEmail('nonexistent@example.com');
      expect(notFoundEmail).toBeNull();

      const notFoundId = await repo.findById('nonexistent-id');
      expect(notFoundId).toBeNull();
    });

    it('creates, finds, and deletes sessions', async () => {
      const repo = new InMemoryAuthRepository();
      const user = await repo.createUser({
        email: 'session@example.com',
        name: 'Session User',
        passwordHash: 'hash:123',
      });

      const expiresAt = new Date(Date.now() + 10000);
      const session = await repo.createSession({
        userId: user.id,
        token: 'token-123',
        expiresAt,
      });

      expect(session.token).toBe('token-123');
      expect(session.userId).toBe(user.id);

      const foundSession = await repo.findSessionByToken('token-123');
      expect(foundSession?.user?.email).toBe('session@example.com');

      const missingSession = await repo.findSessionByToken('nonexistent-token');
      expect(missingSession).toBeNull();

      await repo.deleteSessionByToken('token-123');
      const deletedSession = await repo.findSessionByToken('token-123');
      expect(deletedSession).toBeNull();
    });

    it('cleans up expired sessions', async () => {
      const repo = new InMemoryAuthRepository();
      const user = await repo.createUser({
        email: 'cleanup@example.com',
        name: 'Cleanup User',
        passwordHash: 'hash',
      });

      const past = new Date(Date.now() - 1000);
      const future = new Date(Date.now() + 100000);

      await repo.createSession({ userId: user.id, token: 'expired-token', expiresAt: past });
      await repo.createSession({ userId: user.id, token: 'valid-token', expiresAt: future });

      const deletedCount = await repo.deleteExpiredSessions();
      expect(deletedCount).toBe(1);

      expect(await repo.findSessionByToken('expired-token')).toBeNull();
      expect(await repo.findSessionByToken('valid-token')).not.toBeNull();
    });
  });

  describe('PrismaAuthRepository', () => {
    it('delegates CRUD calls to prisma client', async () => {
      const mockUser = {
        id: 'user-1',
        email: 'prisma@example.com',
        name: 'Prisma User',
        passwordHash: 'hash:123',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockSession = {
        id: 'session-1',
        userId: 'user-1',
        token: 'prisma-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        user: mockUser,
      };

      const mockClient: PrismaAuthClient = {
        userRecord: {
          findUnique: async ({ where }) => {
            if (where.email === 'prisma@example.com' || where.id === 'user-1') {
              return mockUser;
            }
            return null;
          },
          create: async ({ data }) => ({
            id: 'user-1',
            email: data.email,
            passwordHash: data.passwordHash,
            name: data.name,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          delete: async () => mockUser,
        },
        sessionRecord: {
          create: async () => mockSession,
          findUnique: async ({ where }) => (where.token === 'prisma-token' ? mockSession : null),
          deleteMany: async ({ where }) => {
            if (where.token || where.expiresAt) {
              return { count: 1 };
            }
            return { count: 0 };
          },
        },
      };

      const repo = new PrismaAuthRepository(mockClient);

      const createdUser = await repo.createUser({
        email: 'prisma@example.com',
        name: 'Prisma User',
        passwordHash: 'hash:123',
      });
      expect(createdUser.email).toBe('prisma@example.com');

      const foundUserByEmail = await repo.findByEmail('prisma@example.com');
      expect(foundUserByEmail?.id).toBe('user-1');

      const foundUserById = await repo.findById('user-1');
      expect(foundUserById?.name).toBe('Prisma User');

      const createdSession = await repo.createSession({
        userId: 'user-1',
        token: 'prisma-token',
        expiresAt: new Date(),
      });
      expect(createdSession.token).toBe('prisma-token');

      const foundSession = await repo.findSessionByToken('prisma-token');
      expect(foundSession?.userId).toBe('user-1');

      await repo.deleteSessionByToken('prisma-token');
      const deletedCount = await repo.deleteExpiredSessions();
      expect(deletedCount).toBe(1);
    });
  });
});
