import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaApiTestStore } from '../src/modules/apitests/adapters/prisma-api-test-store.js';
import type {
  ApiCollection,
  ApiEnvironment,
  LoadScenario,
} from '../src/modules/apitests/domain/api-test.js';

const NOW = new Date('2026-01-01T00:00:00Z');

function model() {
  return {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  };
}

function build() {
  const db = {
    apiCollectionRecord: model(),
    apiEnvironmentRecord: model(),
    loadScenarioRecord: model(),
    apiRunRecord: model(),
    apiPersonalValueRecord: model(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (operations: unknown[]) => Promise.all(operations)),
  };
  return { db, store: new PrismaApiTestStore(db as unknown as PrismaClient) };
}

const collectionRow = (extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  workspaceId: 'w',
  name: 'Col',
  description: null,
  definition: null,
  source: null,
  createdBy: 'u',
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

const runRow = (extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  workspaceId: 'w',
  kind: 'integration',
  collectionId: 'c1',
  scenarioId: null,
  environmentId: null,
  itemIds: ['a'],
  name: 'Run',
  target: 'remote',
  status: 'queued',
  requestedBy: 'u',
  claimedBy: null,
  claimLabel: null,
  heartbeatAt: null,
  attempts: 0,
  payload: null,
  result: null,
  error: null,
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
  ...extra,
});

describe('PrismaApiTestStore collections', () => {
  it('maps rows with defaults for missing definitions', async () => {
    const { db, store } = build();
    db.apiCollectionRecord.findMany.mockResolvedValue([collectionRow()]);
    const [collection] = await store.listCollections('w');
    expect(db.apiCollectionRecord.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w' },
      orderBy: { name: 'asc' },
    });
    expect(collection).toEqual({
      id: 'c1',
      workspaceId: 'w',
      name: 'Col',
      variables: [],
      auth: { type: 'none' },
      items: [],
      source: { kind: 'manual' },
      createdBy: 'u',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('keeps definitions and descriptions', async () => {
    const { db, store } = build();
    db.apiCollectionRecord.findFirst.mockResolvedValueOnce(
      collectionRow({
        description: 'About',
        definition: {
          variables: [{ key: 'a' }],
          auth: { type: 'bearer' },
          items: [{ id: 'i' }],
          headers: [{ key: 'h' }],
        },
        source: { kind: 'postman' },
      }),
    );
    expect(await store.getCollection('w', 'c1')).toMatchObject({
      description: 'About',
      variables: [{ key: 'a' }],
      auth: { type: 'bearer' },
      items: [{ id: 'i' }],
      headers: [{ key: 'h' }],
      source: { kind: 'postman' },
    });
    db.apiCollectionRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.getCollection('w', 'missing')).toBeNull();
  });

  it('upserts collections without identity fields in the definition', async () => {
    const { db, store } = build();
    db.apiCollectionRecord.upsert.mockImplementation(async ({ create }) =>
      collectionRow({ name: create.name }),
    );
    const input = {
      id: 'c1',
      workspaceId: 'w',
      name: 'Col',
      description: 'About',
      variables: [],
      auth: { type: 'none' },
      items: [],
      source: { kind: 'manual' },
      createdBy: 'u',
      createdAt: NOW,
      updatedAt: NOW,
    } as unknown as ApiCollection;
    expect((await store.saveCollection(input)).name).toBe('Col');
    const call = db.apiCollectionRecord.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 'c1' });
    expect(call.create).toMatchObject({
      id: 'c1',
      workspaceId: 'w',
      createdBy: 'u',
      description: 'About',
    });
    expect(call.update.definition).toEqual({
      variables: [],
      auth: { type: 'none' },
      items: [],
    });
    await store.saveCollection({ ...input, description: undefined });
    expect(db.apiCollectionRecord.upsert.mock.calls[1]![0].update.description).toBeNull();
  });

  it('reports whether a collection was deleted', async () => {
    const { db, store } = build();
    db.apiCollectionRecord.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.deleteCollection('w', 'c1')).toBe(true);
    db.apiCollectionRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.deleteCollection('w', 'c1')).toBe(false);
  });
});

describe('PrismaApiTestStore environments', () => {
  const row = {
    id: 'e1',
    workspaceId: 'w',
    name: 'Dev',
    variables: [{ key: 'a' }],
    createdBy: 'u',
    createdAt: NOW,
    updatedAt: NOW,
  };

  it('lists, gets, saves and deletes environments', async () => {
    const { db, store } = build();
    db.apiEnvironmentRecord.findMany.mockResolvedValue([row]);
    expect(await store.listEnvironments('w')).toEqual([row]);
    db.apiEnvironmentRecord.findFirst.mockResolvedValueOnce(row);
    expect(await store.getEnvironment('w', 'e1')).toEqual(row);
    db.apiEnvironmentRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.getEnvironment('w', 'x')).toBeNull();

    db.apiEnvironmentRecord.upsert.mockResolvedValue(row);
    const environment = {
      ...row,
      variables: [{ key: 'a', value: 'b' }],
    } as unknown as ApiEnvironment;
    expect(await store.saveEnvironment(environment)).toEqual(row);
    expect(db.apiEnvironmentRecord.upsert.mock.calls[0]![0].create).toMatchObject({
      id: 'e1',
      createdBy: 'u',
    });
    await store.saveEnvironment({ ...environment, createdBy: undefined });
    expect(db.apiEnvironmentRecord.upsert.mock.calls[1]![0].create.createdBy).toBeNull();

    db.apiEnvironmentRecord.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.deleteEnvironment('w', 'e1')).toBe(true);
    db.apiEnvironmentRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.deleteEnvironment('w', 'e1')).toBe(false);
  });
});

