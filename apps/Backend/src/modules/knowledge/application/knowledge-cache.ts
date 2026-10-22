import { createHash } from 'node:crypto';
import type { Cache } from '../../../shared/cache.js';
import type { RequestContext } from '../../../shared/context.js';
import type { KnowledgeChunkRepository } from './knowledge-provider.js';
import type { KnowledgeSearchPort } from './knowledge-search.js';
import { requireOwnerId } from './ownership.js';

const TTL_SECONDS = 60 * 60;

/** Cache scope of a workspace's Brain: every write to its pages or relations invalidates it. */
function scope(context: RequestContext): string {
  return `knowledge:${requireOwnerId(context)}`;
}

/**
 * Serves the Brain's reads from the cache: the document list, its stats and relation checks
 * all read every chunk. Wrap the outermost repository (the audited one), which every write
 * goes through.
 */
export function cachedKnowledgeRepository(
  repository: KnowledgeChunkRepository,
  cache: Cache,
): KnowledgeChunkRepository {
  const after = async (context: RequestContext, write: Promise<void>): Promise<void> => {
    await write;
    await cache.invalidate(scope(context));
  };
  return {
    all: (context) =>
      cache.json(scope(context), 'chunks', TTL_SECONDS, () => repository.all(context)),
    listRelations: (context) =>
      cache.json(scope(context), 'relations', TTL_SECONDS, () => repository.listRelations(context)),
    replacePage: (page, chunks, context) =>
      after(context, repository.replacePage(page, chunks, context)),
    deletePage: (page, context) => after(context, repository.deletePage(page, context)),
    movePages: (moves, context) => after(context, repository.movePages(moves, context)),
    addRelation: (sourcePageId, targetPageId, context) =>
      after(context, repository.addRelation(sourcePageId, targetPageId, context)),
    deleteRelation: (sourcePageId, targetPageId, context) =>
      after(context, repository.deleteRelation(sourcePageId, targetPageId, context)),
  };
}

/**
 * Brain searches from the cache, dropped with the rest of the workspace's Brain on any write
 * (through {@link cachedKnowledgeRepository} on the same cache). Agents search on every run.
 */
export function cachedKnowledgeSearch(
  search: KnowledgeSearchPort,
  cache: Cache,
): KnowledgeSearchPort {
  return {
    search: (prompt, context) =>
      cache.json(
        scope(context),
        `search:${createHash('sha256').update(prompt).digest('hex')}`,
        // Prompts vary a lot; results stay briefly so repeated lookups reuse them.
        10 * 60,
        () => search.search(prompt, context),
      ),
  };
}
