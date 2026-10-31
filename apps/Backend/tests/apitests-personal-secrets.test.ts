import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { moduleRequirements } from '../src/adapters/http/module-policy.js';
import { ApiTestService } from '../src/modules/apitests/application/api-test-service.js';
import { InMemoryApiTestStore } from '../src/modules/apitests/application/api-test-store.js';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import {
  fill,
  fillVariables,
  isReference,
  normalizeRuntime,
  refs,
  strip,
  stripVariables,
  variableRefs,
} from '../src/modules/apitests/application/personal-secrets.js';
import type { ApiCollection } from '../src/modules/apitests/domain/api-test.js';
import type {
  ApiFolder,
  ApiRequestSpec,
  CollectionSpec,
  RunPayload,
} from '../src/modules/apitests/engine/types.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { encryptSecret } from '../src/shared/encryption.js';

type IntegrationPayload = Extract<RunPayload, { kind: 'integration' }>;
type Call = (method: 'get' | 'post' | 'put' | 'delete', path: string) => request.Test;

const req = (id: string, extra: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id,
  type: 'request',
  name: id,
  method: 'GET',
  url: '{{baseUrl}}/orders',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...extra,
});

describe('personal secret fields', () => {
  const collection: CollectionSpec = {
    name: 'C',
    variables: [
      { key: 'baseUrl', value: 'https://api.example.test' },
      { key: 'token', value: 'tok-1', secret: true },
      { key: 'ref', value: '{{other}}', secret: true },
      { key: 'empty', value: '', secret: true },
    ],
    auth: { type: 'bearer', token: 'literal-token' },
    items: [
      { id: 'f0', type: 'folder', name: 'No auth', items: [] },
      {
        id: 'f1',
        type: 'folder',
        name: 'Keys',
        auth: { type: 'apikey', key: 'x-key', value: '{{apiKey}}', in: 'header' },
        items: [req('r1', { auth: { type: 'basic', username: 'ana', password: '' } })],
      },
      req('r2', {
        auth: {
          type: 'oauth2',
          grantType: 'client_credentials',
          accessTokenUrl: 'https://auth',
          clientId: '{{clientId}}',
          clientSecret: 'cs',
        },
      }),
    ],
    settings: {
      proxy: { enabled: true, protocol: 'http', hostname: 'p', port: 8080, password: 'pp' },
      clientCertificates: [
        { domain: 'a', type: 'pem', cert: 'CERT', key: 'KEY', passphrase: '' },
        { domain: 'b', type: 'pfx', pfx: 'PFX' },
      ],
    },
  };

  it('recognises references', () => {
    expect(isReference('{{a}}')).toBe(true);
    expect(isReference(' {{ a.b }}{{$guid}} ')).toBe(true);
    expect(isReference('Bearer {{a}}')).toBe(false);
    expect(isReference('')).toBe(false);
  });

  it('strips values, keeps references, and fills them back', () => {
    const { shared, extracted } = strip(collection);
    expect(Object.fromEntries(extracted)).toEqual({
      'var:token': 'tok-1',
      'var:ref': '{{other}}',
      'auth:collection:token': 'literal-token',
      'auth:r1:username': 'ana',
      'auth:r2:clientSecret': 'cs',
      'proxy:password': 'pp',
      'cert:0:key': 'KEY',
      'cert:1:pfx': 'PFX',
    });
    const text = JSON.stringify(shared);
    for (const value of ['tok-1', 'literal-token', '"ana"', '"cs"', 'KEY', 'PFX', '"pp"'])
      expect(text).not.toContain(value);
    expect(text).toContain('{{apiKey}}');
    expect(text).toContain('CERT');
    expect(refs(shared)).toEqual(
      expect.arrayContaining(['var:empty', 'auth:r1:password', 'cert:0:passphrase']),
    );
    expect(refs(shared)).not.toContain('auth:f1:value');

    const filled = fill(shared, extracted);
    expect(filled.auth).toEqual({ type: 'bearer', token: 'literal-token' });
    expect(filled.variables.find((item) => item.key === 'empty')?.value).toBe('');
    expect((filled.items[1] as ApiFolder).auth).toMatchObject({ value: '{{apiKey}}' });
    expect(filled.settings?.clientCertificates?.[1]?.pfx).toBe('PFX');
    // A field that already holds a value (an unsaved literal) keeps it.
    expect(fill(collection, new Map([['auth:collection:token', 'other']])).auth).toEqual(
      collection.auth,
    );
  });

  it('handles settings without secrets and environment variables', () => {
    const plain = { ...collection, settings: { timeoutMs: 100 } };
    expect(strip(plain).shared.settings).toEqual({ timeoutMs: 100 });
    const proxyOnly = {
      ...collection,
      settings: {
        proxy: { enabled: true, protocol: 'http' as const, hostname: 'p', port: 1, username: 'u' },
      },
    };
    expect(strip(proxyOnly).shared.settings?.proxy?.username).toBe('');
    const certsOnly = {
      ...collection,
      settings: { clientCertificates: [{ domain: 'a', type: 'pem' as const }] },
    };
    expect(strip(certsOnly).extracted.has('cert:0:key')).toBe(false);
    const { settings: _settings, ...none } = collection;
    expect(strip(none as CollectionSpec).shared.settings).toBeUndefined();

    const variables = [
      { key: 'a', value: '1' },
      { key: 's', value: 'x', secret: true },
      { key: 't', value: '', secret: true },
    ];
    const stripped = stripVariables(variables);
    expect(stripped.shared[1]?.value).toBe('');
    expect(Object.fromEntries(stripped.extracted)).toEqual({ 'var:s': 'x' });
    expect(fillVariables(stripped.shared, stripped.extracted)[1]?.value).toBe('x');
    expect(variableRefs([...variables, { key: 's', value: '', secret: true }])).toEqual([
      'var:s',
      'var:t',
    ]);
  });

  it('normalizes runtime states', () => {
    expect(normalizeRuntime(null)).toBeNull();
    expect(normalizeRuntime('x')).toBeNull();
    expect(normalizeRuntime({})).toEqual({ variables: [], cookies: [] });
    expect(
      normalizeRuntime({
        variables: [
          { key: 'a', value: '1' },
          { key: 'a', value: '2' },
          { key: ' ', value: 'x' },
          { key: 'b', value: 'x'.repeat(20_001) },
          { nope: true },
        ],
        cookies: [{ name: 'c', value: 'v', domain: 'd', path: '/' }, { name: 1 }],
      }),
    ).toEqual({
      variables: [{ key: 'a', value: '2' }],
      cookies: [{ name: 'c', value: 'v', domain: 'd', path: '/' }],
    });
  });
});

