import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

beforeAll(() => {
  process.env['INTEGRATION_ENCRYPTION_KEY'] ??= 'a'.repeat(64);
});

const collectionBody = {
  name: 'Orders API',
  description: 'Orders',
  items: [
    { id: 'login', name: 'Login', method: 'POST', url: 'https://api.example.test/login' },
    { id: 'list', name: 'List', url: 'https://api.example.test/orders' },
  ],
};

async function setup(options: { llm?: LlmPort } = {}) {
  const authRepo = new InMemoryAuthRepository();
  const store = new InMemoryApiTestStore();
  const app = createApp({
    authService: new AuthService(authRepo),
    workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    apiTestStore: store,
    apiTestDispatcher: { wake: () => Promise.resolve() },
    ...(options.llm ? { defaultLlm: options.llm } : {}),
  });
  const registered = await request(app)
    .post('/auth/register')
    .send({ email: 'gap@example.com', password: 'StrongPassword123!', name: 'Gap' });
  const token = registered.body.token as string;
  const workspace = await request(app)
    .post('/workspaces')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Gap WS', slug: 'gap-ws' });
  const workspaceId = workspace.body.workspace.id as string;
  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(app)
      [method](path)
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', workspaceId);
  const { collection } = (await call('post', '/integration-tests/collections').send(collectionBody))
    .body;
  return { app, call, store, workspaceId, collection };
}

const runner = { id: 'runner-gap-1', name: 'Laptop', platform: 'linux', version: '1.0.0' };

describe('integration test routes', () => {
  it('reads, updates and deletes collections and environments', async () => {
    const { call, collection } = await setup();
    expect(
      (await call('get', '/integration-tests/dynamic-values')).body.values.length,
    ).toBeGreaterThan(0);
    const read = await call('get', `/integration-tests/collections/${collection.id}`);
    expect(read.body.collection).toMatchObject({ name: 'Orders API', description: 'Orders' });
    expect(
      (await call('get', '/integration-tests/collections')).body.collections[0].description,
    ).toBe('Orders');

    const env = (
      await call('post', '/integration-tests/environments').send({
        name: 'Dev',
        variables: [{ key: 'token', value: 'abc', secret: true }],
      })
    ).body.environment;
    const updated = await call('put', `/integration-tests/environments/${env.id}`).send({
      name: 'Dev 2',
      variables: [{ key: 'token', value: '', secret: true }],
    });
    expect(updated.body.environment).toMatchObject({ name: 'Dev 2' });
    expect(updated.body.environment.variables[0]).toMatchObject({ value: '', hasValue: true });
    const listed = await call('get', '/integration-tests/environments');
    expect(listed.body.environments).toHaveLength(1);

    const files = await call(
      'get',
      `/integration-tests/collections/${collection.id}/export?format=bruno&as=files&environmentIds=${env.id}, ,`,
    );
    expect(files.body.files.map((file: { path: string }) => file.path)).toContain(
      'Orders API/environments/Dev 2.bru',
    );

    expect((await call('delete', `/integration-tests/environments/${env.id}`)).body).toEqual({
      success: true,
    });
    expect((await call('delete', `/integration-tests/collections/${collection.id}`)).body).toEqual({
      success: true,
    });
    expect((await call('get', `/integration-tests/collections/${collection.id}`)).status).toBe(404);
  });

  it('cancels, lists and deletes integration runs, keeping load runs apart', async () => {
    const { call, collection } = await setup();
    const run = (
      await call('post', '/integration-tests/runs').send({
        collectionId: collection.id,
        target: 'local',
      })
    ).body.run;
    const listed = await call('get', `/integration-tests/runs?collectionId=${collection.id}`);
    expect(listed.body.runs[0]).toMatchObject({ id: run.id, result: null });
    const cancelled = await call('post', `/integration-tests/runs/${run.id}/cancel`);
    expect(cancelled.body.run.status).toBe('cancelled');
    expect((await call('get', `/load-tests/runs/${run.id}`)).status).toBe(404);
    expect((await call('delete', `/integration-tests/runs/${run.id}`)).body).toEqual({
      success: true,
    });
  });
});

