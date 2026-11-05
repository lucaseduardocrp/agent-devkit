import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import {
  ApiTestService,
  extractJson,
} from '../src/modules/apitests/application/api-test-service.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import type { ApiRun } from '../src/modules/apitests/domain/api-test.js';
import type { RunPayload } from '../src/modules/apitests/engine/types.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

const W = 'w1';
const context = { workspaceId: W, actorId: 'u1', ownerId: 'owner' } as never;

const fakeLlm = (...answers: string[]): LlmPort =>
  ({
    provider: 'fake',
    complete: vi.fn(() => Promise.resolve({ text: answers.shift() ?? '' })),
    stream: () => (async function* () {})(),
  }) as unknown as LlmPort;

async function serviceWithCollection(
  options: Partial<ConstructorParameters<typeof ApiTestService>[0]> = {},
) {
  const store = new InMemoryApiTestStore();
  const service = new ApiTestService({ store, ...options });
  const collection = await service.saveCollection(
    W,
    'u1',
    ApiTestService.parseCollection({
      name: 'Orders',
      items: [
        { id: 'a', name: 'A', url: 'https://api.example.test/a' },
        { id: 'b', name: 'B', url: 'https://api.example.test/b' },
      ],
    }),
  );
  return { store, service, collection };
}

const smoke = (collectionId: string, extra: Record<string, unknown> = {}) => ({
  name: 'Smoke',
  collectionId,
  requests: [{ requestId: 'a' }],
  profile: 'smoke',
  stages: [{ durationSec: 1, targetVus: 1 }],
  ...extra,
});

