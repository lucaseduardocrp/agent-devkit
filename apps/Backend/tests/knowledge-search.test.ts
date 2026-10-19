import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgeSearch } from '../src/modules/knowledge/application/knowledge-search.js';

describe('InMemoryKnowledgeSearch', () => {
  const search = new InMemoryKnowledgeSearch([
    {
      ownerId: 'owner-1',
      chunk: {
        source: 'wiki',
        pageId: 'page-1',
        chunkIndex: 0,
        content: 'Knowledge about testing',
        createdAt: '2026-09-10T00:00:00Z',
      },
    },
    {
      ownerId: 'owner-2',
      chunk: {
        source: 'wiki',
        pageId: 'page-2',
        chunkIndex: 0,
        content: 'Knowledge from another owner',
        createdAt: '2026-09-10T00:00:00Z',
      },
    },
  ]);

  it('returns matching chunks for the owner', async () => {
    await expect(
      search.search('TESTING', { requestId: 'request-1', ownerId: 'owner-1' }),
    ).resolves.toHaveLength(1);
  });

  it('does not return chunks from another owner', async () => {
    await expect(
      search.search('knowledge', { requestId: 'request-1', ownerId: 'owner-3' }),
    ).resolves.toEqual([]);
  });

  it('requires explicit ownership', async () => {
    await expect(search.search('knowledge', { requestId: 'request-1' })).rejects.toMatchObject({
      code: 'OWNER_CONTEXT_REQUIRED',
    });
    await expect(
      search.search('knowledge', { requestId: 'request-1', ownerId: ' ' }),
    ).rejects.toMatchObject({ code: 'OWNER_CONTEXT_REQUIRED' });
  });

  it('rejects empty search prompt', async () => {
    await expect(
      search.search('   ', { requestId: 'request-1', ownerId: 'owner-1' }),
    ).rejects.toMatchObject({ code: 'SEARCH_PROMPT_REQUIRED' });
  });

  it('matches multi-line feature prompt and groups page chunks by index', async () => {
    const multiSearch = new InMemoryKnowledgeSearch([
      {
        ownerId: 'owner-1',
        chunk: {
          source: 'https://wiki.example.com/Rules%20Page',
          pageId: 'page-10',
          chunkIndex: 1,
          content: 'Second part of rules',
          createdAt: '2026-09-10T00:00:00Z',
        },
      },
      {
        ownerId: 'owner-1',
        chunk: {
          source: 'https://wiki.example.com/Rules%20Page',
          pageId: 'page-10',
          chunkIndex: 0,
          content: 'First part of rules',
          createdAt: '2026-09-10T00:00:00Z',
        },
      },
      {
        ownerId: 'owner-1',
        chunk: {
          source: 'invalid-%-uri',
          pageId: 'page-11',
          chunkIndex: 0,
          content: 'Other content mentioning rules',
          createdAt: '2026-09-10T00:00:00Z',
        },
      },
    ]);

    const results = await multiSearch.search(
      'Rules Page\nescreva todos os testes sobre essa feature',
      { requestId: 'request-1', ownerId: 'owner-1' },
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.pageId).toBe('page-10');
    expect(results[0]?.chunkIndex).toBe(0);
    expect(results[1]?.chunkIndex).toBe(1);
    expect(results.some((chunk) => chunk.pageId === 'page-11')).toBe(false);
  });

  it('handles prompt consisting purely of generic command words', async () => {
    const results = await search.search('escreva testes', {
      requestId: 'request-1',
      ownerId: 'owner-1',
    });
    expect(results).toBeDefined();
  });

  it('handles multi-line queries with accented phrases on subsequent lines', async () => {
    const results = await search.search(
      'Rules Page\nConfiguração de Notificação\nescreva os testes',
      { requestId: 'request-1', ownerId: 'owner-1' },
    );
    expect(results).toBeDefined();
  });
});
