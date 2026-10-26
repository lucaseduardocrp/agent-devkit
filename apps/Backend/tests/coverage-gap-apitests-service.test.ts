import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../src/shared/context.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import {
  ApiTestService,
  extractJson,
  type ApiTestServiceOptions,
} from '../src/modules/apitests/application/api-test-service.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import type { ApiRun, CollectionInput } from '../src/modules/apitests/domain/api-test.js';

const KEY = 'b'.repeat(64);
const W = 'w1';
const U = 'u1';
const context = { workspaceId: W, ownerId: 'owner' } as RequestContext;

function service(options: Partial<ApiTestServiceOptions> = {}) {
  const store = new InMemoryApiTestStore();
  return { store, svc: new ApiTestService({ store, encryptionKey: KEY, ...options }) };
}

const req = (id: string, url = 'https://api.example.test/x') => ({
  type: 'request' as const,
  id,
  name: id,
  method: 'GET',
  url,
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
});

const input = (items: unknown[] = [req('a'), req('b')]): CollectionInput =>
  ApiTestService.parseCollection({ name: 'Shop API', items });

function llm(...answers: string[]): LlmPort {
  return {
    provider: 'fake',
    complete: vi.fn(() => Promise.resolve({ text: answers.shift() ?? '' })),
    stream: () => (async function* () {})(),
  } as unknown as LlmPort;
}

describe('ApiTestService.parseCollection', () => {
  it('keeps non-object items for validation and replaces duplicate ids', () => {
    expect(() => ApiTestService.parseCollection('nope')).toThrow(
      expect.objectContaining({ code: 'API_TEST_INVALID' }),
    );
    expect(() => ApiTestService.parseCollection({ name: 'x', items: [null] })).toThrow(
      expect.objectContaining({ code: 'API_TEST_INVALID' }),
    );
    const parsed = ApiTestService.parseCollection({
      name: 'Dup',
      items: [
        {
          id: 'same',
          name: 'A',
          url: 'https://a',
          assertions: [{ id: 'kept', source: 'status', operator: 'exists' }],
        },
        { type: 'folder', name: 'F', items: [{ id: 'same', name: 'B', url: 'https://b' }] },
      ],
    });
    const folder = parsed.items[1] as unknown as { items: { id: string }[] };
    expect(parsed.items[0]!.id).toBe('same');
    expect(folder.items[0]!.id).not.toBe('same');
    expect((parsed.items[0] as unknown as { assertions: { id: string }[] }).assertions[0]!.id).toBe(
      'kept',
    );
  });
});

describe('ApiTestService edge cases', () => {
  it('leaves a folder without items to validation and stores empty new secrets as empty', async () => {
    expect(() =>
      ApiTestService.parseCollection({ name: 'x', items: [{ type: 'folder', name: 'F' }] }),
    ).toThrow(expect.objectContaining({ code: 'API_TEST_INVALID' }));
    const { svc } = service();
    await expect(svc.getCollection(W, 'none')).rejects.toMatchObject({ statusCode: 404 });
    const saved = await svc.saveCollection(W, U, {
      ...input(),
      variables: [{ key: 'token', value: '', secret: true }],
    });
    expect(saved.variables[0]!.value).toBe('');
  });

  it('applies the limits of the user computer to local load runs', async () => {
    const { svc } = service();
    const collection = await svc.saveCollection(W, U, input());
    const long = await svc.saveScenario(W, U, {
      name: 'Long',
      collectionId: collection.id,
      requests: [{ requestId: 'a' }],
      profile: 'soak',
      stages: [
        { durationSec: 14_400, targetVus: 1 },
        { durationSec: 14_400, targetVus: 1 },
      ],
    });
    await expect(
      svc.startLoadRun(W, U, { scenarioId: long.id, authorized: true, target: 'local' }),
    ).rejects.toMatchObject({
      code: 'LOAD_TEST_LIMIT',
      technicalMessage: expect.stringContaining('On your computer'),
    });
  });
});

