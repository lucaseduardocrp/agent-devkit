import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '../src/shared/errors.js';
import {
  createPrismaKnowledgeAdapters,
  PrismaKnowledgeRepository,
  PrismaKnowledgeSearch,
  type PrismaKnowledgeClient,
} from '../src/modules/knowledge/adapters/prisma-knowledge.js';

const record = {
  ownerId: 'owner-1',
  source: 'wiki',
  pageId: 'page-1',
  chunkIndex: 0,
  content: 'Searchable content',
  createdAt: new Date('2026-09-11T10:00:00.000Z'),
};
const chunk = {
  source: record.source,
  pageId: record.pageId,
  chunkIndex: record.chunkIndex,
  content: record.content,
  createdAt: record.createdAt.toISOString(),
};
const context = { requestId: 'request-1', ownerId: 'owner-1' };
const page = { id: 'page-1', source: 'wiki' };

function createClient(records = [record]): {
  client: PrismaKnowledgeClient;
  deleteMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  relationFindMany: ReturnType<typeof vi.fn>;
  relationUpsert: ReturnType<typeof vi.fn>;
  relationDeleteMany: ReturnType<typeof vi.fn>;
} {
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const createMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockResolvedValue(records);
  const delegate = { deleteMany, createMany, findMany };
  const relationFindMany = vi.fn().mockResolvedValue([]);
  const relationUpsert = vi.fn().mockResolvedValue({});
  const relationDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const relationDelegate = {
    findMany: relationFindMany,
    upsert: relationUpsert,
    deleteMany: relationDeleteMany,
  };
  const transaction = vi.fn(async (operation: (value: unknown) => Promise<unknown>) =>
    operation({ knowledgeChunkRecord: delegate, knowledgeRelationRecord: relationDelegate }),
  );
  return {
    client: {
      knowledgeChunkRecord: delegate,
      knowledgeRelationRecord: relationDelegate,
      $transaction: transaction,
    } as PrismaKnowledgeClient,
    deleteMany,
    createMany,
    findMany,
    transaction,
    relationFindMany,
    relationUpsert,
    relationDeleteMany,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Prisma knowledge adapters', () => {
  it('persists, lists, removes, and expands document correlations', async () => {
    const secondRecord = { ...record, pageId: 'page-2', source: 'wiki-2', content: 'Related' };
    const fake = createClient([record, secondRecord]);
    fake.relationFindMany.mockResolvedValue([
      { sourcePageId: 'page-1', targetPageId: 'page-2', createdAt: new Date('2026-09-15') },
    ]);
    const repository = new PrismaKnowledgeRepository(fake.client);
    await repository.addRelation('page-2', 'page-1', context);
    await expect(repository.listRelations(context)).resolves.toMatchObject([
      { sourcePageId: 'page-1', targetPageId: 'page-2' },
    ]);
    await repository.deleteRelation('page-2', 'page-1', context);
    expect(fake.relationUpsert).toHaveBeenCalled();
    expect(fake.relationDeleteMany).toHaveBeenCalled();

    fake.relationFindMany.mockResolvedValue([
      { sourcePageId: 'page-1', targetPageId: 'page-2', createdAt: new Date('2026-09-15') },
      { sourcePageId: 'page-2', targetPageId: 'page-1', createdAt: new Date('2026-09-15') },
      { sourcePageId: 'page-3', targetPageId: 'page-4', createdAt: new Date('2026-09-15') },
    ]);

    fake.findMany
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce([secondRecord]);
    await expect(
      new PrismaKnowledgeSearch(fake.client).search('Searchable', context),
    ).resolves.toEqual([
      chunk,
      { ...chunk, source: 'wiki-2', pageId: 'page-2', content: 'Related' },
    ]);
  });

  it('searches normally when the relation storage is unavailable', async () => {
    const fake = createClient();
    const client = { ...fake.client, knowledgeRelationRecord: undefined };
    fake.findMany.mockResolvedValueOnce([record]).mockResolvedValueOnce([record]);

    await expect(new PrismaKnowledgeSearch(client).search('Searchable', context)).resolves.toEqual([
      chunk,
    ]);
  });
  it('replaces one explicitly owned page in a serializable transaction', async () => {
    const fake = createClient();
    const repository = new PrismaKnowledgeRepository(fake.client);

    await repository.replacePage(page, [chunk], context);

    expect(fake.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(fake.deleteMany).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1', source: 'wiki', pageId: 'page-1' },
    });
    expect(fake.createMany).toHaveBeenCalledWith({
      data: [{ ...record, ownerId: 'owner-1' }],
    });
  });

  it('deletes obsolete chunks without issuing an empty insert', async () => {
    const fake = createClient();
    await new PrismaKnowledgeRepository(fake.client).replacePage(page, [], context);
    expect(fake.deleteMany).toHaveBeenCalledOnce();
    expect(fake.createMany).not.toHaveBeenCalled();

    const fake2 = createClient();
    await new PrismaKnowledgeRepository(fake2.client).deletePage(page, context);
    expect(fake2.deleteMany).toHaveBeenCalledOnce();
    expect(fake2.createMany).not.toHaveBeenCalled();
    expect(fake2.relationDeleteMany).toHaveBeenCalledWith({
      where: {
        ownerId: 'owner-1',
        OR: [{ sourcePageId: 'page-1' }, { targetPageId: 'page-1' }],
      },
    });
  });

  it('atomically moves verified pages and remaps their correlations', async () => {
    const fake = createClient();
    fake.relationFindMany.mockResolvedValue([
      { sourcePageId: 'page-1', targetPageId: 'page-2', createdAt: new Date('2026-09-15') },
      { sourcePageId: 'page-1', targetPageId: '51', createdAt: new Date('2026-09-15') },
      { sourcePageId: 'aaa', targetPageId: 'page-1', createdAt: new Date('2026-09-15') },
      { sourcePageId: 'other-1', targetPageId: 'other-2', createdAt: new Date('2026-09-15') },
    ]);
    const repository = new PrismaKnowledgeRepository(fake.client);
    const verifiedChunk = {
      ...chunk,
      source: 'https://dev.azure.com/wiki?pagePath=%2FNote',
      pageId: '51',
    };

    await repository.movePages(
      [
        {
          previous: page,
          page: {
            id: '51',
            source: verifiedChunk.source,
            content: verifiedChunk.content,
            updatedAt: 'now',
          },
          chunks: [verifiedChunk],
        },
      ],
      context,
    );

    expect(fake.deleteMany).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1', source: 'wiki', pageId: 'page-1' },
    });
    expect(fake.deleteMany).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1', source: verifiedChunk.source, pageId: '51' },
    });
    expect(fake.relationDeleteMany).toHaveBeenCalledTimes(3);
    expect(fake.relationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          ownerId: 'owner-1',
          sourcePageId: '51',
          targetPageId: 'page-2',
          createdAt: new Date('2026-09-15'),
        },
      }),
    );
    expect(fake.relationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          ownerId: 'owner-1',
          sourcePageId: '51',
          targetPageId: 'aaa',
          createdAt: new Date('2026-09-15'),
        },
      }),
    );
    expect(fake.relationUpsert).toHaveBeenCalledTimes(2);
  });

  it('validates atomic page moves and retries write conflicts', async () => {
    const invalid = createClient();
    const invalidRepository = new PrismaKnowledgeRepository(invalid.client);
    await expect(
      invalidRepository.movePages(
        [
          {
            previous: page,
            page: { id: '51', source: 'azure', content: 'Body', updatedAt: 'now' },
            chunks: [{ ...chunk, source: 'wrong' }],
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_KNOWLEDGE_CHUNK' });

    const retry = createClient();
    retry.transaction.mockRejectedValueOnce({ code: 'P2034' });
    const waitBeforeRetry = vi.fn().mockResolvedValue(undefined);
    await new PrismaKnowledgeRepository(retry.client, {
      maxTransactionAttempts: 2,
      waitBeforeRetry,
    }).movePages(
      [
        {
          previous: page,
          page: { id: '51', source: 'azure', content: '', updatedAt: 'now' },
          chunks: [],
        },
      ],
      context,
    );
    expect(waitBeforeRetry).toHaveBeenCalledWith(1);
    expect(retry.createMany).not.toHaveBeenCalled();

    const failed = createClient();
    failed.transaction.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      new PrismaKnowledgeRepository(failed.client).movePages(
        [
          {
            previous: page,
            page: { id: '51', source: 'azure', content: '', updatedAt: 'now' },
            chunks: [],
          },
        ],
        context,
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_PERSISTENCE_ERROR' });
  });

  it('lists and searches only within the explicit owner scope', async () => {
    const fake = createClient();
    const repository = new PrismaKnowledgeRepository(fake.client);
    const search = new PrismaKnowledgeSearch(fake.client);

    await expect(repository.all(context)).resolves.toEqual([chunk]);
    await expect(search.search(' searchable ', context)).resolves.toEqual([chunk]);

    expect(fake.findMany).toHaveBeenNthCalledWith(1, {
      where: { ownerId: 'owner-1' },
      orderBy: [{ source: 'asc' }, { pageId: 'asc' }, { chunkIndex: 'asc' }],
    });
    expect(fake.findMany).toHaveBeenNthCalledWith(2, {
      where: expect.objectContaining({
        ownerId: 'owner-1',
        OR: expect.arrayContaining([{ content: { contains: 'searchable', mode: 'insensitive' } }]),
      }),
      orderBy: [{ source: 'asc' }, { pageId: 'asc' }, { chunkIndex: 'asc' }],
    });
  });

  it('never searches another owner when the same prompt is used', async () => {
    const fake = createClient([]);
    const search = new PrismaKnowledgeSearch(fake.client);
    await expect(
      search.search('Searchable', { requestId: 'request-2', ownerId: 'owner-2' }),
    ).resolves.toEqual([]);
    expect(fake.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: 'owner-2' }),
      }),
    );
  });

  it('searches with special characters and accents triggering URL-encoded filters', async () => {
    const recordWithPage = {
      ...record,
      source: 'https://dev.azure.com/wiki/Regras%20Autom%C3%A1ticas',
      content: 'Regras Automáticas de Conflitos',
    };
    const fake = createClient([recordWithPage]);
    const search = new PrismaKnowledgeSearch(fake.client);
    const results = await search.search('Regras Automáticas', context);
    expect(results).toHaveLength(1);
    expect(fake.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              source: { contains: 'Regras%20Autom%C3%A1ticas', mode: 'insensitive' },
            }),
          ]),
        }),
      }),
    );
  });

  it('requires ownership and validates page and search inputs before database calls', async () => {
    const fake = createClient();
    const repository = new PrismaKnowledgeRepository(fake.client);
    const search = new PrismaKnowledgeSearch(fake.client);

    await expect(repository.all({ requestId: 'missing-owner' })).rejects.toMatchObject({
      code: 'OWNER_CONTEXT_REQUIRED',
    });
    await expect(search.search('value', { requestId: 'missing-owner' })).rejects.toMatchObject({
      code: 'OWNER_CONTEXT_REQUIRED',
    });
    await expect(search.search(' ', context)).rejects.toMatchObject({
      code: 'SEARCH_PROMPT_REQUIRED',
    });
    await expect(
      repository.replacePage(page, [{ ...chunk, pageId: 'other' }], context),
    ).rejects.toMatchObject({ code: 'INVALID_KNOWLEDGE_CHUNK' });
    expect(fake.findMany).not.toHaveBeenCalled();
    expect(fake.transaction).not.toHaveBeenCalled();
  });

  it('retries recognized concurrency errors and then succeeds', async () => {
    const fake = createClient();
    fake.transaction.mockRejectedValueOnce({ code: 'P2034', message: 'sensitive' });
    const waitBeforeRetry = vi.fn().mockResolvedValue(undefined);
    const repository = new PrismaKnowledgeRepository(fake.client, {
      maxTransactionAttempts: 2,
      waitBeforeRetry,
    });

    await repository.replacePage(page, [chunk], context);
    expect(fake.transaction).toHaveBeenCalledTimes(2);
    expect(waitBeforeRetry).toHaveBeenCalledWith(1);
  });

  it('normalizes an exhausted transactional conflict', async () => {
    const fake = createClient();
    fake.transaction.mockRejectedValue({ code: 'P2002', message: 'constraint details' });
    await expect(
      new PrismaKnowledgeRepository(fake.client, { maxTransactionAttempts: 1 }).replacePage(
        page,
        [chunk],
        context,
      ),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_WRITE_CONFLICT', statusCode: 409 });
  });

  it('uses bounded jitter by default for retryable transactions', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fake = createClient();
    fake.transaction.mockRejectedValueOnce({ code: 'P2002' });
    const operation = new PrismaKnowledgeRepository(fake.client).replacePage(
      page,
      [chunk],
      context,
    );
    await vi.advanceTimersByTimeAsync(5);
    await expect(operation).resolves.toBeUndefined();
  });

  it.each([
    [{ code: 'P2002', message: 'database details' }, 'KNOWLEDGE_WRITE_CONFLICT', 409],
    [{ code: 'P1001', message: 'postgresql://secret' }, 'KNOWLEDGE_UNAVAILABLE', 503],
    [{ code: 'P2024', message: 'pool details' }, 'KNOWLEDGE_UNAVAILABLE', 503],
    [new Error('connection string'), 'KNOWLEDGE_PERSISTENCE_ERROR', 500],
    [{ code: 1001 }, 'KNOWLEDGE_PERSISTENCE_ERROR', 500],
  ])(
    'normalizes database failure %# without leaking details',
    async (failure, code, statusCode) => {
      const fake = createClient();
      fake.findMany.mockRejectedValue(failure);

      await expect(new PrismaKnowledgeRepository(fake.client).all(context)).rejects.toMatchObject({
        code,
        statusCode,
        message: expect.not.stringContaining('secret'),
      });
    },
  );

  it('preserves safe application mapping failures', async () => {
    const fake = createClient([{ ...record, createdAt: new Date('invalid') }]);
    await expect(new PrismaKnowledgeSearch(fake.client).search('content', context)).rejects.toEqual(
      expect.objectContaining({ code: 'INVALID_KNOWLEDGE_CHUNK' }),
    );

    fake.findMany.mockRejectedValue(new ApplicationError('SAFE_ERROR', 'Safe.', 422));
    await expect(new PrismaKnowledgeSearch(fake.client).search('content', context)).rejects.toEqual(
      expect.objectContaining({ code: 'SAFE_ERROR' }),
    );
  });

  it('creates repository and search ports over one shared structural client', () => {
    const fake = createClient();
    const adapters = createPrismaKnowledgeAdapters(fake.client);
    expect(adapters.repository).toBeInstanceOf(PrismaKnowledgeRepository);
    expect(adapters.search).toBeInstanceOf(PrismaKnowledgeSearch);
  });
});

