import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaApiTestStore } from '../src/modules/apitests/adapters/prisma-api-test-store.js';
import type {
  ApiCollection,
  ApiEnvironment,
  LoadScenario,
} from '../src/modules/apitests/domain/api-test.js';

const at = new Date('2026-02-01T00:00:00Z');

function model() {
  return {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  };
}

function setup() {
  const db = {
    apiCollectionRecord: model(),
    apiEnvironmentRecord: model(),
    loadScenarioRecord: model(),
    apiRunRecord: model(),
    $queryRaw: vi.fn(),
  };
  return { db, store: new PrismaApiTestStore(db as unknown as PrismaClient) };
}

const collectionRow = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Users',
  description: 'User API',
  definition: { variables: [{ key: 'base', value: 'x' }], auth: { type: 'bearer' }, items: [] },
  source: { kind: 'postman' },
  createdBy: 'u1',
  createdAt: at,
  updatedAt: at,
};

const runRow = {
  id: 'r1',
  workspaceId: 'w1',
  kind: 'integration',
  collectionId: 'c1',
  scenarioId: null,
  environmentId: null,
  itemIds: ['a'],
  name: 'Run',
  target: 'remote',
  status: 'queued',
  requestedBy: 'u1',
  claimedBy: null,
  claimLabel: null,
  heartbeatAt: null,
  attempts: 0,
  payload: '{}',
  result: null,
  error: null,
  createdAt: at,
  startedAt: null,
  finishedAt: null,
};

const rawRow = {
  id: 'r1',
  workspace_id: 'w1',
  kind: 'load',
  collection_id: 'c1',
  scenario_id: 's1',
  environment_id: 'e1',
  item_ids: 'not-an-array',
  name: 'Run',
  target: 'local',
  status: 'running',
  requested_by: 'u1',
  claimed_by: 'runner',
  claim_label: 'Laptop',
  heartbeat_at: at,
  attempts: 1,
  payload: '{}',
  result: { passed: true },
  error: null,
  created_at: at,
  started_at: at,
  finished_at: null,
};

describe('PrismaApiTestStore collections', () => {
  it('maps rows with defaults for empty definitions and sources', async () => {
    const { db, store } = setup();
    db.apiCollectionRecord.findMany.mockResolvedValue([
      collectionRow,
      { ...collectionRow, id: 'c2', description: null, definition: null, source: null },
    ]);
    const [full, bare] = await store.listCollections('w1');
    expect(full).toMatchObject({
      description: 'User API',
      auth: { type: 'bearer' },
      source: { kind: 'postman' },
    });
    expect(bare).toEqual({
      id: 'c2',
      workspaceId: 'w1',
      name: 'Users',
      variables: [],
      auth: { type: 'none' },
      items: [],
      source: { kind: 'manual' },
      createdBy: 'u1',
      createdAt: at,
      updatedAt: at,
    });

    db.apiCollectionRecord.findFirst
      .mockResolvedValueOnce(collectionRow)
      .mockResolvedValueOnce(null);
    expect((await store.getCollection('w1', 'c1'))?.id).toBe('c1');
    expect(await store.getCollection('w1', 'c9')).toBeNull();

    db.apiCollectionRecord.upsert.mockResolvedValue(collectionRow);
    const input = {
      ...collectionRow,
      variables: [{ key: 'k', value: undefined }],
      auth: { type: 'none' },
      items: [],
      source: { kind: 'manual' },
    } as unknown as ApiCollection;
    await store.saveCollection({ ...input, description: undefined });
    const call = db.apiCollectionRecord.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 'c1' });
    expect(call.create).toMatchObject({ id: 'c1', workspaceId: 'w1', description: null });
    expect(call.update.definition).toEqual({
      variables: [{ key: 'k' }],
      auth: { type: 'none' },
      items: [],
    });

    db.apiCollectionRecord.deleteMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    expect(await store.deleteCollection('w1', 'c1')).toBe(true);
    expect(await store.deleteCollection('w1', 'c1')).toBe(false);
  });
});

describe('PrismaApiTestStore environments and scenarios', () => {
  it('stores environments and scenarios as JSON definitions', async () => {
    const { db, store } = setup();
    const envRow = {
      id: 'e1',
      workspaceId: 'w1',
      name: 'Dev',
      variables: [],
      createdAt: at,
      updatedAt: at,
    };
    db.apiEnvironmentRecord.findMany.mockResolvedValue([envRow]);
    expect(await store.listEnvironments('w1')).toEqual([envRow]);
    db.apiEnvironmentRecord.findFirst.mockResolvedValueOnce(envRow).mockResolvedValueOnce(null);
    expect(await store.getEnvironment('w1', 'e1')).toEqual(envRow);
    expect(await store.getEnvironment('w1', 'e2')).toBeNull();
    db.apiEnvironmentRecord.upsert.mockResolvedValue(envRow);
    expect(await store.saveEnvironment(envRow as ApiEnvironment)).toEqual(envRow);
    expect(db.apiEnvironmentRecord.upsert.mock.calls[0]![0].create).toMatchObject({
      id: 'e1',
      workspaceId: 'w1',
    });
    db.apiEnvironmentRecord.deleteMany.mockResolvedValue({ count: 1 });
    expect(await store.deleteEnvironment('w1', 'e1')).toBe(true);

    const scenarioRow = {
      id: 's1',
      workspaceId: 'w1',
      collectionId: 'c1',
      name: 'Spike',
      definition: { profile: 'spike' },
      createdBy: 'u1',
      createdAt: at,
      updatedAt: at,
    };
    db.loadScenarioRecord.findMany.mockResolvedValue([
      scenarioRow,
      { ...scenarioRow, definition: null },
    ]);
    const [first, second] = await store.listScenarios('w1');
    expect(first).toMatchObject({ profile: 'spike', name: 'Spike' });
    expect(second).not.toHaveProperty('profile');
    db.loadScenarioRecord.findFirst.mockResolvedValueOnce(scenarioRow).mockResolvedValueOnce(null);
    expect((await store.getScenario('w1', 's1'))?.id).toBe('s1');
    expect(await store.getScenario('w1', 's2')).toBeNull();
    db.loadScenarioRecord.upsert.mockResolvedValue(scenarioRow);
    await store.saveScenario({
      ...scenarioRow,
      profile: 'spike',
      definition: undefined,
    } as unknown as LoadScenario);
    const upsert = db.loadScenarioRecord.upsert.mock.calls[0]![0];
    expect(upsert.update).toEqual({
      name: 'Spike',
      collectionId: 'c1',
      definition: { profile: 'spike' },
    });
    expect(upsert.create).toMatchObject({ id: 's1', workspaceId: 'w1', createdBy: 'u1' });
    db.loadScenarioRecord.deleteMany.mockResolvedValue({ count: 0 });
    expect(await store.deleteScenario('w1', 's1')).toBe(false);
  });
});