describe('ApiTestService', () => {
  it('parses loose collections', () => {
    const parsed = ApiTestService.parseCollection({
      name: 'C',
      items: [
        {
          id: 'x',
          name: 'One',
          url: 'u',
          assertions: [{ id: 'k', source: 'status', operator: 'exists' }],
        },
        { id: 'x', name: 'Two', url: 'u', assertions: 'nope' },
        { name: 'Folder', items: [{ name: 'Three', url: 'u', method: 7 }] },
      ],
    });
    expect(parsed.items[0]?.id).toBe('x');
    expect(parsed.items[1]?.id).not.toBe('x');
    expect(parsed.items[2]).toMatchObject({ type: 'folder' });
    expect(() => ApiTestService.parseCollection(null)).toThrow();
    expect(() => ApiTestService.parseCollection({ name: 'C', items: 'x' })).toThrow();
    expect(() => ApiTestService.parseCollection({ name: 'C', items: [null] })).toThrow();
  });

  it('validates collections, environments and scenarios', async () => {
    const { service, collection } = await serviceWithCollection();
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `r${i}`, url: 'u' }));
    await expect(
      service.saveCollection(
        W,
        'u1',
        ApiTestService.parseCollection({
          name: 'Big',
          items: [
            { name: 'F', items: many.slice(0, 300) },
            { name: 'G', items: many.slice(300) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'API_TEST_INVALID' });
    await expect(service.deleteCollection(W, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteEnvironment(W, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getScenario(W, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteScenario(W, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.saveScenario(W, 'u1', { name: '' })).rejects.toMatchObject({
      code: 'API_TEST_INVALID',
    });
    const environment = await service.saveEnvironment(W, 'u1', { name: 'E', variables: [] });
    const scenario = await service.saveScenario(
      W,
      'u1',
      smoke(collection.id, { environmentId: environment.id }),
    );
    const updated = await service.saveScenario(W, 'u2', smoke(collection.id), scenario.id);
    expect(updated).toMatchObject({ id: scenario.id, createdBy: 'u1' });
    expect(await service.listScenarios(W)).toHaveLength(1);
    await service.deleteScenario(W, scenario.id);
    expect(await service.listScenarios(W)).toHaveLength(0);
  });

  it('starts, guards and records runs', async () => {
    const { store, service, collection } = await serviceWithCollection();
    const empty = await service.saveCollection(
      W,
      'u1',
      ApiTestService.parseCollection({ name: 'Empty' }),
    );
    await expect(
      service.startIntegrationRun(W, 'u1', { collectionId: empty.id }),
    ).rejects.toMatchObject({
      code: 'API_TEST_INVALID',
    });
    const environment = await service.saveEnvironment(W, 'u1', {
      name: 'Env',
      variables: [{ key: 'v', value: '1' }],
    });

    // Load runs.
    const scenario = await service.saveScenario(
      W,
      'u1',
      smoke(collection.id, { environmentId: environment.id, timeoutMs: 1_000 }),
    );
    await expect(
      service.startLoadRun(W, 'u1', { scenarioId: scenario.id, authorized: false }),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_NOT_AUTHORIZED' });
    const huge = await service.saveScenario(
      W,
      'u1',
      smoke(collection.id, { stages: [{ durationSec: 60, targetVus: 1_000 }] }),
    );
    await expect(
      service.startLoadRun(W, 'u1', { scenarioId: huge.id, authorized: true }),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_LIMIT' });
    // The user's computer may run what the ADK workers refuse; cancelled right away so that it
    // does not sit in the local queue before the integration runs claimed further down.
    const queuedLocally = await service.startLoadRun(W, 'u1', {
      scenarioId: huge.id,
      authorized: true,
      target: 'local',
    });
    expect(queuedLocally.status).toBe('queued');
    await service.cancelRun(W, queuedLocally.id);
    const load = await service.startLoadRun(W, 'u1', { scenarioId: scenario.id, authorized: true });
    await expect(
      service.startLoadRun(W, 'u1', { scenarioId: scenario.id, authorized: true }),
    ).rejects.toMatchObject({ code: 'LOAD_TEST_ALREADY_RUNNING' });
    const claimed = (await service.claimRemote('worker'))!;
    expect(
      (service.payloadOf(claimed) as Extract<RunPayload, { kind: 'load' }>).plan.timeoutMs,
    ).toBe(1_000);
    expect(await service.heartbeat(load.id, 'worker', null)).toBe('running');
    const summary = {
      totalRequests: 10,
      errorRate: 0.1,
      latency: { p95: 12.4 },
      rps: 3.33,
    };
    await service.finish(claimed, 'worker', {
      status: 'passed',
      result: summary as never,
      error: null,
    });

    // A scenario whose requests left the collection.
    const gone = await service.saveScenario(
      W,
      'u1',
      smoke(collection.id, { requests: [{ requestId: 'b' }] }),
    );
    await service.saveCollection(
      W,
      'u1',
      ApiTestService.parseCollection({
        name: 'Orders',
        items: [{ id: 'a', name: 'A', url: 'https://api.example.test/a' }],
      }),
      collection.id,
    );
    await expect(
      service.startLoadRun(W, 'u1', { scenarioId: gone.id, authorized: true }),
    ).rejects.toMatchObject({ code: 'API_TEST_INVALID' });

    // Integration run lifecycle.
    const run = await service.startIntegrationRun(W, 'u1', {
      collectionId: collection.id,
      target: 'local',
    });
    await expect(service.ownedRun(W, 'u2', run.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteRun(W, run.id)).rejects.toMatchObject({ code: 'API_RUN_ACTIVE' });
    expect((await service.cancelRun(W, run.id)).status).toBe('cancelled');
    await service.deleteRun(W, run.id);
    await expect(service.getRun(W, run.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(() => service.payloadOf({ payload: null } as ApiRun)).toThrow();

    const second = await service.startIntegrationRun(W, 'u1', {
      collectionId: collection.id,
      target: 'local',
    });
    const local = (await service.claimLocal(W, 'u1', { id: 'r', label: 'r' }))!;
    expect(local.id).toBe(second.id);
    await service.finish(local, 'r', {
      status: 'passed',
      result: { durationMs: 1_500, total: 1, passed: 1, failed: 0, results: [] },
      error: null,
    });
    const third = await service.startIntegrationRun(W, 'u1', {
      collectionId: collection.id,
      target: 'local',
    });
    await service.claimLocal(W, 'u1', { id: 'r', label: 'r' });
    await service.finish({ ...third }, 'r', { status: 'error', result: null, error: 'boom\nmore' });
    await service.finish({ ...third }, 'other', { status: 'error', result: null, error: null });
    expect(await service.sweep(new Date(), 2)).toEqual({ requeued: 0, failed: 0 });
    expect(await service.listRuns(W, { kind: 'integration' })).toHaveLength(2);
    expect(store).toBeDefined();
  });

  it('lets workers on a local install reach localhost', async () => {
    const { service } = await serviceWithCollection({ workersReachLocalhost: true });
    const collection = await service.saveCollection(
      W,
      'u1',
      ApiTestService.parseCollection({
        name: 'L',
        items: [{ name: 'l', url: 'http://localhost:1' }],
      }),
    );
    await expect(
      service.startIntegrationRun(W, 'u1', { collectionId: collection.id }),
    ).resolves.toMatchObject({
      status: 'queued',
    });
  });

  it('imports, exports and generates', async () => {
    const { service, collection } = await serviceWithCollection();
    const environment = await service.saveEnvironment(W, 'u1', {
      name: 'E',
      variables: [{ key: 's', value: 'x', secret: true }],
    });
    for (const format of ['adk', 'postman', 'insomnia', 'bruno'] as const) {
      const file = await service.exportCollection(W, collection.id, format, [environment.id]);
      expect(file.fileName).toContain('orders');
      expect(String(file.body)).not.toContain('"x"');
    }
    const weird = await service.saveCollection(
      W,
      'u1',
      ApiTestService.parseCollection({ name: '***' }),
    );
    expect((await service.exportCollection(W, weird.id, 'adk')).fileName).toBe(
      'collection.adk.json',
    );
    const imported = await service.importCollection(W, 'u1', {
      content: String((await service.exportCollection(W, collection.id, 'adk')).body),
    });
    expect(imported.collection.name).toBe('Orders');
    const scenario = await service.saveScenario(
      W,
      'u1',
      smoke(collection.id, { name: '!!!', environmentId: environment.id }),
    );
    expect((await service.exportK6(W, scenario.id)).fileName).toBe('load-test.k6.js');
    const plain = await service.saveScenario(W, 'u1', smoke(collection.id));
    expect((await service.exportK6(W, plain.id)).fileName).toBe('smoke.k6.js');

    await expect(
      service.prepareGeneration(W, context, {
        kind: 'integration',
        sources: [{ type: 'brain', id: 'p' }],
      }),
    ).rejects.toMatchObject({ code: 'API_TEST_SOURCES_UNAVAILABLE' });
    await expect(
      service.prepareGeneration(W, context, { kind: 'load', sources: [], instructions: 'x' }),
    ).rejects.toMatchObject({ code: 'API_TEST_INVALID' });
    const withSources = new ApiTestService({
      store: (service as unknown as { options: { store: InMemoryApiTestStore } }).options.store,
      sources: { load: (_c, ref) => Promise.resolve({ ...ref, title: 'Page', text: 'Body' }) },
    });
    const brief = await withSources.prepareGeneration(W, context, {
      kind: 'load',
      sources: [{ type: 'brain', id: 'p' }],
      collectionId: collection.id,
      baseUrl: 'https://api.example.test',
    });
    expect(brief.context).toContain('[brain: Page]');
    expect(brief.context).toContain('a: GET');
    expect(brief.output).toContain('load_save_scenario');

    await expect(
      service.generate(W, 'u1', context, { kind: 'integration', sources: [], instructions: 'x' }),
    ).rejects.toMatchObject({
      code: 'API_TEST_NO_LLM',
    });
    const factory = {
      resolveLlmProvider: vi.fn(() =>
        Promise.resolve(
          fakeLlm(
            'no json here',
            '{"scenario": {"name": "Gen", "requests": [{"requestId": "a"}], "profile": "smoke", "stages": [{"durationSec": 1, "targetVus": 1}]}}',
          ),
        ),
      ),
    } as unknown as DynamicProviderFactory;
    const generating = new ApiTestService({
      store: (service as unknown as { options: { store: InMemoryApiTestStore } }).options.store,
      dynamicProviderFactory: factory,
    });
    const generated = await generating.generate(W, 'u1', context, {
      kind: 'load',
      sources: [],
      instructions: 'peak',
      collectionId: collection.id,
    });
    expect(generated.scenario?.name).toBe('Gen');
    const failing = new ApiTestService({
      store: new InMemoryApiTestStore(),
      defaultLlm: fakeLlm('[1]', '{"collection": {"name": ""}}'),
    });
    await expect(
      failing.generate(W, 'u1', { ...(context as object), ownerId: undefined } as never, {
        kind: 'integration',
        sources: [],
        instructions: 'x',
      }),
    ).rejects.toMatchObject({ code: 'API_TEST_GENERATION_FAILED' });
    expect(() => extractJson('{"a":1')).toThrow('no JSON object');
    expect(() => extractJson('```json\nnull {}\n```')).not.toThrow();
  });
});

describe('InMemoryApiTestStore', () => {
  it('scopes data to the workspace and keeps the queue consistent', async () => {
    const { store, service, collection } = await serviceWithCollection();
    expect(await store.getCollection('other', collection.id)).toBeNull();
    expect(await store.deleteCollection('other', collection.id)).toBe(false);
    const environment = await service.saveEnvironment(W, 'u1', { name: 'E', variables: [] });
    expect(await store.getEnvironment('other', environment.id)).toBeNull();
    expect(await store.deleteEnvironment('other', environment.id)).toBe(false);
    const scenario = await service.saveScenario(W, 'u1', smoke(collection.id));
    expect(await store.getScenario('other', scenario.id)).toBeNull();
    expect(await store.deleteScenario('other', scenario.id)).toBe(false);
    await service.saveCollection(W, 'u1', ApiTestService.parseCollection({ name: 'Another' }));
    await service.saveEnvironment(W, 'u1', { name: 'Another', variables: [] });
    await service.saveScenario(W, 'u1', smoke(collection.id, { name: 'Another' }));
    expect((await store.listCollections(W)).map((item) => item.name)).toEqual([
      'Another',
      'Orders',
    ]);
    expect((await store.listEnvironments(W)).map((item) => item.name)).toEqual(['Another', 'E']);
    expect((await store.listScenarios(W)).map((item) => item.name)).toEqual(['Another', 'Smoke']);

    const first = await service.startIntegrationRun(W, 'u1', {
      collectionId: collection.id,
      target: 'local',
    });
    await service.startLoadRun(W, 'u1', {
      scenarioId: scenario.id,
      authorized: true,
      target: 'local',
    });
    expect(await store.getRun('other', first.id)).toBeNull();
    expect(await store.listRuns(W, { kind: 'load' })).toHaveLength(1);
    expect(await store.listRuns(W, { collectionId: 'none' })).toHaveLength(0);
    expect(await store.listRuns(W, { scenarioId: scenario.id })).toHaveLength(1);
    expect(
      await store.claimLocal({ workspaceId: W, userId: 'u2' }, { id: 'r', label: 'r' }),
    ).toBeNull();
    const claimed = (await store.claimLocal(
      { workspaceId: W, userId: 'u1' },
      { id: 'r', label: 'r' },
    ))!;
    expect(await store.heartbeat(claimed.id, 'other')).toBeNull();
    expect(
      await store.heartbeat(claimed.id, 'r', {
        durationMs: 1,
        total: 1,
        passed: 1,
        failed: 0,
        results: [],
      }),
    ).toBe('running');
    expect(
      await store.finish(claimed.id, 'other', { status: 'passed', result: null, error: null }),
    ).toBe(false);
    expect(await store.cancel('other', claimed.id)).toBe(false);
    await store.cancel(W, claimed.id);
    expect(await store.heartbeat(claimed.id, 'r')).toBe('cancelled');
    expect(await store.cancel(W, claimed.id)).toBe(false);
    expect(await store.deleteRun('other', claimed.id)).toBe(false);

    // Sweep: a stale run goes back to the queue, then fails after the last attempt.
    const stale = (await store.claimLocal(
      { workspaceId: W, userId: 'u1' },
      { id: 'r', label: 'r' },
    ))!;
    const later = new Date(Date.now() + 60_000);
    expect(await store.sweep(later, 5)).toEqual({ requeued: 1, failed: 0 });
    await store.claimLocal({ workspaceId: W, userId: 'u1' }, { id: 'r', label: 'r' });
    expect(await store.sweep(later, 1)).toEqual({ requeued: 0, failed: 1 });
    expect((await store.getRun(W, stale.id))?.status).toBe('error');
    expect(await store.claimRemote('worker')).toBeNull();

    // Personal values.
    const key = { workspaceId: W, userId: 'u1', scope: 'collection' as const, scopeId: 'c' };
    expect(await store.deletePersonalValue(key, 'x')).toBe(false);
    await store.upsertPersonalValues(key, new Map());
    await store.upsertPersonalValues(key, new Map([['x', '1']]));
    await store.upsertPersonalValues({ ...key, userId: 'u2' }, new Map([['x', '2']]));
    await store.upsertPersonalValues({ ...key, scopeId: 'd' }, new Map([['x', '3']]));
    await store.upsertPersonalValues({ ...key, workspaceId: 'w2' }, new Map([['x', '4']]));
    await store.upsertPersonalValues({ ...key, scope: 'runtime' }, new Map([['x', '5']]));
    await store.deletePersonalScope(W, 'collection', 'c');
    expect((await store.listPersonalValues(key)).size).toBe(0);
    expect((await store.listPersonalValues({ ...key, scopeId: 'd' })).size).toBe(1);
    expect((await store.listPersonalValues({ ...key, workspaceId: 'w2' })).size).toBe(1);
    expect((await store.listPersonalValues({ ...key, scope: 'runtime' })).size).toBe(1);

    // Deleting a collection deletes its scenarios.
    await service.deleteCollection(W, collection.id);
    expect(await store.listScenarios(W)).toHaveLength(0);
  });
});

describe('ApiTestWorker', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      setTimeout(() => res.end('ok'), 60);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const payload = (): RunPayload => ({
    kind: 'integration',
    collection: {
      name: 'C',
      variables: [],
      auth: { type: 'none' },
      items: [
        {
          id: 'a',
          type: 'request',
          name: 'a',
          method: 'GET',
          url: `${base}/a`,
          headers: [],
          query: [],
          body: { mode: 'none' },
          auth: { type: 'inherit' },
          assertions: [],
          captures: [],
        },
        {
          id: 'b',
          type: 'request',
          name: 'b',
          method: 'GET',
          url: `${base}/b`,
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
    // Long enough that the 5 ms heartbeat fires at least once while the run goes on.
    delayMs: 30,
  });

  it('drains the queue, reports progress and survives failures', async () => {
    const runs = [{ id: 'r1' }, { id: 'r2' }] as ApiRun[];
    const statuses = ['running', 'cancelled'];
    const service = {
      sweep: vi.fn(() => Promise.resolve({ requeued: 0, failed: 0 })),
      claimRemote: vi.fn(() => Promise.resolve(runs.shift() ?? null)),
      payloadOf: vi.fn((run: ApiRun) => {
        if (run.id === 'r2') throw new Error('gone');
        return payload();
      }),
      heartbeat: vi.fn(() => Promise.resolve((statuses.shift() ?? 'running') as never)),
      finish: vi.fn(() => Promise.reject(new Error('db down'))),
    };
    const onIdle = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const worker = new ApiTestWorker({
      service: service,
      heartbeatMs: 5,
      concurrency: 1,
      allowPrivateNetwork: true,
      onIdle,
    });
    expect(worker.status).toMatchObject({ active: 0, draining: false });
    worker.wake();
    worker.wake();
    await worker.idle();
    expect(onIdle).toHaveBeenCalled();
    expect(service.finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r2' }),
      worker.workerId,
      expect.objectContaining({ status: 'error', error: 'gone' }),
    );
    expect(service.heartbeat).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[ApiTestWorker] Could not finish run:', expect.any(Error));

    service.sweep.mockRejectedValueOnce('sweep failed');
    worker.wake();
    await worker.idle();
    expect(error).toHaveBeenCalledWith('[ApiTestWorker] Drain failed:', 'sweep failed');
    service.payloadOf.mockImplementationOnce(() => {
      throw 'plain';
    });
    runs.push({ id: 'r3' } as ApiRun);
    worker.wake();
    await worker.idle();
    expect(service.finish).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'r3' }),
      worker.workerId,
      expect.objectContaining({ error: 'plain' }),
    );
    error.mockRestore();
  });
});

describe('API tests routes', () => {
  async function setup(llm?: LlmPort) {
    const authRepo = new InMemoryAuthRepository();
    const app = createApp({
      authService: new AuthService(authRepo),
      workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
      apiTestStore: new InMemoryApiTestStore(),
      apiTestDispatcher: { wake: () => Promise.resolve() },
      ...(llm ? { defaultLlm: llm } : {}),
    });
    const token = (
      await request(app)
        .post('/auth/register')
        .send({ email: 'routes@example.com', password: 'StrongPassword123!', name: 'R' })
    ).body.token as string;
    const workspaceId = (
      await request(app)
        .post('/workspaces')
        .set('authorization', `Bearer ${token}`)
        .send({ name: 'Routes', slug: 'routes-ws' })
    ).body.workspace.id as string;
    const call = (method: 'get' | 'post' | 'put' | 'delete', path: string, workspace = true) => {
      const pending = request(app)[method](path).set('authorization', `Bearer ${token}`);
      return workspace ? pending.set('x-workspace-id', workspaceId) : pending;
    };
    return { call };
  }

  it('covers load scenarios, run management and the runner protocol', async () => {
    const llm = fakeLlm(
      '{"scenario": {"name": "Gen", "requests": [{"requestId": "a"}], "profile": "smoke", "stages": [{"durationSec": 1, "targetVus": 1}]}}',
    );
    const { call } = await setup(llm);
    const collection = (
      await call('post', '/integration-tests/collections').send({
        name: 'Orders',
        items: [{ id: 'a', name: 'A', url: 'https://api.example.test/a' }],
      })
    ).body.collection;
    const environment = (
      await call('post', '/integration-tests/environments').send({ name: 'E', variables: [] })
    ).body.environment;
    const files = await call(
      'get',
      `/integration-tests/collections/${collection.id}/export?format=bruno&as=files&environmentIds=${environment.id}`,
    );
    expect(files.status).toBe(200);

    const scenario = (await call('post', '/load-tests/scenarios').send(smoke(collection.id))).body
      .scenario;
    expect((await call('get', '/load-tests/scenarios')).body.scenarios).toHaveLength(1);
    expect((await call('get', `/load-tests/scenarios/${scenario.id}`)).body.scenario.id).toBe(
      scenario.id,
    );
    expect(
      (
        await call('put', `/load-tests/scenarios/${scenario.id}`).send(
          smoke(collection.id, { name: 'Renamed' }),
        )
      ).body.scenario.name,
    ).toBe('Renamed');
    expect(
      (
        await call('post', '/load-tests/generate/prepare').send({
          instructions: 'x',
          collectionId: collection.id,
        })
      ).body.brief.output,
    ).toContain('load_save_scenario');
    expect(
      (
        await call('post', '/load-tests/generate').send({
          instructions: 'x',
          collectionId: collection.id,
        })
      ).body.scenario.name,
    ).toBe('Gen');

    const started = (
      await call('post', '/load-tests/runs').send({
        scenarioId: scenario.id,
        authorized: true,
        target: 'local',
      })
    ).body.run;
    const runner = { id: 'runner-12345', name: 'Laptop', platform: 'linux', version: '1' };
    expect(
      (await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 0 })).body.run.id,
    ).toBe(started.id);
    const beat = await call('post', `/api-tests/runner/runs/${started.id}/heartbeat`).send({
      runnerId: runner.id,
    });
    expect(beat.body.status).toBe('running');
    const other = await call('post', `/api-tests/runner/runs/${started.id}/heartbeat`).send({
      runnerId: 'other-runner',
    });
    expect(other.body.status).toBe('cancelled');
    const summary = {
      totalRequests: 1,
      errorRate: 0,
      latency: { p95: 1 },
      rps: 1,
      timeline: [],
      perRequest: [],
    };
    await call('post', `/api-tests/runner/runs/${started.id}/complete`).send({
      runnerId: runner.id,
      status: 'passed',
      result: summary,
      error: null,
    });
    const listed = (await call('get', `/load-tests/runs?scenarioId=${scenario.id}`)).body.runs;
    expect(listed[0].result).toEqual({
      totalRequests: 1,
      errorRate: 0,
      latency: { p95: 1 },
      rps: 1,
    });
    expect((await call('get', `/load-tests/runs/${started.id}`)).body.run.id).toBe(started.id);
    expect((await call('delete', `/load-tests/runs/${started.id}`)).status).toBe(200);
    expect((await call('delete', `/load-tests/scenarios/${scenario.id}`)).status).toBe(200);

    const run = (
      await call('post', '/integration-tests/runs').send({
        collectionId: collection.id,
        target: 'local',
      })
    ).body.run;
    expect((await call('get', '/integration-tests/runs')).body.runs[0].result).toBeNull();
    expect((await call('get', `/load-tests/runs/${run.id}`)).status).toBe(404);
    expect((await call('post', `/integration-tests/runs/${run.id}/cancel`)).body.run.status).toBe(
      'cancelled',
    );
    expect((await call('delete', `/integration-tests/runs/${run.id}`)).status).toBe(200);

    // The claim waits for work for up to waitSeconds.
    expect(
      (await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 1 })).body.run,
    ).toBeNull();
    // A runner needs workspace membership.
    expect(
      (
        await call('post', '/api-tests/runner/claim', false)
          .set('x-workspace-id', '11111111-1111-4111-8111-111111111111')
          .send({ runner, waitSeconds: 0 })
      ).status,
    ).toBe(403);

    vi.spyOn(ApiTestService.prototype, 'generate').mockResolvedValueOnce({ sources: [] });
    expect(
      (await call('post', '/integration-tests/generate').send({ instructions: 'x' })).body
        .collection,
    ).toBeNull();
    // The long poll of the runner claim alone takes a second.
  }, 20_000);
});
