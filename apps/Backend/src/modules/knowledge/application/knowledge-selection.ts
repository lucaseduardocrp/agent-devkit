import type { KnowledgeChunk } from '../domain/knowledge-chunk.js';

/** One Brain document, with the excerpts of it that are handed to the model. */
export interface KnowledgeExcerpt {
  readonly source: string;
  readonly title: string;
  readonly content: string;
}

export interface KnowledgeSelectionOptions {
  /** Most distinct documents that may reach the model. */
  readonly maxDocuments?: number;
  /** Most characters of Brain text, summed over every document. */
  readonly maxChars?: number;
}

/** Chunks are 500 characters each, so this is about 48 chunks (~6k tokens) of Brain text. */
export const DEFAULT_KNOWLEDGE_MAX_CHARS = 24_000;
export const DEFAULT_KNOWLEDGE_MAX_DOCUMENTS = 6;
const GAP_MARKER = '\n[…]\n';

/** Readable name of a Brain source: the `title` of an `app://local?title=…` URL, else the source. */
export function knowledgeTitle(source: string): string {
  const match = /[?&]title=([^&#]*)/.exec(source);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1].replace(/\+/g, ' '));
    } catch {
      return match[1];
    }
  }
  return source;
}

/**
 * Turns the ranked chunks of a search into a few documents to show the model.
 *
 * The search ranks chunks, with every chunk of the best page first. Cutting that list at a fixed
 * number of chunks lets one long page use the whole allowance, so a question such as "what do you
 * know about approval?" would only ever see one document, and cut it short. Here the allowance is
 * counted in characters and shared: every selected document first gets an equal part, then what is
 * left over goes to the documents in rank order. Each document keeps its chunks in reading order.
 */
export function selectKnowledgeDocuments(
  chunks: readonly KnowledgeChunk[],
  options: KnowledgeSelectionOptions = {},
): KnowledgeExcerpt[] {
  const maxDocuments = Math.max(1, options.maxDocuments ?? DEFAULT_KNOWLEDGE_MAX_DOCUMENTS);
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_KNOWLEDGE_MAX_CHARS);

  const byPage = new Map<string, Map<number, KnowledgeChunk>>();
  for (const chunk of chunks) {
    const key = `${chunk.source}\u0000${chunk.pageId}`;
    const page = byPage.get(key) ?? new Map<number, KnowledgeChunk>();
    if (!page.has(chunk.chunkIndex)) page.set(chunk.chunkIndex, chunk);
    byPage.set(key, page);
  }

  const documents = [...byPage.values()].slice(0, maxDocuments).map((page) => ({
    source: [...page.values()][0]!.source,
    pending: [...page.values()].sort((a, b) => a.chunkIndex - b.chunkIndex),
    taken: [] as KnowledgeChunk[],
  }));
  if (documents.length === 0) return [];

  let used = 0;
  const take = (document: (typeof documents)[number], limit: number): void => {
    while (document.pending.length > 0) {
      const next = document.pending[0]!;
      const fits = used + next.content.length <= limit;
      // A document always shows its first chunk, so a long chunk cannot hide it entirely.
      if (!fits && document.taken.length > 0) return;
      if (!fits && used >= maxChars) return;
      document.pending.shift();
      document.taken.push(next);
      used += next.content.length;
    }
  };

  const share = Math.floor(maxChars / documents.length);
  for (const document of documents) {
    const before = used;
    take(document, before + share);
  }
  for (const document of documents) take(document, maxChars);

  return documents
    .filter((document) => document.taken.length > 0)
    .map((document) => {
      const ordered = [...document.taken].sort((a, b) => a.chunkIndex - b.chunkIndex);
      const content = ordered.reduce(
        (text, chunk, index) =>
          index === 0
            ? chunk.content
            : `${text}${chunk.chunkIndex === ordered[index - 1]!.chunkIndex + 1 ? '' : GAP_MARKER}${chunk.content}`,
        '',
      );
      return { source: document.source, title: knowledgeTitle(document.source), content };
    });
}