async function setup() {
  const authRepo = new InMemoryAuthRepository();
  const store = new InMemoryApiTestStore();
  const app = createApp({
    authService: new AuthService(authRepo),
    workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    apiTestStore: store,
    apiTestDispatcher: { wake: () => Promise.resolve() },
  });
  const register = async (email: string) =>
    (
      await request(app)
        .post('/auth/register')
        .send({ email, password: 'StrongPassword123!', name: email })
    ).body as { token: string; user: { id: string } };
  const alice = await register('alice@example.com');
  const bob = await register('bob@example.com');
  const workspaceId = (
    await request(app)
      .post('/workspaces')
      .set('authorization', `Bearer ${alice.token}`)
      .send({ name: 'Shared', slug: 'shared-ws' })
  ).body.workspace.id as string;
  await request(app)
    .post(`/workspaces/${workspaceId}/members`)
    .set('authorization', `Bearer ${alice.token}`)
    .send({ email: 'bob@example.com', role: 'ADMIN' })
    .expect(201);
  const as =
    (token: string): Call =>
    (method, path) =>
      request(app)
        [method](path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', workspaceId);
  return {
    store,
    workspaceId,
    alice: { call: as(alice.token), id: alice.user.id },
    bob: { call: as(bob.token), id: bob.user.id },
  };
}

const runner = { id: 'runner-12345', name: 'Laptop', platform: 'win32', version: '1.0.0' };

/** Starts a local run as the user and claims it with their runner: the frozen payload. */
async function payloadOf(call: Call, body: Record<string, unknown>) {
  const started = await call('post', '/integration-tests/runs').send({ ...body, target: 'local' });
  expect(started.status).toBe(201);
  const claimed = await call('post', '/api-tests/runner/claim').send({ runner, waitSeconds: 0 });
  return { run: started.body.run, payload: claimed.body.run.payload as IntegrationPayload };
}

const sharedBody = {
  name: 'Orders',
  variables: [
    { key: 'baseUrl', value: 'https://api.example.test' },
    { key: 'token', value: 'alice-token', secret: true },
  ],
  auth: { type: 'bearer', token: 'alice-literal' },
  items: [
    {
      type: 'folder',
      name: 'Orders',
      items: [{ id: 'list', name: 'List', method: 'GET', url: '{{baseUrl}}/orders' }],
    },
    {
      id: 'rpc',
      name: 'Rpc',
      kind: 'grpc',
      method: 'POST',
      url: 'grpcs://api.example.test',
      grpc: { method: 'a.B/C', message: '{}' },
    },
  ],
};

describe('personal credentials API', () => {
  it('keeps each member’s secrets to themselves', async () => {
    const { store, workspaceId, alice, bob } = await setup();
    const created = await alice.call('post', '/integration-tests/collections').send(sharedBody);
    expect(created.status).toBe(201);
    const id = created.body.collection.id as string;
    expect(created.body.collection.personalSecrets).toEqual(['auth:collection:token', 'var:token']);
    expect(created.body.collection.variables[1]).toEqual({
      key: 'token',
      value: '',
      secret: true,
      hasValue: true,
    });

    const bobView = (await bob.call('get', `/integration-tests/collections/${id}`)).body.collection;
    expect(bobView.personalSecrets).toEqual([]);
    expect(bobView.variables[1].hasValue).toBe(false);
    const bobSaved = await bob.call('put', `/integration-tests/collections/${id}`).send({
      ...bobView,
      variables: [bobView.variables[0], { key: 'token', value: 'bob-token', secret: true }],
    });
    expect(bobSaved.body.collection.personalSecrets).toEqual(['var:token']);
    expect(
      (await alice.call('get', `/integration-tests/collections/${id}`)).body.collection
        .personalSecrets,
    ).toEqual(['auth:collection:token', 'var:token']);
    const stored = JSON.stringify(await store.getCollection(workspaceId, id));
    for (const value of ['alice-token', 'alice-literal', 'bob-token'])
      expect(stored).not.toContain(value);

    // Environments: same rules.
    const environment = (
      await alice.call('post', '/integration-tests/environments').send({
        name: 'Staging',
        variables: [{ key: 'password', value: 'env-a', secret: true }],
      })
    ).body.environment;
    expect(environment.personalSecrets).toEqual(['var:password']);
    const bobEnvironments = (await bob.call('get', '/integration-tests/environments')).body
      .environments;
    expect(bobEnvironments[0]).toMatchObject({ personalSecrets: [] });
    expect(bobEnvironments[0].variables[0].hasValue).toBe(false);
    const bobEnvironment = await bob
      .call('put', `/integration-tests/environments/${environment.id}`)
      .send({ name: 'Staging', variables: [{ key: 'password', value: 'env-b', secret: true }] });
    expect(bobEnvironment.body.environment.personalSecrets).toEqual(['var:password']);
    expect(JSON.stringify(await store.listEnvironments(workspaceId))).not.toMatch(/env-[ab]/);

    // Each run uses the requester's own values only.
    const mine = (await payloadOf(alice.call, { collectionId: id, environmentId: environment.id }))
      .payload;
    expect(mine.collection.variables[1]?.value).toBe('alice-token');
    expect(mine.collection.auth).toEqual({ type: 'bearer', token: 'alice-literal' });
    expect(mine.environment[0]?.value).toBe('env-a');
    expect(mine.environmentName).toBe('Staging');
    const theirs = (await payloadOf(bob.call, { collectionId: id, environmentId: environment.id }))
      .payload;
    expect(theirs.collection.variables[1]?.value).toBe('bob-token');
    expect(theirs.collection.auth).toEqual({ type: 'bearer', token: '' });
    expect(theirs.environment[0]?.value).toBe('env-b');

    // A member clears their own value.
    const cleared = await bob.call('delete', '/integration-tests/personal-secrets').send({
      scope: 'collection',
      scopeId: id,
      ref: 'var:token',
    });
    expect(cleared.body).toEqual({ success: true });
    expect(
      (await bob.call('get', `/integration-tests/collections/${id}`)).body.collection
        .personalSecrets,
    ).toEqual([]);
    await bob
      .call('delete', '/integration-tests/personal-secrets')
      .send({ scope: 'environment', scopeId: environment.id, ref: 'var:password' })
      .expect(200);
    const missing = await bob
      .call('delete', '/integration-tests/personal-secrets')
      .send({ scope: 'collection', scopeId: 'nope', ref: 'var:token' });
    expect(missing.status).toBe(404);

    // Exports and imports carry the shared document only.
    const exported = await alice.call(
      'get',
      `/integration-tests/collections/${id}/export?format=adk&environmentIds=${environment.id}`,
    );
    expect(exported.text).not.toMatch(/alice-|env-a/);
    const imported = await bob
      .call('post', '/integration-tests/collections/import')
      .send({ content: exported.text, name: 'Copy' });
    expect(imported.body.environments[0]).toMatchObject({ name: 'Staging', personalSecrets: [] });

    // Deleting removes everyone's values.
    await alice.call('delete', `/integration-tests/collections/${id}`).expect(200);
    await alice.call('delete', `/integration-tests/environments/${environment.id}`).expect(200);
    const key = { workspaceId, userId: alice.id, scopeId: id };
    expect((await store.listPersonalValues({ ...key, scope: 'collection' })).size).toBe(0);
    expect(
      (
        await store.listPersonalValues({
          ...key,
          scope: 'environment',
          scopeId: environment.id,
        })
      ).size,
    ).toBe(0);
  });

  it('keeps the runtime state per member and out of the run', async () => {
    const { alice, bob } = await setup();
    const id = (await alice.call('post', '/integration-tests/collections').send(sharedBody)).body
      .collection.id as string;
    const path = `/integration-tests/collections/${id}/runtime`;
    expect((await alice.call('get', path)).body).toEqual({
      runtime: { variables: [], cookies: [] },
    });
    const state = {
      variables: [{ key: 'session', value: 's-1' }],
      cookies: [{ name: 'sid', value: 'c', domain: 'api.example.test', path: '/' }],
    };
    expect((await alice.call('put', path).send(state)).body).toEqual({ runtime: state });
    expect((await alice.call('put', path).send({ variables: 'x' })).status).toBe(400);
    expect((await bob.call('get', path)).body.runtime.variables).toEqual([]);
    expect((await alice.call('get', '/integration-tests/collections/nope/runtime')).status).toBe(
      404,
    );

    const { run, payload } = await payloadOf(alice.call, { collectionId: id });
    expect(payload.runtime).toEqual(state);
    const fresh = await payloadOf(alice.call, { collectionId: id, useRuntime: false });
    expect(fresh.payload.runtime).toBeUndefined();

    const next = { variables: [{ key: 'session', value: 's-2' }], cookies: [] };
    const completed = await alice
      .call('post', `/api-tests/runner/runs/${run.id}/complete`)
      .send({ runnerId: runner.id, status: 'passed', result: null, error: null, runtime: next });
    expect(completed.body.saved).toBe(true);
    await alice
      .call('post', `/api-tests/runner/runs/${fresh.run.id}/complete`)
      .send({ runnerId: runner.id, status: 'passed', result: null, error: null });
    const finished = (await alice.call('get', `/integration-tests/runs/${run.id}`)).body.run;
    expect(JSON.stringify(finished)).not.toContain('s-2');
    expect((await alice.call('get', path)).body.runtime).toEqual(next);
    expect((await bob.call('get', path)).body.runtime.variables).toEqual([]);

    expect((await alice.call('delete', path)).body).toEqual({ success: true });
    expect((await alice.call('get', path)).body.runtime.variables).toEqual([]);
  });

  it('runs unsaved requests alone without storing their credentials', async () => {
    const { store, workspaceId, alice } = await setup();
    const collection = (await alice.call('post', '/integration-tests/collections').send(sharedBody))
      .body.collection;
    const edited = {
      id: 'list',
      name: 'List (edited)',
      method: 'get',
      url: '{{baseUrl}}/orders?page=2',
      auth: { type: 'bearer', token: 'adhoc-literal' },
    };
    const { payload, run } = await payloadOf(alice.call, {
      collectionId: collection.id,
      request: edited,
    });
    expect(run.itemIds).toEqual(['list']);
    expect(payload.itemIds).toEqual(['list']);
    const folder = payload.collection.items[0] as ApiFolder;
    expect(folder.items[0]).toMatchObject({ name: 'List (edited)', method: 'GET' });
    expect(payload.previewBytes).toBe(1024 * 1024);
    const stored = JSON.stringify(await store.getCollection(workspaceId, collection.id));
    expect(stored).not.toContain('adhoc-literal');
    expect(stored).not.toContain('List (edited)');
    const vault = await store.listPersonalValues({
      workspaceId,
      userId: alice.id,
      scope: 'collection',
      scopeId: collection.id,
    });
    expect([...vault.keys()]).not.toContain('auth:list:token');

    const added = await payloadOf(alice.call, {
      collectionId: collection.id,
      request: { id: 'new', name: 'New', url: '{{baseUrl}}/new' },
    });
    expect(added.payload.collection.items.at(-1)).toMatchObject({ id: 'new' });

    const folderId = collection.items[0].id as string;
    const onFolder = await alice
      .call('post', '/integration-tests/runs')
      .send({ collectionId: collection.id, request: { id: folderId, name: 'x', url: 'x' } });
    expect(onFolder.body).toMatchObject({ code: 'API_TEST_INVALID', message: expect.any(String) });
    const broken = await alice
      .call('post', '/integration-tests/runs')
      .send({ collectionId: collection.id, request: { id: 'x', name: 'x' } });
    expect(broken.body.code).toBe('API_TEST_INVALID');
    const asFolder = await alice
      .call('post', '/integration-tests/runs')
      .send({ collectionId: collection.id, request: { id: 'y', name: 'y', items: [] } });
    expect(asFolder.body.code).toBe('API_TEST_INVALID');
  });

  it('validates gRPC listing, data-driven runs and targets', async () => {
    const { alice } = await setup();
    const collection = (await alice.call('post', '/integration-tests/collections').send(sharedBody))
      .body.collection;
    const notGrpc = await alice
      .call('post', '/integration-tests/runs')
      .send({ collectionId: collection.id, itemIds: ['list'], mode: 'grpc-reflect' });
    expect(notGrpc.body).toMatchObject({ code: 'API_TEST_INVALID' });
    const many = await alice
      .call('post', '/integration-tests/runs')
      .send({ collectionId: collection.id, mode: 'grpc-reflect' });
    expect(many.body.code).toBe('API_TEST_INVALID');
    const reflect = await payloadOf(alice.call, {
      collectionId: collection.id,
      itemIds: ['rpc'],
      mode: 'grpc-reflect',
    });
    expect(reflect.payload).toMatchObject({ mode: 'grpc-reflect', previewBytes: 1024 * 1024 });

    const data = await payloadOf(alice.call, {
      collectionId: collection.id,
      data: [{ page: '1' }, { page: '2' }],
      iterations: 3,
      delayMs: 50,
    });
    expect(data.payload).toMatchObject({
      data: [{ page: '1' }, { page: '2' }],
      iterations: 3,
      delayMs: 50,
      previewBytes: 4096,
      mode: 'run',
    });
    const once = await payloadOf(alice.call, {
      collectionId: collection.id,
      itemIds: ['list'],
      data: [],
      iterations: 2,
    });
    expect(once.payload.previewBytes).toBe(4096);
    expect(once.payload.data).toBeUndefined();

    const wide = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`c${i}`, 'v']));
    expect(
      (
        await alice
          .call('post', '/integration-tests/runs')
          .send({ collectionId: collection.id, data: [wide] })
      ).status,
    ).toBe(400);
    expect(
      (
        await alice
          .call('post', '/integration-tests/runs')
          .send({ collectionId: collection.id, iterations: 0 })
      ).status,
    ).toBe(400);

    for (const url of ['localhost:3000/x', 'grpc://127.0.0.1:50051', 'tcp://localhost:9000']) {
      const refused = await alice
        .call('post', '/integration-tests/runs')
        .send({ collectionId: collection.id, request: { id: 'l', name: 'l', url } });
      expect(refused.body.code).toBe('API_TEST_TARGET_LOCAL');
    }
    const unparsable = await alice
      .call('post', '/integration-tests/runs')
      .send({ collectionId: collection.id, request: { id: 'u', name: 'u', url: 'http://[bad' } });
    expect(unparsable.status).toBe(201);
  });

  it('maps personal routes to view permission', () => {
    expect(moduleRequirements('DELETE', '/integration-tests/personal-secrets')).toEqual([
      { module: 'integrationTests', operation: 'view' },
    ]);
    expect(moduleRequirements('PUT', '/integration-tests/collections/c1/runtime')).toEqual([
      { module: 'integrationTests', operation: 'view' },
    ]);
  });
});

