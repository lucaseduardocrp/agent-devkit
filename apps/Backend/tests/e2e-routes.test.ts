import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eRunner } from '../src/modules/e2e/application/e2e-runner.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };

const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001', async ({ page }) => { await page.goto('/'); await expect(page).toHaveURL('/'); });`;

function setup() {
  const scripts = new FakeScriptRepository();
  const runner: E2eRunner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'x', pages: [] }),
    run: vi.fn().mockResolvedValue({
      status: 'passed',
      durationMs: 5,
      error: null,
      logs: 'ok',
      video: Buffer.from('video-bytes'),
      steps: [],
    }),
  };
  const author: E2eAuthor = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [{ title: 'Open page', description: 'd', priority: 'high', steps: [] }],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn(),
  };
  const app = createApp({
    e2eRunner: runner,
    e2eAuthor: author,
    e2eArtifacts: new InMemoryE2eArtifactStore(),
    e2eScripts: scripts,
    requestContextResolver: (req) => ({
      requestId: 'e2e-test',
      ownerId: 'ws',
      workspaceId: req.header('x-test-workspace') ?? 'ws',
      actorId: 'user',
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
      locale: 'en-US',
    }),
  });
  return { app, runner, scripts };
}

async function createAgent(app: ReturnType<typeof setup>['app']) {
  const agent = await request(app)
    .post('/agents')
    .send({ name: 'QA', instructions: 'Test things.' })
    .expect(201);
  return agent.body.agent.id as string;
}

async function waitForStatus(
  app: ReturnType<typeof setup>['app'],
  id: string,
  status: string,
): Promise<Record<string, unknown>> {
  await vi.waitFor(async () => {
    const response = await request(app).get(`/e2e/creations/${id}`).expect(200);
    expect(response.body.creation.status).toBe(status);
  });
  return (await request(app).get(`/e2e/creations/${id}`)).body.creation;
}

