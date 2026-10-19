import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eRunner } from '../src/modules/e2e/application/e2e-runner.js';
import { InMemoryE2eRunnerTaskStore } from '../src/modules/e2e/application/runner-tasks.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };
const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001', async ({ page }) => { await page.goto('/'); await expect(page).toHaveURL('/'); });`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9]);
const runner = { id: 'runner-0001', name: 'QA-LAPTOP', platform: 'win32', version: '0.2.0' };

function setup() {
  const remote: E2eRunner = { explore: vi.fn(), run: vi.fn() };
  const author: E2eAuthor = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [{ title: 'Open page', description: 'd', priority: 'high', steps: [] }],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn().mockResolvedValue(null),
  };
  const tasks = new InMemoryE2eRunnerTaskStore();
  const app = createApp({
    e2eRunner: remote,
    e2eAuthor: author,
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: new FakeScriptRepository(),
    e2eRunnerTasks: tasks,
    requestContextResolver: (req) => ({
      requestId: 'local-runner-test',
      ownerId: 'ws',
      workspaceId: 'ws',
      actorId: req.header('x-test-user') ?? 'user',
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
      locale: 'en-US',
    }),
  });
  return { app, remote, tasks };
}

async function createLocalRun(app: ReturnType<typeof setup>['app']) {
  const agent = await request(app)
    .post('/agents')
    .send({ name: 'QA', instructions: 'Test things.' })
    .expect(201);
  const created = await request(app)
    .post('/e2e/creations')
    .send({
      name: 'Local app',
      agentId: agent.body.agent.id,
      mode: 'frontend',
      baseUrl: 'http://localhost:8014',
      executionTarget: 'local',
      username: 'qa@example.com',
      password: 'local-secret',
      prd: 'Login and dashboard',
      repository,
    })
    .expect(202);
  return created.body.creation as { id: string; executionTarget: string };
}

/** Claims the next task the way `devkit runner` does, waiting until the worker creates it. */
async function claim(app: ReturnType<typeof setup>['app'], user = 'user') {
  let task: Record<string, any> | null = null;
  await vi.waitFor(
    async () => {
      const response = await request(app)
        .post('/e2e/runner/claim')
        .set('x-test-user', user)
        .send({ runner, waitSeconds: 0 })
        .expect(200);
      task = response.body.task;
      expect(task).not.toBeNull();
    },
    { timeout: 5_000 },
  );
  return task as unknown as Record<string, any>;
}

