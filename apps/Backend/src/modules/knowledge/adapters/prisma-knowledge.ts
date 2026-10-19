import type { RequestContext } from '../../../shared/context.js';
import { ApplicationError } from '../../../shared/errors.js';
import {
  normalizeRelation,
  validateRelation,
  type KnowledgeChunkRepository,
  type KnowledgePage,
  type KnowledgePageMove,
  type KnowledgeRelation,
} from '../application/knowledge-provider.js';
import type { KnowledgeSearchPort } from '../application/knowledge-search.js';
import { requireOwnerId } from '../application/ownership.js';
import type { KnowledgeChunk } from '../domain/knowledge-chunk.js';
import {
  toKnowledgeChunk,
  toKnowledgeChunkRecord,
  type KnowledgeChunkRecordData,
} from './knowledge-chunk-mapper.js';
import { analyzeSearchPrompt, scoreKnowledgeChunk } from '../application/search-matcher.js';

interface KnowledgeChunkDelegate {
  deleteMany(arguments_: {
    where: { ownerId: string; source: string; pageId: string };
  }): Promise<unknown>;
  createMany(arguments_: { data: readonly KnowledgeChunkRecordData[] }): Promise<unknown>;
  findMany(arguments_: {
    where: {
      ownerId: string;
      pageId?: string;
      content?: { contains: string; mode: 'insensitive' };
      source?: { contains: string; mode: 'insensitive' };
      OR?: readonly Record<string, unknown>[];
    };
    orderBy: readonly Record<string, 'asc'>[];
  }): Promise<readonly KnowledgeChunkRecordData[]>;
}

interface PrismaKnowledgeTransaction {
  readonly knowledgeChunkRecord: KnowledgeChunkDelegate;
  readonly knowledgeRelationRecord?: KnowledgeRelationDelegate;
}

interface KnowledgeRelationDelegate {
  findMany(arguments_: { where: { ownerId: string } }): Promise<
    readonly {
      sourcePageId: string;
      targetPageId: string;
      createdAt: Date;
    }[]
  >;
  upsert(arguments_: {
    where: {
      ownerId_sourcePageId_targetPageId: {
        ownerId: string;
        sourcePageId: string;
        targetPageId: string;
      };
    };
    create: { ownerId: string; sourcePageId: string; targetPageId: string; createdAt?: Date };
    update: Record<string, never>;
  }): Promise<unknown>;
  deleteMany(arguments_: {
    where: {
      ownerId: string;
      sourcePageId?: string;
      targetPageId?: string;
      OR?: readonly ({ sourcePageId: string } | { targetPageId: string })[];
    };
  }): Promise<unknown>;
}

export interface PrismaKnowledgeClient extends PrismaKnowledgeTransaction {
  $transaction<T>(
    operation: (transaction: PrismaKnowledgeTransaction) => Promise<T>,
    options: { isolationLevel: 'Serializable' },
  ): Promise<T>;
}

interface PrismaKnowledgeRepositoryOptions {
  readonly maxTransactionAttempts?: number;
  readonly waitBeforeRetry?: (attempt: number) => Promise<void>;
}

const orderBy = [{ source: 'asc' }, { pageId: 'asc' }, { chunkIndex: 'asc' }] as const;

export class PrismaKnowledgeRepository implements KnowledgeChunkRepository {
  private readonly maxTransactionAttempts: number;
  private readonly waitBeforeRetry: (attempt: number) => Promise<void>;

  public constructor(
    private readonly client: PrismaKnowledgeClient,
    options: PrismaKnowledgeRepositoryOptions = {},
  ) {
    this.maxTransactionAttempts = options.maxTransactionAttempts ?? 3;
    this.waitBeforeRetry = options.waitBeforeRetry ?? defaultRetryDelay;
  }

  public async replacePage(
    page: Readonly<Pick<KnowledgePage, 'id' | 'source'>>,
    chunks: readonly KnowledgeChunk[],
    context: RequestContext,
  ): Promise<void> {
    const ownerId = requireOwnerId(context);
    const records = chunks.map((chunk) => {
      if (chunk.source !== page.source || chunk.pageId !== page.id) {
        throw new ApplicationError(
          'INVALID_KNOWLEDGE_CHUNK',
          'Knowledge chunks must belong to the replaced page.',
          400,
        );
      }
      return toKnowledgeChunkRecord(chunk, ownerId);
    });

    for (let attempt = 1; attempt <= this.maxTransactionAttempts; attempt += 1) {
      try {
        await this.client.$transaction(
          async (transaction) => {
            await transaction.knowledgeChunkRecord.deleteMany({
              where: { ownerId, source: page.source, pageId: page.id },
            });
            if (records.length > 0) {
              await transaction.knowledgeChunkRecord.createMany({ data: records });
            }
          },
          { isolationLevel: 'Serializable' },
        );
        return;
      } catch (error) {
        if (isConcurrencyError(error) && attempt < this.maxTransactionAttempts) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw normalizePersistenceError(error);
      }
    }
  }

