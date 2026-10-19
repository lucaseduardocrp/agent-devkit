import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import { InMemoryPbiStore, type PbiKind } from '../src/modules/pbi/pbi-store.js';
import type {
  PbiProvider,
  PbiProviderConfig,
  RemotePbiItem,
} from '../src/modules/pbi/providers.js';
import type { PushField } from '../src/modules/pbi/push-contract.js';

const factory = vi.hoisted(() => ({
  provider: null as null | ((config: PbiProviderConfig) => unknown),
  configs: [] as PbiProviderConfig[],
}));
vi.mock('../src/modules/pbi/providers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/pbi/providers.js')>();
  return {
    ...actual,
    createPbiProvider: (config: PbiProviderConfig, fetcher: typeof fetch) => {
      factory.configs.push(config);
      return factory.provider
        ? factory.provider(config)
        : actual.createPbiProvider(config, fetcher);
    },
  };
});

type Config = {
  providerId: string;
  isEnabled?: boolean;
  hasSecret?: boolean;
  settings?: Record<string, unknown>;
};
function integrations(configs: Config[], secret: string | null = 'secret') {
  return {
    listIntegrations: vi.fn(() =>
      Promise.resolve(
        configs.map((config) => ({
          category: 'PROJECT_MANAGEMENT',
          isEnabled: true,
          hasSecret: true,
          settings: {},
          ...config,
        })),
      ),
    ),
    getDecryptedSecret: vi.fn(() => Promise.resolve(secret)),
  } as unknown as IntegrationsService;
}
function remote(externalId: string, extra: Partial<RemotePbiItem> = {}): RemotePbiItem {
  return {
    externalId,
    parentExternalId: null,
    kind: 'pbi',
    title: `Remote ${externalId}`,
    description: '',
    status: 'New',
    position: 0,
    externalUrl: null,
    boardId: null,
    sourceData: {},
    ...extra,
  };
}
const field = (key: string, value: string, required = false): PushField => ({
  key,
  label: key,
  required,
  options: [{ value, label: value }],
  value,
  status: value ? 'resolved' : 'empty',
});
function fakeProvider(overrides: Partial<PbiProvider> = {}): PbiProvider {
  return {
    id: 'fake',
    pull: vi.fn(() => Promise.resolve([])),
    pushContract: vi.fn(() => Promise.resolve([])),
    push: vi.fn(() => Promise.resolve(remote('pushed'))),
    ...overrides,
  };
}
function use(provider: PbiProvider) {
  factory.provider = () => provider;
}

beforeEach(() => {
  factory.provider = null;
  factory.configs = [];
});

describe('PbiService provider resolution', () => {
  it('prefers a direct Azure integration over the wiki one and ignores unusable configs', async () => {
    const service = new PbiService(
      new InMemoryPbiStore(),
      integrations([
        { providerId: 'azure_devops_wiki', settings: { from: 'wiki' } },
        { providerId: 'azure_devops', settings: { from: 'boards' } },
        { providerId: 'jira', isEnabled: false },
        { providerId: 'trello', hasSecret: false },
        { providerId: 'confluence' },
      ]),
    );
    expect(await service.availableProviders('ws')).toEqual([
      { providerId: 'azure_devops', settings: { from: 'boards' } },
    ]);
  });

  it('falls back to the Azure wiki integration and returns null for a missing iteration', async () => {
    use(fakeProvider());
    const service = new PbiService(
      new InMemoryPbiStore(),
      integrations([{ providerId: 'azure_devops_wiki', settings: { organization: 'o' } }]),
    );
    expect(await service.availableProviders('ws')).toEqual([
      { providerId: 'azure_devops', settings: { organization: 'o' } },
    ]);
    expect(await service.currentIteration('ws')).toBeNull();
    expect(factory.configs[0]).toEqual({
      id: 'azure_devops',
      settings: { organization: 'o' },
      secret: 'secret',
    });
  });

  it('requires a configured provider and a stored credential', async () => {
    const store = new InMemoryPbiStore();
    const item = await store.create('ws', { kind: 'pbi', title: 'Item' });
    const none = new PbiService(store, integrations([]));
    await expect(none.pushContract('ws', item.id, 'jira')).rejects.toMatchObject({
      code: 'PBI_PROVIDER_CONFIG',
      message: 'Configure jira in Integrations first.',
    });
    await expect(none.pushContract('ws', item.id, 'azure_devops')).rejects.toMatchObject({
      code: 'PBI_PROVIDER_CONFIG',
    });
    const noSecret = new PbiService(store, integrations([{ providerId: 'jira' }], null));
    await expect(noSecret.pushContract('ws', item.id, 'jira')).rejects.toMatchObject({
      code: 'PBI_PROVIDER_CONFIG',
      message: 'Provider credential is missing.',
    });
  });
});

