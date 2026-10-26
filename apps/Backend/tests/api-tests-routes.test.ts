import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { moduleRequirements } from '../src/adapters/http/module-policy.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import { ApiTestService } from '../src/modules/apitests/application/api-test-service.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import {
  isBlockedHostname,
  isPrivateAddress,
} from '../src/modules/apitests/application/target-guard.js';
import { executeRun } from '../src/modules/apitests/engine/run-executor.js';
import type { RunPayload } from '../src/modules/apitests/engine/types.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

const KEY = 'a'.repeat(64);
let local = '';
let server: http.Server;

beforeAll(async () => {
  process.env['INTEGRATION_ENCRYPTION_KEY'] ??= KEY;
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: 'tok-123456' }));
      return;
    }
    if (url.pathname === '/orders') {
      const ok = req.headers.authorization === 'Bearer tok-123456';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { items: [{ id: 'o1' }] } : { error: 'unauthorized' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** The workers see https://api.example.test; requests go to the local test server. */
const tunnel: typeof fetch = (input, init) =>
  fetch(String(input).replace('https://api.example.test', local), init);

const collectionBody = (baseUrl: string) => ({
  name: 'Orders API',
  variables: [
    { key: 'baseUrl', value: baseUrl },
    { key: 'password', value: 'pass-9876', secret: true },
  ],
  auth: { type: 'none' },
  items: [
    {
      name: 'Login',
      method: 'post',
      url: '{{baseUrl}}/login',
      body: { mode: 'json', content: '{"password":"{{password}}"}' },
      assertions: [{ source: 'status', operator: 'eq', expected: '200' }],
      captures: [{ variable: 'token', source: 'json', path: 'token' }],
    },
    {
      type: 'folder',
      name: 'Orders',
      auth: { type: 'bearer', token: '{{token}}' },
      items: [
        {
          name: 'List',
          method: 'GET',
          url: '{{baseUrl}}/orders',
          assertions: [{ source: 'json', path: 'items[0].id', operator: 'eq', expected: 'o1' }],
        },
      ],
    },
  ],
});

async function setup(options: { llm?: LlmPort } = {}) {
  const authRepo = new InMemoryAuthRepository();
  const store = new InMemoryApiTestStore();
  const worker = new ApiTestWorker({
    service: new ApiTestService({ store }),
    fetch: tunnel,
    guard: () => Promise.resolve(),
    heartbeatMs: 20,
  });
  const app = createApp({
    authService: new AuthService(authRepo),
    workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    apiTestStore: store,
    apiTestDispatcher: { wake: () => Promise.resolve(worker.wake()) },
    ...(options.llm ? { defaultLlm: options.llm } : {}),
  });
  const registered = await request(app)
    .post('/auth/register')
    .send({ email: 'qa@example.com', password: 'StrongPassword123!', name: 'QA' });
  const token = registered.body.token as string;
  const workspace = await request(app)
    .post('/workspaces')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'API WS', slug: 'api-ws' });
  const workspaceId = workspace.body.workspace.id as string;
  const call = (method: 'get' | 'post' | 'put' | 'delete', path: string) =>
    request(app)
      [method](path)
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', workspaceId);
  return { call, worker, store };
}

const waitForRun = async (call: Awaited<ReturnType<typeof setup>>['call'], path: string) => {
  let run: { status: string } = { status: 'queued' };
  await vi.waitFor(
    async () => {
      run = (await call('get', path)).body.run;
      expect(['passed', 'failed', 'error']).toContain(run.status);
    },
    { timeout: 10_000, interval: 50 },
  );
  return run as Record<string, unknown> & { status: string; result: Record<string, unknown> };
};

