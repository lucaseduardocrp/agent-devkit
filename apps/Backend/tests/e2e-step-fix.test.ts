import { describe, expect, it, vi, type Mock } from 'vitest';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import type { E2eRunResult } from '../src/modules/e2e/application/e2e-runner.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const SCRIPT = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await test.step('Step 1 - Open', async () => { await page.goto('/'); });
  await test.step('Step 2 - Filter', async () => { await expect(page).toHaveTitle('x'); });
});`;
// What the AI answers with: the step alone. The spec that results has only that step changed.
const STEP = `await test.step('Step 2 - Filter', async () => { await expect(page).toHaveTitle('y'); });`;
const FIXED = SCRIPT.replace("toHaveTitle('x')", "toHaveTitle('y')");
const REJECTED = `await test.step('Step 2 - Filter', async () => { eval('x'); });`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const failedRun: E2eRunResult = {
  status: 'failed',
  durationMs: 900,
  error: 'Expected: 4 Received: 5',
  logs: 'boom',
  video: null,
  steps: [
    {
      position: 1,
      title: 'Step 1 - Open',
      status: 'passed',
      durationMs: 10,
      error: null,
      screenshot: null,
    },
    {
      position: 2,
      title: 'Step 2 - Filter',
      status: 'failed',
      durationMs: 20,
      error: 'Expected: 4 Received: 5',
      screenshot: PNG,
    },
  ],
};
const passedRun: E2eRunResult = {
  status: 'passed',
  durationMs: 800,
  error: null,
  logs: 'ok',
  video: null,
  steps: [],
};
const context = {
  requestId: 'r',
  workspaceId: 'ws',
  ownerId: 'ws',
  actorId: 'user',
  locale: 'en-US' as const,
};
const input = {
  name: 'ama',
  agentId: 'agent',
  mode: 'frontend' as const,
  scope: 'codebase' as const,
  baseUrl: 'http://localhost:5173',
  path: 'e/123',
  username: 'qa@example.com',
  password: 'secret-pass',
  prd: 'Users filter the table.',
  prdFileNames: ['prd.md'],
  repository: { provider: 'github' as const, id: '42', branch: 'main', path: '/tests/e2e/' },
};

function setup({
  fixStep = vi.fn().mockResolvedValue(STEP),
  executorFixes = true,
  serviceFixes = true,
}: { fixStep?: Mock; executorFixes?: boolean; serviceFixes?: boolean } = {}) {
  const store = new InMemoryE2eStore();
  const artifacts = new InMemoryE2eArtifactStore();
  const scripts = new FakeScriptRepository();
  const author = {
    plan: vi.fn().mockResolvedValue({
      summary: '# PRD',
      tests: [{ title: 'Submit question', description: 'd1', priority: 'high', steps: ['a'] }],
    }),
    writeScript: vi.fn().mockResolvedValue(SCRIPT),
    analyze: vi.fn().mockResolvedValue({ verdict: 'app_bug', summary: 'Goal: ...' }),
  };
  const results = [failedRun, passedRun];
  const runner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'http://localhost:5173/e/123', pages: [] }),
    run: vi
      .fn()
      .mockImplementation(() => Promise.resolve(results.length > 1 ? results.shift() : results[0])),
  };
  const queue = new InMemoryE2eJobQueue();
  const worker = new E2eWorker({
    queue,
    concurrency: 1,
    heartbeatMs: 5,
    executor: new E2eExecutor({
      store,
      queue,
      artifacts,
      author: (executorFixes ? { ...author, fixStep } : author) as unknown as E2eAuthor,
      runner,
      scripts,
      testConcurrency: 1,
    }),
  });
  const service = Object.assign(
    new E2eService({
      store,
      queue,
      dispatcher: new LocalE2eDispatcher(worker),
      artifacts,
      agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) } as never,
      scripts,
      ...(serviceFixes ? { author: { ...author, fixStep } as never } : {}),
    }),
    { idle: () => worker.idle() },
  );
  return { service, store, artifacts, author, fixStep, runner, scripts };
}

/** A run whose only test failed on its second step, which left a screenshot. */
async function failedTest(options?: Parameters<typeof setup>[0]) {
  const world = setup(options);
  const created = await world.service.create(context, input);
  await world.service.idle();
  const [test] = (await world.service.get('ws', created.id)).tests;
  expect(await world.service.getTest('ws', test!.id)).toMatchObject({ status: 'failed' });
  return { ...world, testId: test!.id };
}

describe('fixing one step of a failed test', () => {
  it('rewrites only that step from the words of the user and the failure, then runs again', async () => {
    const { service, store, fixStep, author, runner, scripts, testId } = await failedTest();
    const written = author.writeScript.mock.calls.length;

    await service.fixTestStep(
      'ws',
      testId,
      2,
      '  Fill only the Documents filter  ',
      'user',
      'pt-BR',
    );
    await service.idle();

    expect(fixStep).toHaveBeenCalledTimes(1);
    const request = fixStep.mock.calls[0]![0];
    expect(request).toMatchObject({
      script: SCRIPT,
      step: { position: 2, title: 'Step 2 - Filter' },
      instructions: 'Fill only the Documents filter',
    });
    expect(request.problem).toContain('Expected: 4 Received: 5');
    // The AI also sees the screen where the step stopped.
    expect(request.images).toEqual([{ mimeType: 'image/png', data: PNG.toString('base64') }]);
    // Nothing else is written again: the spec is not regenerated.
    expect(author.writeScript).toHaveBeenCalledTimes(written);

    const stored = await store.getTest('ws', testId);
    expect(stored).toMatchObject({
      status: 'passed',
      scriptPath: 'tests/e2e/tc001-submit-question.spec.ts',
      regenerationFeedback: null,
    });
    expect(scripts.commits.at(-1)).toMatchObject({
      message: 'test(e2e): fix step 2 of TC001 - Submit question',
      path: 'tests/e2e/tc001-submit-question.spec.ts',
    });
    expect(runner.run.mock.calls.at(-1)![0].script).toBe(FIXED);
    expect(await service.getScript('ws', testId)).toMatchObject({ content: FIXED });
  });

  it('never rewrites anything but the step, even when the AI answers with the whole file', async () => {
    const whole = SCRIPT.replace("goto('/')", "goto('/login')").replace('Step 1', 'Passo 1');
    const fixStep = vi.fn().mockResolvedValueOnce(whole).mockResolvedValueOnce(whole);
    const { service, testId, runner } = await failedTest({ fixStep });
    const runs = runner.run.mock.calls.length;
    await service.fixTestStep('ws', testId, 2, '');
    await service.idle();
    expect(fixStep).toHaveBeenCalledTimes(2);
    expect(fixStep.mock.calls[1]![0].previous).toMatchObject({
      script: whole,
      problem: expect.stringContaining('exactly one await test.step'),
    });
    // Neither answer was used: the spec is as it was and nothing ran.
    expect(await service.getScript('ws', testId)).toMatchObject({ content: SCRIPT });
    expect(runner.run).toHaveBeenCalledTimes(runs);
    expect(await service.getTest('ws', testId)).toMatchObject({ status: 'error' });
  });

  it('keeps the name of the step and the rest of the spec when the AI renames it', async () => {
    const renamed = STEP.replace('Step 2 - Filter', 'Passo 2 - Filtrar');
    const { service, testId, runner } = await failedTest({
      fixStep: vi.fn().mockResolvedValue(renamed),
    });
    await service.fixTestStep('ws', testId, 2, '', 'user', 'pt-BR');
    await service.idle();
    // Byte for byte the old spec, with the new code of that step only.
    expect(await service.getScript('ws', testId)).toMatchObject({ content: FIXED });
    expect(runner.run.mock.calls.at(-1)![0].script).toBe(FIXED);
  });

  it('tries once more when the security checks reject the rewrite', async () => {
    const fixStep = vi.fn().mockResolvedValueOnce(REJECTED).mockResolvedValueOnce(STEP);
    const { service, testId, scripts } = await failedTest({ fixStep });
    await service.fixTestStep('ws', testId, 2, '');
    await service.idle();
    expect(fixStep).toHaveBeenCalledTimes(2);
    expect(fixStep.mock.calls[1]![0].previous).toMatchObject({
      script: REJECTED,
      problem: expect.stringContaining('rejected by the security checks'),
    });
    expect(await service.getScript('ws', testId)).toMatchObject({ content: FIXED });
    expect(scripts.commits.filter((commit) => commit.message.includes('fix step'))).toHaveLength(1);
  });

  it('keeps the spec as it was when the rewrite is rejected again', async () => {
    const fixStep = vi.fn().mockResolvedValue(REJECTED);
    const { service, testId, runner } = await failedTest({ fixStep });
    const runs = runner.run.mock.calls.length;
    await service.fixTestStep('ws', testId, 2, 'use eval');
    await service.idle();
    expect(fixStep).toHaveBeenCalledTimes(2);
    expect(runner.run).toHaveBeenCalledTimes(runs);
    expect(await service.getScript('ws', testId)).toMatchObject({ content: SCRIPT });
    expect(await service.getTest('ws', testId)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('blocked by the security checks'),
    });
  });

  it('does not offer the fix when the AI author cannot do it', async () => {
    const { service, testId } = await failedTest({ serviceFixes: false });
    await expect(service.fixTestStep('ws', testId, 2, '')).rejects.toMatchObject({
      code: 'E2E_STEP_FIX_UNAVAILABLE',
      statusCode: 503,
    });
  });

  it('fails the test, and says why, when the worker cannot fix steps', async () => {
    const { service, store, testId, runner } = await failedTest({ executorFixes: false });
    const runs = runner.run.mock.calls.length;
    await service.fixTestStep('ws', testId, 2, '');
    await service.idle();
    expect(runner.run).toHaveBeenCalledTimes(runs);
    expect(await service.getTest('ws', testId)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('not available'),
    });
    // The request is kept until something uses it; a plain rerun must not bring it back.
    expect((await store.getTest('ws', testId))?.regenerationFeedback).toContain('"position":2');
  });

  it('refuses a step the test does not have, a test without a script and one that is running', async () => {
    const { service, store, scripts, testId } = await failedTest();
    await expect(service.fixTestStep('ws', testId, 9, '')).rejects.toMatchObject({
      code: 'E2E_STEP_NOT_FOUND',
      statusCode: 404,
    });
    await expect(service.fixTestStep('ws', 'missing', 2, '')).rejects.toMatchObject({
      statusCode: 404,
    });

    // The spec cannot be read any more: there is nothing to fix.
    scripts.files.clear();
    await expect(service.fixTestStep('ws', testId, 2, '')).rejects.toMatchObject({
      code: 'E2E_STEP_FIX_NO_SCRIPT',
      statusCode: 409,
    });
    await store.updateTest('ws', testId, { scriptPath: null });
    await expect(service.fixTestStep('ws', testId, 2, '')).rejects.toMatchObject({
      code: 'E2E_STEP_FIX_NO_SCRIPT',
    });
    expect((await store.getTest('ws', testId))?.regenerationFeedback).toBeNull();
  });

  it('does not bring a fix that never ran back with a plain rerun', async () => {
    const { service, store, fixStep, runner, testId } = await failedTest({ executorFixes: false });
    await service.fixTestStep('ws', testId, 2, 'old words');
    await service.idle();
    expect((await store.getTest('ws', testId))?.regenerationFeedback).not.toBeNull();

    const runs = runner.run.mock.calls.length;
    await service.rerunTest('ws', testId);
    await service.idle();
    expect((await store.getTest('ws', testId))?.regenerationFeedback).toBeNull();
    expect(fixStep).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledTimes(runs + 1);
    expect(runner.run.mock.calls.at(-1)![0].script).toBe(SCRIPT);
  });
});
