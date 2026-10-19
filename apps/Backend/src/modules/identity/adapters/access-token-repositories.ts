import { randomUUID } from 'node:crypto';
import type {
  AccessTokenEntity,
  AccessTokenRepository,
  AccessTokenScope,
  CreateAccessTokenRecord,
} from '../application/access-tokens.js';

export class InMemoryAccessTokenRepository implements AccessTokenRepository {
  private readonly tokens = new Map<string, AccessTokenEntity>();

  public create(input: CreateAccessTokenRecord): Promise<AccessTokenEntity> {
    const record: AccessTokenEntity = {
      ...input,
      id: randomUUID(),
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date(),
    };
    this.tokens.set(record.id, record);
    return Promise.resolve(record);
  }

  public listByUser(userId: string): Promise<readonly AccessTokenEntity[]> {
    return Promise.resolve([...this.tokens.values()].filter((token) => token.userId === userId));
  }

  public findByHash(tokenHash: string): Promise<AccessTokenEntity | null> {
    return Promise.resolve(
      [...this.tokens.values()].find((token) => token.tokenHash === tokenHash) ?? null,
    );
  }

  public touch(id: string, usedAt: Date): Promise<void> {
    const token = this.tokens.get(id);
    if (token) this.tokens.set(id, { ...token, lastUsedAt: usedAt });
    return Promise.resolve();
  }

  public revoke(id: string, userId: string, revokedAt: Date): Promise<boolean> {
    const token = this.tokens.get(id);
    if (!token || token.userId !== userId || token.revokedAt) return Promise.resolve(false);
    this.tokens.set(id, { ...token, revokedAt });
    return Promise.resolve(true);
  }
}

interface AccessTokenRow extends Omit<AccessTokenEntity, 'scope'> {
  readonly scope: string;
}

interface AccessTokenDelegate {
  create(arguments_: { data: CreateAccessTokenRecord }): Promise<AccessTokenRow>;
  findMany(arguments_: { where: { userId: string } }): Promise<AccessTokenRow[]>;
  findUnique(arguments_: { where: { tokenHash: string } }): Promise<AccessTokenRow | null>;
  update(arguments_: { where: { id: string }; data: { lastUsedAt: Date } }): Promise<unknown>;
  updateMany(arguments_: {
    where: { id: string; userId: string; revokedAt: null };
    data: { revokedAt: Date };
  }): Promise<{ count: number }>;
}

export interface PrismaAccessTokenClient {
  readonly personalAccessTokenRecord: AccessTokenDelegate;
}

const toEntity = (row: AccessTokenRow): AccessTokenEntity => ({
  ...row,
  scope: row.scope === 'read' ? 'read' : ('full' satisfies AccessTokenScope),
});

export class PrismaAccessTokenRepository implements AccessTokenRepository {
  public constructor(private readonly client: PrismaAccessTokenClient) {}

  public async create(input: CreateAccessTokenRecord): Promise<AccessTokenEntity> {
    return toEntity(await this.client.personalAccessTokenRecord.create({ data: input }));
  }

  public async listByUser(userId: string): Promise<readonly AccessTokenEntity[]> {
    return (await this.client.personalAccessTokenRecord.findMany({ where: { userId } })).map(
      toEntity,
    );
  }

  public async findByHash(tokenHash: string): Promise<AccessTokenEntity | null> {
    const row = await this.client.personalAccessTokenRecord.findUnique({ where: { tokenHash } });
    return row ? toEntity(row) : null;
  }

  public async touch(id: string, usedAt: Date): Promise<void> {
    await this.client.personalAccessTokenRecord.update({
      where: { id },
      data: { lastUsedAt: usedAt },
    });
  }

  public async revoke(id: string, userId: string, revokedAt: Date): Promise<boolean> {
    const result = await this.client.personalAccessTokenRecord.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count > 0;
  }
}
