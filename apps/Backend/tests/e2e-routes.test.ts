import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import type { E2eRunner } from '../src/modules/e2e/application/e2e-runner.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const repository = { provider: 'github', id: '42', branch: 'main', path: 'tests/e2e' };

const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001', async ({ page }) => {
  await test.step('Step 1 - Open', async () => { await page.goto('/'); await expect(page).toHaveURL('/'); });
});`;
const STEP = `await test.step('Step 1 - Open', async () => { await page.goto('/x'); });`;

function setup(options: { chat?: boolean; fix?: boolean } = {}) {
  const analyze = vi.fn().mockResolvedValue({
    verdict: options.fix ? 'app_bug' : 'test_issue',
    summary: 'Goal: ...',
    criteriaMet: true,
  });
  const reviseCase = vi.fn().mockResolvedValue({
    reply: 'Ajustei o caso.',
    testCase: {
      title: 'Open page',
      description: 'd',
      steps: [{ action: 'Abrir', expectedResult: '' }],
    },
  });
  const fixStep = vi.fn().mockResolvedValue(STEP);
  const scripts = new FakeScriptRepository();
  const runner: E2eRunner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'x', pages: [] }),
    run: vi.fn().mockResolvedValue({
      status: options.fix ? 'failed' : 'passed',
      durationMs: 5,
      error: options.fix ? 'Expected: 4 Received: 5' : null,
      logs: 'ok',
      video: Buffer.from('video-bytes'),
      steps: options.fix
        ? [
            {
              position: 1,
              title: 'Step 1 - Open',
              status: 'failed',
              durationMs: 1,
              error: 'Expected: 4 Received: 5',
              screenshot: null,
            },
          ]
        : [],
    }),
  };
  const author: E2eAuthor = {
    plan: vi.fn().mockResolvedValue({
      summary: 'PRD',
      tests: [{ title: 'Open page', description: 'd', priority: 'high', steps: [] }],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze,
    ...(options.chat === false ? {} : { reviseCase }),
    ...(options.fix ? { fixStep } : {}),
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
  return { app, runner, scripts, analyze, reviseCase, fixStep };
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
    const cleanup = `export default async function afterRun() {}`;
    const hook = await request(app)
      .put('/e2e/tests/' + tests[0]!.id + '/script')
      .send({ content: cleanup, kind: 'afterRun' })
      .expect(200);
    expect(hook.body.script).toMatchObject({
      kind: 'afterRun',
      path: 'tests/e2e/tc001-open-page.after.ts',
      content: cleanup,
    });
    const before = await request(app)
      .get('/e2e/tests/' + tests[0]!.id + '/script?kind=beforeRun')
      .expect(200);
    expect(before.body.script).toMatchObject({ kind: 'beforeRun', content: null });
    await request(app)
      .get('/e2e/tests/' + tests[0]!.id + '/script?kind=other')
      .expect(400);
    const instructions = await request(app)
      .put('/e2e/tests/' + tests[0]!.id + '/hook-instructions')
      .send({ kind: 'beforeRun', instructions: '<p>Abrir /eventos</p>' })
      .expect(200);
    expect(instructions.body.test).toMatchObject({
      beforeRunInstructions: '<p>Abrir /eventos</p>',
    });
    await request(app)
      .put('/e2e/tests/' + tests[0]!.id + '/hook-instructions')
      .send({ kind: 'spec', instructions: 'x' })
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
    await request(app)
      .post(`/e2e/tests/${tests[0]!.id}/run`)
      .send({ regenerate: true, instructions: 'Open it by its route', useLastRun: true })
      .expect(202);
    await waitForStatus(app, id, 'completed');
    const guided = await request(app).get(`/e2e/tests/${tests[0]!.id}`).expect(200);
    expect(guided.body.test).toMatchObject({ scriptInstructions: 'Open it by its route' });
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

  it('talks about a test case with the AI ("Fix with AI") without saving or running anything', async () => {
    const { app, runner, reviseCase } = setup();
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'chat',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        path: 'e/1',
        prd: 'x',
        prdFileNames: [],
        repository,
      })
      .expect(202);
    const detail = await waitForStatus(app, created.body.creation.id as string, 'completed');
    const testId = (detail['tests'] as { id: string }[])[0]!.id;
    const runs = vi.mocked(runner.run).mock.calls.length;
    const body = {
      messages: [{ role: 'user', content: 'O fluxo começa pelo menu' }],
      testCase: {
        title: 'Open page',
        description: 'd',
        steps: [{ action: 'Abrir', expectedResult: 'x' }],
      },
    };

    const answer = await request(app).post(`/e2e/tests/${testId}/fix-case`).send(body).expect(200);
    expect(answer.body.revision).toMatchObject({ reply: 'Ajustei o caso.' });
    expect(reviseCase).toHaveBeenCalledWith(
      expect.objectContaining({ messages: body.messages, testCase: body.testCase, images: [] }),
    );
    // The test is the same afterwards and nothing ran.
    expect(vi.mocked(runner.run).mock.calls).toHaveLength(runs);

    // Images are looked up by id among the workspace's attachments; one that is not there is skipped.
    await request(app)
      .post(`/e2e/tests/${testId}/fix-case`)
      .send({ ...body, imageIds: ['11111111-1111-4111-8111-111111111111'] })
      .expect(200);

    await request(app).post('/e2e/tests/missing/fix-case').send(body).expect(404);
    await request(app)
      .post(`/e2e/tests/${testId}/fix-case`)
      .send({ ...body, messages: [{ role: 'assistant', content: 'oi' }] })
      .expect(400);
    await request(app)
      .post(`/e2e/tests/${testId}/fix-case`)
      .send({ ...body, messages: [] })
      .expect(400);
    await request(app)
      .post(`/e2e/tests/${testId}/fix-case`)
      .send({ ...body, imageIds: ['not-an-id'] })
      .expect(400);
    await request(app)
      .post(`/e2e/tests/${testId}/fix-case`)
      .set('x-test-role', 'VIEWER')
      .send(body)
      .expect(403);
  });

  it('fixes one failed step with the AI, then runs the test again', async () => {
    const { app, runner, fixStep } = setup({ fix: true });
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'fix step',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        path: 'e/1',
        prd: 'x',
        prdFileNames: [],
        repository,
      })
      .expect(202);
    const detail = await waitForStatus(app, created.body.creation.id as string, 'completed');
    const testId = (detail['tests'] as { id: string }[])[0]!.id;
    const runs = vi.mocked(runner.run).mock.calls.length;

    // The instructions are optional; the test runs again with the step rewritten.
    await request(app)
      .post(`/e2e/tests/${testId}/steps/1/fix`)
      .send({ instructions: 'Fill only the Documents filter' })
      .expect(202);
    await vi.waitFor(() => expect(vi.mocked(runner.run).mock.calls).toHaveLength(runs + 1));
    expect(fixStep).toHaveBeenCalledWith(
      expect.objectContaining({
        step: { position: 1, title: 'Step 1 - Open' },
        instructions: 'Fill only the Documents filter',
      }),
    );
    await waitForStatus(app, created.body.creation.id as string, 'completed');
    await request(app).post(`/e2e/tests/${testId}/steps/1/fix`).send({}).expect(202);
    await waitForStatus(app, created.body.creation.id as string, 'completed');
    expect(fixStep.mock.calls.at(-1)![0].instructions).toBe('');

    await request(app).post(`/e2e/tests/${testId}/steps/9/fix`).send({}).expect(404);
    await request(app).post('/e2e/tests/missing/steps/1/fix').send({}).expect(404);
    await request(app).post(`/e2e/tests/${testId}/steps/0/fix`).send({}).expect(400);
    await request(app)
      .post(`/e2e/tests/${testId}/steps/1/fix`)
      .send({ instructions: 'a'.repeat(20_001) })
      .expect(400);
    await request(app)
      .post(`/e2e/tests/${testId}/steps/1/fix`)
      .set('x-test-role', 'VIEWER')
      .send({})
      .expect(403);
  });

  it('does not offer to fix a step when the author cannot', async () => {
    const { app } = setup();
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'no fix',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        path: 'e/1',
        prd: 'x',
        prdFileNames: [],
        repository,
      })
      .expect(202);
    const detail = await waitForStatus(app, created.body.creation.id as string, 'completed');
    const testId = (detail['tests'] as { id: string }[])[0]!.id;
    const answer = await request(app).post(`/e2e/tests/${testId}/steps/1/fix`).send({}).expect(503);
    expect(answer.body.code).toBe('E2E_STEP_FIX_UNAVAILABLE');
  });

  it('does not offer the chat when the author cannot rewrite a test case', async () => {
    const { app } = setup({ chat: false });
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'nochat',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        path: 'e/1',
        prd: 'x',
        prdFileNames: [],
        repository,
      })
      .expect(202);
    const detail = await waitForStatus(app, created.body.creation.id as string, 'completed');
    const testId = (detail['tests'] as { id: string }[])[0]!.id;
    const response = await request(app)
      .post(`/e2e/tests/${testId}/fix-case`)
      .send({
        messages: [{ role: 'user', content: 'x' }],
        testCase: { title: 't', description: '', steps: [] },
      })
      .expect(503);
    expect(response.body.code).toBe('E2E_CASE_CHAT_UNAVAILABLE');
  });

  it('lets the user set the success criteria and the result of a test, and review it', async () => {
    const { app, analyze } = setup();
    const agentId = await createAgent(app);
    const created = await request(app)
      .post('/e2e/creations')
      .send({
        name: 'perm',
        agentId,
        mode: 'frontend',
        baseUrl: 'http://localhost:5173',
        path: 'e/1',
        prd: 'x',
        prdFileNames: [],
        repository,
      })
      .expect(202);
    const detail = await waitForStatus(app, created.body.creation.id as string, 'completed');
    const testId = (detail['tests'] as { id: string }[])[0]!.id;

    const criteria = await request(app)
      .put(`/e2e/tests/${testId}/success-criteria`)
      .send({ criteria: ' Acesso negado ' })
      .expect(200);
    expect(criteria.body.test).toMatchObject({ successCriteria: 'Acesso negado' });
    await request(app).put(`/e2e/tests/${testId}/success-criteria`).send({}).expect(400);

    // A pass of the run itself has nothing to review.
    await request(app).post(`/e2e/tests/${testId}/reevaluate`).expect(409);
    const failed = await request(app)
      .put(`/e2e/tests/${testId}/result`)
      .send({ decision: 'failed', note: 'wrong screen' })
      .expect(200);
    expect(failed.body.test).toMatchObject({
      status: 'failed',
      resultSource: 'manual',
      resultNote: 'wrong screen',
    });
    await request(app).put(`/e2e/tests/${testId}/result`).send({ decision: 'maybe' }).expect(400);

    // The run of this test reported no steps, so there is none to decide.
    await request(app)
      .put(`/e2e/tests/${testId}/steps/1/result`)
      .send({ decision: 'passed', note: 'fine' })
      .expect(404);
    await request(app)
      .put(`/e2e/tests/${testId}/steps/1/result`)
      .set('x-test-role', 'VIEWER')
      .send({ decision: 'passed' })
      .expect(403);
    await request(app)
      .put(`/e2e/tests/${testId}/steps/0/result`)
      .send({ decision: 'passed' })
      .expect(400);

    const reviewed = await request(app).post(`/e2e/tests/${testId}/reevaluate`).expect(200);
    expect(analyze).toHaveBeenCalledOnce();
    expect(reviewed.body.test).toMatchObject({ status: 'passed', resultSource: 'criteria' });
    const back = await request(app)
      .put(`/e2e/tests/${testId}/result`)
      .send({ decision: 'run' })
      .expect(200);
    expect(back.body.test).toMatchObject({ status: 'passed', resultSource: 'run' });

    await request(app)
      .put(`/e2e/tests/${testId}/result`)
      .set('x-test-role', 'VIEWER')
      .send({ decision: 'passed' })
      .expect(403);
    await request(app).post(`/e2e/tests/${testId}/run`).send({ successCriteria: '' }).expect(202);
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
    // Extra instructions have room for long acceptance criteria, but not for unlimited text.
    const withInstructions = (instructions: string) => ({
      name: 'x',
      agentId,
      mode: 'frontend',
      baseUrl: 'http://x',
      prd: 'p',
      repository,
      start: false,
      instructions,
    });
    const tooLong = await request(app)
      .post('/e2e/creations')
      .send(withInstructions('a'.repeat(20_001)))
      .expect(400);
    expect(tooLong.body.details).toEqual([expect.objectContaining({ field: 'instructions' })]);
    await request(app)
      .post('/e2e/creations')
      .send(withInstructions('a'.repeat(20_000)))
      .expect(202);
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