describe('integration tests API', () => {
  it('saves collections with ids filled in and secrets never returned', async () => {
    const { call } = await setup();
    const created = await call('post', '/integration-tests/collections').send(
      collectionBody('https://api.example.test'),
    );
    expect(created.status).toBe(201);
    const collection = created.body.collection;
    expect(collection.items[0]).toMatchObject({ type: 'request', method: 'POST' });
    expect(collection.items[0].id).toBeTruthy();
    expect(collection.items[0].assertions[0].id).toBeTruthy();
    expect(collection.variables[1]).toEqual({
      key: 'password',
      value: '',
      secret: true,
      hasValue: true,
    });

    // Saving without the secret value keeps the stored one.
    const updated = await call('put', `/integration-tests/collections/${collection.id}`).send({
      ...collection,
      name: 'Orders API v2',
    });
    expect(updated.body.collection.variables[1].hasValue).toBe(true);
    const list = await call('get', '/integration-tests/collections');
    expect(list.body.collections).toEqual([
      expect.objectContaining({
        name: 'Orders API v2',
        requestCount: 2,
        source: { kind: 'manual' },
      }),
    ]);

    const invalid = await call('post', '/integration-tests/collections').send({ name: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('API_TEST_INVALID');
  });

  it('runs a collection on the workers, chaining the captured token', async () => {
    const { call } = await setup();
    const { collection } = (
      await call('post', '/integration-tests/collections').send(
        collectionBody('https://api.example.test'),
      )
    ).body;
    const started = await call('post', '/integration-tests/runs').send({
      collectionId: collection.id,
    });
    expect(started.status).toBe(201);
    expect(started.body.run).toMatchObject({ status: 'queued', target: 'remote', payload: null });
    const run = await waitForRun(call, `/integration-tests/runs/${started.body.run.id}`);
    expect(run.status).toBe('passed');
    expect(run.result).toMatchObject({ total: 2, passed: 2, failed: 0 });
    // The request body shows the secret masked.
    expect(JSON.stringify(run.result)).not.toContain('pass-9876');
    const list = await call('get', `/integration-tests/runs?collectionId=${collection.id}`);
    expect(list.body.runs[0].result).toEqual(expect.objectContaining({ passed: 2 }));
    expect(list.body.runs[0].result.results).toBeUndefined();
  });

  it('refuses remote runs against localhost and hands local runs to devkit runner', async () => {
    const { call } = await setup();
    const { collection } = (
      await call('post', '/integration-tests/collections').send(collectionBody(local))
    ).body;
    const remote = await call('post', '/integration-tests/runs').send({
      collectionId: collection.id,
    });
    expect(remote.status).toBe(400);
    expect(remote.body.code).toBe('API_TEST_TARGET_LOCAL');

    const started = await call('post', '/integration-tests/runs').send({
      collectionId: collection.id,
      target: 'local',
    });
    expect(started.body.run.status).toBe('queued');
    const runner = { id: 'runner-12345', name: 'Laptop', platform: 'win32', version: '1.0.0' };
    const claimed = await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 0 });
    expect(claimed.body.run).toMatchObject({ id: started.body.run.id, kind: 'integration' });
    expect(claimed.body.run.payload.collection.variables[1].value).toBe('pass-9876');

    const outcome = await executeRun(claimed.body.run.payload as RunPayload, {
      heartbeatMs: 10,
      report: async (partial) =>
        (
          await call('post', `/api-tests/runner/runs/${started.body.run.id}/heartbeat`).send({
            runnerId: runner.id,
            partial,
          })
        ).body.status as 'running' | 'stopped',
    });
    const completed = await call(
      'post',
      `/api-tests/runner/runs/${started.body.run.id}/complete`,
    ).send({ runnerId: runner.id, ...outcome });
    expect(completed.body.saved).toBe(true);
    const run = (await call('get', `/integration-tests/runs/${started.body.run.id}`)).body.run;
    expect(run).toMatchObject({ status: 'passed', claimLabel: 'Laptop (win32)', target: 'local' });
    expect(
      (await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 0 })).body.run,
    ).toBeNull();
  });

  it('imports and exports collections in every format', async () => {
    const { call } = await setup();
    const { collection } = (
      await call('post', '/integration-tests/collections').send(
        collectionBody('https://api.example.test'),
      )
    ).body;
    const postman = await call(
      'get',
      `/integration-tests/collections/${collection.id}/export?format=postman`,
    );
    expect(postman.headers['content-disposition']).toContain('orders-api.postman_collection.json');
    expect(postman.text).not.toContain('pass-9876');
    const imported = await call('post', '/integration-tests/collections/import').send({
      content: postman.text,
      name: 'From Postman',
    });
    expect(imported.body).toMatchObject({
      format: 'postman',
      collection: { name: 'From Postman', source: { kind: 'postman' } },
    });

    const bruno = await call(
      'get',
      `/integration-tests/collections/${collection.id}/export?format=bruno`,
    ).buffer(true);
    expect(bruno.headers['content-type']).toBe('application/zip');
    const files = await call(
      'get',
      `/integration-tests/collections/${collection.id}/export?format=bruno&as=files`,
    );
    expect(files.body.files.map((file: { path: string }) => file.path)).toContain(
      'Orders API/Orders/List.bru',
    );
    for (const format of ['adk', 'insomnia']) {
      expect(
        (
          await call(
            'get',
            `/integration-tests/collections/${collection.id}/export?format=${format}`,
          )
        ).status,
      ).toBe(200);
    }
    const bad = await call('post', '/integration-tests/collections/import').send({
      content: '{"nope":1}',
    });
    expect(bad.body.code).toBe('API_TEST_IMPORT_INVALID');

    const withEnvironments = await call('post', '/integration-tests/collections/import').send({
      content: JSON.stringify({
        ...JSON.parse(
          (await call('get', `/integration-tests/collections/${collection.id}/export?format=adk`))
            .text,
        ),
        environments: [
          { name: 'Staging', variables: [{ key: 'token', value: 'env-secret', secret: true }] },
        ],
      }),
    });
    expect(withEnvironments.status).toBe(201);
    expect(withEnvironments.body.format).toBe('adk');
    expect(withEnvironments.body.environments).toEqual([
      expect.objectContaining({
        name: 'Staging',
        variables: [{ key: 'token', value: '', secret: true, hasValue: true }],
      }),
    ]);
  });

  it('keeps environment secrets encrypted and uses them in runs', async () => {
    const { call, store } = await setup();
    const environment = await call('post', '/integration-tests/environments').send({
      name: 'Staging',
      variables: [
        { key: 'baseUrl', value: 'https://api.example.test' },
        { key: 'password', value: 'pass-9876', secret: true },
      ],
    });
    expect(environment.body.environment.variables[1]).toEqual({
      key: 'password',
      value: '',
      secret: true,
      hasValue: true,
    });
    const stored = await store.getEnvironment(
      environment.body.environment.workspaceId,
      environment.body.environment.id,
    );
    expect(stored!.variables[1]!.value).not.toContain('pass-9876');
    const { collection } = (
      await call('post', '/integration-tests/collections').send({
        ...collectionBody(''),
        variables: [],
      })
    ).body;
    const started = await call('post', '/integration-tests/runs').send({
      collectionId: collection.id,
      environmentId: environment.body.environment.id,
    });
    expect((await waitForRun(call, `/integration-tests/runs/${started.body.run.id}`)).status).toBe(
      'passed',
    );
  });

  it('prepares host generation from instructions and generates with the workspace model', async () => {
    const llm: LlmPort = {
      provider: 'fake',
      complete: vi.fn(() =>
        Promise.resolve({
          text: '```json\n{"collection":{"name":"Generated","items":[{"name":"Health","method":"GET","url":"{{baseUrl}}/health","assertions":[{"source":"status","operator":"eq","expected":"200"}]}]}}\n```',
        }),
      ),
      stream: () => (async function* () {})(),
    } as unknown as LlmPort;
    const { call } = await setup({ llm });
    const brief = await call('post', '/integration-tests/generate/prepare').send({
      instructions: 'Health endpoint returns 200',
      baseUrl: 'https://api.example.test',
    });
    expect(brief.body.brief.context).toContain('Health endpoint returns 200');
    expect(brief.body.brief.output).toContain('integration_save_collection');
    const generated = await call('post', '/integration-tests/generate').send({
      instructions: 'Health endpoint returns 200',
    });
    expect(generated.status).toBe(201);
    expect(generated.body.collection).toMatchObject({
      name: 'Generated',
      source: { kind: 'generated' },
    });
    const empty = await call('post', '/integration-tests/generate/prepare').send({});
    expect(empty.status).toBe(400);
  });
});