describe('ApiTestService CRUD errors', () => {
  it('reports missing collections, environments, scenarios and runs as 404', async () => {
    const { svc } = service();
    await expect(svc.deleteCollection(W, 'x')).rejects.toMatchObject({
      code: 'API_COLLECTION_NOT_FOUND',
    });
    await expect(svc.deleteEnvironment(W, 'x')).rejects.toMatchObject({
      code: 'API_ENVIRONMENT_NOT_FOUND',
    });
    await expect(svc.getScenario(W, 'x')).rejects.toMatchObject({
      code: 'LOAD_SCENARIO_NOT_FOUND',
    });
    await expect(svc.deleteScenario(W, 'x')).rejects.toMatchObject({
      code: 'LOAD_SCENARIO_NOT_FOUND',
    });
    await expect(svc.getRun(W, 'x')).rejects.toMatchObject({ code: 'API_RUN_NOT_FOUND' });
    await expect(svc.ownedRun(W, U, 'x')).rejects.toMatchObject({ code: 'API_RUN_NOT_FOUND' });
    expect(() => svc.payloadOf({ payload: null } as ApiRun)).toThrow(
      expect.objectContaining({ statusCode: 410 }),
    );
  });

  it('limits the size of a collection and deletes what exists', async () => {
    const { svc } = service();
    const folder = (n: number) => ({
      type: 'folder',
      name: `F${n}`,
      items: Array.from({ length: 251 }, (_, i) => req(`r${n}-${i}`)),
    });
    await expect(svc.saveCollection(W, U, input([folder(1), folder(2)]))).rejects.toMatchObject({
      code: 'API_TEST_INVALID',
      technicalMessage: 'A collection holds at most 500 requests.',
    });
    const saved = await svc.saveCollection(W, U, input());
    expect(await svc.listCollections(W)).toHaveLength(1);
    await svc.deleteCollection(W, saved.id);
    expect(await svc.listCollections(W)).toEqual([]);

    const env = await svc.saveEnvironment(W, { name: 'Dev', variables: [] });
    const renamed = await svc.saveEnvironment(W, { name: 'Dev 2', variables: [] }, env.id);
    expect(renamed).toMatchObject({ id: env.id, createdAt: env.createdAt, name: 'Dev 2' });
    expect(await svc.listEnvironments(W)).toHaveLength(1);
    await svc.deleteEnvironment(W, env.id);
    expect(await svc.listEnvironments(W)).toEqual([]);
  });
});

