import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../src/shared/context.js';
import type {
  ApiCollection,
  ApiEnvironment,
  ApiRun,
  LoadScenario,
} from '../src/modules/apitests/domain/api-test.js';
import {
  InMemoryApiTestStore,
  type NewApiRun,
} from '../src/modules/apitests/application/api-test-store.js';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import {
  WorkspaceSourceLoader,
  type WorkspaceSourceLoaderOptions,
} from '../src/modules/apitests/adapters/workspace-source-loader.js';

const now = new Date('2026-01-01T00:00:00Z');

function collection(id: string, workspaceId: string, name: string): ApiCollection {
  return {
    id,
    workspaceId,
    name,
    source: { kind: 'manual' },
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  } as unknown as ApiCollection;
}

function environment(id: string, workspaceId: string, name: string): ApiEnvironment {
  return { id, workspaceId, name, variables: [], createdAt: now, updatedAt: now };
}

function scenario(id: string, workspaceId: string, name: string, collectionId: string) {
  return {
    id,
    workspaceId,
    name,
    collectionId,
    createdBy: 'u1',
    createdAt: now,
    updatedAt: now,
  } as unknown as LoadScenario;
}

function newRun(overrides: Partial<NewApiRun> = {}): NewApiRun {
  return {
    workspaceId: 'w1',
    kind: 'integration',
    collectionId: 'c1',
    scenarioId: null,
    environmentId: null,
    itemIds: [],
    name: 'run',
    target: 'remote',
    requestedBy: 'u1',
    payload: '{}',
    ...overrides,
  };
}

describe('InMemoryApiTestStore', () => {
  it('scopes, sorts and deletes collections, environments and scenarios by workspace', async () => {
    const store = new InMemoryApiTestStore();
    await store.saveCollection(collection('c2', 'w1', 'Beta'));
    await store.saveCollection(collection('c1', 'w1', 'Alpha'));
    await store.saveCollection(collection('cx', 'w2', 'Other'));
    expect((await store.listCollections('w1')).map((c) => c.name)).toEqual(['Alpha', 'Beta']);
    expect(await store.getCollection('w2', 'c1')).toBeNull();

    await store.saveEnvironment(environment('e2', 'w1', 'Staging'));
    await store.saveEnvironment(environment('e1', 'w1', 'Dev'));
    expect((await store.listEnvironments('w1')).map((e) => e.name)).toEqual(['Dev', 'Staging']);
    expect(await store.getEnvironment('w1', 'e1')).not.toBeNull();
    expect(await store.getEnvironment('w2', 'e1')).toBeNull();
    expect(await store.deleteEnvironment('w2', 'e1')).toBe(false);
    expect(await store.deleteEnvironment('w1', 'e1')).toBe(true);
    expect(await store.listEnvironments('w1')).toHaveLength(1);

    await store.saveScenario(scenario('s2', 'w1', 'Spike', 'c1'));
    await store.saveScenario(scenario('s1', 'w1', 'Load', 'c2'));
    expect((await store.listScenarios('w1')).map((s) => s.name)).toEqual(['Load', 'Spike']);
    expect(await store.getScenario('w1', 's1')).not.toBeNull();
    expect(await store.getScenario('w2', 's1')).toBeNull();
    expect(await store.deleteScenario('w2', 's1')).toBe(false);
    expect(await store.deleteScenario('w1', 's1')).toBe(true);

    await store.saveScenario(scenario('s3', 'w1', 'Soak', 'c2'));

    // Deleting a collection removes its scenarios, only in the owning workspace.
    expect(await store.deleteCollection('w2', 'c1')).toBe(false);
    expect(await store.deleteCollection('w1', 'c1')).toBe(true);
    expect((await store.listScenarios('w1')).map((s) => s.id)).toEqual(['s3']);
  });

  it('filters runs, claims local runs and sweeps stale ones', async () => {
    const store = new InMemoryApiTestStore();
    const load = await store.createRun(newRun({ kind: 'load', scenarioId: 's1', target: 'local' }));
    await store.createRun(newRun({ collectionId: 'c2' }));
    expect(await store.getRun('w2', load.id)).toBeNull();
    expect((await store.listRuns('w1', { kind: 'load' })).map((r) => r.id)).toEqual([load.id]);
    expect(await store.listRuns('w1', { collectionId: 'c2' })).toHaveLength(1);
    expect(await store.listRuns('w1', { scenarioId: 's1' })).toHaveLength(1);
    expect(await store.listRuns('w1', { limit: 1 })).toHaveLength(1);

    expect(
      await store.claimLocal({ workspaceId: 'w1', userId: 'other' }, { id: 'r', label: 'R' }),
    ).toBeNull();
    const claimed = await store.claimLocal(
      { workspaceId: 'w1', userId: 'u1' },
      { id: 'runner-1', label: 'Laptop' },
    );
    expect(claimed).toMatchObject({ id: load.id, claimedBy: 'runner-1', claimLabel: 'Laptop' });

    // Heartbeat of a stranger is refused, a valid one keeps partial results.
    expect(await store.heartbeat(load.id, 'other')).toBeNull();
    expect(await store.heartbeat('missing', 'runner-1')).toBeNull();
    const partial = { requests: 1 } as unknown as ApiRun['result'];
    expect(await store.heartbeat(load.id, 'runner-1', partial)).toBe('running');
    expect((await store.getRun('w1', load.id))?.result).toEqual(partial);
    expect(await store.heartbeat(load.id, 'runner-1')).toBe('running');

    // Stale with attempts left: back to the queue; then claimed again and failing on sweep.
    const future = new Date(Date.now() + 60_000);
    expect(await store.sweep(future, 2)).toEqual({ requeued: 1, failed: 0 });
    expect((await store.getRun('w1', load.id))?.status).toBe('queued');
    await store.claimLocal({ workspaceId: 'w1', userId: 'u1' }, { id: 'runner-1', label: 'L' });
    expect(await store.sweep(future, 2)).toEqual({ requeued: 0, failed: 1 });
    const errored = await store.getRun('w1', load.id);
    expect(errored).toMatchObject({ status: 'error', error: 'The run stopped responding.' });
    // A finished run still answers heartbeats with its status, without changing it.
    expect(await store.heartbeat(load.id, 'runner-1')).toBe('error');
    expect(await store.sweep(future, 2)).toEqual({ requeued: 0, failed: 0 });
  });
});

