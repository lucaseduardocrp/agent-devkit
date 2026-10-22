import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import {
  Cache,
  createCache,
  MemoryCacheStore,
  noCache,
  reviveDates,
  type CacheStore,
} from '../src/shared/cache.js';
import { InMemoryPbiStore, PrismaPbiStore, toPbiSummary } from '../src/modules/pbi/pbi-store.js';
import {
  cachedKnowledgeRepository,
  cachedKnowledgeSearch,
} from '../src/modules/knowledge/application/knowledge-cache.js';
import { InMemoryKnowledgeChunkRepository } from '../src/modules/knowledge/application/knowledge-provider.js';
import { cachedWorkspaceRepository } from '../src/modules/workspaces/application/cached-workspace-repository.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

describe('MemoryCacheStore', () => {
  it('expires values, evicts the least recently used past its size and keeps counters', async () => {
    let now = 0;
    const store = new MemoryCacheStore(10, () => now);
    await store.set('a', '12345', 60);
    await store.set('b', '12345', 60);
    expect(await store.get('a')).toBe('12345');
    // "a" was read last, so "b" leaves when "c" no longer fits.
    await store.set('c', '123', 60);
    expect(await store.get('b')).toBeNull();
    expect(await store.get('a')).toBe('12345');
    await store.set('huge', '12345678901', 60);
    expect(await store.get('huge')).toBeNull();
    expect(await store.incr('version')).toBe(1);
    expect(await store.incr('version')).toBe(2);
    expect(await store.get('version')).toBe('2');
    now = 61_000;
    expect(await store.get('a')).toBeNull();
    expect(await store.get('version')).toBe('2');
    await store.close();
    expect(await store.get('c')).toBeNull();
  });
});