  public async deletePage(
    page: Readonly<Pick<KnowledgePage, 'id' | 'source'>>,
    context: RequestContext,
  ): Promise<void> {
    const ownerId = requireOwnerId(context);
    for (let attempt = 1; attempt <= this.maxTransactionAttempts; attempt += 1) {
      try {
        await this.client.$transaction(
          async (transaction) => {
            await transaction.knowledgeChunkRecord.deleteMany({
              where: { ownerId, source: page.source, pageId: page.id },
            });
            await transaction.knowledgeRelationRecord!.deleteMany({
              where: { ownerId, OR: [{ sourcePageId: page.id }, { targetPageId: page.id }] },
            });
          },
          { isolationLevel: 'Serializable' },
        );
        return;
      } catch (error) {
        if (isConcurrencyError(error) && attempt < this.maxTransactionAttempts) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw normalizePersistenceError(error);
      }
    }
  }

  public async movePages(
    moves: readonly KnowledgePageMove[],
    context: RequestContext,
  ): Promise<void> {
    const ownerId = requireOwnerId(context);
    const records = moves.flatMap((move) =>
      move.chunks.map((chunk) => {
        if (chunk.source !== move.page.source || chunk.pageId !== move.page.id) {
          throw new ApplicationError(
            'INVALID_KNOWLEDGE_CHUNK',
            'Knowledge chunks must belong to the moved page.',
            400,
          );
        }
        return toKnowledgeChunkRecord(chunk, ownerId);
      }),
    );
    const idMap = new Map(moves.map((move) => [move.previous.id, move.page.id]));

    for (let attempt = 1; attempt <= this.maxTransactionAttempts; attempt += 1) {
      try {
        await this.client.$transaction(
          async (transaction) => {
            const relations = await transaction.knowledgeRelationRecord!.findMany({
              where: { ownerId },
            });
            const affected = relations.filter(
              (relation) => idMap.has(relation.sourcePageId) || idMap.has(relation.targetPageId),
            );
            for (const move of moves) {
              await transaction.knowledgeChunkRecord.deleteMany({
                where: { ownerId, source: move.previous.source, pageId: move.previous.id },
              });
              await transaction.knowledgeChunkRecord.deleteMany({
                where: { ownerId, source: move.page.source, pageId: move.page.id },
              });
            }
            if (records.length > 0) {
              await transaction.knowledgeChunkRecord.createMany({ data: records });
            }
            for (const relation of affected) {
              await transaction.knowledgeRelationRecord!.deleteMany({
                where: {
                  ownerId,
                  sourcePageId: relation.sourcePageId,
                  targetPageId: relation.targetPageId,
                },
              });
              const sourcePageId = idMap.get(relation.sourcePageId) ?? relation.sourcePageId;
              const targetPageId = idMap.get(relation.targetPageId) ?? relation.targetPageId;
              if (sourcePageId === targetPageId) continue;
              const [source, target] = normalizeRelation(sourcePageId, targetPageId);
              await transaction.knowledgeRelationRecord!.upsert({
                where: {
                  ownerId_sourcePageId_targetPageId: {
                    ownerId,
                    sourcePageId: source,
                    targetPageId: target,
                  },
                },
                create: {
                  ownerId,
                  sourcePageId: source,
                  targetPageId: target,
                  createdAt: relation.createdAt,
                },
                update: {},
              });
            }
          },
          { isolationLevel: 'Serializable' },
        );
        return;
      } catch (error) {
        if (isConcurrencyError(error) && attempt < this.maxTransactionAttempts) {
          await this.waitBeforeRetry(attempt);
          continue;
        }
        throw normalizePersistenceError(error);
      }
    }
  }

  public async all(context: RequestContext): Promise<readonly KnowledgeChunk[]> {
    const ownerId = requireOwnerId(context);
    try {
      const records = await this.client.knowledgeChunkRecord.findMany({
        where: { ownerId },
        orderBy,
      });
      return records.map(toKnowledgeChunk);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }

  public async listRelations(context: RequestContext): Promise<readonly KnowledgeRelation[]> {
    const ownerId = requireOwnerId(context);
    const records = await this.client.knowledgeRelationRecord!.findMany({ where: { ownerId } });
    return records.map((record) => ({
      sourcePageId: record.sourcePageId,
      targetPageId: record.targetPageId,
      createdAt: record.createdAt.toISOString(),
    }));
  }

  public async addRelation(sourcePageId: string, targetPageId: string, context: RequestContext) {
    const ownerId = requireOwnerId(context);
    validateRelation(sourcePageId, targetPageId, await this.all(context));
    const [source, target] = normalizeRelation(sourcePageId, targetPageId);
    await this.client.knowledgeRelationRecord!.upsert({
      where: {
        ownerId_sourcePageId_targetPageId: {
          ownerId,
          sourcePageId: source,
          targetPageId: target,
        },
      },
      create: { ownerId, sourcePageId: source, targetPageId: target },
      update: {},
    });
  }

  public async deleteRelation(sourcePageId: string, targetPageId: string, context: RequestContext) {
    const ownerId = requireOwnerId(context);
    const [source, target] = normalizeRelation(sourcePageId, targetPageId);
    await this.client.knowledgeRelationRecord!.deleteMany({
      where: { ownerId, sourcePageId: source, targetPageId: target },
    });
  }
}

export class PrismaKnowledgeSearch implements KnowledgeSearchPort {
  public constructor(private readonly client: PrismaKnowledgeClient) {}

