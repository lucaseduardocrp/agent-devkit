import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createApp } from '../src/adapters/http/app.js';
import { createE2eRouter } from '../src/adapters/http/e2e-routes.js';
import type { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eRunner } from '../src/modules/e2e/application/e2e-runner.js';
import { InMemoryE2eRunnerTaskStore } from '../src/modules/e2e/application/runner-tasks.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };

function setup(e2eDefaultExecution?: 'local' | 'remote') {
  const explore = vi.fn();
  const run = vi.fn();
  const remote: E2eRunner = { explore, run };
  const author: E2eAuthor = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [{ title: 'Open page', description: 'd', priority: 'high', steps: [] }],
    }),
    writeScript: vi.fn().mockResolvedValue('test'),
    analyze: vi.fn().mockResolvedValue(null),
  };
  const app = createApp({
    ...(e2eDefaultExecution ? { e2eDefaultExecution } : {}),
    e2eRunner: remote,
    e2eAuthor: author,
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: new FakeScriptRepository(),
    e2eRunnerTasks: new InMemoryE2eRunnerTaskStore(),
    requestContextResolver: () => ({
      requestId: 'default-execution-test',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: 'user',
      memberRole: 'ADMIN',
      locale: 'en-US',
    }),
  });
  return { app, explore, run };
}

async function createRun(
  app: ReturnType<typeof setup>['app'],
  extra: Record<string, unknown> = {},
  baseUrl = 'http://localhost:8014',
) {
  const agent = await request(app)
    .post('/agents')
    .send({ name: 'QA', instructions: 'Test things.' })
    .expect(201);
  return request(app)
    .post('/e2e/creations')
    .send({
      name: 'App',
      agentId: agent.body.agent.id,
      mode: 'frontend',
      baseUrl,
      username: 'qa@example.com',
      password: 'secret',
      prd: 'Login',
      repository,
      ...extra,
    });
}

describe('default E2E execution', () => {
  const created = async (
    app: ReturnType<typeof setup>['app'],
    extra: Record<string, unknown> = {},
  ) => {
    const response = await createRun(app, extra, 'https://staging.example.com');
    expect(response.status).toBe(202);
    return response.body.creation as { executionTarget: string; baseUrl: string };
  };

  it('runs on the user computer when the server prefers it and the run does not choose', async () => {
    const { app, explore, run } = setup('local');
    const creation = await created(app);
    expect(creation.executionTarget).toBe('local');
    // Nothing is handed to the ADK worker.
    expect(run).not.toHaveBeenCalled();
    expect(explore).not.toHaveBeenCalled();
  });

  it('accepts localhost when it runs on the user computer by default', async () => {
    const response = await createRun(setup('local').app);
    expect(response.status).toBe(202);
    expect(response.body.creation).toMatchObject({
      executionTarget: 'local',
    });
    expect(String(response.body.creation.baseUrl)).toContain('localhost:8014');
  });

  it('lets a run choose the ADK worker explicitly', async () => {
    const { app } = setup('local');
    expect((await created(app, { executionTarget: 'remote' })).executionTarget).toBe('remote');
  });

  it('keeps the ADK worker as the default when nothing is configured', async () => {
    expect((await created(setup().app)).executionTarget).toBe('remote');
    expect((await created(setup('remote').app)).executionTarget).toBe('remote');
    expect((await created(setup().app, { executionTarget: 'local' })).executionTarget).toBe(
      'local',
    );
  });

  it('tells the clients where runs execute by default', async () => {
    const local = await request(setup('local').app).get('/capabilities').expect(200);
    expect(local.body).toMatchObject({ defaultExecutionTarget: 'local' });
    const remote = await request(setup('remote').app).get('/capabilities').expect(200);
    expect(remote.body.defaultExecutionTarget).toBe('remote');
    const unset = await request(setup().app).get('/capabilities').expect(200);
    expect(unset.body).toEqual({ workersReachLocalhost: false, defaultExecutionTarget: 'remote' });
  });
});

describe('warning when no local runner is online', () => {
  const runner = { id: 'runner-0001', name: 'QA-LAPTOP', platform: 'win32', version: '0.2.0' };
  const WARNING = expect.objectContaining({ code: 'NO_LOCAL_RUNNER' });

  it('says so when a run for the user computer is created and nobody is connected', async () => {
    const { app } = setup('local');
    const response = await createRun(app);
    expect(response.status).toBe(202);
    expect(response.body.warnings).toEqual([WARNING]);
    expect(response.body.warnings[0].message).toContain('devkit runner');
    // The run is still created: it waits for a runner.
    expect(response.body.creation.executionTarget).toBe('local');
  });

  it('stays quiet once a runner is connected, and for runs on the ADK worker', async () => {
    const { app } = setup('local');
    await request(app).post('/e2e/runner/claim').send({ runner, waitSeconds: 0 }).expect(200);
    const connected = await createRun(app);
    expect(connected.status).toBe(202);
    expect(connected.body).not.toHaveProperty('warnings');

    const remote = await createRun(
      setup().app,
      { executionTarget: 'remote' },
      'https://staging.example.com',
    );
    expect(remote.status).toBe(202);
    expect(remote.body).not.toHaveProperty('warnings');
  });

  it('also warns when a run is switched to the user computer or run again', async () => {
    const { app } = setup('local');
    const created = await createRun(
      app,
      { executionTarget: 'remote' },
      'https://staging.example.com',
    );
    const id = created.body.creation.id as string;
    await request(app).post(`/e2e/creations/${id}/cancel`);
    const switched = await request(app)
      .put(`/e2e/creations/${id}/execution`)
      .send({ executionTarget: 'local' });
    expect(switched.status).toBe(200);
    expect(switched.body.warnings).toEqual([WARNING]);
    const rerun = await request(app).post(`/e2e/creations/${id}/run`);
    expect(rerun.body.warnings).toEqual([WARNING]);
  });
});

describe('presence check of the local runner', () => {
  const local = { id: 'c1', executionTarget: 'local' };
  const service = {
    create: vi.fn().mockResolvedValue(local),
    rerunTest: vi.fn().mockResolvedValue(local),
  } as unknown as E2eService;
  const bare = (runners?: { hasOnlineRunner: () => Promise<boolean> }) =>
    express()
      .use(express.json())
      .use(
        createE2eRouter(
          service,
          () => ({
            requestId: 't',
            ownerId: 'ws',
            workspaceId: 'ws',
            actorId: 'user',
            memberRole: 'ADMIN',
          }),
          runners,
        ),
      );
  const body = {
    name: 'App',
    agentId: 'a',
    mode: 'frontend',
    baseUrl: 'https://x.example.com',
    prd: 'p',
    repository,
  };

  it('does not warn when the router cannot tell, or when asking fails', async () => {
    const without = await request(bare()).post('/e2e/creations').send(body);
    expect(without.status).toBe(202);
    expect(without.body).not.toHaveProperty('warnings');

    const failing = await request(bare({ hasOnlineRunner: () => Promise.reject(new Error('db')) }))
      .post('/e2e/creations')
      .send(body);
    expect(failing.status).toBe(202);
    expect(failing.body).not.toHaveProperty('warnings');
  });

  it('warns when a single test is run again with nobody connected', async () => {
    const response = await request(bare({ hasOnlineRunner: async () => false }))
      .post('/e2e/tests/11111111-1111-4111-8111-111111111111/run')
      .send({});
    expect(response.status).toBe(202);
    expect(response.body.warnings).toEqual([expect.objectContaining({ code: 'NO_LOCAL_RUNNER' })]);
  });
});