describe('PbiService items', () => {
  async function linked(store: InMemoryPbiStore, providerId: string, externalId: string) {
    const item = await store.create('ws', { kind: 'pbi', title: `${providerId} item` });
    return store.link('ws', item.id, { providerId, externalId, externalUrl: null, boardId: null });
  }

  it('resolves provider-qualified and numeric Azure ids', async () => {
    const store = new InMemoryPbiStore();
    const trello = await linked(store, 'trello', 'card-1');
    const azure = await linked(store, 'azure_devops', '123');
    const service = new PbiService(store, integrations([]));
    expect((await service.get('ws', 'trello:card-1')).id).toBe(trello.id);
    expect((await service.get('ws', '123')).id).toBe(azure.id);
    await expect(service.get('ws', 'jira:missing')).rejects.toMatchObject({
      code: 'PBI_NOT_FOUND',
    });
  });

  it('searches through the store', async () => {
    const store = new InMemoryPbiStore();
    await store.create('ws', { kind: 'pbi', title: 'One' });
    const service = new PbiService(store, integrations([]));
    expect((await service.search('ws', { page: 1, pageSize: 10 })).total).toBe(1);
  });

  it('returns no comments when the provider cannot list them', async () => {
    use(fakeProvider());
    const store = new InMemoryPbiStore();
    const item = await linked(store, 'azure_devops', '7');
    const service = new PbiService(store, integrations([{ providerId: 'azure_devops' }]));
    expect(await service.comments('ws', item.id)).toEqual([]);
  });

  it('enforces the PBI/card hierarchy on create and update', async () => {
    const store = new InMemoryPbiStore();
    const service = new PbiService(store, integrations([]));
    const root = await service.create('ws', { kind: 'pbi', title: 'Root' });
    await expect(
      service.create('ws', { kind: 'pbi', title: 'Nested', parentId: root.id }),
    ).rejects.toMatchObject({ message: 'PBIs cannot have a parent.' });
    await expect(service.create('ws', { kind: 'card', title: 'Orphan' })).rejects.toMatchObject({
      message: 'Cards require a parent PBI.',
    });
    const odd = await store.create('ws', { kind: 'epic' as PbiKind, title: 'Legacy' });
    await expect(
      service.create('ws', { kind: 'card', title: 'Under legacy', parentId: odd.id }),
    ).rejects.toMatchObject({ message: 'Cards must belong to a PBI or card.' });

    const first = await service.create('ws', { kind: 'card', title: 'A', parentId: root.id });
    const second = await service.create('ws', { kind: 'card', title: 'B', parentId: first.id });
    await expect(service.update('ws', first.id, { parentId: first.id })).rejects.toMatchObject({
      message: 'An item cannot parent itself.',
    });
    await expect(service.update('ws', first.id, { parentId: second.id })).rejects.toMatchObject({
      message: 'The hierarchy cannot contain a cycle.',
    });
    await expect(service.update('ws', first.id, { parentId: null })).rejects.toMatchObject({
      message: 'Cards require a parent PBI.',
    });
    expect((await service.update('ws', second.id, { parentId: root.id })).parentId).toBe(root.id);
  });
});

describe('PbiService pull', () => {
  it('imports items whose parent is unknown as roots and can omit the item list', async () => {
    use(
      fakeProvider({
        pull: () =>
          Promise.resolve([remote('1', { parentExternalId: 'gone', kind: 'card', title: 'Lost' })]),
      }),
    );
    const store = new InMemoryPbiStore();
    const service = new PbiService(store, integrations([{ providerId: 'trello' }]));
    expect(await service.pull('ws', false)).toEqual({
      results: [{ providerId: 'trello', imported: 1 }],
    });
    const [item] = await store.list('ws');
    expect(item).toMatchObject({ title: 'Lost', parentId: null, kind: 'card' });
  });

  it('reports store failures, cyclic hierarchies and non-error rejections per provider', async () => {
    const store = new InMemoryPbiStore();
    const service = new PbiService(store, integrations([{ providerId: 'jira' }]));
    const create = vi.spyOn(store, 'create');

    use(fakeProvider({ pull: () => Promise.resolve([remote('1')]) }));
    create.mockRejectedValueOnce(new Error('database down'));
    expect((await service.pull('ws')).results).toEqual([
      { providerId: 'jira', imported: 0, error: 'database down' },
    ]);
    create.mockRejectedValueOnce('opaque');
    expect((await service.pull('ws')).results[0]!.error).toBe('PBI import failed.');

    use(
      fakeProvider({
        pull: () =>
          Promise.resolve([
            remote('a', { parentExternalId: 'b' }),
            remote('b', { parentExternalId: 'a' }),
          ]),
      }),
    );
    expect((await service.pull('ws')).results[0]!.error).toBe(
      'Provider returned a cyclic hierarchy.',
    );

    use(fakeProvider({ pull: () => Promise.reject('offline') }));
    expect((await service.pull('ws')).results[0]!.error).toBe('Pull failed.');
  });

  it('syncs children only for Azure-linked items and tolerates providers without children', async () => {
    use(fakeProvider());
    const store = new InMemoryPbiStore();
    const service = new PbiService(store, integrations([{ providerId: 'azure_devops' }]));
    const plain = await store.create('ws', { kind: 'pbi', title: 'Local' });
    expect(await service.syncChildren('ws', plain.id)).toHaveLength(1);
    await store.link('ws', plain.id, {
      providerId: 'azure_devops',
      externalId: '9',
      externalUrl: null,
      boardId: null,
    });
    expect(await service.syncChildren('ws', plain.id)).toHaveLength(1);
  });
});