describe('ApiTestService scenarios and load runs', () => {
  async function withScenario(overrides: Record<string, unknown> = {}) {
    const ctx = service();
    const collection = await ctx.svc.saveCollection(W, U, input());
    const scenario = await ctx.svc.saveScenario(W, U, {
      name: 'Peak',
      collectionId: collection.id,
      requests: [{ requestId: 'a' }],
      profile: 'smoke',
      stages: [{ durationSec: 10, targetVus: 2 }],
      ...overrides,
    });
    return { ...ctx, collection, scenario };
  }

  it('validates scenarios, updates them and checks the environment', async () => {
    const { svc, collection, scenario } = await withScenario();
    await expect(svc.saveScenario(W, U, { name: '' })).rejects.toMatchObject({
      code: 'API_TEST_INVALID',
      technicalMessage: 'The load scenario is not valid.',
    });
    await expect(
      svc.saveScenario(W, U, {
        name: 'x',
        collectionId: collection.id,
        environmentId: 'missing',
        requests: [{ requestId: 'a' }],
        profile: 'smoke',
        stages: [{ durationSec: 1, targetVus: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'API_ENVIRONMENT_NOT_FOUND' });
    const updated = await svc.saveScenario(
      W,
      'other',
      {
        name: 'Peak 2',
        collectionId: collection.id,
        requests: [{ requestId: 'b' }],
        profile: 'load',
        stages: [{ durationSec: 5, targetVus: 1 }],
      },
      scenario.id,
    );
    expect(updated).toMatchObject({ id: scenario.id, createdBy: U, name: 'Peak 2' });
    expect(await svc.listScenarios(W)).toHaveLength(1);
    await svc.deleteScenario(W, scenario.id);
    expect(await svc.listScenarios(W)).toEqual([]);
  });

  it('refuses scenarios whose requests left the collection and localhost targets', async () => {
    const { svc, collection, scenario } = await withScenario({ timeoutMs: 2_000 });
    await svc.saveCollection(W, U, input([req('c', 'http://localhost:3000/x')]), collection.id);
    await expect(
      svc.startLoadRun(W, U, { scenarioId: scenario.id, authorized: true }),
    ).rejects.toMatchObject({ code: 'API_TEST_INVALID', details: [] });

    const env = await svc.saveEnvironment(W, {
      name: 'Local',
      variables: [{ key: 'token', value: 's3cret', secret: true }],
    });
    const local = await svc.saveScenario(W, U, {
      name: 'Local',
      collectionId: collection.id,
      environmentId: env.id,
      requests: [{ requestId: 'c' }],
      profile: 'smoke',
      stages: [{ durationSec: 10, targetVus: 2 }],
      timeoutMs: 2_000,
    });
    await expect(
      svc.startLoadRun(W, U, { scenarioId: local.id, authorized: true }),
    ).rejects.toMatchObject({ code: 'API_TEST_TARGET_LOCAL' });
    const run = await svc.startLoadRun(W, U, {
      scenarioId: local.id,
      authorized: true,
      target: 'local',
    });
    expect(run).toMatchObject({
      kind: 'load',
      target: 'local',
      environmentId: env.id,
      payload: null,
    });
    const stored = (await svc.claimLocal(W, U, { id: 'r', label: 'L' }))!;
    const payload = svc.payloadOf(stored);
    expect(payload).toMatchObject({ kind: 'load', maxVus: 2_000, plan: { timeoutMs: 2_000 } });
    expect(JSON.stringify(payload)).toContain('s3cret');
    expect(await svc.ownedRun(W, U, stored.id)).toMatchObject({ id: stored.id });
    await expect(svc.ownedRun(W, 'other', stored.id)).rejects.toMatchObject({ statusCode: 404 });

    // Exports the scenario with the masked environment.
    const k6 = await svc.exportK6(W, local.id);
    expect(k6.fileName).toBe('local.k6.js');
    expect(k6.body).not.toContain('s3cret');
  });

  it('names k6 exports of unnamed-looking scenarios and refuses deleting active runs', async () => {
    const { svc, scenario, store } = await withScenario({ name: '***' });
    expect((await svc.exportK6(W, scenario.id)).fileName).toBe('load-test.k6.js');
    const run = await svc.startLoadRun(W, U, {
      scenarioId: scenario.id,
      authorized: true,
      target: 'local',
    });
    await expect(svc.deleteRun(W, run.id)).rejects.toMatchObject({ code: 'API_RUN_ACTIVE' });
    expect((await svc.cancelRun(W, run.id)).status).toBe('cancelled');
    await svc.deleteRun(W, run.id);
    expect(await store.getRun(W, run.id)).toBeNull();
  });
});

describe('ApiTestService integration runs', () => {
  it('needs a request, skips unparseable URLs and tolerates a failing dispatcher', async () => {
    const wake = vi.fn().mockRejectedValue(new Error('queue down'));
    const { svc } = service({ dispatcher: { wake } });
    const collection = await svc.saveCollection(W, U, input([req('a', '{{base}}/x')]));
    await expect(
      svc.startIntegrationRun(W, U, { collectionId: collection.id, itemIds: ['missing'] }),
    ).rejects.toMatchObject({ technicalMessage: 'There is no request to run.' });
    const run = await svc.startIntegrationRun(W, U, { collectionId: collection.id, bail: true });
    expect(run).toMatchObject({ status: 'queued', target: 'remote', payload: null });
    expect(wake).toHaveBeenCalled();
    const claimed = (await svc.claimRemote('worker'))!;
    expect(svc.payloadOf(claimed)).toMatchObject({ kind: 'integration', bail: true, itemIds: [] });
    expect(await svc.heartbeat(claimed.id, 'worker')).toBe('running');
    expect(
      await svc.finish(claimed.id, 'worker', { status: 'passed', result: null, error: null }),
    ).toBe(true);
    expect(await svc.sweep(new Date(), 2)).toEqual({ requeued: 0, failed: 0 });
    expect((await svc.listRuns(W, {})).length).toBe(1);
  });

  it('lets workers with host access reach localhost', async () => {
    const { svc } = service({ workersReachLocalhost: true });
    const collection = await svc.saveCollection(W, U, input([req('a', 'http://localhost:1/x')]));
    expect((await svc.startIntegrationRun(W, U, { collectionId: collection.id })).status).toBe(
      'queued',
    );
  });
});

describe('ApiTestService import and export', () => {
  it('imports environments and names exports of symbol-only collections', async () => {
    const { svc } = service();
    const content = JSON.stringify({
      format: 'adk-api-collection',
      collection: { name: 'Imported', items: [req('a')] },
      environments: [{ name: 'Prod', variables: [{ key: 'baseUrl', value: 'https://x' }] }],
    });
    const imported = await svc.importCollection(W, U, { content });
    expect(imported.format).toBe('adk');
    expect(imported.environments.map((env) => env.name)).toEqual(['Prod']);

    const odd = await svc.saveCollection(
      W,
      U,
      ApiTestService.parseCollection({ name: '!!!', items: [] }),
    );
    const exported = await svc.exportCollection(W, odd.id, 'adk', [imported.environments[0]!.id]);
    expect(exported.fileName).toBe('collection.adk.json');
    expect(exported.body).toContain('Prod');
  });
});

describe('ApiTestService generation', () => {
  it('needs a source loader for sources and a collection for load generation', async () => {
    const { svc } = service();
    await expect(
      svc.prepareGeneration(W, context, {
        kind: 'integration',
        sources: [{ type: 'brain', id: 'p' }],
      }),
    ).rejects.toMatchObject({ code: 'API_TEST_SOURCES_UNAVAILABLE', statusCode: 503 });
    await expect(
      svc.prepareGeneration(W, context, { kind: 'load', sources: [], instructions: 'peak' }),
    ).rejects.toMatchObject({ messageParams: { detail: 'collectionId' } });
  });

  it('builds load briefs from sources and the collection requests', async () => {
    const load = vi
      .fn()
      .mockResolvedValue({ type: 'spec', id: 's', title: 'Spec', text: 'Checkout SLA 300ms' });
    const { svc } = service({ sources: { load } });
    const collection = await svc.saveCollection(
      W,
      U,
      input([{ type: 'folder', name: 'Orders', items: [req('list')] }]),
    );
    const brief = await svc.prepareGeneration(W, context, {
      kind: 'load',
      sources: [{ type: 'spec', id: 's' }],
      collectionId: collection.id,
    });
    expect(brief.context).toContain('- list: GET https://api.example.test/x (Orders / list)');
    expect(brief.context).toContain('--- [spec: Spec] ---\nCheckout SLA 300ms');
    expect(brief.output).toContain(`collectionId "${collection.id}"`);
    expect(brief.sources).toEqual([{ type: 'spec', id: 's', title: 'Spec' }]);
  });

  it('refuses generation without any model', async () => {
    const resolveLlmProvider = vi.fn().mockResolvedValue(null);
    const { svc } = service({ dynamicProviderFactory: { resolveLlmProvider } as never });
    await expect(
      svc.generate(W, U, context, {
        kind: 'integration',
        sources: [],
        instructions: 'x',
        llmProvider: 'p',
      }),
    ).rejects.toMatchObject({ code: 'API_TEST_NO_LLM' });
    expect(resolveLlmProvider).toHaveBeenCalledWith('owner', 'p');
  });

  it('retries once with the rejection reason and fails after two bad answers', async () => {
    const model = llm('no json here', '[1]');
    const { svc } = service({ defaultLlm: model });
    await expect(
      svc.generate(W, U, context, { kind: 'integration', sources: [], instructions: 'x' }),
    ).rejects.toMatchObject({
      code: 'API_TEST_GENERATION_FAILED',
      statusCode: 502,
    });
    const second = (model.complete as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(second.instruction).toContain(
      'The previous answer was rejected (no JSON object in the answer)',
    );
  });

  it('records non-Error failures as invalid JSON', async () => {
    const { svc, store } = service({
      defaultLlm: llm('{"collection":{"name":"G","items":[]}}', '{"name":"G","items":[]}'),
    });
    vi.spyOn(store, 'saveCollection').mockRejectedValue('boom');
    await expect(
      svc.generate(W, U, context, { kind: 'integration', sources: [], instructions: 'x' }),
    ).rejects.toMatchObject({ messageParams: { detail: 'invalid JSON' } });
  });

  it('generates and saves a load scenario, also from a bare object', async () => {
    const { svc } = service();
    const collection = await svc.saveCollection(W, U, input());
    const scenario = {
      name: 'Gen',
      requests: [{ requestId: 'a' }],
      profile: 'smoke',
      stages: [{ durationSec: 1, targetVus: 1 }],
    };
    const resolveLlmProvider = vi
      .fn()
      .mockResolvedValue(llm(JSON.stringify({ scenario }), JSON.stringify(scenario)));
    const generating = new ApiTestService({
      store: (svc as unknown as { options: ApiTestServiceOptions }).options.store,
      encryptionKey: KEY,
      dynamicProviderFactory: { resolveLlmProvider } as never,
    });
    const first = await generating.generate(W, U, context, {
      kind: 'load',
      sources: [],
      instructions: 'peak',
      collectionId: collection.id,
    });
    expect(first.scenario).toMatchObject({ name: 'Gen', collectionId: collection.id });
    const second = await generating.generate(W, U, context, {
      kind: 'load',
      sources: [],
      instructions: 'peak',
      collectionId: collection.id,
    });
    expect(second.scenario?.id).not.toBe(first.scenario?.id);
  });
});

describe('extractJson', () => {
  it('reads fenced and bare objects and rejects arrays', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('text {"b":2} text')).toEqual({ b: 2 });
    expect(() => extractJson('{}x{')).not.toThrow();
    expect(() => extractJson('} {')).toThrow('no JSON object in the answer');
    expect(() => extractJson('{ broken }')).toThrow(SyntaxError);
  });
});