describe('load tests API', () => {
  it('validates scenarios, exports k6, and runs a load test with thresholds', async () => {
    const { call } = await setup();
    const { collection } = (
      await call('post', '/integration-tests/collections').send(
        collectionBody('https://api.example.test'),
      )
    ).body;
    const listId = collection.items[1].items[0].id as string;
    const profiles = await call('get', '/load-tests/profiles?vus=10&durationSec=100');
    expect(profiles.body.profiles.map((p: { profile: string }) => p.profile)).toEqual([
      'smoke',
      'load',
      'stress',
      'spike',
      'soak',
      'breakpoint',
      'custom',
    ]);

    const unknown = await call('post', '/load-tests/scenarios').send({
      name: 'x',
      collectionId: collection.id,
      requests: [{ requestId: 'nope' }],
      profile: 'smoke',
      stages: [{ durationSec: 1, targetVus: 1 }],
    });
    expect(unknown.body.code).toBe('API_TEST_INVALID');

    const scenario = (
      await call('post', '/load-tests/scenarios').send({
        name: 'Orders smoke',
        collectionId: collection.id,
        requests: [
          { requestId: collection.items[0].id, weight: 1 },
          { requestId: listId, weight: 3 },
        ],
        profile: 'smoke',
        stages: [{ durationSec: 2, targetVus: 2 }],
        thinkTimeMs: 20,
        thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.5 }],
      })
    ).body.scenario;
    expect(scenario.id).toBeTruthy();
    const k6 = await call('get', `/load-tests/scenarios/${scenario.id}/k6`);
    expect(k6.body.fileName).toBe('orders-smoke.k6.js');
    expect(k6.body.body).toContain('"duration": "2s"');

    const unauthorised = await call('post', '/load-tests/runs').send({ scenarioId: scenario.id });
    expect(unauthorised.body.code).toBe('LOAD_TEST_NOT_AUTHORIZED');
    const started = await call('post', '/load-tests/runs').send({
      scenarioId: scenario.id,
      authorized: true,
    });
    expect(started.status).toBe(201);
    expect(
      (await call('post', '/load-tests/runs').send({ scenarioId: scenario.id, authorized: true }))
        .body.code,
    ).toBe('LOAD_TEST_ALREADY_RUNNING');
    const run = await waitForRun(call, `/load-tests/runs/${started.body.run.id}`);
    expect(run.status).toBe('passed');
    expect(run.result['totalRequests']).toBeGreaterThan(0);
    expect(run.result['thresholds']).toEqual([
      expect.objectContaining({ metric: 'errorRate', passed: true }),
    ]);
    // An integration run id is not a load run.
    expect((await call('get', `/integration-tests/runs/${started.body.run.id}`)).status).toBe(404);
  });

  it('enforces the limits of the ADK workers and cancels runs', async () => {
    const { call } = await setup();
    const { collection } = (
      await call('post', '/integration-tests/collections').send(
        collectionBody('https://api.example.test'),
      )
    ).body;
    const big = (
      await call('post', '/load-tests/scenarios').send({
        name: 'Huge',
        collectionId: collection.id,
        requests: [{ requestId: collection.items[0].id }],
        profile: 'load',
        stages: [{ durationSec: 60, targetVus: 1_000 }],
      })
    ).body.scenario;
    const refused = await call('post', '/load-tests/runs').send({
      scenarioId: big.id,
      authorized: true,
    });
    expect(refused.body.code).toBe('LOAD_TEST_LIMIT');
    const local = await call('post', '/load-tests/runs').send({
      scenarioId: big.id,
      authorized: true,
      target: 'local',
    });
    expect(local.body.run.status).toBe('queued');
    const cancelled = await call('post', `/load-tests/runs/${local.body.run.id}/cancel`);
    expect(cancelled.body.run.status).toBe('cancelled');
    expect((await call('delete', `/load-tests/runs/${local.body.run.id}`)).status).toBe(200);
  });
});

describe('policy and network guard', () => {
  it('maps the routes to their permission modules', () => {
    expect(moduleRequirements('GET', '/integration-tests/collections')).toEqual([
      { module: 'integrationTests', operation: 'view' },
    ]);
    expect(moduleRequirements('POST', '/load-tests/runs')).toEqual([
      { module: 'loadTests', operation: 'edit' },
    ]);
    expect(moduleRequirements('POST', '/api-tests/runner/claim')).toEqual([]);
  });

  it('recognises local and private targets', () => {
    expect(
      ['localhost', 'app.localhost', '127.0.0.1', '[::1]', '169.254.169.254'].every(
        isBlockedHostname,
      ),
    ).toBe(true);
    expect(isBlockedHostname('api.example.com')).toBe(false);
    expect(['10.0.0.1', '192.168.1.10', '172.20.0.5', 'fd00::1'].every(isPrivateAddress)).toBe(
      true,
    );
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});