describe('PbiService push', () => {
  async function setup(contract: PushField[] = [], overrides: Partial<PbiProvider> = {}) {
    const provider = fakeProvider({
      pushContract: vi.fn(() => Promise.resolve(contract)),
      ...overrides,
    });
    use(provider);
    const store = new InMemoryPbiStore();
    const service = new PbiService(
      store,
      integrations([
        { providerId: 'jira' },
        { providerId: 'trello' },
        { providerId: 'azure_devops' },
      ]),
    );
    const root = await store.create('ws', { kind: 'pbi', title: 'Root' });
    return { provider, store, service, root };
  }

  it('maps legacy destination options onto contract values per provider', async () => {
    const { provider, service, root } = await setup();
    await service.push('ws', root.id, {
      providerId: 'jira',
      boardId: 'board',
      listId: 'list',
      issueType: 'Story',
      fields: { extra: 'x' },
    });
    expect(provider.pushContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        values: { board: 'board', list: 'list', issueType: 'Story', extra: 'x' },
      }),
    );
    await service.push('ws', root.id, { providerId: 'azure_devops', issueType: 'Bug' });
    expect(provider.pushContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ values: { workItemType: 'Bug' } }),
    );
  });

  it('rejects missing required fields', async () => {
    const { service, root } = await setup([field('board', '', true), field('list', '', true)]);
    await expect(service.push('ws', root.id, { providerId: 'trello' })).rejects.toMatchObject({
      code: 'PBI_PUSH_FIELDS',
      message: 'Missing push fields: board, list',
    });
  });

  it('requires the parent to be pushed first unless a list was chosen', async () => {
    const { store, service, root } = await setup();
    const card = await store.create('ws', { kind: 'card', title: 'Card', parentId: root.id });
    await expect(service.push('ws', card.id, { providerId: 'trello' })).rejects.toMatchObject({
      code: 'PBI_PARENT_NOT_LINKED',
    });
  });

  it('keeps existing link metadata when the provider omits it, else stores nulls', async () => {
    const { store, service, root } = await setup();
    const first = await service.push('ws', root.id, { providerId: 'jira' });
    expect(first.item.links).toEqual([
      expect.objectContaining({ externalId: 'pushed', externalUrl: null, boardId: null }),
    ]);
    expect(first.warnings).toEqual([]);

    const other = await store.create('ws', { kind: 'pbi', title: 'Linked' });
    await store.link('ws', other.id, {
      providerId: 'jira',
      externalId: 'pushed',
      externalUrl: 'https://x.atlassian.net/browse/P-1',
      boardId: 'P',
    });
    const second = await service.push('ws', other.id, { providerId: 'jira' });
    expect(second.item.links).toEqual([
      expect.objectContaining({
        externalUrl: 'https://x.atlassian.net/browse/P-1',
        boardId: 'P',
      }),
    ]);
  });

  it('turns non-error link sync failures into warnings', async () => {
    const { service, root } = await setup([], {
      syncLinks: () => Promise.reject('rate limited'),
    });
    const result = await service.push('ws', root.id, { providerId: 'jira' });
    expect(result.warnings).toEqual(['Links were not published: rate limited']);
  });
});

describe('PbiService relations summary', () => {
  it('labels related items by card type, provider type, or kind', async () => {
    const store = new InMemoryPbiStore();
    const service = new PbiService(store, integrations([]));
    const root = await store.create('ws', { kind: 'pbi', title: 'Root', sourceData: { type: 7 } });
    const typed = await store.create('ws', {
      kind: 'card',
      title: 'Typed',
      parentId: root.id,
      sourceData: { type: 'Bug' },
    });
    const card = await store.create('ws', { kind: 'card', title: 'Plain', parentId: root.id });
    const views = await service.relations('ws', root.id);
    const types = Object.fromEntries(views.map((view) => [view.item!.title, view.item!.type]));
    expect(types).toEqual({ Typed: 'Bug', Plain: 'Card' });
    const parentView = await service.relations('ws', typed.id);
    expect(parentView[0]!.item).toMatchObject({ title: 'Root', type: 'PBI' });
    expect(card.parentId).toBe(root.id);
  });
});