describe('Cache', () => {
  it('loads once, serves later reads and reloads after its scope is invalidated', async () => {
    const cache = new Cache(new MemoryCacheStore());
    const load = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    expect(await cache.text('scope', 'key', 60, load)).toBe('first');
    expect(await cache.text('scope', 'key', 60, load)).toBe('first');
    expect(load).toHaveBeenCalledTimes(1);
    await cache.invalidate('other');
    expect(await cache.text('scope', 'key', 60, load)).toBe('first');
    await cache.invalidate('scope');
    expect(await cache.text('scope', 'key', 60, load)).toBe('second');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent misses', async () => {
    const cache = new Cache(new MemoryCacheStore());
    let finish: (value: string) => void = () => undefined;
    const load = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const reads = [cache.text('s', 'k', 60, load), cache.text('s', 'k', 60, load)];
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    finish('value');
    expect(await Promise.all(reads)).toEqual(['value', 'value']);
  });

  it('round-trips JSON and restores dates by name', async () => {
    const cache = new Cache(new MemoryCacheStore());
    const value = {
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      note: '2026-01-02T03:04:05.000Z',
    };
    const load = vi.fn().mockResolvedValue(value);
    expect(await cache.json('s', 'k', 60, load, reviveDates('createdAt'))).toBe(value);
    const cached = await cache.json<typeof value>('s', 'k', 60, load, reviveDates('createdAt'));
    expect(cached.createdAt).toBeInstanceOf(Date);
    expect(cached.createdAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(cached.note).toBe('2026-01-02T03:04:05.000Z');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reads from the source while its store fails, warning once a minute', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const failing: CacheStore = {
      kind: 'redis',
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      incr: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      close,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cache = new Cache(failing);
    const load = vi.fn().mockResolvedValue('fresh');
    expect(await cache.text('s', 'k', 60, load)).toBe('fresh');
    expect(await cache.text('s', 'k', 60, load)).toBe('fresh');
    await cache.invalidate('s');
    expect(load).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    await cache.close();
    expect(close).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps nothing without a store size, and picks Redis only with REDIS_URL', async () => {
    const cache = noCache();
    const load = vi.fn().mockResolvedValue('value');
    await cache.text('s', 'k', 60, load);
    await cache.text('s', 'k', 60, load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(createCache({}).store.kind).toBe('memory');
    const redis = createCache({ REDIS_URL: 'redis://127.0.0.1:1' });
    expect(redis.store.kind).toBe('redis');
    await redis.close();
  });
});

describe('PBI list cache', () => {
  const context = () => ({
    requestId: 'pbi-cache',
    ownerId: 'ws-a',
    workspaceId: 'ws-a',
    actorId: 'user-a',
    memberRole: 'ADMIN' as const,
  });

  it('serves the list without detail fields, from the cache until an item changes', async () => {
    const store = new InMemoryPbiStore();
    const summaries = vi.spyOn(store, 'summaries');
    const app = createApp({
      cache: new Cache(new MemoryCacheStore()),
      pbiStore: store,
      requestContextResolver: context,
    });
    // Provider data such as custom fields comes from a pull, straight into the store.
    const { id } = await store.create('ws-a', {
      kind: 'pbi',
      title: 'Release',
      description: '<p>Ship&nbsp;<b>safely</b></p>',
      sourceData: { iterationPath: 'Sprint 1', customFields: { 'Custom.Big': 'x'.repeat(50) } },
    });

    const first = await request(app).get('/pbi?view=summary').expect(200);
    expect(first.headers['content-type']).toMatch(/application\/json/);
    expect(first.body.items).toEqual([
      expect.objectContaining({
        id,
        title: 'Release',
        descriptionExcerpt: 'Ship&nbsp; safely',
        sourceData: { iterationPath: 'Sprint 1' },
      }),
    ]);
    expect(first.body.items[0]).not.toHaveProperty('description');
    expect(first.body.items[0]).not.toHaveProperty('attachments');
    await request(app).get('/pbi?view=summary').expect(200);
    expect(summaries).toHaveBeenCalledTimes(1);

    await request(app).patch(`/pbi/items/${id}`).send({ title: 'Release 2' }).expect(200);
    const changed = await request(app).get('/pbi?view=summary').expect(200);
    expect(changed.body.items[0].title).toBe('Release 2');
    expect(summaries).toHaveBeenCalledTimes(2);
    // The full item keeps every field.
    const full = await request(app).get(`/pbi/items/${id}`).expect(200);
    expect(full.body.item.description).toBe('<p>Ship&nbsp;<b>safely</b></p>');
    expect(full.body.item.sourceData.customFields).toEqual({ 'Custom.Big': 'x'.repeat(50) });
  });

  it('compresses large responses', async () => {
    const store = new InMemoryPbiStore();
    for (let index = 0; index < 50; index += 1)
      await store.create('ws-a', { kind: 'pbi', title: `Item ${index}`, description: 'text' });
    const app = createApp({ pbiStore: store, requestContextResolver: context });
    const response = await request(app)
      .get('/pbi?view=summary')
      .set('Accept-Encoding', 'gzip')
      .expect(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.body.items).toHaveLength(50);
  });

  it('reads the list from the database without the heavy columns and groups links', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          id: 'a',
          workspaceId: 'ws',
          parentId: null,
          kind: 'pbi',
          title: 'A',
          status: 'New',
          position: '2.5',
          createdAt,
          updatedAt: createdAt,
          sourceData: { type: 'PBI' },
          descriptionExcerpt: 'text',
        },
        { id: 'b', position: 3, kind: 'card', sourceData: {}, descriptionExcerpt: '' },
      ]),
      pbiExternalLinkRecord: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'l1',
            itemId: 'a',
            providerId: 'azure_devops',
            externalId: '1',
            externalUrl: null,
            boardId: null,
            syncedAt: createdAt,
          },
          {
            id: 'l2',
            itemId: 'a',
            providerId: 'trello',
            externalId: 'x',
            externalUrl: null,
            boardId: 'b',
            syncedAt: createdAt,
          },
        ]),
      },
    };
    const items = await new PrismaPbiStore(db as unknown as PrismaClient).summaries('ws');
    expect(items[0]).toMatchObject({ id: 'a', position: 2.5, descriptionExcerpt: 'text' });
    expect(items[0]!.links.map((link) => link.id)).toEqual(['l1', 'l2']);
    expect(items[1]!.links).toEqual([]);
    expect(db.pbiExternalLinkRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws' } }),
    );
  });

  it('cuts the description to a plain-text excerpt', () => {
    const summary = toPbiSummary({
      id: 'a',
      workspaceId: 'ws',
      parentId: null,
      kind: 'pbi',
      title: 'A',
      description: `<div>${'word '.repeat(100)}</div>`,
      attachments: [],
      status: 'New',
      position: 0,
      sourceData: { externalLinks: [], relatedExternalIds: [], type: 'PBI' },
      createdAt: new Date(),
      updatedAt: new Date(),
      links: [],
    });
    expect(summary.descriptionExcerpt).toHaveLength(300);
    expect(summary.descriptionExcerpt.startsWith('word word')).toBe(true);
    expect(summary.sourceData).toEqual({ type: 'PBI' });
  });
});