describe('PrismaApiTestStore scenarios', () => {
  const row = (definition: unknown) => ({
    id: 's1',
    workspaceId: 'w',
    collectionId: 'c1',
    name: 'Load',
    definition,
    createdBy: 'u',
    createdAt: NOW,
    updatedAt: NOW,
  });

  it('merges the stored definition into the scenario', async () => {
    const { db, store } = build();
    db.loadScenarioRecord.findMany.mockResolvedValue([row({ profile: 'smoke' }), row(null)]);
    const scenarios = await store.listScenarios('w');
    expect(scenarios[0]).toMatchObject({ id: 's1', profile: 'smoke' });
    expect(scenarios[1]).not.toHaveProperty('profile');
    db.loadScenarioRecord.findFirst.mockResolvedValueOnce(row({ profile: 'x' }));
    expect(await store.getScenario('w', 's1')).toMatchObject({ profile: 'x' });
    db.loadScenarioRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.getScenario('w', 's1')).toBeNull();
  });

  it('saves and deletes scenarios', async () => {
    const { db, store } = build();
    db.loadScenarioRecord.upsert.mockResolvedValue(row({ profile: 'smoke' }));
    const saved = await store.saveScenario({
      ...row(undefined),
      definition: undefined,
      profile: 'smoke',
    } as unknown as LoadScenario);
    expect(saved).toMatchObject({ profile: 'smoke' });
    const call = db.loadScenarioRecord.upsert.mock.calls[0]![0];
    expect(call.update).toEqual({
      name: 'Load',
      collectionId: 'c1',
      definition: { profile: 'smoke' },
    });
    expect(call.create).toMatchObject({ id: 's1', workspaceId: 'w', createdBy: 'u' });
    db.loadScenarioRecord.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.deleteScenario('w', 's1')).toBe(true);
    db.loadScenarioRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.deleteScenario('w', 's1')).toBe(false);
  });
});