  public async search(prompt: string, context: RequestContext): Promise<readonly KnowledgeChunk[]> {
    const ownerId = requireOwnerId(context);
    const analysis = analyzeSearchPrompt(prompt);
    if (!analysis.rawPrompt) {
      throw new ApplicationError('SEARCH_PROMPT_REQUIRED', 'A search prompt is required.', 400, [
        { field: 'prompt' },
      ]);
    }
    try {
      const orFilters: Record<string, unknown>[] = [];
      if (analysis.cleanedPrompt) {
        orFilters.push({ content: { contains: analysis.cleanedPrompt, mode: 'insensitive' } });
        orFilters.push({ source: { contains: analysis.cleanedPrompt, mode: 'insensitive' } });
        const encoded = encodeURIComponent(analysis.cleanedPrompt);
        if (encoded !== analysis.cleanedPrompt) {
          orFilters.push({ source: { contains: encoded, mode: 'insensitive' } });
        }
      }
      for (const phrase of analysis.phrases) {
        orFilters.push({ content: { contains: phrase, mode: 'insensitive' } });
        orFilters.push({ source: { contains: phrase, mode: 'insensitive' } });
      }
      for (const token of analysis.tokens.slice(0, 8)) {
        orFilters.push({ content: { contains: token, mode: 'insensitive' } });
        orFilters.push({ source: { contains: token, mode: 'insensitive' } });
        const encoded = encodeURIComponent(token);
        if (encoded !== token) {
          orFilters.push({ source: { contains: encoded, mode: 'insensitive' } });
        }
      }

      const records = await this.client.knowledgeChunkRecord.findMany({
        where: {
          ownerId,
          OR: orFilters,
        },
        orderBy,
      });

      const scored = records
        .map((record) => ({
          chunk: toKnowledgeChunk(record),
          score: scoreKnowledgeChunk(record, analysis),
        }))
        .filter((item) => item.score >= 20);

      scored.sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex);

      const topPageId = scored[0]?.chunk.pageId;
      if (topPageId) {
        const allTopPageRecords = await this.client.knowledgeChunkRecord.findMany({
          where: { ownerId, pageId: topPageId },
          orderBy,
        });
        const topPageChunks = allTopPageRecords.map(toKnowledgeChunk);
        const otherChunks = scored
          .filter((item) => item.chunk.pageId !== topPageId)
          .map((item) => item.chunk);
        const relations = this.client.knowledgeRelationRecord
          ? await this.client.knowledgeRelationRecord.findMany({ where: { ownerId } })
          : [];
        const correlatedIds = relations.flatMap((relation) =>
          relation.sourcePageId === topPageId
            ? [relation.targetPageId]
            : relation.targetPageId === topPageId
              ? [relation.sourcePageId]
              : [],
        );
        const correlatedRecords = correlatedIds.length
          ? await this.client.knowledgeChunkRecord.findMany({
              where: { ownerId, OR: correlatedIds.map((pageId) => ({ pageId })) },
              orderBy,
            })
          : [];
        const known = new Set(
          [...topPageChunks, ...otherChunks].map((chunk) => `${chunk.pageId}:${chunk.chunkIndex}`),
        );
        return [
          ...topPageChunks,
          ...otherChunks,
          ...correlatedRecords
            .map(toKnowledgeChunk)
            .filter((chunk) => !known.has(`${chunk.pageId}:${chunk.chunkIndex}`)),
        ];
      }

      return scored.map((item) => item.chunk);
    } catch (error) {
      throw normalizePersistenceError(error);
    }
  }
}

export function createPrismaKnowledgeAdapters(client: unknown): {
  repository: KnowledgeChunkRepository;
  search: KnowledgeSearchPort;
} {
  const knowledgeClient = client as PrismaKnowledgeClient;
  return {
    repository: new PrismaKnowledgeRepository(knowledgeClient),
    search: new PrismaKnowledgeSearch(knowledgeClient),
  };
}

function isConcurrencyError(error: unknown): boolean {
  return getErrorCode(error) === 'P2002' || getErrorCode(error) === 'P2034';
}

function normalizePersistenceError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }
  const code = getErrorCode(error);
  if (code === 'P2002' || code === 'P2034') {
    return new ApplicationError(
      'KNOWLEDGE_WRITE_CONFLICT',
      'Knowledge could not be updated due to a concurrent request.',
      409,
    );
  }
  if ((code?.startsWith('P10') ?? false) || code === 'P2024') {
    return new ApplicationError(
      'KNOWLEDGE_UNAVAILABLE',
      'Knowledge storage is temporarily unavailable.',
      503,
    );
  }
  return new ApplicationError(
    'KNOWLEDGE_PERSISTENCE_ERROR',
    'Knowledge storage operation failed.',
    500,
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

function defaultRetryDelay(attempt: number): Promise<void> {
  const delayMilliseconds = attempt * (5 + Math.floor(Math.random() * 11));
  return new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
}
