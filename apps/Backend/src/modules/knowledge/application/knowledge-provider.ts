import type { RequestContext } from '../../../shared/context.js';
import { ApplicationError } from '../../../shared/errors.js';
import { requireOwnerId } from './ownership.js';
import type { KnowledgeChunk } from '../domain/knowledge-chunk.js';

export interface KnowledgePage {
  readonly id: string;
  readonly source: string;
  readonly content: string;
  readonly updatedAt: string;
}

export interface KnowledgeContentProvider {
  readonly name: string;
  listPages(context: RequestContext): Promise<readonly KnowledgePage[]>;
  ownsSource?(source: string): boolean;
}

export interface KnowledgeChunkRepository {
  replacePage(
    page: Readonly<Pick<KnowledgePage, 'id' | 'source'>>,
    chunks: readonly KnowledgeChunk[],
    context: RequestContext,
  ): Promise<void>;
  deletePage(
    page: Readonly<Pick<KnowledgePage, 'id' | 'source'>>,
    context: RequestContext,
  ): Promise<void>;
  movePages(moves: readonly KnowledgePageMove[], context: RequestContext): Promise<void>;
  all(context: RequestContext): Promise<readonly KnowledgeChunk[]>;
  listRelations(context: RequestContext): Promise<readonly KnowledgeRelation[]>;
  addRelation(sourcePageId: string, targetPageId: string, context: RequestContext): Promise<void>;
  deleteRelation(
    sourcePageId: string,
    targetPageId: string,
    context: RequestContext,
  ): Promise<void>;
}

export interface KnowledgePageMove {
  readonly previous: Readonly<Pick<KnowledgePage, 'id' | 'source'>>;
  readonly page: KnowledgePage;
  readonly chunks: readonly KnowledgeChunk[];
}

export interface KnowledgeRelation {
  readonly sourcePageId: string;
  readonly targetPageId: string;
  readonly createdAt: string;
}

export interface KnowledgeSynchronizationResult {
  readonly chunksCount: number;
  readonly archived: readonly {
    readonly pageId: string;
    readonly oldSource: string;
    readonly newSource: string;
  }[];
}

export class InMemoryKnowledgeChunkRepository implements KnowledgeChunkRepository {
  private readonly chunks = new Map<string, { ownerId: string; chunk: KnowledgeChunk }>();
  private readonly relations = new Map<string, KnowledgeRelation>();

  public listRelations(context: RequestContext): Promise<readonly KnowledgeRelation[]> {
    const ownerId = requireOwnerId(context);
    return Promise.resolve(
      [...this.relations.entries()]
        .filter(([key]) => key.startsWith(`${ownerId}:`))
        .map(([, relation]) => relation),
    );
  }

  public async addRelation(sourcePageId: string, targetPageId: string, context: RequestContext) {
    const ownerId = requireOwnerId(context);
    validateRelation(sourcePageId, targetPageId, await this.all(context));
    const [source, target] = normalizeRelation(sourcePageId, targetPageId);
    this.relations.set(`${ownerId}:${source}:${target}`, {
      sourcePageId: source,
      targetPageId: target,
      createdAt: new Date().toISOString(),
    });
  }

  public deleteRelation(sourcePageId: string, targetPageId: string, context: RequestContext) {
    const ownerId = requireOwnerId(context);
    const [source, target] = normalizeRelation(sourcePageId, targetPageId);
    this.relations.delete(`${ownerId}:${source}:${target}`);
    return Promise.resolve();
  }

  public async deletePage(
    page: Readonly<Pick<KnowledgePage, 'id' | 'source'>>,
    context: RequestContext,
  ): Promise<void> {
    await this.replacePage(page, [], context);
    const ownerId = requireOwnerId(context);
    for (const [key, relation] of this.relations.entries()) {
      if (
        key.startsWith(`${ownerId}:`) &&
        (relation.sourcePageId === page.id || relation.targetPageId === page.id)
      ) {
        this.relations.delete(key);
      }
    }
  }

