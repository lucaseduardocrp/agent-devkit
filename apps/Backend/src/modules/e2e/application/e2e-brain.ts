import type { RequestContext } from '../../../shared/context.js';
import type { KnowledgeSearchPort } from '../../knowledge/application/knowledge-search.js';
import type { KnowledgeChunk } from '../../knowledge/domain/knowledge-chunk.js';
import type { E2eCreation } from '../domain/e2e.js';

/** Most characters of Brain text handed to the AI for one task. */
export const MAX_BRAIN_CHARACTERS = 60_000;
const MAX_BRAIN_PAGES = 12;
const MAX_QUERIES = 8;
const MAX_QUERY_LENGTH = 500;

/** One Brain document (or the part of it found by the search) given to the AI as knowledge. */
export interface E2eBrainDocument {
  readonly title: string;
  /** Exact source of the document, so answers can cite it. */
  readonly source: string;
  readonly content: string;
}

function documentTitle(chunks: readonly KnowledgeChunk[]): string {
  const first = chunks[0]!;
  try {
    const url = new URL(first.source);
    const title = url.searchParams.get('title');
    if (title) return title;
    const path = url.searchParams.get('pagePath');
    if (path) return decodeURIComponent(path).split('/').filter(Boolean).at(-1) ?? first.pageId;
  } catch {
    // Not a URL: the page id or the first heading names it.
  }
  return first.content.match(/^#\s+([^\r\n]+)/)?.[1]?.trim() || first.pageId;
}

/** Search texts for a task: the longest text first, as the full question, then its pieces. */
export function brainQueries(...texts: readonly (string | null | undefined)[]): string[] {
  const queries = new Set<string>();
  for (const text of texts) {
    const trimmed = text?.replace(/\s+/g, ' ').trim();
    if (trimmed) queries.add(trimmed.slice(0, MAX_QUERY_LENGTH));
  }
  return [...queries].slice(0, MAX_QUERIES);
}

/**
 * Looks the queries up in the Brain. The search ranks documents by relevance and also returns
 * the documents correlated (linked) with the best match, so a feature's rules, flows and the
 * pages tied to them reach the AI together. Chunks are merged back into whole documents.
 */
export async function searchBrain(
  search: KnowledgeSearchPort,
  creation: Pick<E2eCreation, 'id' | 'ownerId' | 'workspaceId' | 'actorId' | 'locale'>,
  queries: readonly string[],
  signal?: AbortSignal,
): Promise<E2eBrainDocument[]> {
  const context: RequestContext = {
    requestId: `e2e-brain-${creation.id}`,
    ownerId: creation.ownerId,
    workspaceId: creation.workspaceId,
    actorId: creation.actorId,
    ...(signal ? { signal } : {}),
  };
  const byPage = new Map<string, Map<number, KnowledgeChunk>>();
  const order: string[] = [];
  for (const query of queries) {
    let found: readonly KnowledgeChunk[];
    try {
      found = await search.search(query, context);
    } catch (error) {
      // One failed lookup must not stop the others; the caller sees what was found.
      console.error('[E2eBrain] Brain search failed:', error);
      continue;
    }
    for (const chunk of found) {
      const key = `${chunk.source}:${chunk.pageId}`;
      let chunks = byPage.get(key);
      if (!chunks) {
        chunks = new Map();
        byPage.set(key, chunks);
        order.push(key);
      }
      chunks.set(chunk.chunkIndex, chunk);
    }
  }
  const documents: E2eBrainDocument[] = [];
  let characters = 0;
  for (const key of order.slice(0, MAX_BRAIN_PAGES)) {
    const chunks = [...byPage.get(key)!.values()].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const room = MAX_BRAIN_CHARACTERS - characters;
    if (room <= 0) break;
    const content = chunks
      .map((chunk) => chunk.content)
      .join('')
      .slice(0, room);
    characters += content.length;
    documents.push({ title: documentTitle(chunks), source: chunks[0]!.source, content });
  }
  return documents;
}

/** Brain lookups of a Source go in batches: each batch brings up to a dozen documents. */
const SOURCE_QUERY_BATCH = 4;
const MAX_SOURCE_QUERIES = 24;
export const MAX_SOURCE_DOCUMENTS = 40;
const MAX_SOURCE_DOCUMENT_CHARACTERS = 6_000;

/** General questions that bring the documents describing the system as a whole. */
const SYSTEM_QUERIES = [
  'visão geral do sistema: objetivo, módulos, perfis de usuário e permissões',
  'system overview: features, user flows and business rules',
  'fluxos de usuário, regras de negócio e validações',
];

/**
 * What the Brain knows about the whole system: the general questions first, then one lookup per
 * screen the agent discovered. Each document is kept once, in the order it was found.
 */
export async function searchSourceBrain(
  search: KnowledgeSearchPort,
  creation: Pick<E2eCreation, 'id' | 'ownerId' | 'workspaceId' | 'actorId' | 'locale'>,
  pages: readonly { readonly title: string }[],
  signal?: AbortSignal,
): Promise<E2eBrainDocument[]> {
  const queries = [
    ...SYSTEM_QUERIES,
    ...new Set(pages.map((page) => page.title.trim()).filter(Boolean)),
  ].slice(0, MAX_SOURCE_QUERIES);
  const documents: E2eBrainDocument[] = [];
  const seen = new Set<string>();
  for (let from = 0; from < queries.length; from += SOURCE_QUERY_BATCH) {
    const found = await searchBrain(
      search,
      creation,
      queries.slice(from, from + SOURCE_QUERY_BATCH),
      signal,
    );
    for (const document of found) {
      if (seen.has(document.source) || documents.length >= MAX_SOURCE_DOCUMENTS) continue;
      seen.add(document.source);
      documents.push({
        ...document,
        content: document.content.slice(0, MAX_SOURCE_DOCUMENT_CHARACTERS),
      });
    }
  }
  return documents;
}

/** Tells the AI what the Brain excerpts are and how far to trust them. */
export const BRAIN_RULES = [
  'The product knowledge comes from the Brain, the workspace knowledge base (field brainKnowledge: documents found by semantic search and the documents linked to them). Treat it as the product specification.',
  'Use only facts stated in brainKnowledge and the snapshot; when a flow or rule is not documented there, do not invent it. Prefer the document whose title matches the feature under test.',
];

/** What the AI receives for a run that uses the Brain. */
export const brainContext = (documents: readonly E2eBrainDocument[]) => ({
  brainKnowledge: documents,
});
