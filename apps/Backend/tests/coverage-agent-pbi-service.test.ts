import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import {
  InMemoryFieldMappingStore,
  type FieldDefinition,
  type FieldMappingInput,
} from '../src/modules/field-mapping/field-mapping.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import { InMemoryPbiStore } from '../src/modules/pbi/pbi-store.js';
import type * as Providers from '../src/modules/pbi/providers.js';
import type { PbiProvider, RemotePbiItem } from '../src/modules/pbi/providers.js';
import type { PushField } from '../src/modules/pbi/push-contract.js';

const factory = vi.hoisted(() => ({ provider: null as PbiProvider | null }));
vi.mock('../src/modules/pbi/providers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Providers>()),
  createPbiProvider: () => factory.provider,
}));

type Config = { providerId: string; settings?: Record<string, unknown> };
function integrations(configs: Config[]) {
  const toEntries = (list: Config[]) =>
    list.map((config) => ({
      category: 'PROJECT_MANAGEMENT',
      isEnabled: true,
      hasSecret: true,
      settings: {},
      ...config,
    }));
  return {
    listIntegrations: vi.fn(() => Promise.resolve(toEntries(configs))),
    getDecryptedSecret: vi.fn(() => Promise.resolve('secret')),
    toEntries,
  };
}
function remote(externalId: string, extra: Partial<RemotePbiItem> = {}): RemotePbiItem {
  return {
    externalId,
    parentExternalId: null,
    kind: 'pbi',
    title: `Remote ${externalId}`,
    description: '',
    status: 'Active',
    position: 0,
    externalUrl: null,
    boardId: null,
    sourceData: {},
    ...extra,
  };
}
const field = (key: string, value: string): PushField => ({
  key,
  label: key,
  required: false,
  options: [{ value, label: value }],
  value,
  status: 'resolved',
});
const definitions: FieldDefinition[] = [
  { id: 'cf_title', name: 'Mirror title', type: 'text' },
  { id: 'cf_points', name: 'Points', type: 'number' },
];
/** A fake provider plus its listFields and push mocks, kept apart to assert on them. */
function fakeProvider(overrides: Partial<PbiProvider> = {}) {
  const listFields = vi.fn((_scope?: string, _itemType?: string) => Promise.resolve(definitions));
  const push = vi.fn((..._args: Parameters<PbiProvider['push']>) => Promise.resolve(remote('R1')));
  const provider: PbiProvider = {
    id: 'fake',
    pull: vi.fn(() => Promise.resolve([])),
    pushContract: vi.fn(() => Promise.resolve([])),
    listFields,
    push,
    ...overrides,
  };
  return { provider, listFields, push };
}
const template = (overrides: Partial<FieldMappingInput> = {}): FieldMappingInput => ({
  name: 'Jira mirror',
  entityType: 'pbi',
  providerId: 'jira',
  scope: '',
  itemType: '',
  rules: [{ targetFieldId: 'cf_title', source: { kind: 'core', key: 'title' } }],
  ...overrides,
});

async function setup(provider: PbiProvider, configs: Config[] = [{ providerId: 'jira' }]) {
  factory.provider = provider;
  const store = new InMemoryPbiStore();
  const mappings = new InMemoryFieldMappingStore();
  const fake = integrations(configs);
  const service = new PbiService(
    store,
    fake as unknown as IntegrationsService,
    fetch,
    undefined,
    undefined,
    mappings,
  );
  const item = await store.create('ws', { kind: 'pbi', title: 'Checkout', status: 'New' });
  return { store, mappings, service, item, fake };
}

beforeEach(() => {
  factory.provider = null;
});

describe('PbiService.fieldCatalog', () => {
  it('lists provider fields for the requested scope and type', async () => {
    const { provider, listFields } = fakeProvider();
    const { service } = await setup(provider);
    expect(await service.fieldCatalog('ws', 'jira', 'KEY', 'Story')).toEqual(definitions);
    expect(listFields).toHaveBeenCalledWith('KEY', 'Story');
  });

  it('rejects providers that do not expose field definitions', async () => {
    const { service } = await setup(fakeProvider({ listFields: undefined }).provider);
    await expect(service.fieldCatalog('ws', 'jira')).rejects.toMatchObject({
      code: 'FIELD_MAPPING_UNSUPPORTED',
      statusCode: 400,
    });
  });
});