describe('InMemoryApiTestStore run lifecycle', () => {
  it('claims remote runs, finishes only held runs, cancels and deletes ended ones', async () => {
    const store = new InMemoryApiTestStore();
    await store.saveCollection(collection('c1', 'w1', 'Alpha'));
    expect(await store.getCollection('w1', 'c1')).not.toBeNull();
    const run = await store.createRun(newRun());
    expect(await store.deleteRun('w1', run.id)).toBe(false); // still active
    const claimed = await store.claimRemote('worker');
    expect(claimed).toMatchObject({ id: run.id, claimLabel: 'ADK worker', attempts: 1 });
    expect(await store.claimRemote('worker')).toBeNull();
    const outcome = { status: 'passed' as const, result: null, error: null };
    expect(await store.finish(run.id, 'stranger', outcome)).toBe(false);
    expect(await store.finish(run.id, 'worker', outcome)).toBe(true);
    expect(await store.finish(run.id, 'worker', outcome)).toBe(false);
    expect(await store.cancel('w1', run.id)).toBe(false);
    expect(await store.deleteRun('w2', run.id)).toBe(false);
    expect(await store.deleteRun('w1', run.id)).toBe(true);

    const queued = await store.createRun(newRun());
    expect(await store.cancel('w2', queued.id)).toBe(false);
    expect(await store.cancel('w1', queued.id)).toBe(true);
    expect((await store.getRun('w1', queued.id))?.status).toBe('cancelled');
  });
});

function baseRun(id: string): ApiRun {
  return { id, workspaceId: 'w1', payload: '{}' } as unknown as ApiRun;
}

