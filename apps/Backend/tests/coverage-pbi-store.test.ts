import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { InMemoryPbiStore, PrismaPbiStore } from '../src/modules/pbi/pbi-store.js';

describe('InMemoryPbiStore.search', () => {
  async function seed() {
    const store = new InMemoryPbiStore();
    const a = await store.create('ws', {
      kind: 'pbi',
      title: 'A',
      position: 1,
      sourceData: { iterationPath: 'Project\\Sprint 1' },
    });
    const b = await store.create('ws', {
      kind: 'pbi',
      title: 'B',
      position: 2,
      sourceData: { iterationPath: 42 },
    });
    const c = await store.create('ws', { kind: 'pbi', title: 'C', position: 3 });
    await store.create('other', { kind: 'pbi', title: 'Elsewhere' });
    const link = (id: string, providerId: string, externalId: string) =>
      store.link('ws', id, { providerId, externalId, externalUrl: null, boardId: null });
    await link(a.id, 'azure_devops', '1');
    await link(b.id, 'trello', '1');
    await link(c.id, 'trello', '2');
    return { store, a, b, c };
  }
  const titles = (result: { items: { title: string }[] }) => result.items.map((i) => i.title);

  it('filters by external id, optionally scoped to a provider', async () => {
    const { store } = await seed();
    expect(titles(await store.search('ws', { externalId: '1', page: 1, pageSize: 10 }))).toEqual([
      'A',
      'B',
    ]);
    expect(
      titles(
        await store.search('ws', {
          externalId: '1',
          providerId: 'trello',
          page: 1,
          pageSize: 10,
        }),
      ),
    ).toEqual(['B']);
  });

  it('filters by provider alone and by iteration path', async () => {
    const { store } = await seed();
    expect(
      titles(await store.search('ws', { providerId: 'trello', page: 1, pageSize: 10 })),
    ).toEqual(['B', 'C']);
    expect(
      titles(await store.search('ws', { iterationPath: 'Sprint 1', page: 1, pageSize: 10 })),
    ).toEqual(['A']);
  });

  it('paginates the matches and reports the total', async () => {
    const { store } = await seed();
    expect(await store.search('ws', { page: 2, pageSize: 2 })).toEqual({
      items: [expect.objectContaining({ title: 'C' })],
      total: 3,
      page: 2,
      pageSize: 2,
    });
  });
});