describe('load test routes', () => {
  it('manages scenarios and load runs, summarising results without the timeline', async () => {
    const { call, collection, store, workspaceId } = await setup();
    const scenario = (
      await call('post', '/load-tests/scenarios').send({
        name: 'Smoke',
        collectionId: collection.id,
        requests: [{ requestId: 'list' }],
        profile: 'smoke',
        stages: [{ durationSec: 5, targetVus: 1 }],
      })
    ).body.scenario;
    expect((await call('get', '/load-tests/scenarios')).body.scenarios).toHaveLength(1);
    expect((await call('get', `/load-tests/scenarios/${scenario.id}`)).body.scenario.name).toBe(
      'Smoke',
    );
    const renamed = await call('put', `/load-tests/scenarios/${scenario.id}`).send({
      name: 'Smoke 2',
      collectionId: collection.id,
      requests: [{ requestId: 'login' }],
      profile: 'smoke',
      stages: [{ durationSec: 5, targetVus: 1 }],
    });
    expect(renamed.body.scenario).toMatchObject({ id: scenario.id, name: 'Smoke 2' });

    const run = (
      await call('post', '/load-tests/runs').send({
        scenarioId: scenario.id,
        authorized: true,
        target: 'local',
      })
    ).body.run;
    const claimed = await store.claimLocal(
      { workspaceId, userId: run.requestedBy },
      { id: 'r', label: 'R' },
    );
    await store.finish(claimed!.id, 'r', {
      status: 'passed',
      result: { totalRequests: 3, timeline: [{ t: 1 }], perRequest: [{ id: 'login' }] } as never,
      error: null,
    });
    const listed = await call('get', `/load-tests/runs?scenarioId=${scenario.id}`);
    expect(listed.body.runs[0].result).toEqual({ totalRequests: 3 });
    expect((await call('get', `/load-tests/runs/${run.id}`)).body.run.result.timeline).toHaveLength(
      1,
    );
    expect((await call('post', `/load-tests/runs/${run.id}/cancel`)).body.run.status).toBe(
      'passed',
    );
    expect((await call('delete', `/load-tests/runs/${run.id}`)).body).toEqual({ success: true });
    expect((await call('delete', `/load-tests/scenarios/${scenario.id}`)).body).toEqual({
      success: true,
    });
  });

  it('prepares and generates load scenarios', async () => {
    const llm = {
      provider: 'fake',
      complete: vi.fn(() =>
        Promise.resolve({
          text: '{"scenario":{"name":"Gen","requests":[{"requestId":"list"}],"profile":"smoke","stages":[{"durationSec":5,"targetVus":1}]}}',
        }),
      ),
      stream: () => (async function* () {})(),
    } as unknown as LlmPort;
    const { call, collection } = await setup({ llm });
    const brief = await call('post', '/load-tests/generate/prepare').send({
      collectionId: collection.id,
      instructions: 'Peak of 1 user',
    });
    expect(brief.body.brief.context).toContain('- list: GET https://api.example.test/orders');
    const generated = await call('post', '/load-tests/generate').send({
      collectionId: collection.id,
      instructions: 'Peak of 1 user',
    });
    expect(generated.status).toBe(201);
    expect(generated.body.scenario).toMatchObject({ name: 'Gen', collectionId: collection.id });
  });
});

describe('devkit runner routes', () => {
  it('refuses callers without a workspace membership', async () => {
    const { app } = await setup();
    const response = await request(app)
      .post('/api-tests/runner/claim')
      .set('x-owner-id', 'legacy-owner')
      .send({ runner, waitSeconds: 0 });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('waits for a run, reports cancellation and saves an outcome without result', async () => {
    const { call, collection } = await setup();
    const empty = await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 1 });
    expect(empty.body.run).toBeNull();

    const run = (
      await call('post', '/integration-tests/runs').send({
        collectionId: collection.id,
        target: 'local',
      })
    ).body.run;
    await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 0 });
    const beat = await call('post', `/api-tests/runner/runs/${run.id}/heartbeat`).send({
      runnerId: runner.id,
      partial: null,
    });
    expect(beat.body.status).toBe('running');
    const stranger = await call('post', `/api-tests/runner/runs/${run.id}/heartbeat`).send({
      runnerId: 'someone-else-1',
    });
    expect(stranger.body.status).toBe('cancelled');
    const completed = await call('post', `/api-tests/runner/runs/${run.id}/complete`).send({
      runnerId: runner.id,
      status: 'error',
      result: null,
      error: 'crashed',
    });
    expect(completed.body).toEqual({ saved: true });
    const stored = (await call('get', `/integration-tests/runs/${run.id}`)).body.run;
    expect(stored).toMatchObject({ status: 'error', error: 'crashed', result: null });
  });

  it('stops waiting when the runner disconnects', async () => {
    const { call } = await setup();
    await expect(
      call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 5 }).timeout(300),
    ).rejects.toThrow();
    // The handler notices the closed connection after its next poll and gives up.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
  });
});