describe('ApiTestWorker', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports status, records executor errors and survives finish failures', async () => {
    const runs = [baseRun('r1')];
    const finish = vi.fn().mockRejectedValue(new Error('db down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onIdle = vi.fn();
    const worker = new ApiTestWorker({
      service: {
        sweep: vi.fn().mockResolvedValue({ requeued: 0, failed: 0 }),
        claimRemote: vi.fn().mockImplementation(() => Promise.resolve(runs.shift() ?? null)),
        payloadOf: vi.fn().mockImplementation(() => {
          throw 'bad payload';
        }),
        heartbeat: vi.fn(),
        finish,
      },
      onIdle,
      hostAlias: 'host.docker.internal',
    });
    expect(worker.workerId).toMatch(/^api-worker-/);
    expect(worker.status).toEqual({ workerId: worker.workerId, active: 0, draining: false });
    worker.wake();
    worker.wake();
    expect(worker.status.draining).toBe(true);
    await worker.idle();
    expect(finish).toHaveBeenCalledWith('r1', worker.workerId, {
      status: 'error',
      result: null,
      error: 'bad payload',
    });
    expect(error).toHaveBeenCalledWith('[ApiTestWorker] Could not finish run:', expect.any(Error));
    expect(onIdle).toHaveBeenCalled();
  });

  it('logs a failed drain and records Error messages', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = new ApiTestWorker({
      service: {
        sweep: vi.fn().mockRejectedValue(new Error('sweep failed')),
        claimRemote: vi.fn(),
        payloadOf: vi.fn(),
        heartbeat: vi.fn(),
        finish: vi.fn(),
      },
    });
    failing.wake();
    await failing.idle();
    expect(error).toHaveBeenCalledWith('[ApiTestWorker] Drain failed:', expect.any(Error));

    const runs = [baseRun('r2')];
    const finish = vi.fn().mockResolvedValue(true);
    const worker = new ApiTestWorker({
      workerId: 'w-1',
      concurrency: 0,
      fetch: vi.fn(),
      service: {
        sweep: vi.fn().mockResolvedValue({ requeued: 0, failed: 0 }),
        claimRemote: vi.fn().mockImplementation(() => Promise.resolve(runs.shift() ?? null)),
        payloadOf: vi.fn().mockImplementation(() => {
          throw new Error('corrupt');
        }),
        heartbeat: vi.fn(),
        finish,
      },
    });
    worker.wake();
    await worker.idle();
    expect(finish).toHaveBeenCalledWith('r2', 'w-1', expect.objectContaining({ error: 'corrupt' }));
  });
});

describe('ApiTestWorker executing a run', () => {
  it('runs the payload through the default guard, reporting heartbeats until finished', async () => {
    const runs = [baseRun('r3')];
    const finish = vi.fn().mockResolvedValue(true);
    const states = ['running', 'cancelled'];
    const heartbeat = vi.fn().mockImplementation(() => Promise.resolve(states.shift() ?? null));
    const fakeFetch = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return new Response('ok', { status: 200 });
    });
    const worker = new ApiTestWorker({
      workerId: 'w-2',
      heartbeatMs: 10,
      hostAlias: 'host.docker.internal',
      fetch: fakeFetch,
      service: {
        sweep: vi.fn().mockResolvedValue({ requeued: 0, failed: 0 }),
        claimRemote: vi.fn().mockImplementation(() => Promise.resolve(runs.shift() ?? null)),
        payloadOf: vi.fn().mockReturnValue({
          kind: 'integration',
          collection: {
            name: 'Health',
            variables: [],
            auth: { type: 'none' },
            items: [
              {
                type: 'request',
                id: 'health',
                name: 'health',
                method: 'GET',
                url: 'http://localhost:9/health',
                headers: [],
                query: [],
                body: { mode: 'none' },
                auth: { type: 'inherit' },
                assertions: [],
                captures: [],
              },
            ],
          },
          environment: [],
          itemIds: [],
          bail: false,
        }),
        heartbeat,
        finish,
      },
    });
    worker.wake();
    await worker.idle();
    expect(fakeFetch).toHaveBeenCalled();
    expect(heartbeat).toHaveBeenCalledWith('r3', 'w-2', null);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(finish).toHaveBeenCalledWith('r3', 'w-2', expect.objectContaining({ error: null }));
  });
});

describe('ApiTestWorker defaults', () => {
  it('uses the global fetch and default heartbeat for a run without requests', async () => {
    const runs = [baseRun('r4')];
    const finish = vi.fn().mockResolvedValue(true);
    const worker = new ApiTestWorker({
      guard: () => Promise.resolve(),
      service: {
        sweep: vi.fn().mockResolvedValue({ requeued: 0, failed: 0 }),
        claimRemote: vi.fn().mockImplementation(() => Promise.resolve(runs.shift() ?? null)),
        payloadOf: vi.fn().mockReturnValue({
          kind: 'integration',
          collection: { name: 'Empty', variables: [], auth: { type: 'none' }, items: [] },
          environment: [],
          itemIds: [],
          bail: false,
        }),
        heartbeat: vi.fn(),
        finish,
      },
    });
    worker.wake();
    await worker.idle();
    expect(finish).toHaveBeenCalledWith(
      'r4',
      worker.workerId,
      expect.objectContaining({ status: 'passed', error: null }),
    );
  });
});

