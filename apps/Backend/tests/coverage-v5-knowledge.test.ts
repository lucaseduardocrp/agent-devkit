import { describe, expect, it, vi } from 'vitest';
import {
  auditedRepositories,
  MemoryAuditPersistence,
  type AuditRepositories,
} from '../src/modules/audit/audit.js';
import {
  PrismaKnowledgeSearch,
  type PrismaKnowledgeClient,
} from '../src/modules/knowledge/adapters/prisma-knowledge.js';
import { AzureDevOpsWikiProvider } from '../src/modules/knowledge/adapters/wiki-providers.js';
import {
  chunkPage,
  InMemoryKnowledgeChunkRepository,
  synchronizeKnowledge,
} from '../src/modules/knowledge/application/knowledge-provider.js';
import { InMemoryKnowledgeSearch } from '../src/modules/knowledge/application/knowledge-search.js';
import { analyzeSearchPrompt } from '../src/modules/knowledge/application/search-matcher.js';
import { InMemorySpecRepository } from '../src/modules/spec/application/spec-service.js';
import { InMemorySavedTestPlanStore } from '../src/modules/testplans/application/saved-test-plans.js';

const context = { ownerId: 'ws', workspaceId: 'ws', actorId: 'alice', requestId: 'r' };
const page = (id: string, content = `Content of ${id}`) => ({
  id,
  source: `app://local?title=${id}`,
  content,
  updatedAt: '2026-09-16T12:00:00Z',
});

describe('knowledge relations', () => {
  it('records a document snapshot with its relations in a stable order', async () => {
    const raw: AuditRepositories = {
      knowledge: new InMemoryKnowledgeChunkRepository(),
      specs: new InMemorySpecRepository(),
      tests: new InMemorySavedTestPlanStore(),
    };
    const persistence = new MemoryAuditPersistence(raw);
    const repo = auditedRepositories(raw, persistence);
    for (const id of ['a', 'c', 'b'])
      await repo.knowledge.replacePage(page(id), chunkPage(page(id)), context);
    await repo.knowledge.addRelation('a', 'c', context);
    await repo.knowledge.addRelation('a', 'b', context);
    const { items } = await persistence.list({
      workspaceId: 'ws',
      entityType: 'document',
      offset: 0,
      limit: 50,
    });
    const relations = items
      .map((item) => (item.after as { relations?: unknown[] } | null)?.relations ?? [])
      .find((list) => list.length === 2);
    expect(relations).toEqual([
      { sourcePageId: 'a', targetPageId: 'b' },
      { sourcePageId: 'a', targetPageId: 'c' },
    ]);
  });

  it('keeps the relations of other pages when a page is deleted', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    for (const id of ['a', 'b', 'c'])
      await repository.replacePage(page(id), chunkPage(page(id)), context);
    await repository.addRelation('a', 'b', context);
    await repository.addRelation('b', 'c', context);
    await repository.deletePage(page('c'), context);
    expect(await repository.listRelations(context)).toEqual([
      expect.objectContaining({ sourcePageId: 'a', targetPageId: 'b' }),
    ]);
  });
});

describe('knowledge synchronization', () => {
  it('archives a removed multi-chunk page with its chunks in order', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const removed = {
      id: 'gone',
      source: 'https://dev.azure.com/wiki?pagePath=%2FGone',
      content: 'abcdef',
      updatedAt: 'old',
    };
    await repository.replacePage(removed, chunkPage(removed, 2).reverse(), context);
    const result = await synchronizeKnowledge(
      { name: 'azure', listPages: async () => [], ownsSource: () => true },
      repository,
      context,
    );
    expect(result.archived).toHaveLength(1);
    const archived = await repository.all(context);
    expect(archived.map((chunk) => chunk.content).join('')).toContain('abcdef');
  });
});

describe('knowledge search across pages', () => {
  const chunk = (pageId: string, chunkIndex: number, content: string) => ({
    source: `wiki-${pageId}`,
    pageId,
    chunkIndex,
    content,
    createdAt: '2026-09-10T00:00:00Z',
  });

  it('returns the best page whole, then matches from other pages', async () => {
    const search = new InMemoryKnowledgeSearch([
      { ownerId: 'o', chunk: chunk('p1', 0, 'checkout checkout flow') },
      { ownerId: 'o', chunk: chunk('p1', 1, 'unrelated tail') },
      { ownerId: 'o', chunk: chunk('p2', 0, 'checkout notes') },
    ]);
    const result = await search.search('checkout', { requestId: 'r', ownerId: 'o' });
    expect(result.map((item) => `${item.pageId}:${item.chunkIndex}`)).toEqual([
      'p1:0',
      'p1:1',
      'p2:0',
    ]);
    await expect(search.search('nothing here', { requestId: 'r', ownerId: 'o' })).resolves.toEqual(
      [],
    );
  });

  it('does the same against the database', async () => {
    const record = (pageId: string, chunkIndex: number, content: string) => ({
      ownerId: 'o',
      ...chunk(pageId, chunkIndex, content),
      createdAt: new Date('2026-09-10T00:00:00Z'),
    });
    const records = [
      record('p2', 0, 'checkout notes'),
      record('p1', 0, 'checkout flow'),
      record('p1', 1, 'unrelated tail'),
    ];
    const findMany = vi.fn(async ({ where }: { where: { pageId?: string; OR?: unknown[] } }) =>
      where.pageId
        ? records.filter((item) => item.pageId === where.pageId)
        : records.filter((item) => item.content.includes('checkout')),
    );
    const client = {
      knowledgeChunkRecord: { findMany },
      knowledgeRelationRecord: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaKnowledgeClient;
    const result = await new PrismaKnowledgeSearch(client).search('checkout', {
      requestId: 'r',
      ownerId: 'o',
    });
    const top = result[0]!.pageId;
    const other = top === 'p1' ? 'p2' : 'p1';
    expect(new Set(result.map((item) => item.pageId))).toEqual(new Set(['p1', 'p2']));
    expect(result.at(-1)?.pageId).toBe(other);
    expect(findMany.mock.calls[0]![0].where.OR).toEqual(
      expect.arrayContaining([{ content: { contains: 'checkout', mode: 'insensitive' } }]),
    );
  });

  it('keeps each search token once', () => {
    expect(analyzeSearchPrompt('login depois login').tokens).toEqual(['login', 'depois']);
  });
});

describe('Azure DevOps wiki listing', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it.each([
    ['the pages endpoint fails', () => json({}, 404)],
    ['the pages endpoint has no page list', () => json({ value: [] })],
    [
      'the pages endpoint is unreachable',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('falls back to the wiki tree when %s', async (_case, pagesResponse) => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/_apis/wiki/pages?') ? pagesResponse() : json({ value: [] }),
    );
    const provider = new AzureDevOpsWikiProvider({
      baseUrl: 'https://dev.azure.com/example',
      token: 'token',
      fetcher: fetcher,
    });
    await expect(provider.listPages(context)).resolves.toEqual([]);
    expect(String(fetcher.mock.calls[1]![0])).toContain('/_apis/wiki/wikis?');
  });
});