  public async movePages(
    moves: readonly KnowledgePageMove[],
    context: RequestContext,
  ): Promise<void> {
    const ownerId = requireOwnerId(context);
    for (const move of moves) {
      if (
        move.chunks.some(
          (chunk) => chunk.source !== move.page.source || chunk.pageId !== move.page.id,
        )
      ) {
        throw new ApplicationError(
          'INVALID_KNOWLEDGE_CHUNK',
          'Knowledge chunks must belong to the moved page.',
          400,
        );
      }
    }

    const idMap = new Map(moves.map((move) => [move.previous.id, move.page.id]));
    for (const move of moves) {
      await this.replacePage(move.previous, [], context);
      await this.replacePage(move.page, move.chunks, context);
    }
    const affected = [...this.relations.entries()].filter(
      ([key, relation]) =>
        key.startsWith(`${ownerId}:`) &&
        (idMap.has(relation.sourcePageId) || idMap.has(relation.targetPageId)),
    );
    for (const [key] of affected) this.relations.delete(key);
    for (const [, relation] of affected) {
      const sourcePageId = idMap.get(relation.sourcePageId) ?? relation.sourcePageId;
      const targetPageId = idMap.get(relation.targetPageId) ?? relation.targetPageId;
      if (sourcePageId === targetPageId) continue;
      const [source, target] = normalizeRelation(sourcePageId, targetPageId);
      this.relations.set(`${ownerId}:${source}:${target}`, {
        sourcePageId: source,
        targetPageId: target,
        createdAt: relation.createdAt,
      });
    }
  }

  public replacePage(
    page: Readonly<Pick<KnowledgePage, 'id' | 'source'>>,
    chunks: readonly KnowledgeChunk[],
    context: RequestContext,
  ): Promise<void> {
    return Promise.resolve().then(() => {
      const ownerId = requireOwnerId(context);
      if (chunks.some((chunk) => chunk.source !== page.source || chunk.pageId !== page.id)) {
        throw new ApplicationError(
          'INVALID_KNOWLEDGE_CHUNK',
          'Knowledge chunks must belong to the replaced page.',
          400,
        );
      }
      const pagePrefix = `${ownerId}:${page.source}:${page.id}:`;
      for (const key of this.chunks.keys()) {
        if (key.startsWith(pagePrefix)) {
          this.chunks.delete(key);
        }
      }
      for (const chunk of chunks) {
        this.chunks.set(`${pagePrefix}${chunk.chunkIndex}`, { ownerId, chunk });
      }
    });
  }

  public all(context: RequestContext): Promise<readonly KnowledgeChunk[]> {
    return Promise.resolve().then(() => {
      const ownerId = requireOwnerId(context);
      return [...this.chunks.values()]
        .filter((entry) => entry.ownerId === ownerId)
        .map((entry) => entry.chunk);
    });
  }
}

export const normalizeRelation = (sourcePageId: string, targetPageId: string) =>
  sourcePageId.localeCompare(targetPageId) <= 0
    ? ([sourcePageId, targetPageId] as const)
    : ([targetPageId, sourcePageId] as const);

export function validateRelation(
  sourcePageId: string,
  targetPageId: string,
  chunks: readonly KnowledgeChunk[],
): void {
  if (!sourcePageId.trim() || !targetPageId.trim() || sourcePageId === targetPageId) {
    throw new ApplicationError('INVALID_KNOWLEDGE_RELATION', 'Invalid document correlation.', 400);
  }
  const ids = new Set(chunks.map((chunk) => chunk.pageId));
  if (!ids.has(sourcePageId) || !ids.has(targetPageId)) {
    throw new ApplicationError(
      'KNOWLEDGE_DOCUMENT_NOT_FOUND',
      'Knowledge document not found.',
      404,
    );
  }
}