describe('PrismaApiTestStore runs', () => {
  it('creates and reads runs, normalizing item ids and results', async () => {
    const { db, store } = build();
    db.apiRunRecord.create.mockResolvedValue(runRow());
    const created = await store.createRun({
      workspaceId: 'w',
      kind: 'integration',
      collectionId: 'c1',
      scenarioId: null,
      environmentId: null,
      itemIds: ['a'],
      name: 'Run',
      target: 'remote',
      requestedBy: 'u',
      payload: null,
    });
    expect(created).toMatchObject({ id: 'r1', itemIds: ['a'], result: null });
    expect(db.apiRunRecord.create.mock.calls[0]![0].data.itemIds).toEqual(['a']);

    db.apiRunRecord.findFirst.mockResolvedValueOnce(runRow({ itemIds: null, result: { ok: 1 } }));
    expect(await store.getRun('w', 'r1')).toMatchObject({ itemIds: [], result: { ok: 1 } });
    db.apiRunRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.getRun('w', 'r1')).toBeNull();
  });

  it('lists runs with filters, a capped limit and no payloads', async () => {
    const { db, store } = build();
    db.apiRunRecord.findMany.mockResolvedValue([runRow({ payload: 'secret' })]);
    const [run] = await store.listRuns('w');
    expect(run!.payload).toBeNull();
    expect(db.apiRunRecord.findMany.mock.calls[0]![0]).toMatchObject({
      where: { workspaceId: 'w' },
      take: 50,
      omit: { payload: true },
    });
    await store.listRuns('w', { kind: 'load', collectionId: 'c1', scenarioId: 's1', limit: 500 });
    expect(db.apiRunRecord.findMany.mock.calls[1]![0]).toMatchObject({
      where: { workspaceId: 'w', kind: 'load', collectionId: 'c1', scenarioId: 's1' },
      take: 200,
    });
  });

  const rawRow = {
    id: 'r1',
    workspace_id: 'w',
    kind: 'load',
    collection_id: 'c1',
    scenario_id: 's1',
    environment_id: 'e1',
    item_ids: ['a'],
    name: 'Run',
    target: 'local',
    status: 'running',
    requested_by: 'u',
    claimed_by: 'worker',
    claim_label: 'ADK worker',
    heartbeat_at: NOW,
    attempts: 1,
    payload: null,
    result: null,
    error: null,
    created_at: NOW,
    started_at: NOW,
    finished_at: null,
  };

  it('claims remote and local runs through raw queries', async () => {
    const { db, store } = build();
    db.$queryRaw.mockResolvedValueOnce([rawRow]);
    expect(await store.claimRemote('worker')).toMatchObject({
      id: 'r1',
      workspaceId: 'w',
      collectionId: 'c1',
      claimedBy: 'worker',
      status: 'running',
      requestedBy: 'u',
      startedAt: NOW,
    });
    db.$queryRaw.mockResolvedValueOnce([]);
    expect(await store.claimRemote('worker')).toBeNull();
    db.$queryRaw.mockResolvedValueOnce([rawRow]);
    expect(
      await store.claimLocal({ workspaceId: 'w', userId: 'u' }, { id: 'runner', label: 'Mine' }),
    ).toMatchObject({ id: 'r1' });
    db.$queryRaw.mockResolvedValueOnce([]);
    expect(
      await store.claimLocal({ workspaceId: 'w', userId: 'u' }, { id: 'runner', label: 'Mine' }),
    ).toBeNull();
  });

  it('keeps runs alive and reports their status', async () => {
    const { db, store } = build();
    db.apiRunRecord.updateMany.mockResolvedValue({ count: 1 });
    db.apiRunRecord.findFirst.mockResolvedValueOnce({ status: 'running' });
    expect(await store.heartbeat('r1', 'w1')).toBe('running');
    expect(db.apiRunRecord.updateMany.mock.calls[0]![0].data).not.toHaveProperty('result');
    db.apiRunRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.heartbeat('r1', 'w1', { total: 1 } as never)).toBeNull();
    expect(db.apiRunRecord.updateMany.mock.calls[1]![0].data.result).toEqual({ total: 1 });
  });

  it('records outcomes, cancels, sweeps and deletes', async () => {
    const { db, store } = build();
    db.apiRunRecord.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(
      await store.finish('r1', 'w1', {
        status: 'passed',
        result: { total: 1 } as never,
        error: null,
      }),
    ).toBe(true);
    expect(db.apiRunRecord.updateMany.mock.calls[0]![0].data).toMatchObject({
      status: 'passed',
      result: { total: 1 },
      payload: null,
    });
    db.apiRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.finish('r1', 'w1', { status: 'error', result: null, error: 'boom' })).toBe(
      false,
    );
    expect(db.apiRunRecord.updateMany.mock.calls[1]![0].data.result).toBeUndefined();

    db.apiRunRecord.updateMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.cancel('w', 'r1')).toBe(true);
    db.apiRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.cancel('w', 'r1')).toBe(false);

    db.apiRunRecord.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 });
    expect(await store.sweep(NOW, 3)).toEqual({ requeued: 3, failed: 2 });

    db.apiRunRecord.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.deleteRun('w', 'r1')).toBe(true);
    db.apiRunRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.deleteRun('w', 'r1')).toBe(false);
  });
});

describe('PrismaApiTestStore personal values', () => {
  const key = { workspaceId: 'w', userId: 'u', scope: 'collection', scopeId: 'c1' } as const;

  it('lists values as a map', async () => {
    const { db, store } = build();
    db.apiPersonalValueRecord.findMany.mockResolvedValue([{ ref: 'a', value: 'x' }]);
    expect(await store.listPersonalValues(key)).toEqual(new Map([['a', 'x']]));
    expect(db.apiPersonalValueRecord.findMany.mock.calls[0]![0].where).toEqual(key);
  });

  it('upserts values in one transaction and skips empty input', async () => {
    const { db, store } = build();
    await store.upsertPersonalValues(key, new Map());
    expect(db.$transaction).not.toHaveBeenCalled();
    await store.upsertPersonalValues(key, new Map([['a', 'x']]));
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.apiPersonalValueRecord.upsert).toHaveBeenCalledWith({
      where: { personalValueKey: { ...key, ref: 'a' } },
      create: { ...key, ref: 'a', value: 'x' },
      update: { value: 'x' },
    });
  });

  it('deletes values and scopes', async () => {
    const { db, store } = build();
    db.apiPersonalValueRecord.deleteMany.mockResolvedValueOnce({ count: 1 });
    expect(await store.deletePersonalValue(key, 'a')).toBe(true);
    db.apiPersonalValueRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.deletePersonalValue(key, 'a')).toBe(false);
    await store.deletePersonalScope('w', 'collection', 'c1');
    expect(db.apiPersonalValueRecord.deleteMany).toHaveBeenLastCalledWith({
      where: { workspaceId: 'w', scope: 'collection', scopeId: 'c1' },
    });
    await store.deleteUserPersonalScope(key);
    expect(db.apiPersonalValueRecord.deleteMany).toHaveBeenLastCalledWith({ where: key });
  });
});