describe('atomic document deletion failures', () => {
  it('runs chunk and relation cleanup in the same transaction', async () => {
    const fake = createClient();
    const outsideDelete = vi.fn();
    const repository = new PrismaKnowledgeRepository({
      ...fake.client,
      knowledgeRelationRecord: {
        ...fake.client.knowledgeRelationRecord!,
        deleteMany: outsideDelete,
      },
    });
    await repository.deletePage(page, context);
    expect(fake.transaction).toHaveBeenCalledOnce();
    expect(fake.relationDeleteMany).toHaveBeenCalledOnce();
    expect(outsideDelete).not.toHaveBeenCalled();
  });

  it('retries serialization errors and normalizes exhausted and non-retryable failures', async () => {
    const fake = createClient();
    const waitBeforeRetry = vi.fn().mockResolvedValue(undefined);
    fake.relationDeleteMany.mockRejectedValueOnce({ code: 'P2034' });
    const repository = new PrismaKnowledgeRepository(fake.client, { waitBeforeRetry });
    await repository.deletePage(page, context);
    expect(waitBeforeRetry).toHaveBeenCalledWith(1);
    expect(fake.transaction).toHaveBeenCalledTimes(2);
    fake.relationDeleteMany.mockRejectedValue({ code: 'P2034' });
    await expect(repository.deletePage(page, context)).rejects.toMatchObject({
      code: 'KNOWLEDGE_WRITE_CONFLICT',
    });
    fake.relationDeleteMany.mockRejectedValue({ code: 'P2021' });
    await expect(repository.deletePage(page, context)).rejects.toMatchObject({
      code: 'KNOWLEDGE_PERSISTENCE_ERROR',
    });
  });
});
