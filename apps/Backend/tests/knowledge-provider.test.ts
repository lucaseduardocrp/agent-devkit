import { describe, expect, it, vi } from 'vitest';
import {
  chunkPage,
  InMemoryKnowledgeChunkRepository,
  synchronizeKnowledge,
  type KnowledgeContentProvider,
} from '../src/modules/knowledge/application/knowledge-provider.js';
import { DeterministicEmbedding } from '../src/modules/knowledge/application/embedding.js';

describe('knowledge synchronization', () => {
  const provider: KnowledgeContentProvider = {
    name: 'fixture',
    listPages: async () => [
      { id: 'page-1', source: 'wiki', content: 'abcdef', updatedAt: '2026-09-10' },
    ],
  };

  it('chunks pages deterministically', () => {
    expect(
      chunkPage({ id: 'p', source: 's', content: 'abcdef', updatedAt: 'now' }, 2),
    ).toHaveLength(3);
    expect(() => chunkPage({ id: 'p', source: 's', content: 'x', updatedAt: 'now' }, 0)).toThrow(
      'Chunk size must be positive.',
    );
    expect(chunkPage({ id: 'p', source: 's', content: '', updatedAt: 'now' })).toEqual([]);
  });

  it('saves synchronized chunks idempotently', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'request-1', ownerId: 'owner-1' };
    await expect(synchronizeKnowledge(provider, repository, context)).resolves.toEqual({
      chunksCount: 1,
      archived: [],
    });
    await expect(synchronizeKnowledge(provider, repository, context)).resolves.toEqual({
      chunksCount: 1,
      archived: [],
    });
    await expect(repository.all(context)).resolves.toHaveLength(1);
  });

  it('manages normalized workspace-scoped document correlations', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'relations', ownerId: 'owner-1' };
    for (const pageId of ['page-a', 'page-b']) {
      await repository.replacePage(
        { id: pageId, source: `wiki://${pageId}` },
        [{ pageId, source: `wiki://${pageId}`, chunkIndex: 0, content: pageId, createdAt: 'now' }],
        context,
      );
    }
    await repository.addRelation('page-b', 'page-a', context);
    await repository.addRelation('page-a', 'page-b', context);
    await expect(repository.listRelations(context)).resolves.toMatchObject([
      { sourcePageId: 'page-a', targetPageId: 'page-b' },
    ]);
    await expect(
      repository.listRelations({ requestId: 'other', ownerId: 'owner-2' }),
    ).resolves.toEqual([]);
    await expect(repository.addRelation('page-a', 'page-a', context)).rejects.toMatchObject({
      code: 'INVALID_KNOWLEDGE_RELATION',
    });
    await expect(repository.addRelation('page-a', 'missing', context)).rejects.toMatchObject({
      code: 'KNOWLEDGE_DOCUMENT_NOT_FOUND',
    });
    await repository.deleteRelation('page-b', 'page-a', context);
    await expect(repository.listRelations(context)).resolves.toEqual([]);
    await repository.addRelation('page-a', 'page-b', context);
    await repository.deletePage({ id: 'page-b', source: 'wiki://page-b' }, context);
    await expect(repository.listRelations(context)).resolves.toEqual([]);
  });

  it('moves provider-owned pages missing remotely to application notes', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'deletion-sync', ownerId: 'owner-1' };
    await repository.replacePage(
      { id: 'deleted', source: 'https://dev.azure.com/wiki?pagePath=%2FDeleted' },
      [
        {
          pageId: 'deleted',
          source: 'https://dev.azure.com/wiki?pagePath=%2FDeleted',
          chunkIndex: 0,
          content: '# Preserved\n\nold',
          createdAt: 'old',
        },
      ],
      context,
    );
    await repository.replacePage(
      { id: 'local', source: 'app://local?title=Local' },
      [
        {
          pageId: 'local',
          source: 'app://local?title=Local',
          chunkIndex: 0,
          content: 'keep',
          createdAt: 'now',
        },
      ],
      context,
    );
    await repository.addRelation('deleted', 'local', context);
    await repository.replacePage(
      { id: 'path-title', source: 'https://dev.azure.com/wiki?pagePath=%2FFrom%20Path' },
      [
        {
          pageId: 'path-title',
          source: 'https://dev.azure.com/wiki?pagePath=%2FFrom%20Path',
          chunkIndex: 0,
          content: 'without heading',
          createdAt: 'old',
        },
      ],
      context,
    );
    await repository.replacePage(
      { id: 'fallback-id', source: 'azure-owned' },
      [
        {
          pageId: 'fallback-id',
          source: 'azure-owned',
          chunkIndex: 0,
          content: 'without title',
          createdAt: 'old',
        },
      ],
      context,
    );
    await repository.replacePage(
      { id: 'no-path', source: 'https://dev.azure.com/wiki' },
      [
        {
          pageId: 'no-path',
          source: 'https://dev.azure.com/wiki',
          chunkIndex: 0,
          content: 'without path',
          createdAt: 'old',
        },
      ],
      context,
    );
    await repository.replacePage(
      { id: 'remote-kept', source: 'https://dev.azure.com/wiki?pagePath=%2FKept' },
      [
        {
          pageId: 'remote-kept',
          source: 'https://dev.azure.com/wiki?pagePath=%2FKept',
          chunkIndex: 0,
          content: 'current',
          createdAt: 'old',
        },
      ],
      context,
    );

    const result = await synchronizeKnowledge(
      {
        name: 'azure',
        listPages: async () => [
          {
            id: 'remote-kept',
            source: 'https://dev.azure.com/wiki?pagePath=%2FKept',
            content: 'current',
            updatedAt: 'now',
          },
        ],
        ownsSource: (source) => source.includes('azure'),
      },
      repository,
      context,
    );

    expect(result.archived).toEqual(
      expect.arrayContaining([
        {
          pageId: 'deleted',
          oldSource: 'https://dev.azure.com/wiki?pagePath=%2FDeleted',
          newSource: 'app://local?title=Preserved',
        },
      ]),
    );

    const synchronized = await repository.all(context);
    expect(synchronized).toHaveLength(6);
    expect(synchronized).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pageId: 'deleted',
          source: 'app://local?title=Preserved',
          content: '# Preserved\n\nold',
        }),
        expect.objectContaining({
          pageId: 'path-title',
          source: 'app://local?title=From%20Path',
        }),
        expect.objectContaining({
          pageId: 'fallback-id',
          source: 'app://local?title=fallback-id',
        }),
        expect.objectContaining({
          pageId: 'no-path',
          source: 'app://local?title=no-path',
        }),
        expect.objectContaining({
          pageId: 'remote-kept',
          source: 'https://dev.azure.com/wiki?pagePath=%2FKept',
          content: 'current',
        }),
        expect.objectContaining({ pageId: 'local' }),
      ]),
    );
    await expect(repository.listRelations(context)).resolves.toMatchObject([
      { sourcePageId: 'deleted', targetPageId: 'local' },
    ]);
  });

  it('reconciles a published local page with the Azure page ID on pull', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'reconcile', ownerId: 'owner-1' };
    await repository.replacePage(
      { id: 'doc-local', source: 'https://dev.azure.com/wiki?pagePath=%2FNote' },
      [
        {
          pageId: 'doc-local',
          source: 'https://dev.azure.com/wiki?pagePath=%2FNote',
          chunkIndex: 0,
          content: '# Note',
          createdAt: 'now',
        },
      ],
      context,
    );
    const reconciled = await synchronizeKnowledge(
      {
        name: 'azure',
        ownsSource: (source) => source.includes('dev.azure.com'),
        listPages: async () => [
          {
            id: '42',
            source: 'https://dev.azure.com/wiki?pagePath=%2FNote',
            content: '# Note',
            updatedAt: 'now',
          },
        ],
      },
      repository,
      context,
    );
    expect(reconciled.archived).toEqual([]);
    expect((await repository.all(context)).map((chunk) => chunk.pageId)).toEqual(['42']);
  });

  it('replaces a legacy Azure source with its canonical hierarchical URL on pull', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'canonical-source', ownerId: 'owner-1' };
    await repository.replacePage(
      { id: '42', source: 'https://dev.azure.com/wiki/42' },
      [
        {
          pageId: '42',
          source: 'https://dev.azure.com/wiki/42',
          chunkIndex: 0,
          content: '# Child',
          createdAt: 'old',
        },
      ],
      context,
    );
    const reconciled = await synchronizeKnowledge(
      {
        name: 'azure',
        ownsSource: (source) => source.includes('dev.azure.com'),
        listPages: async () => [
          {
            id: '42',
            source: 'https://dev.azure.com/wiki/42?pagePath=%2FParent%2FChild',
            content: '# Child',
            updatedAt: 'now',
          },
        ],
      },
      repository,
      context,
    );
    expect(reconciled.archived).toEqual([]);

    const chunks = await repository.all(context);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.source).toContain('pagePath=%2FParent%2FChild');
  });

  it('archives missing pages and retains every remote page when a legacy Azure source is shared', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'shared-legacy-source', ownerId: 'owner-1' };
    const legacySource = 'azure-devops:dev.azure.com';
    for (const pageId of ['remote-1', 'remote-2', 'removed-1', 'removed-2']) {
      await repository.replacePage(
        { id: pageId, source: legacySource },
        [
          {
            pageId,
            source: legacySource,
            chunkIndex: 0,
            content: `# ${pageId}`,
            createdAt: 'old',
          },
        ],
        context,
      );
    }

    const reconciled = await synchronizeKnowledge(
      {
        name: 'azure',
        ownsSource: (source) => source === legacySource,
        listPages: async () => [
          {
            id: 'remote-1',
            source: legacySource,
            content: '# remote-1 updated',
            updatedAt: 'now',
          },
          {
            id: 'remote-2',
            source: legacySource,
            content: '# remote-2 updated',
            updatedAt: 'now',
          },
        ],
      },
      repository,
      context,
    );

    expect(reconciled.archived).toHaveLength(2);
    expect(reconciled.archived.map((item) => item.pageId).sort()).toEqual([
      'removed-1',
      'removed-2',
    ]);
    const chunks = await repository.all(context);
    expect(
      chunks
        .filter((chunk) => chunk.source === legacySource)
        .map((chunk) => chunk.pageId)
        .sort(),
    ).toEqual(['remote-1', 'remote-2']);
    expect(
      chunks
        .filter((chunk) => chunk.source.startsWith('app://local'))
        .map((chunk) => chunk.pageId)
        .sort(),
    ).toEqual(['removed-1', 'removed-2']);
  });

  it('atomically replaces a page and isolates owners', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const ownerOne = { requestId: 'request-1', ownerId: 'owner-1' };
    const ownerTwo = { requestId: 'request-2', ownerId: 'owner-2' };
    const page = { id: 'page-1', source: 'wiki' };
    const chunks = [
      { source: 'wiki', pageId: 'page-1', chunkIndex: 0, content: 'a', createdAt: 'now' },
      { source: 'wiki', pageId: 'page-1', chunkIndex: 1, content: 'b', createdAt: 'now' },
    ];

    await repository.replacePage(page, chunks, ownerOne);
    await repository.replacePage(page, chunks.slice(0, 1), ownerOne);
    await repository.replacePage(page, chunks, ownerTwo);

    await expect(repository.all(ownerOne)).resolves.toEqual(chunks.slice(0, 1));
    await expect(repository.all(ownerTwo)).resolves.toEqual(chunks);

    await repository.deletePage(page, ownerOne);
    await expect(repository.all(ownerOne)).resolves.toEqual([]);
    await expect(repository.all(ownerTwo)).resolves.toEqual(chunks);
  });

  it('moves verified pages and preserves correlations in memory', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { requestId: 'move-page', ownerId: 'owner-1' };
    await repository.replacePage(
      { id: 'local', source: 'app://local?title=Local' },
      [
        {
          source: 'app://local?title=Local',
          pageId: 'local',
          chunkIndex: 0,
          content: '# Local',
          createdAt: 'old',
        },
      ],
      context,
    );
    await repository.replacePage(
      { id: 'related', source: 'app://local?title=Related' },
      [
        {
          source: 'app://local?title=Related',
          pageId: 'related',
          chunkIndex: 0,
          content: '# Related',
          createdAt: 'old',
        },
      ],
      context,
    );
    for (const id of ['aaa', 'unrelated-a', 'unrelated-b']) {
      await repository.replacePage(
        { id, source: `app://local?title=${id}` },
        [
          {
            source: `app://local?title=${id}`,
            pageId: id,
            chunkIndex: 0,
            content: `# ${id}`,
            createdAt: 'old',
          },
        ],
        context,
      );
    }
    const foreignContext = { requestId: 'request-2', ownerId: 'owner-2' };
    for (const id of ['foreign-a', 'foreign-b']) {
      await repository.replacePage(
        { id, source: `app://local?title=${id}` },
        [
          {
            source: `app://local?title=${id}`,
            pageId: id,
            chunkIndex: 0,
            content: `# ${id}`,
            createdAt: 'old',
          },
        ],
        foreignContext,
      );
    }
    await repository.addRelation('local', 'related', context);
    await repository.addRelation('aaa', 'local', context);
    await repository.addRelation('unrelated-a', 'unrelated-b', context);
    await repository.addRelation('foreign-a', 'foreign-b', foreignContext);
    const verifiedPage = {
      id: '51',
      source: 'https://dev.azure.com/wiki?pagePath=%2FLocal',
      content: '# Local',
      updatedAt: 'now',
    };
    await repository.movePages(
      [
        {
          previous: { id: 'local', source: 'app://local?title=Local' },
          page: verifiedPage,
          chunks: chunkPage(verifiedPage),
        },
      ],
      context,
    );

    expect((await repository.all(context)).map((item) => item.pageId).sort()).toEqual([
      '51',
      'aaa',
      'related',
      'unrelated-a',
      'unrelated-b',
    ]);
    await expect(repository.listRelations(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePageId: '51', targetPageId: 'related' }),
        expect.objectContaining({ sourcePageId: '51', targetPageId: 'aaa' }),
        expect.objectContaining({ sourcePageId: 'unrelated-a', targetPageId: 'unrelated-b' }),
      ]),
    );
    await expect(
      repository.movePages(
        [
          {
            previous: { id: '51', source: verifiedPage.source },
            page: verifiedPage,
            chunks: [{ ...chunkPage(verifiedPage)[0]!, source: 'wrong' }],
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_KNOWLEDGE_CHUNK' });

    const selfRelationRepository = new InMemoryKnowledgeChunkRepository();
    for (const id of ['first', 'second']) {
      await selfRelationRepository.replacePage(
        { id, source: `app://local?title=${id}` },
        [
          {
            source: `app://local?title=${id}`,
            pageId: id,
            chunkIndex: 0,
            content: `# ${id}`,
            createdAt: 'old',
          },
        ],
        context,
      );
    }
    await selfRelationRepository.addRelation('first', 'second', context);
    const sharedPage = {
      id: 'shared',
      source: 'https://dev.azure.com/wiki?pagePath=%2FShared',
      content: '# Shared',
      updatedAt: 'now',
    };
    await selfRelationRepository.movePages(
      [
        {
          previous: { id: 'first', source: 'app://local?title=First' },
          page: sharedPage,
          chunks: chunkPage(sharedPage),
        },
        {
          previous: { id: 'second', source: 'app://local?title=Second' },
          page: sharedPage,
          chunks: chunkPage(sharedPage),
        },
      ],
      context,
    );
    await expect(selfRelationRepository.listRelations(context)).resolves.toEqual([]);
  });

  it('rejects absent ownership and chunks from another page', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const page = { id: 'page-1', source: 'wiki' };
    await expect(repository.all({ requestId: 'request-1' })).rejects.toMatchObject({
      code: 'OWNER_CONTEXT_REQUIRED',
    });
    await expect(
      repository.replacePage(
        page,
        [{ source: 'other', pageId: 'page-1', chunkIndex: 0, content: 'a', createdAt: 'now' }],
        { requestId: 'request-1', ownerId: 'owner-1' },
      ),
    ).rejects.toThrow('must belong');
    await expect(repository.all({ requestId: 'request-1', ownerId: 'owner-1' })).resolves.toEqual(
      [],
    );
  });

  it('creates deterministic embeddings and rejects empty input', async () => {
    const embedding = new DeterministicEmbedding();
    await expect(embedding.embed('abc')).resolves.toEqual([97, 98, 99]);
    await expect(embedding.embed(' ')).rejects.toThrow('Text is required for embedding.');
  });
});

