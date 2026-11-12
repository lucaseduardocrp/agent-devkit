import { describe, expect, it, vi } from 'vitest';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import {
  ApiTestService,
  extractJson,
} from '../src/modules/apitests/application/api-test-service.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import type { ApiCollection, ApiEnvironment } from '../src/modules/apitests/domain/api-test.js';
import { encryptSecret } from '../src/shared/encryption.js';

const W = 'w1';
const context = { workspaceId: W, actorId: 'u1' } as never;
const now = new Date();

const llm = (...answers: string[]): LlmPort =>
  ({
    provider: 'fake',
    complete: vi.fn(() => Promise.resolve({ text: answers.shift() ?? '' })),
    stream: () => (async function* () {})(),
  }) as unknown as LlmPort;

describe('legacy credential migration when the document disappears', () => {
  it('keeps migrating the document already read when a collection is deleted in between', async () => {
    let reads = 0;
    class Store extends InMemoryApiTestStore {
      override getCollection(workspaceId: string, id: string) {
        reads += 1;
        return reads === 1 ? super.getCollection(workspaceId, id) : Promise.resolve(null);
      }
    }
    const store = new Store();
    const legacy: ApiCollection = {
      id: 'c1',
      workspaceId: W,
      name: 'Legacy',
      variables: [{ key: 'pass', value: encryptSecret('legacy'), secret: true }],
      auth: { type: 'bearer', token: 'tok' },
      items: [],
      source: { kind: 'manual' },
      createdBy: 'alice',
      createdAt: now,
      updatedAt: now,
    };
    await store.saveCollection(legacy);
    const view = await new ApiTestService({ store }).getCollectionView(W, 'bob', 'c1');
    expect(JSON.stringify(view)).not.toContain('legacy');
  });

  it('keeps migrating the environment already read when it is deleted in between', async () => {
    class Store extends InMemoryApiTestStore {
      override getEnvironment() {
        return Promise.resolve(null);
      }
    }
    const store = new Store();
    const environment: ApiEnvironment = {
      id: 'e1',
      workspaceId: W,
      name: 'Env',
      variables: [{ key: 'pass', value: encryptSecret('env-legacy'), secret: true }],
      createdBy: 'alice',
      createdAt: now,
      updatedAt: now,
    };
    await store.saveEnvironment(environment);
    const views = await new ApiTestService({ store }).listEnvironmentViews(W, 'alice');
    expect(views).toHaveLength(1);
    expect(JSON.stringify(await store.listEnvironments(W))).not.toContain('env-legacy');
  });
});

describe('load limits on the local target', () => {
  it('names the user computer when the local limit is exceeded', async () => {
    const store = new InMemoryApiTestStore();
    const service = new ApiTestService({ store });
    const collection = await service.saveCollection(
      W,
      'u1',
      ApiTestService.parseCollection({
        name: 'C',
        items: [{ id: 'a', name: 'A', url: 'https://api.example.test/a' }],
      }),
    );
    const scenario = await service.saveScenario(W, 'u1', {
      name: 'Huge',
      collectionId: collection.id,
      requests: [{ requestId: 'a' }],
      profile: 'smoke',
      stages: [{ durationSec: 60, targetVus: 1 }],
    });
    // Larger than any schema allows to save: written straight to the store.
    await store.saveScenario({
      ...scenario,
      stages: [{ durationSec: 60, targetVus: 5_000 }],
    });
    await expect(
      service.startLoadRun(W, 'u1', { scenarioId: scenario.id, authorized: true, target: 'local' }),
    ).rejects.toMatchObject({
      code: 'LOAD_TEST_LIMIT',
      message: expect.stringContaining('your computer'),
    });
  });
});

describe('invalid run options', () => {
  it('reports the first validation issue of an integration run', async () => {
    const service = new ApiTestService({ store: new InMemoryApiTestStore() });
    await expect(
      service.startIntegrationRun(W, 'u1', { collectionId: 1 } as never),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('generate from model answers', () => {
  const generating = (answers: string[]) =>
    new ApiTestService({ store: new InMemoryApiTestStore(), defaultLlm: llm(...answers) });

  it('accepts a bare collection and a bare scenario object', async () => {
    const collection = await generating([
      '{"name": "Bare", "items": [{"name": "A", "url": "https://api.example.test/a"}]}',
    ]).generate(W, 'u1', context, { kind: 'integration', sources: [], instructions: 'x' });
    expect(collection.collection?.name).toBe('Bare');

    const service = new ApiTestService({
      store: new InMemoryApiTestStore(),
      defaultLlm: llm(
        '{"name": "S", "requests": [{"requestId": "a"}], "profile": "smoke", "stages": [{"durationSec": 1, "targetVus": 1}]}',
      ),
    });
    const base = await service.saveCollection(
      W,
      'u1',
      ApiTestService.parseCollection({
        name: 'C',
        items: [{ id: 'a', name: 'A', url: 'https://api.example.test/a' }],
      }),
    );
    const scenario = await service.generate(W, 'u1', context, {
      kind: 'load',
      sources: [],
      instructions: 'x',
      collectionId: base.id,
    });
    expect(scenario.scenario?.name).toBe('S');
  });

  it('retries with a generic message when the failure is not an Error', async () => {
    const store = new InMemoryApiTestStore();
    vi.spyOn(store, 'saveCollection').mockRejectedValue('boom');
    const service = new ApiTestService({
      store,
      defaultLlm: llm('{"name": "C", "items": []}', '{"name": "C", "items": []}'),
    });
    await expect(
      service.generate(W, 'u1', context, { kind: 'integration', sources: [], instructions: 'x' }),
    ).rejects.toMatchObject({
      code: 'API_TEST_GENERATION_FAILED',
      message: expect.stringContaining('invalid JSON'),
    });
  });

  it('extracts a JSON object only', () => {
    expect(extractJson('text {"a": 1} text')).toEqual({ a: 1 });
    expect(() => extractJson('{not json}')).toThrow();
  });
});