describe('E2E routes', () => {
  it('stores Access credentials encrypted, uses them on the worker and clears them when the origin changes', async () => {
    const { app, runner } = setup();
    const agentId = await createAgent(app);
    const input = {
      name: 'Protected app',
      agentId,
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'https://app.example.com',
      prd: 'Protected application',
      repository,
    };
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        ...input,
        planning: 'host',
        accessClientId: 'client-id',
        accessClientSecret: 'client-secret',
      })
      .expect(202);
    const id = created.body.creation.id as string;
    expect(created.body.creation.hasAccessServiceToken).toBe(true);
    expect(created.body.creation).not.toHaveProperty('accessSecret');
    await vi.waitFor(() =>
      expect(runner.explore).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: { clientId: 'client-id', clientSecret: 'client-secret' },
        }),
      ),
    );
    const saved = await request(app).get(`/e2e/creations/${id}`).expect(200);
    expect(JSON.stringify(saved.body)).not.toContain('client-secret');

    const unchanged = await request(app).put(`/e2e/creations/${id}`).send(input).expect(200);
    expect(unchanged.body.creation.hasAccessServiceToken).toBe(true);
    const moved = await request(app)
      .put(`/e2e/creations/${id}`)
      .send({
        ...input,
        baseUrl: 'https://other.example.com',
      })
      .expect(200);
    expect(moved.body.creation.hasAccessServiceToken).toBe(false);
  });

  it('rejects local URLs in the public tunnel check', async () => {
    const { app } = setup();
    await request(app).post('/e2e/tunnel/check').send({ url: 'http://localhost:5173' }).expect(400);
    await request(app)
      .post('/e2e/tunnel/check')
      .set('x-test-role', 'VIEWER')
      .send({ url: 'https://sample.trycloudflare.com' })
      .expect(403);
  });
  it('creates a run, lists it and serves test details and videos', async () => {
    const { app } = setup();
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'ama',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        path: 'e/123',
        username: 'qa@example.com',
        password: 'pw',
        prd: 'Questions and votes',
        prdFileNames: ['prd.md'],
        repository,
      })
      .expect(202);
    expect(created.body.creation).toMatchObject({ status: 'queued', hasPassword: true });
    expect(created.body.creation).not.toHaveProperty('passwordSecret');
    const id = created.body.creation.id as string;
    const detail = await waitForStatus(app, id, 'completed');
    const tests = detail['tests'] as { id: string; status: string }[];
    expect(tests[0]).toMatchObject({ status: 'passed', hasVideo: true });

    const list = await request(app).get('/e2e/creations').expect(200);
    expect(list.body.creations[0]).toMatchObject({ id, passed: 1, total: 1 });

    const test = await request(app).get(`/e2e/tests/${tests[0]!.id}`).expect(200);
    expect(test.body.test).toMatchObject({
      scriptPath: 'tests/e2e/tc001-open-page.spec.ts',
      logs: 'ok',
    });

    const script = await request(app)
      .get('/e2e/tests/' + tests[0]!.id + '/script')
      .expect(200);
    expect(script.body.script).toMatchObject({
      content: SCRIPT,
      repository: { name: 'acme/demo-app' },
    });
    const edited = SCRIPT.replace("toHaveURL('/')", "toHaveURL('/home')");
    const pushed = await request(app)
      .put('/e2e/tests/' + tests[0]!.id + '/script')
      .send({ content: edited })
      .expect(200);
    expect(pushed.body.script.content).toBe(edited);
    await request(app)
      .put('/e2e/tests/' + tests[0]!.id + '/script')
      .send({})
      .expect(400);
    const pulled = await request(app)
      .post('/e2e/creations/' + id + '/pull')
      .expect(200);
    expect(pulled.body.result).toEqual({ linked: 1, imported: 0, missing: 0 });

    const repositories = await request(app).get('/e2e/repositories').expect(200);
    expect(repositories.body.repositories).toHaveLength(2);
    const branches = await request(app)
      .get('/e2e/repositories/branches?provider=github&repositoryId=42')
      .expect(200);
    expect(branches.body.branches[0]).toEqual({ name: 'main', isDefault: true });
    await request(app).get('/e2e/repositories/branches?provider=gitlab&repositoryId=1').expect(400);

    // In-memory storage cannot sign URLs, so the client falls back to downloading.
    const signed = await request(app).get(`/e2e/tests/${tests[0]!.id}/video-url`).expect(200);
    expect(signed.body).toEqual({ video: null });
    await request(app).get('/e2e/tests/missing/video-url').expect(404);
    const video = await request(app).get(`/e2e/tests/${tests[0]!.id}/video`).expect(200);
    expect(video.headers['content-type']).toBe('video/webm');
    expect(Buffer.from(video.body as Buffer).toString()).toBe('video-bytes');

    await request(app).post(`/e2e/tests/${tests[0]!.id}/run`).expect(202);
    await waitForStatus(app, id, 'completed');
    await request(app)
      .post(`/e2e/tests/${tests[0]!.id}/run`)
      .send({ regenerate: true })
      .expect(202);
    await waitForStatus(app, id, 'completed');
    await request(app).post(`/e2e/creations/${id}/run`).expect(202);
    await waitForStatus(app, id, 'completed');
    await request(app).post(`/e2e/creations/${id}/cancel`).expect(409);
    const updated = await request(app)
      .put(`/e2e/creations/${id}`)
      .send({ name: 'ama v2', agentId, mode: 'backend', baseUrl: 'http://x', prd: 'p', repository })
      .expect(200);
    expect(updated.body.creation).toMatchObject({ name: 'ama v2', mode: 'backend', path: '/' });
    await request(app).put(`/e2e/creations/${id}`).send({ name: '' }).expect(400);
    await request(app).delete(`/e2e/creations/${id}`).expect(204);
    await request(app).get(`/e2e/creations/${id}`).expect(404);
  });

  it('lets the MCP host plan a run and save its specs', async () => {
    const { app, scripts } = setup();
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'login',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        prd: 'Login page',
        repository,
        planning: 'host',
      })
      .expect(202);
    expect(created.body.creation.status).toBe('draft');
    const id = created.body.creation.id as string;
    await vi.waitFor(async () => {
      const brief = await request(app).post(`/e2e/creations/${id}/brief`).expect(200);
      expect(brief.body.brief.snapshot.status).toBe('ready');
    });
    const refreshed = await request(app)
      .post(`/e2e/creations/${id}/brief`)
      .send({ refresh: true })
      .expect(200);
    expect(refreshed.body.brief.snapshot.status).toBe('capturing');
    await vi.waitFor(async () => {
      const brief = await request(app).post(`/e2e/creations/${id}/brief`).expect(200);
      expect(brief.body.brief.snapshot.status).toBe('ready');
    });
    await request(app).put(`/e2e/creations/${id}/plan`).send({ tests: [] }).expect(400);
    const planned = await request(app)
      .put(`/e2e/creations/${id}/plan`)
      .send({ tests: [{ title: 'Open page', script: SCRIPT }] })
      .expect(202);
    expect(planned.body.creation.status).toBe('queued');
    expect(scripts.commits.at(-1)?.path).toBe('tests/e2e/tc001-open-page.spec.ts');
    const detail = await waitForStatus(app, id, 'completed');
    expect(detail['tests']).toEqual([
      expect.objectContaining({ code: 'TC001', priority: 'medium', status: 'passed' }),
    ]);
    await request(app).post('/e2e/creations/missing/brief').expect(404);
  });

  it('cancels active runs', async () => {
    const { app, runner } = setup();
    vi.mocked(runner.explore).mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'api',
        agentId,
        mode: 'backend',
        baseUrl: 'http://api.test',
        prd: 'API',
        repository,
      })
      .expect(202);
    const cancelled = await request(app)
      .post(`/e2e/creations/${created.body.creation.id}/cancel`)
      .expect(200);
    expect(cancelled.body.creation.status).toBe('cancelled');
  });

  it('validates input, permissions and workspace scoping', async () => {
    const { app, scripts } = setup();
    const agentId = await createAgent(app);
    await request(app).post('/e2e/creations').send({ name: '' }).expect(400);
    const invalidUrl = await request(app)
      .post('/e2e/creations')
      .send({ name: 'x', agentId, mode: 'frontend', baseUrl: 'ftp://x', prd: 'p', repository })
      .expect(400);
    expect(invalidUrl.body.code).toBe('E2E_INVALID_URL');
    await request(app)
      .post('/e2e/creations')
      .set('x-test-role', 'VIEWER')
      .send({ name: 'x', agentId, mode: 'frontend', baseUrl: 'http://x', prd: 'p', repository })
      .expect(403);
    await request(app).get('/e2e/creations').set('x-test-role', 'VIEWER').expect(200);
    await request(app).get('/e2e/tests/missing').expect(404);
    await request(app).get('/e2e/tests/missing/video').expect(404);
    await request(app).post('/e2e/tests/missing/run').expect(404);
    await request(app).post('/e2e/creations/missing/run').expect(404);
    await request(app).delete('/e2e/creations/missing').expect(404);
    await request(app).get('/e2e/tests/missing/script').expect(404);
    await request(app).put('/e2e/tests/missing/script').send({ content: 'x' }).expect(404);
    await request(app).post('/e2e/creations/missing/pull').expect(404);
    vi.spyOn(scripts, 'listRepositories').mockRejectedValueOnce(new Error('down'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await request(app).get('/e2e/repositories').expect(500);
    errorLog.mockRestore();
  });

  it('requires a workspace context', async () => {
    const app = createApp({
      requestContextResolver: () => ({ requestId: 'r', ownerId: 'u', memberRole: 'ADMIN' }),
    });
    const response = await request(app).get('/e2e/creations').expect(400);
    expect(response.body.code).toBe('WORKSPACE_REQUIRED');
  });
});
