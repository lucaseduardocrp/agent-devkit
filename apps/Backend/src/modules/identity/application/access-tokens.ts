import { createHash, randomBytes } from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import type { AuthRepository, UserEntity } from './auth-repository.js';

/** `full` acts with the user's permissions; `read` is limited to safe HTTP methods. */
export type AccessTokenScope = 'full' | 'read';

export interface AccessTokenEntity {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  /** SHA-256 of the secret; the secret itself is never stored. */
  readonly tokenHash: string;
  /** First characters of the secret, shown so users can recognise a token. */
  readonly tokenPrefix: string;
  readonly scope: AccessTokenScope;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateAccessTokenRecord {
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
  readonly scope: AccessTokenScope;
  readonly expiresAt: Date | null;
}

export interface AccessTokenRepository {
  create(input: CreateAccessTokenRecord): Promise<AccessTokenEntity>;
  listByUser(userId: string): Promise<readonly AccessTokenEntity[]>;
  findByHash(tokenHash: string): Promise<AccessTokenEntity | null>;
  touch(id: string, usedAt: Date): Promise<void>;
  revoke(id: string, userId: string, revokedAt: Date): Promise<boolean>;
}

export interface AccessTokenView {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scope: AccessTokenScope;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface VerifiedAccessToken {
  readonly user: UserEntity;
  readonly scope: AccessTokenScope;
}

export const ACCESS_TOKEN_PREFIX = 'adk_pat_';
const MAX_TOKENS_PER_USER = 50;
const LAST_USED_RESOLUTION_MS = 60_000;

export function isAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

export function hashAccessToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toAccessTokenView(token: AccessTokenEntity): AccessTokenView {
  return {
    id: token.id,
    name: token.name,
    tokenPrefix: token.tokenPrefix,
    scope: token.scope,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

/**
 * Personal access tokens: long-lived, named, revocable credentials for MCP clients and scripts.
 * Only a hash is persisted and the secret is returned once, at creation.
 */
export class AccessTokenService {
  public constructor(
    private readonly tokens: AccessTokenRepository,
    private readonly users: Pick<AuthRepository, 'findById'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    userId: string,
    input: { name: string; scope: AccessTokenScope; expiresInDays: number | null },
  ): Promise<{ token: string; accessToken: AccessTokenView }> {
    const active = (await this.tokens.listByUser(userId)).filter((token) => this.isActive(token));
    if (active.length >= MAX_TOKENS_PER_USER) {
      throw new ApplicationError(
        'ACCESS_TOKEN_LIMIT_REACHED',
        `A user can hold at most ${MAX_TOKENS_PER_USER} active access tokens.`,
        409,
      );
    }
    const secret = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt =
      input.expiresInDays === null
        ? null
        : new Date(this.now().getTime() + input.expiresInDays * 24 * 60 * 60 * 1000);
    const record = await this.tokens.create({
      userId,
      name: input.name.trim(),
      tokenHash: hashAccessToken(secret),
      tokenPrefix: secret.slice(0, ACCESS_TOKEN_PREFIX.length + 6),
      scope: input.scope,
      expiresAt,
    });
    return { token: secret, accessToken: toAccessTokenView(record) };
  }

  public async list(userId: string): Promise<readonly AccessTokenView[]> {
    return (await this.tokens.listByUser(userId))
      .filter((token) => this.isActive(token))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toAccessTokenView);
  }

  public async revoke(userId: string, id: string): Promise<void> {
    if (!(await this.tokens.revoke(id, userId, this.now()))) {
      throw new ApplicationError('ACCESS_TOKEN_NOT_FOUND', 'Access token not found.', 404);
    }
  }

  public async verify(token: string): Promise<VerifiedAccessToken | null> {
    if (!isAccessToken(token)) return null;
    const record = await this.tokens.findByHash(hashAccessToken(token));
    if (!record || !this.isActive(record)) return null;
    const user = await this.users.findById(record.userId);
    if (!user) return null;
    const now = this.now();
    if (
      !record.lastUsedAt ||
      now.getTime() - record.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
    ) {
      await this.tokens.touch(record.id, now);
    }
    return { user, scope: record.scope };
  }

  private isActive(token: AccessTokenEntity): boolean {
    return (
      !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > this.now().getTime())
    );
  }
}
