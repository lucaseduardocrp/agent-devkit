import { randomUUID } from 'node:crypto';
import type {
  AuthRepository,
  AuthCodeEntity,
  AuthCodePurpose,
  CreateSessionInput,
  CreateUserInput,
  SessionEntity,
  UserEntity,
} from '../application/auth-repository.js';

export class InMemoryAuthRepository implements AuthRepository {
  private readonly users = new Map<string, UserEntity>();
  private readonly sessions = new Map<string, SessionEntity>();
  private readonly authCodes = new Map<string, AuthCodeEntity>();
  private readonly oauthIdentities = new Map<string, string>();

  public findByEmail(email: string): Promise<UserEntity | null> {
    const normalized = email.toLowerCase().trim();
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === normalized) {
        return Promise.resolve(user);
      }
    }
    return Promise.resolve(null);
  }

  public findById(id: string): Promise<UserEntity | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }

  public createUser(input: CreateUserInput): Promise<UserEntity> {
    const now = new Date();
    const user: UserEntity = {
      id: randomUUID(),
      email: input.email.toLowerCase().trim(),
      passwordHash: input.passwordHash,
      name: input.name,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }

  public deleteUser(userId: string): Promise<void> {
    this.users.delete(userId);
    return Promise.resolve();
  }

  public updateUser(
    userId: string,
    input: { passwordHash?: string; emailVerifiedAt?: Date },
  ): Promise<UserEntity> {
    const current = this.users.get(userId);
    if (!current) throw new Error('User not found.');
    const updated = { ...current, ...input, updatedAt: new Date() };
    this.users.set(userId, updated);
    return Promise.resolve(updated);
  }

  public createAuthCode(input: {
    email: string;
    purpose: AuthCodePurpose;
    codeHash: string;
    expiresAt: Date;
  }): Promise<AuthCodeEntity> {
    const code: AuthCodeEntity = {
      id: randomUUID(),
      ...input,
      email: input.email.toLowerCase().trim(),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    };
    this.authCodes.set(code.id, code);
    return Promise.resolve(code);
  }

  public findLatestAuthCode(
    email: string,
    purpose: AuthCodePurpose,
  ): Promise<AuthCodeEntity | null> {
    const normalized = email.toLowerCase().trim();
    const codes = [...this.authCodes.values()]
      .filter((item) => item.email === normalized && item.purpose === purpose && !item.consumedAt)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return Promise.resolve(codes[0] ?? null);
  }

  public incrementAuthCodeAttempts(id: string): Promise<void> {
    const current = this.authCodes.get(id);
    if (current) this.authCodes.set(id, { ...current, attempts: current.attempts + 1 });
    return Promise.resolve();
  }

  public consumeAuthCode(id: string, consumedAt: Date): Promise<void> {
    const current = this.authCodes.get(id);
    if (current) this.authCodes.set(id, { ...current, consumedAt });
    return Promise.resolve();
  }

  public findUserByOAuth(provider: string, providerUserId: string): Promise<UserEntity | null> {
    const userId = this.oauthIdentities.get(`${provider}:${providerUserId}`);
    return Promise.resolve(userId ? (this.users.get(userId) ?? null) : null);
  }

  public linkOAuthIdentity(
    userId: string,
    provider: string,
    providerUserId: string,
  ): Promise<void> {
    this.oauthIdentities.set(`${provider}:${providerUserId}`, userId);
    return Promise.resolve();
  }

  public createSession(input: CreateSessionInput): Promise<SessionEntity> {
    const now = new Date();
    const user = this.users.get(input.userId);
    const session: SessionEntity = {
      id: randomUUID(),
      userId: input.userId,
      token: input.token,
      expiresAt: input.expiresAt,
      createdAt: now,
      user,
    };
    this.sessions.set(session.token, session);
    return Promise.resolve(session);
  }

  public findSessionByToken(token: string): Promise<SessionEntity | null> {
    const session = this.sessions.get(token);
    if (!session) {
      return Promise.resolve(null);
    }
    const user = this.users.get(session.userId);
    return Promise.resolve({ ...session, user });
  }

  public deleteSessionByToken(token: string): Promise<void> {
    this.sessions.delete(token);
    return Promise.resolve();
  }

  public deleteExpiredSessions(now: Date = new Date()): Promise<number> {
    let deleted = 0;
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt.getTime() <= now.getTime()) {
        this.sessions.delete(token);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}
