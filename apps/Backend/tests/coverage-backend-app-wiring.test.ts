import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { ApiTestWorker } from '../src/modules/apitests/application/api-test-worker.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

const PASSWORD = 'StrongPassword123!';

async function signedIn(options: Partial<AppOptions> = {}) {
  const authRepo = new InMemoryAuthRepository();
  const app = createApp({
    authService: new AuthService(authRepo),
    workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    ...options,
  });
  const registered = await request(app)
    .post('/auth/register')
    .send({ email: 'qa@example.com', password: PASSWORD, name: 'QA' });
  const token = registered.body.token as string;
  const workspace = await request(app)
    .post('/workspaces')
    .set('authorization', `Bearer ${token}`)
    .send({ name: 'Wiring', slug: 'wiring' });
  const workspaceId = workspace.body.workspace.id as string;
  const call = (method: 'get' | 'post', path: string) =>
    request(app)
      [method](path)
      .set('authorization', `Bearer ${token}`)
      .set('x-workspace-id', workspaceId);
  return { app, call, userId: registered.body.user.id as string };
}

const collection = {
  name: 'Ping API',
  variables: [],
  auth: { type: 'none' },
  items: [
    {
      name: 'Ping',
      method: 'GET',
      url: 'https://api.example.test/ping',
      assertions: [{ source: 'status', operator: 'eq', expected: '200' }],
    },
  ],
};

async function startRemoteRun(call: Awaited<ReturnType<typeof signedIn>>['call']) {
  const created = await call('post', '/integration-tests/collections').send(collection);
  expect(created.status).toBe(201);
  const started = await call('post', '/integration-tests/runs').send({
    collectionId: created.body.collection.id,
  });
  expect(started.status).toBe(201);
  expect(started.body.run).toMatchObject({ status: 'queued', target: 'remote' });
}

afterEach(() => vi.restoreAllMocks());

describe('createApp wiring', () => {
  it('wakes its own API test worker when a remote run is queued without a dispatcher', async () => {
    const wake = vi.spyOn(ApiTestWorker.prototype, 'wake').mockImplementation(() => undefined);
    const { call } = await signedIn();
    await startRemoteRun(call);
    expect(wake).toHaveBeenCalled();
  });

  it('queues a remote run even when the dispatcher answers nothing', async () => {
    const wake = vi.fn(() => undefined as unknown as Promise<void>);
    const { call } = await signedIn({ apiTestDispatcher: { wake } });
    await startRemoteRun(call);
    expect(wake).toHaveBeenCalled();
  });

  it('builds the default E2E runner with host access and runs without a Telegram notifier', async () => {
    const { call } = await signedIn({ hostAlias: 'host.docker.internal', runNotifier: null });
    expect((await call('get', '/auth/me')).status).toBe(200);
  });

  it('skips notification recipients that are not members of the workspace', async () => {
    const { call } = await signedIn();
    const issue = await call('post', '/issues').send({ title: 'Notify' });
    expect(issue.status).toBe(201);
    const sent = await call('post', '/notifications/send').send({
      issueId: issue.body.issue.id,
      userIds: ['11111111-1111-4111-8111-111111111111'],
      channels: ['email'],
      subject: 'Heads up',
      message: 'Look at this issue.',
    });
    expect(sent.status).toBe(200);
    expect(sent.body.results).toEqual([
      expect.objectContaining({
        status: 'skipped',
        reason: 'Not a member of the workspace.',
      }),
    ]);
  });
});