describe('sync identity transitions', () => {
  it('preserves correlations across canonical identity migration and archival', async () => {
    const repository = new InMemoryKnowledgeChunkRepository();
    const context = { ownerId: 'sync-owner', requestId: 'sync' };
    const old = {
      id: 'old',
      source: 'https://example.com/wiki?pagePath=/Note',
      content: '# Note',
      updatedAt: '2026-09-16',
    };
    const local = {
      id: 'local',
      source: 'app://local?title=Related',
      content: '# Related',
      updatedAt: old.updatedAt,
    };
    await repository.replacePage(old, chunkPage(old), context);
    await repository.replacePage(local, chunkPage(local), context);
    await repository.addRelation(old.id, local.id, context);
    const remote = { ...old, id: 'new', content: '# Updated' };
    const provider = {
      name: 'wiki',
      ownsSource: (source: string) => source.startsWith('https://example.com'),
      listPages: async () => [remote],
    };
    const before = await repository.all(context);
    vi.spyOn(repository, 'movePages').mockRejectedValueOnce(new Error('Storage failure'));
    await expect(synchronizeKnowledge(provider, repository, context)).rejects.toThrow(
      'Storage failure',
    );
    expect(await repository.all(context)).toEqual(before);
    await synchronizeKnowledge(provider, repository, context);
    expect(await repository.listRelations(context)).toMatchObject([
      { sourcePageId: 'local', targetPageId: 'new' },
    ]);
    expect((await repository.all(context)).some((chunk) => chunk.pageId === 'old')).toBe(false);
    const beforeArchive = await repository.all(context);
    vi.spyOn(repository, 'movePages').mockRejectedValueOnce(new Error('Archive failure'));
    const empty = { ...provider, listPages: async () => [] };
    await expect(synchronizeKnowledge(empty, repository, context)).rejects.toThrow(
      'Archive failure',
    );
    expect(await repository.all(context)).toEqual(beforeArchive);
    await synchronizeKnowledge(empty, repository, context);
    expect(await repository.listRelations(context)).toMatchObject([
      { sourcePageId: 'local', targetPageId: 'new' },
    ]);
    expect((await repository.all(context)).find((chunk) => chunk.pageId === 'new')?.source).toBe(
      'app://local?title=Updated',
    );
  });
});