describe('WorkspaceSourceLoader', () => {
  const context = { workspaceId: 'w1' } as RequestContext;

  function loader(overrides: Partial<Record<keyof WorkspaceSourceLoaderOptions, unknown>> = {}) {
    const plan = {
      id: 'p1',
      title: 'Login plan',
      suiteId: 's1',
      plans: [
        {
          title: 'Valid login',
          description: 'Happy path',
          steps: [
            { action: 'Open login', expectedResult: 'Form shown' },
            { action: 'Submit', data: 'user/pass', expectedResult: 'Logged in' },
          ],
        },
        { title: 'No description', description: '', steps: [] },
      ],
    };
    return new WorkspaceSourceLoader({
      tests: {
        find: vi
          .fn()
          .mockImplementation((id: string) => Promise.resolve(id === 'p1' ? plan : null)),
        list: vi.fn().mockResolvedValue([plan, { ...plan, id: 'p2', suiteId: 'other' }]),
      },
      suites: {
        find: vi
          .fn()
          .mockImplementation((id: string) =>
            Promise.resolve(id === 'missing' ? null : { id, name: `Suite ${id}` }),
          ),
      },
      knowledge: {
        all: vi.fn().mockResolvedValue([
          { pageId: 'pg', chunkIndex: 1, content: 'second', source: 'wiki/Docs/My%20Page' },
          { pageId: 'pg', chunkIndex: 0, content: 'first', source: 'wiki/Docs/My%20Page' },
          { pageId: 'root', chunkIndex: 0, content: 'root', source: '/' },
          { pageId: 'zz', chunkIndex: 0, content: 'x', source: 'x' },
        ]),
      },
      specs: {
        findSpecification: vi.fn().mockResolvedValue(null),
      },
      pbis: {
        get: vi
          .fn()
          .mockImplementation((_w: string, id: string) =>
            Promise.resolve(
              id === 'pbi1'
                ? { id, kind: 'story', title: 'Checkout', status: 'active', description: '' }
                : null,
            ),
          ),
        listChildren: vi
          .fn()
          .mockResolvedValue([{ kind: 'task', title: 'API', description: 'Build it' }]),
      },
      ...overrides,
    } as unknown as WorkspaceSourceLoaderOptions);
  }

  it('renders test plans and suites as numbered steps', async () => {
    const plan = await loader().load(context, { type: 'testPlan', id: 'p1' });
    expect(plan.title).toBe('Login plan');
    expect(plan.text).toContain('### Test case 1: Valid login');
    expect(plan.text).toContain('Case id: p1#0');
    expect(plan.text).toContain('1. Open login → Form shown');
    expect(plan.text).toContain('2. Submit (data: user/pass) → Logged in');
    expect(plan.text).toContain('### Test case 2: No description\nCase id: p1#1');

    const suite = await loader().load(context, { type: 'testSuite', id: 's1' });
    expect(suite).toMatchObject({ title: 'Suite s1' });
    expect(suite.text.startsWith('## Login plan')).toBe(true);
    const empty = await loader().load(context, { type: 'testSuite', id: 'none' });
    expect(empty.text).toBe('(empty suite)');
  });

  it('joins brain chunks in order and names them after the page', async () => {
    const page = await loader().load(context, { type: 'brain', id: 'pg' });
    expect(page).toMatchObject({ title: 'My Page', text: 'first\n\nsecond' });
    const root = await loader().load(context, { type: 'brain', id: 'root' });
    expect(root.title).toBe('root');
  });

  it('renders specs and PBIs with their children', async () => {
    const spec = { id: 'sp', title: 'Spec title', sections: [] };
    const withSpec = loader({
      specs: { findSpecification: vi.fn().mockResolvedValue(spec) },
    });
    const loaded = await withSpec.load(context, { type: 'spec', id: 'sp' });
    expect(loaded.title).toBe('Spec title');
    expect(loaded.text).toContain('Spec title');

    const pbi = await loader().load({} as RequestContext, { type: 'pbi', id: 'pbi1' });
    expect(pbi.text).toBe('STORY: Checkout (active)\n\n- task: API — Build it');
  });

  it.each([
    ['testPlan', 'nope'],
    ['testSuite', 'missing'],
    ['brain', 'nope'],
    ['spec', 'nope'],
    ['pbi', 'nope'],
  ] as const)('reports a missing %s as a 404', async (type, id) => {
    await expect(loader().load(context, { type, id })).rejects.toMatchObject({
      code: 'API_TEST_SOURCE_NOT_FOUND',
      statusCode: 404,
      message: `${type} '${id}' not found.`,
    });
  });
});
