import type { RequestContext } from '../../../shared/context.js';
import { ApplicationError } from '../../../shared/errors.js';
import { requireOwnerId } from './ownership.js';
import type { KnowledgeChunk } from '../domain/knowledge-chunk.js';
import { analyzeSearchPrompt, scoreKnowledgeChunk } from './search-matcher.js';

export interface KnowledgeSearchPort {
  search(prompt: string, context: RequestContext): Promise<readonly KnowledgeChunk[]>;
}

export interface OwnedKnowledgeChunk {
  readonly ownerId: string;
  readonly chunk: KnowledgeChunk;
}

export class InMemoryKnowledgeSearch implements KnowledgeSearchPort {
  public constructor(private readonly chunks: readonly OwnedKnowledgeChunk[] = []) {}

  public search(prompt: string, context: RequestContext): Promise<readonly KnowledgeChunk[]> {
    return Promise.resolve().then(() => {
      const ownerId = requireOwnerId(context);
      const analysis = analyzeSearchPrompt(prompt);
      if (!analysis.rawPrompt) {
        throw new ApplicationError('SEARCH_PROMPT_REQUIRED', 'A search prompt is required.', 400, [
          { field: 'prompt' },
        ]);
      }

      const scored = this.chunks
        .filter((entry) => entry.ownerId === ownerId)
        .map((entry) => ({
          chunk: entry.chunk,
          score: scoreKnowledgeChunk(entry.chunk, analysis),
        }))
        .filter((entry) => entry.score >= 20);

      scored.sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex);

      if (!scored.length) return [];
      // The best page is returned whole, then the other matching chunks.
      const topPageId = scored[0]!.chunk.pageId;
      const topPageChunks = this.chunks
        .filter((entry) => entry.ownerId === ownerId && entry.chunk.pageId === topPageId)
        .map((entry) => entry.chunk)
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      const otherChunks = scored.filter((item) => item.chunk.pageId !== topPageId);
      return [...topPageChunks, ...otherChunks.map((item) => item.chunk)];
    });
  }
}