describe('PrismaPbiStore', () => {
  const syncedAt = new Date('2026-01-01T00:00:00Z');
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    workspaceId: 'ws',
    parentId: null,
    kind: 'pbi',
    title: `Item ${id}`,
    description: '',
    status: 'backlog',
    position: 1,
    sourceData: { type: 'Bug' },
    createdAt: syncedAt,
    updatedAt: syncedAt,
    links: [
      {
        id: `link-${id}`,
        workspaceId: 'ws',
        itemId: id,
        providerId: 'azure_devops',
        externalId: `ext-${id}`,
        externalUrl: null,
        boardId: 'board',
        syncedAt,
      },
    ],
    ...extra,
  });
  function setup() {
    const items = {
      findMany: vi.fn(() => Promise.resolve([row('a')])),
      count: vi.fn(() => Promise.resolve(7)),
      findFirst: vi.fn((): Promise<ReturnType<typeof row> | null> => Promise.resolve(row('a'))),
      create: vi.fn(() => Promise.resolve(row('new'))),
      update: vi.fn(() => Promise.resolve(row('a', { title: 'Updated' }))),
      deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
    };
    const links = { upsert: vi.fn(() => Promise.resolve({})) };
    const prisma = {
      pbiItemRecord: items,
      pbiExternalLinkRecord: links,
    } as unknown as PrismaClient;
    return { store: new PrismaPbiStore(prisma), items, links };
  }
  const expectedLink = {
    id: 'link-a',
    providerId: 'azure_devops',
    externalId: 'ext-a',
    externalUrl: null,
    boardId: 'board',
    syncedAt,
  };

  it('searches with link and iteration filters, paginating in the database', async () => {
    const { store, items } = setup();
    const result = await store.search('ws', {
      externalId: '42',
      providerId: 'jira',
      iterationPath: 'Sprint',
      page: 3,
      pageSize: 10,
    });
    expect(result).toMatchObject({ total: 7, page: 3, pageSize: 10 });
    expect(result.items[0]).toMatchObject({ id: 'a', kind: 'pbi', links: [expectedLink] });
    expect(result.items[0]!.links[0]).not.toHaveProperty('itemId');
    const where = {
      workspaceId: 'ws',
      links: { some: { externalId: '42', providerId: 'jira' } },
      sourceData: { path: ['iterationPath'], string_contains: 'Sprint' },
    };
    expect(items.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where, skip: 20, take: 10 }),
    );
    expect(items.count).toHaveBeenCalledWith({ where });
  });

  it('builds partial filters for external id only, provider only, or none', async () => {
    const { store, items } = setup();
    await store.search('ws', { externalId: '42', page: 1, pageSize: 5 });
    expect(items.count).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws', links: { some: { externalId: '42' } } },
    });
    await store.search('ws', { providerId: 'trello', page: 1, pageSize: 5 });
    expect(items.count).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws', links: { some: { providerId: 'trello' } } },
    });
    await store.search('ws', { page: 1, pageSize: 5 });
    expect(items.count).toHaveBeenLastCalledWith({ where: { workspaceId: 'ws' } });
  });

  it('lists, gets and lists children of a workspace', async () => {
    const { store, items } = setup();
    expect((await store.list('ws'))[0]!.links).toEqual([expectedLink]);
    expect(items.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws' } }),
    );
    expect((await store.get('ws', 'a'))?.id).toBe('a');
    items.findFirst.mockResolvedValueOnce(null);
    expect(await store.get('ws', 'missing')).toBeNull();
    await store.listChildren('ws', 'parent');
    expect(items.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws', parentId: 'parent' } }),
    );
  });

  it('gets many items, skipping the query for no ids', async () => {
    const { store, items } = setup();
    expect(await store.getMany('ws', [])).toEqual([]);
    expect(items.findMany).not.toHaveBeenCalled();
    expect(await store.getMany('ws', ['a', 'b'])).toHaveLength(1);
    expect(items.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws', id: { in: ['a', 'b'] } } }),
    );
  });

  it('creates items with defaults or the given values', async () => {
    const { store, items } = setup();
    vi.spyOn(Date, 'now').mockReturnValueOnce(1234);
    expect((await store.create('ws', { kind: 'pbi', title: 'New' })).id).toBe('new');
    expect(items.create).toHaveBeenLastCalledWith({
      data: {
        workspaceId: 'ws',
        parentId: null,
        kind: 'pbi',
        title: 'New',
        description: '',
        status: 'backlog',
        position: 1234,
        sourceData: {},
      },
      include: { links: true },
    });
    await store.create('ws', {
      kind: 'card',
      title: 'Card',
      parentId: 'p',
      description: 'd',
      status: 'done',
      position: 5,
      sourceData: { a: 1 },
    });
    expect(items.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentId: 'p',
          description: 'd',
          status: 'done',
          position: 5,
          sourceData: { a: 1 },
        }),
      }),
    );
  });

  it('updates only items of the workspace', async () => {
    const { store, items } = setup();
    expect((await store.update('ws', 'a', { title: 'Updated' }))?.title).toBe('Updated');
    expect(items.update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { title: 'Updated', sourceData: undefined },
      include: { links: true },
    });
    items.findFirst.mockResolvedValueOnce(null);
    expect(await store.update('ws', 'missing', { title: 'X' })).toBeNull();
    expect(items.update).toHaveBeenCalledTimes(1);
  });

  it('removes items and reports whether anything was deleted', async () => {
    const { store, items } = setup();
    expect(await store.remove('ws', 'a')).toBe(true);
    expect(items.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'ws', id: 'a' } });
    items.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.remove('ws', 'a')).toBe(false);
  });

  it('finds items by external link', async () => {
    const { store, items } = setup();
    expect((await store.findByExternal('ws', 'azure_devops', 'ext-a'))?.id).toBe('a');
    expect(items.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws',
        links: { some: { providerId: 'azure_devops', externalId: 'ext-a' } },
      },
      include: { links: true },
    });
    items.findFirst.mockResolvedValueOnce(null);
    expect(await store.findByExternal('ws', 'azure_devops', 'nope')).toBeNull();
  });

  it('upserts external links and returns the refreshed item', async () => {
    const { store, links } = setup();
    const fields = {
      providerId: 'jira',
      externalId: '10',
      externalUrl: 'https://x.atlassian.net/browse/A-1',
      boardId: 'A',
    };
    expect((await store.link('ws', 'a', fields)).id).toBe('a');
    expect(links.upsert).toHaveBeenCalledWith({
      where: {
        workspaceId_providerId_externalId: {
          workspaceId: 'ws',
          providerId: 'jira',
          externalId: '10',
        },
      },
      create: { workspaceId: 'ws', itemId: 'a', ...fields },
      update: { externalUrl: fields.externalUrl, boardId: 'A', syncedAt: expect.any(Date) },
    });
  });
});