describe('personal credentials service', () => {
  const now = new Date();
  const legacyCollection = (extra: Partial<ApiCollection> = {}): ApiCollection => ({
    id: 'c1',
    workspaceId: 'w1',
    name: 'Legacy',
    variables: [
      { key: 'pass', value: encryptSecret('legacy-pass'), secret: true },
      { key: 'broken', value: 'not-encrypted', secret: true },
    ],
    auth: { type: 'bearer', token: 'legacy-token' },
    items: [],
    source: { kind: 'manual' },
    createdBy: 'alice',
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
  const key = (userId: string, scope: 'collection' | 'environment' = 'collection') => ({
    workspaceId: 'w1',
    userId,
    scope,
    scopeId: scope === 'collection' ? 'c1' : 'e1',
  });

  it('moves legacy collection credentials to the creator only, once', async () => {
    const store = new InMemoryApiTestStore();
    const service = new ApiTestService({ store });
    await store.saveCollection(legacyCollection());
    // The creator already set their own token: it is kept.
    await store.upsertPersonalValues(
      key('alice'),
      new Map([['auth:collection:token', encryptSecret('newer')]]),
    );
    const view = await service.getCollectionView('w1', 'bob', 'c1');
    expect(view.personalSecrets).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/legacy-|not-encrypted/);
    expect(JSON.stringify(await store.getCollection('w1', 'c1'))).not.toMatch(
      /legacy-|not-encrypted/,
    );
    const values = await store.listPersonalValues(key('alice'));
    expect([...values.keys()].sort()).toEqual(['auth:collection:token', 'var:pass']);
    expect((await store.listPersonalValues(key('bob'))).size).toBe(0);
    const run = await service.startIntegrationRun('w1', 'alice', {
      collectionId: 'c1',
      target: 'local',
      request: { id: 'r', name: 'r', url: 'https://api.example.test' },
    });
    const payload = service.payloadOf(
      (await store.claimLocal({ workspaceId: 'w1', userId: 'alice' }, { id: 'r', label: 'r' }))!,
    ) as IntegrationPayload;
    expect(run.status).toBe('queued');
    expect(payload.collection.variables[0]?.value).toBe('legacy-pass');
    expect(payload.collection.auth).toEqual({ type: 'bearer', token: 'newer' });

    const save = vi.spyOn(store, 'saveCollection');
    await service.getCollection('w1', 'c1');
    expect(save).not.toHaveBeenCalled();
  });

  it('drops legacy values it cannot keep', async () => {
    const store = new InMemoryApiTestStore();
    const service = new ApiTestService({ store });
    await store.saveCollection(legacyCollection());
    vi.spyOn(store, 'upsertPersonalValues').mockRejectedValueOnce(new Error('no user'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cleaned = await service.getCollection('w1', 'c1');
    expect(JSON.stringify(cleaned)).not.toContain('legacy-token');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('moves legacy environment secrets to the owner or clears them', async () => {
    const store = new InMemoryApiTestStore();
    const service = new ApiTestService({ store });
    const variables = [
      { key: 'url', value: 'https://x' },
      { key: 'pass', value: encryptSecret('env-legacy'), secret: true },
    ];
    await store.saveEnvironment({
      id: 'e1',
      workspaceId: 'w1',
      name: 'Owned',
      variables,
      createdBy: 'alice',
      createdAt: now,
      updatedAt: now,
    });
    await store.saveEnvironment({
      id: 'e2',
      workspaceId: 'w1',
      name: 'Orphan',
      variables,
      createdAt: now,
      updatedAt: now,
    });
    const views = await service.listEnvironmentViews('w1', 'alice');
    expect(views.map((view) => view.personalSecrets)).toEqual([[], ['var:pass']]);
    expect(JSON.stringify(await store.listEnvironments('w1'))).not.toContain('env-legacy');
    const kept = await store.listPersonalValues(key('alice', 'environment'));
    expect(kept.has('var:pass')).toBe(true);
    // Saving a legacy environment keeps it without an owner.
    const saved = await service.saveEnvironment('w1', 'bob', { name: 'Orphan', variables }, 'e2');
    expect(saved.createdBy).toBeNull();
  });

  it('records runtime from finished runs, never in the run row', async () => {
    const store = new InMemoryApiTestStore();
    const service = new ApiTestService({ store });
    const collection = await service.saveCollection(
      'w1',
      'alice',
      ApiTestService.parseCollection({
        name: 'C',
        headers: [{ key: 'x-tenant', value: '1' }],
        settings: {
          proxy: { enabled: true, protocol: 'http', hostname: 'p', port: 1, password: 'pp' },
        },
        items: [
          {
            id: 'f',
            type: 'folder',
            name: 'F',
            headers: [{ key: 'x-folder', value: '2' }],
            items: [{ id: 'r', name: 'r', url: 'https://api.example.test' }],
          },
          { id: 'r2', name: 'r2', url: 'https://api.example.test/2' },
        ],
      }),
    );
    const claim = async (userId = 'alice') =>
      (await store.claimLocal({ workspaceId: 'w1', userId }, { id: 'runner', label: 'l' }))!;
    const runtime = { variables: [{ key: 'v', value: '1' }], cookies: [] };

    await service.startIntegrationRun('w1', 'alice', {
      collectionId: collection.id,
      target: 'local',
    });
    const first = await claim();
    expect(
      await service.finish(first, 'runner', {
        status: 'passed',
        result: null,
        error: null,
        runtime,
      }),
    ).toBe(true);
    expect((await store.getRun('w1', first.id)) as unknown).not.toHaveProperty('runtime');
    expect(await service.getRuntime('w1', 'alice', collection.id)).toEqual(runtime);

    // Not kept when the runtime cannot be written or the collection is gone.
    await service.startIntegrationRun('w1', 'alice', {
      collectionId: collection.id,
      target: 'local',
    });
    const second = await claim();
    vi.spyOn(store, 'upsertPersonalValues').mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      await service.finish(second, 'runner', {
        status: 'passed',
        result: null,
        error: null,
        runtime: { variables: [], cookies: [] },
      }),
    ).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    // Load runs: the requester's credentials, the collection settings and inherited headers.
    const scenario = await service.saveScenario('w1', 'alice', {
      name: 'S',
      collectionId: collection.id,
      requests: [{ requestId: 'r' }, { requestId: 'r2' }],
      profile: 'smoke',
      stages: [{ durationSec: 1, targetVus: 1 }],
    });
    await service.startLoadRun('w1', 'alice', {
      scenarioId: scenario.id,
      target: 'local',
      authorized: true,
    });
    const loadRun = await claim();
    const load = service.payloadOf(loadRun) as Extract<RunPayload, { kind: 'load' }>;
    expect(load.plan.settings?.proxy?.password).toBe('pp');
    expect(load.plan.requests[0]?.inheritedHeaders).toEqual([
      { key: 'x-tenant', value: '1' },
      { key: 'x-folder', value: '2' },
    ]);
    expect(
      await service.finish(loadRun, 'runner', {
        status: 'passed',
        result: null,
        error: null,
        runtime,
      }),
    ).toBe(true);

    await service.startIntegrationRun('w1', 'alice', {
      collectionId: collection.id,
      target: 'local',
    });
    const third = await claim();
    await service.deleteCollection('w1', collection.id);
    expect(
      await service.finish(third, 'runner', {
        status: 'passed',
        result: null,
        error: null,
        runtime,
      }),
    ).toBe(true);
    expect(
      (
        await store.listPersonalValues({
          workspaceId: 'w1',
          userId: 'alice',
          scope: 'runtime',
          scopeId: collection.id,
        })
      ).size,
    ).toBe(0);
  });

  it('ignores personal values it cannot open', async () => {
    const store = new InMemoryApiTestStore();
    const service = new ApiTestService({ store });
    const collection = await service.saveCollection(
      'w1',
      'alice',
      ApiTestService.parseCollection({
        name: 'C',
        variables: [{ key: 'token', value: '', secret: true }],
        items: [{ id: 'r', name: 'r', url: 'https://api.example.test' }],
      }),
    );
    const scope = { workspaceId: 'w1', userId: 'alice', scopeId: collection.id };
    await store.upsertPersonalValues(
      { ...scope, scope: 'collection' },
      new Map([['var:token', 'bad']]),
    );
    await store.upsertPersonalValues({ ...scope, scope: 'runtime' }, new Map([['state', 'bad']]));
    expect(await service.getRuntime('w1', 'alice', collection.id)).toEqual({
      variables: [],
      cookies: [],
    });
    await store.upsertPersonalValues(
      { ...scope, scope: 'runtime' },
      new Map([['state', encryptSecret('null')]]),
    );
    expect(await service.getRuntime('w1', 'alice', collection.id)).toEqual({
      variables: [],
      cookies: [],
    });
    expect(await service.setRuntime('w1', 'alice', collection.id, 'nope')).toEqual({
      variables: [],
      cookies: [],
    });
    await service.startIntegrationRun('w1', 'alice', {
      collectionId: collection.id,
      target: 'local',
    });
    const run = (await store.claimLocal(
      { workspaceId: 'w1', userId: 'alice' },
      { id: 'x', label: 'x' },
    ))!;
    expect((service.payloadOf(run) as IntegrationPayload).collection.variables[0]?.value).toBe('');
    await expect(
      service.startIntegrationRun('w1', 'alice', { collectionId: collection.id, delayMs: -1 }),
    ).rejects.toMatchObject({ code: 'API_TEST_INVALID' });
    await expect(
      service.clearPersonalValue('w1', 'alice', 'environment', 'nope', 'var:x'),
    ).rejects.toMatchObject({ code: 'API_ENVIRONMENT_NOT_FOUND' });
  });
});

describe('API test worker host access', () => {
  it('connects localhost targets to the host alias', () => {
    const service = {} as ConstructorParameters<typeof ApiTestWorker>[0]['service'];
    const worker = new ApiTestWorker({ service, hostAlias: 'host.docker.internal' });
    const connect = (worker as unknown as { connectHost: (host: string) => string }).connectHost;
    expect(connect('localhost')).toBe('host.docker.internal');
    expect(connect('api.example.test')).toBe('api.example.test');
  });
});