describe('PbiService.previewFields', () => {
  it('resolves template values against the destination fields', async () => {
    const { provider, listFields } = fakeProvider();
    const { service, mappings, item } = await setup(provider);
    const saved = await mappings.save(
      'ws',
      null,
      template({
        scope: 'KEY',
        itemType: 'Story',
        rules: [
          { targetFieldId: 'cf_title', source: { kind: 'core', key: 'title' } },
          { targetFieldId: 'cf_points', source: { kind: 'constant', value: '8' } },
        ],
      }),
    );
    expect(await service.previewFields('ws', item.id, 'jira', saved.id, 'KEY', 'Story')).toEqual({
      definitions,
      values: { cf_title: 'Checkout', cf_points: 8 },
    });
    expect(listFields).toHaveBeenCalledWith('KEY', 'Story');
  });

  it.each([
    ['is missing', null],
    ['targets test cases', { entityType: 'test_case' as const }],
    ['targets another provider', { providerId: 'trello' }],
    ['targets another scope', { scope: 'OTHER' }],
    ['targets another item type', { itemType: 'Bug' }],
  ])('rejects a template that %s', async (_label, overrides) => {
    const { provider, listFields } = fakeProvider();
    const { service, mappings, item } = await setup(provider);
    const id = overrides
      ? (await mappings.save('ws', null, template(overrides))).id
      : '33333333-3333-4333-8333-333333333333';
    await expect(
      service.previewFields('ws', item.id, 'jira', id, 'KEY', 'Story'),
    ).rejects.toMatchObject({
      code: 'FIELD_MAPPING_INVALID',
      message: 'Template does not match this destination.',
    });
    expect(listFields).not.toHaveBeenCalled();
  });

  it('uses an empty scope and item type by default', async () => {
    const { provider, listFields } = fakeProvider();
    const { service, mappings, item } = await setup(provider);
    const saved = await mappings.save('ws', null, template());
    await service.previewFields('ws', item.id, 'jira', saved.id);
    expect(listFields).toHaveBeenCalledWith('', '');
  });
});

describe('PbiService.push with a field mapping template', () => {
  it('sends mapped custom fields to the provider and mirrors them on the item', async () => {
    const { provider, listFields, push } = fakeProvider({
      pushContract: vi.fn(() =>
        Promise.resolve([field('project', 'KEY'), field('issueType', 'Story')]),
      ),
    });
    const { service, mappings, item } = await setup(provider);
    const saved = await mappings.save('ws', null, template());
    const result = await service.push('ws', item.id, {
      providerId: 'jira',
      templateId: saved.id,
    });
    expect(listFields).toHaveBeenCalledWith('KEY', 'Story');
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Checkout' }),
      expect.objectContaining({
        fields: { project: 'KEY', issueType: 'Story' },
        customFields: { cf_title: 'Checkout' },
        fieldDefinitions: definitions,
      }),
    );
    expect(result.item.sourceData.customFields).toEqual({ jira: { cf_title: 'Checkout' } });
    expect(result.item.links).toEqual([
      expect.objectContaining({ providerId: 'jira', externalId: 'R1' }),
    ]);
  });

  it('keeps the item custom fields untouched when the template maps nothing', async () => {
    const { provider, push } = fakeProvider();
    const { service, mappings, item } = await setup(provider);
    const saved = await mappings.save('ws', null, template({ rules: [] }));
    const result = await service.push('ws', item.id, {
      providerId: 'jira',
      templateId: saved.id,
    });
    expect(push).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ customFields: {}, fieldDefinitions: definitions }),
    );
    expect(result.item.sourceData.customFields).toEqual({});
  });

  it.each([
    ['the contract board', {}, [field('board', 'B1'), field('workItemType', 'Bug')], 'B1', 'Bug'],
    ['the contract project', {}, [field('project', 'P1')], 'P1', ''],
    ['the configured project', { project: 'Proj' }, [], 'Proj', ''],
    ['the configured project key', { project: 5, projectKey: 'KEY' }, [], 'KEY', ''],
    ['the configured board', { projectKey: 5, boardId: 'brd' }, [], 'brd', ''],
    ['the configured project number', { boardId: 5, projectNumber: '7' }, [], '7', ''],
    ['nothing', { projectNumber: 7 }, [], '', ''],
  ])('scopes the field catalog by %s', async (_label, settings, contract, scope, itemType) => {
    const { provider, listFields } = fakeProvider({
      pushContract: vi.fn(() => Promise.resolve(contract)),
    });
    const { service, mappings, item } = await setup(provider, [{ providerId: 'jira', settings }]);
    const saved = await mappings.save('ws', null, template());
    await service.push('ws', item.id, { providerId: 'jira', templateId: saved.id });
    expect(listFields).toHaveBeenCalledWith(scope, itemType);
  });

  it('scopes an update by the linked board and survives a vanished integration', async () => {
    const { provider, listFields, push } = fakeProvider();
    const { service, mappings, item, store, fake } = await setup(provider);
    await store.link('ws', item.id, {
      providerId: 'jira',
      externalId: 'R1',
      externalUrl: 'https://jira.test/R1',
      boardId: 'LINKED',
    });
    const saved = await mappings.save('ws', null, template());
    // The settings lookup briefly misses the integration that resolved the provider.
    fake.listIntegrations
      .mockResolvedValueOnce(fake.toEntries([{ providerId: 'jira' }]))
      .mockResolvedValueOnce([]);
    const result = await service.push('ws', item.id, { providerId: 'jira', templateId: saved.id });
    expect(listFields).toHaveBeenCalledWith('LINKED', '');
    expect(push).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ externalId: 'R1' }),
    );
    expect(result.item.links[0]).toMatchObject({
      externalUrl: 'https://jira.test/R1',
      boardId: 'LINKED',
    });
  });
});