describe('PrismaApiTestStore runs', () => {
  it('creates, reads and lists runs with filters', async () => {
    const { db, store } = setup();
    db.apiRunRecord.create.mockResolvedValue({ ...runRow, itemIds: null });
    const created = await store.createRun({ ...runRow } as never);
    expect(created.itemIds).toEqual([]);
    expect(db.apiRunRecord.create.mock.calls[0]![0].data).toMatchObject({
      itemIds: ['a'],
      payload: '{}',
    });

    db.apiRunRecord.findFirst.mockResolvedValueOnce(runRow).mockResolvedValueOnce(null);
    expect((await store.getRun('w1', 'r1'))?.itemIds).toEqual(['a']);
    expect(await store.getRun('w1', 'r2')).toBeNull();

    db.apiRunRecord.findMany.mockResolvedValue([runRow]);
    expect((await store.listRuns('w1'))[0]!.payload).toBeNull();
    expect(db.apiRunRecord.findMany.mock.calls[0]![0]).toMatchObject({
      where: { workspaceId: 'w1' },
      take: 50,
    });
    await store.listRuns('w1', { kind: 'load', collectionId: 'c1', scenarioId: 's1', limit: 999 });
    expect(db.apiRunRecord.findMany.mock.calls[1]![0]).toMatchObject({
      where: { workspaceId: 'w1', kind: 'load', collectionId: 'c1', scenarioId: 's1' },
      take: 200,
    });
  });

  it('claims runs with raw SQL and maps column names', async () => {
    const { db, store } = setup();
    db.$queryRaw.mockResolvedValueOnce([rawRow]).mockResolvedValueOnce([]);
    expect(await store.claimRemote('worker')).toMatchObject({
      workspaceId: 'w1',
      kind: 'load',
      scenarioId: 's1',
      itemIds: [],
      claimLabel: 'Laptop',
      result: { passed: true },
    });
    expect(await store.claimRemote('worker')).toBeNull();
    db.$queryRaw.mockResolvedValueOnce([rawRow]).mockResolvedValueOnce([]);
    expect(
      (await store.claimLocal({ workspaceId: 'w1', userId: 'u1' }, { id: 'r', label: 'L' }))?.id,
    ).toBe('r1');
    expect(
      await store.claimLocal({ workspaceId: 'w1', userId: 'u1' }, { id: 'r', label: 'L' }),
    ).toBeNull();
  });

  it('heartbeats, finishes, cancels, sweeps and deletes', async () => {
    const { db, store } = setup();
    db.apiRunRecord.updateMany.mockResolvedValue({ count: 1 });
    db.apiRunRecord.findFirst
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce(null);
    expect(await store.heartbeat('r1', 'w', { passed: 1 } as never)).toBe('running');
    expect(db.apiRunRecord.updateMany.mock.calls[0]![0].data.result).toEqual({ passed: 1 });
    expect(await store.heartbeat('r1', 'w')).toBeNull();
    expect(db.apiRunRecord.updateMany.mock.calls[1]![0].data).not.toHaveProperty('result');

    expect(
      await store.finish('r1', 'w', {
        status: 'passed',
        result: { total: 1 } as never,
        error: null,
      }),
    ).toBe(true);
    expect(db.apiRunRecord.updateMany.mock.calls[2]![0].data.result).toEqual({ total: 1 });
    db.apiRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.finish('r1', 'w', { status: 'error', result: null, error: 'x' })).toBe(
      false,
    );
    expect(db.apiRunRecord.updateMany.mock.calls[3]![0].data.result).toBeUndefined();

    expect(await store.cancel('w1', 'r1')).toBe(true);
    db.apiRunRecord.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 3 });
    expect(await store.sweep(at, 2)).toEqual({ failed: 2, requeued: 3 });

    db.apiRunRecord.deleteMany.mockResolvedValue({ count: 1 });
    expect(await store.deleteRun('w1', 'r1')).toBe(true);
    expect(db.apiRunRecord.deleteMany.mock.calls[0]![0].where.status).toEqual({
      notIn: ['queued', 'running'],
    });
  });
});