export function chunkPage(page: KnowledgePage, chunkSize = 500): KnowledgeChunk[] {
  if (chunkSize < 1) {
    throw new RangeError('Chunk size must be positive.');
  }

  const chunks: KnowledgeChunk[] = [];
  for (let offset = 0, index = 0; offset < page.content.length; offset += chunkSize, index += 1) {
    chunks.push({
      source: page.source,
      pageId: page.id,
      chunkIndex: index,
      content: page.content.slice(offset, offset + chunkSize),
      createdAt: page.updatedAt,
    });
  }

  return chunks;
}

function archivedPageSource(page: Pick<KnowledgePage, 'id' | 'source'>, content: string): string {
  const headingTitle = content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim();
  let sourceTitle: string | undefined;
  try {
    const source = new URL(page.source);
    const pagePath = source.searchParams.get('pagePath');
    sourceTitle = pagePath?.split('/').filter(Boolean).at(-1);
    sourceTitle = sourceTitle ? decodeURIComponent(sourceTitle) : undefined;
  } catch {
    // Non-URL providers fall back to the stable page ID.
  }
  const title = headingTitle || sourceTitle || page.id;
  return `app://local?title=${encodeURIComponent(title)}`;
}

function isCanonicalPageSource(source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function synchronizeKnowledge(
  provider: KnowledgeContentProvider,
  repository: KnowledgeChunkRepository,
  context: RequestContext,
): Promise<KnowledgeSynchronizationResult> {
  const pages = await provider.listPages(context);
  const stored = await repository.all(context);
  const archived: KnowledgeSynchronizationResult['archived'][number][] = [];
  if (provider.ownsSource) {
    const remoteKeys = new Set(pages.map((page) => `${page.source}:${page.id}`));
    const remoteIds = new Set(pages.map((page) => page.id));
    const canonicalRemoteSources = new Set(
      pages.filter((page) => isCanonicalPageSource(page.source)).map((page) => page.source),
    );
    const storedPages = new Map<string, KnowledgeChunk[]>();
    for (const chunk of stored) {
      if (provider.ownsSource(chunk.source)) {
        const key = `${chunk.source}:${chunk.pageId}`;
        const pageChunks = storedPages.get(key) ?? [];
        pageChunks.push(chunk);
        storedPages.set(key, pageChunks);
      }
    }
    for (const [key, storedChunks] of storedPages) {
      const storedPage = storedChunks[0]!;
      if (
        remoteKeys.has(key) ||
        remoteIds.has(storedPage.pageId) ||
        (isCanonicalPageSource(storedPage.source) && canonicalRemoteSources.has(storedPage.source))
      )
        continue;
      const orderedChunks = [...storedChunks].sort(
        (left, right) => left.chunkIndex - right.chunkIndex,
      );
      const content = orderedChunks.map((chunk) => chunk.content).join('');
      const previous = orderedChunks[0]!;
      const archivedPage: KnowledgePage = {
        id: previous.pageId,
        source: archivedPageSource({ id: previous.pageId, source: previous.source }, content),
        content,
        updatedAt: previous.createdAt,
      };
      await repository.movePages(
        [
          {
            previous: { id: previous.pageId, source: previous.source },
            page: archivedPage,
            chunks: chunkPage(archivedPage),
          },
        ],
        context,
      );
      archived.push({
        pageId: previous.pageId,
        oldSource: previous.source,
        newSource: archivedPage.source,
      });
    }
  }
  let chunkCount = 0;
  for (const page of pages) {
    const existing = stored.find(
      (chunk) =>
        (isCanonicalPageSource(page.source) &&
          chunk.source === page.source &&
          chunk.pageId !== page.id) ||
        (chunk.pageId === page.id && chunk.source !== page.source),
    );
    const chunks = chunkPage(page);
    if (existing) {
      await repository.movePages(
        [{ previous: { id: existing.pageId, source: existing.source }, page, chunks }],
        context,
      );
    } else {
      await repository.replacePage(page, chunks, context);
    }
    chunkCount += chunks.length;
  }
  return { chunksCount: chunkCount, archived };
}