describe('Brain cache', () => {
  const context = { requestId: 'brain', ownerId: 'ws-a', workspaceId: 'ws-a' };
  const page = { id: 'p1', source: 'app://local?title=Doc' };
  const chunk = (content: string) => ({
    source: page.source,
    pageId: page.id,
    chunkIndex: 0,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('serves chunks, relations and searches from the cache until a page or relation changes', async () => {
    const raw = new InMemoryKnowledgeChunkRepository();
    const cache = new Cache(new MemoryCacheStore());
    const repository = cachedKnowledgeRepository(raw, cache);
    const all = vi.spyOn(raw, 'all');
    const relations = vi.spyOn(raw, 'listRelations');
    const search = { search: vi.fn().mockResolvedValue([chunk('found')]) };
    const searches = cachedKnowledgeSearch(search, cache);

    await repository.replacePage(page, [chunk('first')], context);
    expect((await repository.all(context)).map((item) => item.content)).toEqual(['first']);
    await repository.all(context);
    await repository.listRelations(context);
    await repository.listRelations(context);
    await searches.search('deploy', context);
    await searches.search('deploy', context);
    expect(all).toHaveBeenCalledTimes(1);
    expect(relations).toHaveBeenCalledTimes(1);
    expect(search.search).toHaveBeenCalledTimes(1);

    await repository.replacePage(page, [chunk('second')], context);
    expect((await repository.all(context)).map((item) => item.content)).toEqual(['second']);
    await searches.search('deploy', context);
    expect(search.search).toHaveBeenCalledTimes(2);

    const other = { id: 'p2', source: 'app://local?title=Other' };
    await repository.replacePage(
      other,
      [{ ...chunk('other'), ...{ pageId: other.id, source: other.source } }],
      context,
    );
    await repository.addRelation('p1', 'p2', context);
    expect(await repository.listRelations(context)).toHaveLength(1);
    await repository.deleteRelation('p1', 'p2', context);
    expect(await repository.listRelations(context)).toHaveLength(0);
    await repository.movePages([], context);
    await repository.deletePage(page, context);
    expect((await repository.all(context)).map((item) => item.pageId)).toEqual(['p2']);
  });
});

describe('Workspace access cache', () => {
  it('serves membership, workspace, members and groups from the cache until they change', async () => {
    const raw = new InMemoryWorkspaceRepository();
    const repository = cachedWorkspaceRepository(raw, new Cache(new MemoryCacheStore()));
    const workspace = await repository.createWorkspace({ name: 'WS', slug: 'ws', ownerId: 'u1' });
    const member = await repository.addMember({
      workspaceId: workspace.id,
      userId: 'u1',
      role: 'MEMBER',
    });
    const findMember = vi.spyOn(raw, 'findMember');
    const findById = vi.spyOn(raw, 'findById');
    const listGroups = vi.spyOn(raw, 'listGroups');
    const listMembers = vi.spyOn(raw, 'listMembers');

    const cached = await repository.findMember(workspace.id, 'u1');
    expect(cached?.createdAt).toBeInstanceOf(Date);
    await repository.findMember(workspace.id, 'u1');
    expect((await repository.findById(workspace.id))?.createdAt).toBeInstanceOf(Date);
    await repository.findById(workspace.id);
    await repository.listGroups(workspace.id);
    await repository.listGroups(workspace.id);
    await repository.listMembers(workspace.id);
    await repository.listMembers(workspace.id);
    expect(findMember).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledTimes(1);
    expect(listGroups).toHaveBeenCalledTimes(1);
    expect(listMembers).toHaveBeenCalledTimes(1);

    const group = await repository.createGroup({
      workspaceId: workspace.id,
      name: 'Editors',
      description: '',
      modules: {},
      memberIds: [],
    });
    await repository.setMemberGroups(workspace.id, member.id, [group.id]);
    expect((await repository.listGroups(workspace.id))[0]?.memberIds).toEqual([member.id]);
    await repository.updateGroup(group.id, { name: 'Writers' });
    expect((await repository.listGroups(workspace.id))[0]?.name).toBe('Writers');
    await repository.deleteGroup(group.id);
    expect(await repository.listGroups(workspace.id)).toEqual([]);

    await repository.updateMember(member.id, { role: 'ADMIN' });
    expect((await repository.findMember(workspace.id, 'u1'))?.role).toBe('ADMIN');
    expect(await repository.countAdmins(workspace.id)).toBe(1);
    expect(await repository.findMemberById(member.id)).toMatchObject({ id: member.id });
    await repository.renameWorkspace(workspace.id, 'Renamed');
    expect((await repository.findById(workspace.id))?.name).toBe('Renamed');
    expect(await repository.findBySlug('ws')).toMatchObject({ id: workspace.id });
    expect(await repository.listUserWorkspaces('u1')).toHaveLength(1);
    expect(await repository.findGroup('missing')).toBeNull();
    await repository.deleteMember(member.id);
    expect(await repository.findMember(workspace.id, 'u1')).toBeNull();
    await repository.deleteMember('missing');
    await repository.deleteGroup('missing').catch(() => undefined);
    await repository.deleteWorkspace(workspace.id);
    expect(await repository.findById(workspace.id)).toBeNull();
  });
});
