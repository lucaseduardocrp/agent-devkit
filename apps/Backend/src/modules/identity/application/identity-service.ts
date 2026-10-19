import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';

export interface UserIdentity {
  readonly id: string;
  readonly email: string;
}

export interface IdentityPort {
  register(email: string, password: string): Promise<UserIdentity>;
  authenticate(email: string, password: string): Promise<UserIdentity>;
  authorize(context: RequestContext, ownerId: string): void;
}

interface StoredUser extends UserIdentity {
  readonly passwordHash: string;
}

export class InMemoryIdentityService implements IdentityPort {
  private readonly users = new Map<string, StoredUser>();

  public register(email: string, password: string): Promise<UserIdentity> {
    return Promise.resolve().then(() => {
      const normalizedEmail = normalizeEmail(email);
      validatePassword(password);
      if (this.users.has(normalizedEmail)) {
        throw new ApplicationError('IDENTITY_EXISTS', 'An account already exists.', 409);
      }

      const user = { id: randomUUID(), email: normalizedEmail, passwordHash: hash(password) };
      this.users.set(normalizedEmail, user);
      return publicIdentity(user);
    });
  }

  public authenticate(email: string, password: string): Promise<UserIdentity> {
    return Promise.resolve().then(() => {
      const user = this.users.get(normalizeEmail(email));
      if (!user || user.passwordHash !== hash(password)) {
        throw new ApplicationError('INVALID_CREDENTIALS', 'Invalid credentials.', 401);
      }

      return publicIdentity(user);
    });
  }

  public authorize(context: RequestContext, ownerId: string): void {
    if (!context.actorId || context.actorId !== ownerId) {
      throw new ApplicationError('FORBIDDEN', 'Access denied.', 403);
    }
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes('@')) {
    throw new ApplicationError('VALID_EMAIL_REQUIRED', 'A valid email is required.', 400, [
      { field: 'email' },
    ]);
  }

  return normalized;
}

function validatePassword(password: string): void {
  if (password.length < 8) {
    throw new ApplicationError(
      'PASSWORD_TOO_SHORT',
      'Password must contain at least 8 characters.',
      400,
      [{ field: 'password', minimum: 8 }],
    );
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicIdentity(user: StoredUser): UserIdentity {
  return { id: user.id, email: user.email };
}

export function createOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}