describe('local runner routes', () => {
  it('runs a local run on the user runner and stores its evidence in ADK', async () => {
    const { app, remote } = setup();
    const creation = await createLocalRun(app);
    expect(creation.executionTarget).toBe('local');

    const explore = await claim(app);
    expect(explore).toMatchObject({
      kind: 'explore',
      label: { run: 'Local app', test: null },
      input: { kind: 'explore', url: 'http://localhost:8014/', accessToken: null },
    });
    await request(app)
      .post(`/e2e/runner/tasks/${explore.id}/complete`)
      .send({
        runnerId: runner.id,
        outcome: { kind: 'explore', snapshot: { startUrl: 'http://localhost:8014/', pages: [] } },
      })
      .expect(204);

    const run = await claim(app);
    expect(run.kind).toBe('run');
    expect(run.label.test).toBe('TC001 - Open page');
    expect(run.input).toMatchObject({
      kind: 'run',
      script: SCRIPT,
      baseUrl: 'http://localhost:8014',
      credentials: { username: 'qa@example.com', password: 'local-secret' },
    });
    await request(app)
      .post(`/e2e/runner/tasks/${run.id}/heartbeat`)
      .send({ runner })
      .expect(200, { status: 'running' });
    const runners = await request(app).get('/e2e/runners').expect(200);
    expect(runners.body.runners).toEqual([
      expect.objectContaining({ id: runner.id, name: 'QA-LAPTOP', online: true }),
    ]);
    await request(app)
      .put(`/e2e/runner/tasks/${run.id}/artifacts/video.webm`)
      .set('x-adk-runner-id', runner.id)
      .set('content-type', 'application/octet-stream')
      .send(WEBM)
      .expect(204);
    await request(app)
      .put(`/e2e/runner/tasks/${run.id}/artifacts/step-01.png`)
      .set('x-adk-runner-id', runner.id)
      .set('content-type', 'application/octet-stream')
      .send(PNG)
      .expect(204);
    await request(app)
      .post(`/e2e/runner/tasks/${run.id}/complete`)
      .send({
        runnerId: runner.id,
        outcome: {
          kind: 'run',
          status: 'passed',
          durationMs: 1200,
          error: null,
          logs: '1 passed',
          steps: [
            {
              position: 1,
              title: 'Open',
              status: 'passed',
              durationMs: 10,
              error: null,
              hasScreenshot: true,
            },
          ],
          hasVideo: true,
        },
      })
      .expect(204);

    await vi.waitFor(
      async () => {
        const response = await request(app).get(`/e2e/creations/${creation.id}`).expect(200);
        expect(response.body.creation.status).toBe('completed');
      },
      { timeout: 5_000 },
    );
    const detail = await request(app).get(`/e2e/creations/${creation.id}`).expect(200);
    const test = detail.body.creation.tests[0];
    expect(test).toMatchObject({
      status: 'passed',
      executedOn: 'QA-LAPTOP (win32)',
      hasVideo: true,
      stepResults: [expect.objectContaining({ position: 1, hasScreenshot: true })],
    });
    const video = await request(app).get(`/e2e/tests/${test.id}/video`).expect(200);
    expect(Buffer.from(video.body as Buffer)).toEqual(WEBM);
    const screenshot = await request(app)
      .get(`/e2e/tests/${test.id}/steps/1/screenshot`)
      .expect(200);
    expect(Buffer.from(screenshot.body as Buffer)).toEqual(PNG);
    expect(remote.run).not.toHaveBeenCalled();
    expect(remote.explore).not.toHaveBeenCalled();
  });

  it('moves a tunnel run to the local runner using its localhost origin', async () => {
    const { app } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Test things.' })
      .expect(201);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'Tunnel app',
        agentId: agent.body.agent.id,
        mode: 'frontend',
        baseUrl: 'https://tunnel.trycloudflare.com',
        localOrigin: 'http://localhost:8014',
        accessClientId: 'adk-local-id',
        accessClientSecret: 'secret',
        planning: 'host',
        prd: 'Login',
        repository,
      })
      .expect(202);
    const id = created.body.creation.id as string;
    // Waits for the host-mode exploration job: an active run cannot change its target.
    let local!: request.Response;
    await vi.waitFor(async () => {
      local = await request(app)
        .put(`/e2e/creations/${id}/execution`)
        .send({ executionTarget: 'local' })
        .expect(200);
    });
    expect(local.body.creation).toMatchObject({
      executionTarget: 'local',
      baseUrl: 'http://localhost:8014',
      localOrigin: null,
      hasAccessServiceToken: false,
    });
    const remote = await request(app)
      .put(`/e2e/creations/${id}/execution`)
      .send({ executionTarget: 'remote' })
      .expect(200);
    expect(remote.body.creation.executionTarget).toBe('remote');
    await request(app)
      .put(`/e2e/creations/${id}/execution`)
      .send({ executionTarget: 'elsewhere' })
      .expect(400);

    // Editing the settings: a local target opens the tunnel's localhost origin directly.
    const edited = await request(app)
      .put(`/e2e/creations/${id}`)
      .send({
        name: 'Tunnel app',
        agentId: agent.body.agent.id,
        mode: 'frontend',
        baseUrl: 'https://tunnel.trycloudflare.com',
        localOrigin: 'http://localhost:8014',
        executionTarget: 'local',
        prd: 'Login',
        repository,
      })
      .expect(200);
    expect(edited.body.creation).toMatchObject({
      executionTarget: 'local',
      baseUrl: 'http://localhost:8014',
      localOrigin: null,
    });
  });

  it('validates runner requests and keeps the target when a run is edited', async () => {
    const { app } = setup();
    const creation = await createLocalRun(app);
    await request(app)
      .post('/e2e/runner/claim')
      .send({ runner: { id: 'x' } })
      .expect(400);
    await request(app).get('/e2e/runners').set('x-test-user', '').expect(401);
    await request(app).post('/e2e/runner/tasks/t1/heartbeat').send({}).expect(400);
    await request(app)
      .put('/e2e/runner/tasks/t1/artifacts/video.webm')
      .set('content-type', 'application/octet-stream')
      .send(WEBM)
      .expect(400);
    const scoped = await request(app)
      .post('/e2e/runner/claim')
      .send({ runner, creationId: 'another-run', waitSeconds: 0 })
      .expect(200);
    expect(scoped.body.task).toBeNull();
    const task = await claim(app);
    expect(task.creationId).toBe(creation.id);
  });

  it('keeps tasks private to the user who started the run and validates uploads', async () => {
    const { app } = setup();
    await createLocalRun(app);
    const other = await request(app)
      .post('/e2e/runner/claim')
      .set('x-test-user', 'someone-else')
      .send({ runner, waitSeconds: 0 })
      .expect(200);
    expect(other.body.task).toBeNull();
    await request(app)
      .post('/e2e/runner/claim')
      .set('x-test-role', 'VIEWER')
      .send({ runner, waitSeconds: 0 })
      .expect(403);

    const task = await claim(app);
    await request(app)
      .post(`/e2e/runner/tasks/${task.id}/heartbeat`)
      .set('x-test-user', 'someone-else')
      .send({ runner })
      .expect(200, { status: 'cancelled' });
    await request(app)
      .put(`/e2e/runner/tasks/${task.id}/artifacts/video.webm`)
      .set('x-adk-runner-id', 'another-runner')
      .set('content-type', 'application/octet-stream')
      .send(WEBM)
      .expect(404);
    // Exploration tasks carry no evidence files.
    await request(app)
      .put(`/e2e/runner/tasks/${task.id}/artifacts/video.webm`)
      .set('x-adk-runner-id', runner.id)
      .set('content-type', 'application/octet-stream')
      .send(WEBM)
      .expect(400);
    await request(app)
      .post(`/e2e/runner/tasks/${task.id}/complete`)
      .send({ runnerId: runner.id, outcome: { kind: 'run', status: 'passed' } })
      .expect(400);
  });
});
