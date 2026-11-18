import { describe, expect, it, vi, type Mock } from 'vitest';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import type { E2eRunResult } from '../src/modules/e2e/application/e2e-runner.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eExecutor, recentSnapshot } from '../src/modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import {
  evidenceSteps,
  meetsCriteria,
  toLlmImages,
} from '../src/modules/e2e/application/e2e-judge.js';
import {
  PACES,
  SLOW_MO_MS,
  evidenceModule,
  resolvePace,
  runnerConfig,
  withRecordingHold,
} from '../src/modules/e2e/adapters/playwright-runner.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const VALID = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('x');
});`;
// The signature of a PNG file: enough for the judge to accept it as an image.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const passed: E2eRunResult = {
  status: 'passed',
  durationMs: 10,
  error: null,
  logs: 'ok',
  video: null,
  steps: [],
};
const failedOnTechnicality: E2eRunResult = {
  status: 'failed',
  durationMs: 20,
  error: 'expect(locator).toHaveCount(expected) failed',
  logs: 'boom',
  video: null,
  steps: [
    {
      position: 1,
      title: 'Passo 1',
      status: 'passed',
      durationMs: 5,
      error: null,
      screenshot: PNG,
    },
    {
      position: 2,
      title: 'Passo 2',
      status: 'failed',
      durationMs: 5,
      error: 'Expected: 0\nReceived: 1',
      screenshot: PNG,
    },
  ],
};
const context = {
  requestId: 'r',
  workspaceId: 'ws',
  ownerId: 'ws',
  actorId: 'user',
  locale: 'pt-BR' as const,
};
const input = {
  name: 'permissions',
  agentId: 'agent',
  mode: 'frontend' as const,
  scope: 'codebase' as const,
  baseUrl: 'http://localhost:5173',
  path: 'e/1',
  username: 'qa@example.com',
  password: 'secret-pass',
  prd: 'Users without permission see an access denied screen.',
  prdFileNames: [],
  repository: { provider: 'github' as const, id: '42', branch: 'main', path: 'tests/e2e' },
};

function setup(
  runResults: E2eRunResult[],
  analysis: Record<string, unknown> = {},
  withAuthor = true,
) {
  const store = new InMemoryE2eStore();
  const artifacts = new InMemoryE2eArtifactStore();
  const scripts = new FakeScriptRepository();
  const author = {
    plan: vi.fn().mockResolvedValue({
      summary: '# PRD',
      tests: [{ title: 'Hide buttons', description: 'd', priority: 'high', steps: ['a', 'b'] }],
    }),
    writeScript: vi.fn().mockResolvedValue(VALID),
    // Returns the script as it is: nothing is committed unless a test says otherwise.
    adaptScript: vi.fn().mockResolvedValue(VALID),
    analyze: vi
      .fn()
      .mockResolvedValue({ verdict: 'test_issue', summary: 'Goal: ...', ...analysis }),
  } as unknown as { plan: Mock; writeScript: Mock; adaptScript: Mock; analyze: Mock };
  const results = [...runResults];
  const runner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'http://localhost:5173/e/1', pages: [] }),
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
      artifacts,
      author: author as unknown as E2eAuthor,
      runner,
      scripts,
      testConcurrency: 1,
    }),
  });
  const service = new E2eService({
    store,
    queue,
    dispatcher: new LocalE2eDispatcher(worker),
    artifacts,
    agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) } as never,
    scripts,
    ...(withAuthor ? { author: author as unknown as E2eAuthor } : {}),
  });
  return { service, store, artifacts, scripts, author, runner, idle: () => worker.idle() };
}

async function firstTest(setupResult: ReturnType<typeof setup>) {
  const created = await setupResult.service.create(context, input);
  await setupResult.idle();
  return (await setupResult.service.get('ws', created.id)).tests[0]!;
}

describe('success criteria of a test', () => {
  it('counts a failure as passed when the criteria are met, without rewriting or running again', async () => {
    const harness = setup([passed, failedOnTechnicality], { criteriaMet: true });
    const test = await firstTest(harness);
    await harness.service.updateSuccessCriteria('ws', test.id, '  Show "Acesso negado"  ');
    harness.author.writeScript.mockClear();
    harness.runner.run.mockClear();
    harness.author.analyze.mockClear();

    await harness.service.rerunTest('ws', test.id, false, 'user', {
      successCriteria: 'Acesso negado',
    });
    await harness.idle();

    expect(harness.runner.run).toHaveBeenCalledOnce();
    expect(harness.author.writeScript).not.toHaveBeenCalled();
    const call = harness.author.analyze.mock.calls[0]![0];
    expect(call.steps).toHaveLength(2);
    // The failed step is also the last one: its screen is sent once.
    expect(call.images).toHaveLength(1);
    expect(await harness.service.getTest('ws', test.id)).toMatchObject({
      status: 'passed',
      resultSource: 'criteria',
      successCriteria: 'Acesso negado',
      error: 'expect(locator).toHaveCount(expected) failed',
    });
  });

  it('never promotes a failure without criteria, or when the evidence does not meet them', async () => {
    const harness = setup([passed, failedOnTechnicality], {
      criteriaMet: true,
      verdict: 'app_bug',
    });
    const test = await firstTest(harness);
    await harness.service.rerunTest('ws', test.id);
    await harness.idle();
    expect(await harness.service.getTest('ws', test.id)).toMatchObject({
      status: 'failed',
      resultSource: 'run',
    });
    // Without criteria the screenshots are not sent: only what the user asked to judge is.
    expect(harness.author.analyze.mock.calls.at(-1)![0].images).toBeUndefined();

    await harness.service.updateSuccessCriteria('ws', test.id, 'Acesso negado');
    harness.author.analyze.mockResolvedValue({
      verdict: 'app_bug',
      summary: 's',
      criteriaMet: false,
    });
    await harness.service.rerunTest('ws', test.id);
    await harness.idle();
    expect(await harness.service.getTest('ws', test.id)).toMatchObject({
      status: 'failed',
      resultSource: 'run',
    });
  });

  it('does not excuse a failing Before Run or After Run', async () => {
    const harness = setup(
      [passed, { ...failedOnTechnicality, error: 'Before Run: seed failed', steps: [] }],
      { criteriaMet: true, verdict: 'environment' },
    );
    const test = await firstTest(harness);
    await harness.service.updateSuccessCriteria('ws', test.id, 'anything');
    await harness.service.rerunTest('ws', test.id);
    await harness.idle();
    expect(await harness.service.getTest('ws', test.id)).toMatchObject({ status: 'failed' });
  });

  it('clears an empty criteria and clears the verdict of the user on the next execution', async () => {
    const harness = setup([passed, failedOnTechnicality], { verdict: 'app_bug' });
    const test = await firstTest(harness);
    await harness.service.updateSuccessCriteria('ws', test.id, 'x');
    expect(
      (await harness.service.updateSuccessCriteria('ws', test.id, '   ')).successCriteria,
    ).toBeNull();

    await harness.service.rerunTest('ws', test.id);
    await harness.idle();
    const failed = await harness.service.setResult('ws', test.id, 'passed', ' looks fine ');
    expect(failed).toMatchObject({
      status: 'passed',
      resultSource: 'manual',
      resultNote: 'looks fine',
    });
    await harness.service.rerunTest('ws', test.id, false, 'user', { successCriteria: '' });
    await harness.idle();
    expect(await harness.service.getTest('ws', test.id)).toMatchObject({
      status: 'failed',
      resultSource: 'run',
      resultNote: null,
    });
  });
});

describe('result decided by the user', () => {
  it('passes, fails and gives back the status of the run', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    expect(test.status).toBe('failed');

    expect(await harness.service.setResult('ws', test.id, 'passed')).toMatchObject({
      status: 'passed',
      resultSource: 'manual',
      resultNote: null,
    });
    expect(await harness.service.setResult('ws', test.id, 'failed', 'no')).toMatchObject({
      status: 'failed',
      resultNote: 'no',
    });
    await harness.service.setResult('ws', test.id, 'passed');
    expect(await harness.service.setResult('ws', test.id, 'run')).toMatchObject({
      status: 'failed',
      resultSource: 'run',
    });
  });

  it('gives back a pass when the run had no error and no failed step', async () => {
    const harness = setup([passed]);
    const test = await firstTest(harness);
    await harness.service.setResult('ws', test.id, 'failed');
    expect(await harness.service.setResult('ws', test.id, 'run')).toMatchObject({
      status: 'passed',
    });
  });

  it('refuses a test that has not finished a run or ended in an error', async () => {
    const harness = setup([passed]);
    const test = await firstTest(harness);
    await harness.store.updateTest('ws', test.id, { status: 'error' });
    await expect(harness.service.setResult('ws', test.id, 'passed')).rejects.toMatchObject({
      code: 'E2E_RESULT_NOT_REVIEWABLE',
    });
    await harness.store.updateTest('ws', test.id, { status: 'passed', lastRunAt: null });
    await expect(harness.service.setResult('ws', test.id, 'failed')).rejects.toMatchObject({
      code: 'E2E_RESULT_NOT_REVIEWABLE',
    });
  });
});

describe('result decided by the user, step by step', () => {
  const stepOf = (test: { stepResults: readonly { position: number }[] }, position: number) =>
    test.stepResults.find((step) => step.position === position);

  it('passes the failed step, which passes the test, and gives the run back', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);

    const passedByHand = await harness.service.setStepResult('ws', test.id, 2, 'passed', ' ok ');
    expect(passedByHand).toMatchObject({ status: 'passed', resultSource: 'manual' });
    expect(stepOf(passedByHand, 2)).toMatchObject({
      status: 'failed',
      manualStatus: 'passed',
      manualNote: 'ok',
    });
    expect(stepOf(passedByHand, 1)).not.toHaveProperty('manualStatus');

    expect(await harness.service.setStepResult('ws', test.id, 2, 'run')).toMatchObject({
      status: 'failed',
      resultSource: 'run',
    });
    const back = await harness.service.getTest('ws', test.id);
    expect(stepOf(back, 2)).not.toHaveProperty('manualStatus');
  });

  it('fails the test when a step is failed by hand, and keeps what else the user decided', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    await harness.service.setStepResult('ws', test.id, 2, 'passed');
    const failedByHand = await harness.service.setStepResult('ws', test.id, 1, 'failed');
    expect(failedByHand).toMatchObject({ status: 'failed', resultSource: 'manual' });
    expect(stepOf(failedByHand, 1)).toMatchObject({ manualStatus: 'failed', manualNote: null });

    // Giving one step back leaves the verdict on the other.
    const oneBack = await harness.service.setStepResult('ws', test.id, 1, 'run');
    expect(oneBack).toMatchObject({ status: 'passed', resultSource: 'manual' });
  });

  it('does not pass a test whose error came from outside its steps', async () => {
    const harness = setup([{ ...failedOnTechnicality, steps: [] }]);
    const test = await firstTest(harness);
    await harness.store.updateTest('ws', test.id, {
      stepResults: [
        {
          position: 1,
          title: 'Passo 1',
          status: 'passed',
          durationMs: 1,
          error: null,
          screenshotKey: null,
        },
      ],
    });
    expect(await harness.service.setStepResult('ws', test.id, 1, 'passed')).toMatchObject({
      status: 'failed',
      resultSource: 'manual',
    });
  });

  it('keeps a pass by criteria when no step was decided by hand', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    await harness.store.updateTest('ws', test.id, { status: 'passed', resultSource: 'criteria' });
    expect(await harness.service.setStepResult('ws', test.id, 1, 'run')).toMatchObject({
      status: 'passed',
      resultSource: 'criteria',
    });
  });

  it('drops the verdicts on the steps when the test gives back the run result', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    await harness.service.setStepResult('ws', test.id, 2, 'passed');
    const back = await harness.service.setResult('ws', test.id, 'run');
    expect(back).toMatchObject({ status: 'failed', resultSource: 'run' });
    expect(stepOf(back, 2)).not.toHaveProperty('manualStatus');
  });

  it('refuses an unknown step and a test that has no finished result', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    await expect(harness.service.setStepResult('ws', test.id, 9, 'passed')).rejects.toMatchObject({
      code: 'E2E_STEP_NOT_FOUND',
    });
    await harness.store.updateTest('ws', test.id, { status: 'error' });
    await expect(harness.service.setStepResult('ws', test.id, 2, 'passed')).rejects.toMatchObject({
      code: 'E2E_RESULT_NOT_REVIEWABLE',
    });
  });
});

describe('script adapted to what the user decided', () => {
  const ADAPTED = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await page.goto('/');
});`;
  const specKey = (harness: ReturnType<typeof setup>) =>
    [...harness.scripts.files.keys()].find((key) => key.endsWith('.spec.ts'))!;

  it('rewrites the spec to agree with the steps the user passed or failed, and commits it', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    harness.author.adaptScript.mockResolvedValue(ADAPTED);
    harness.scripts.commits.length = 0;

    await harness.service.setStepResult('ws', test.id, 2, 'passed', ' submenu hidden is right ');

    const call = harness.author.adaptScript.mock.calls[0]![0];
    expect(call.script).toBe(VALID);
    expect(call.result).toBeNull();
    expect(call.steps).toEqual([
      {
        position: 2,
        title: 'Passo 2',
        decided: 'passed',
        ran: 'failed',
        note: 'submenu hidden is right',
        error: 'Expected: 0\nReceived: 1',
      },
    ]);
    expect(call.hooks).toEqual({ beforeRun: null, afterRun: null });
    expect(harness.scripts.files.get(specKey(harness))).toBe(ADAPTED);
    expect(harness.scripts.commits).toHaveLength(1);
    expect(harness.scripts.commits[0]!.message).toContain('update TC001');
  });

  it('sends the decision about the whole test with the steps already decided, and the hooks', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    const key = specKey(harness);
    harness.scripts.files.set(key.replace('.spec.ts', '.before.ts'), '// before');
    harness.scripts.files.set(key.replace('.spec.ts', '.after.ts'), '  ');
    harness.author.adaptScript.mockResolvedValue(ADAPTED);
    await harness.service.setStepResult('ws', test.id, 1, 'failed');
    harness.author.adaptScript.mockClear();

    await harness.service.setResult('ws', test.id, 'passed', ' fine ');

    const call = harness.author.adaptScript.mock.calls[0]![0];
    expect(call.result).toEqual({ decided: 'passed', note: 'fine' });
    expect(call.steps).toMatchObject([{ position: 1, decided: 'failed', note: null, error: null }]);
    expect(call.hooks).toEqual({ beforeRun: '// before', afterRun: null });
  });

  it('does not touch the script when the result is given back to the run', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    await harness.service.setStepResult('ws', test.id, 2, 'passed');
    harness.author.adaptScript.mockClear();
    await harness.service.setStepResult('ws', test.id, 2, 'run');
    await harness.service.setResult('ws', test.id, 'run');
    expect(harness.author.adaptScript).not.toHaveBeenCalled();
  });

  it('keeps the script when the AI changes nothing, answers nothing or the guard rejects it', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    const key = specKey(harness);
    harness.scripts.commits.length = 0;

    for (const answer of [`  ${VALID}\n`, '', `require('fs');\n${ADAPTED}`]) {
      harness.author.adaptScript.mockResolvedValue(answer);
      const decided = await harness.service.setStepResult('ws', test.id, 2, 'passed');
      expect(decided).toMatchObject({ status: 'passed', resultSource: 'manual' });
    }
    expect(harness.scripts.files.get(key)).toBe(VALID);
    expect(harness.scripts.commits).toHaveLength(0);
  });

  it('keeps the decision, and says why in the log, when the script cannot be adapted', async () => {
    const harness = setup([failedOnTechnicality]);
    const test = await firstTest(harness);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    harness.author.adaptScript.mockRejectedValue(new Error('model down'));

    const decided = await harness.service.setResult('ws', test.id, 'passed');

    expect(decided).toMatchObject({ status: 'passed', resultSource: 'manual' });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('adapt the script'),
      expect.objectContaining({ message: 'model down' }),
    );
    log.mockRestore();
  });

  it('has nothing to adapt without an author that can, a linked spec or a spec in the repository', async () => {
    const withoutAdapt = setup([failedOnTechnicality]);
    const test = await firstTest(withoutAdapt);
    delete (withoutAdapt.author as { adaptScript?: Mock }).adaptScript;
    await withoutAdapt.service.setResult('ws', test.id, 'passed');

    const harness = setup([failedOnTechnicality]);
    const other = await firstTest(harness);
    await harness.store.updateTest('ws', other.id, { scriptPath: null });
    await harness.service.setResult('ws', other.id, 'passed');
    await harness.store.updateTest('ws', other.id, { scriptPath: 'gone.spec.ts' });
    await harness.service.setResult('ws', other.id, 'failed');
    harness.scripts.files.set(specKey(harness), '  ');
    await harness.store.updateTest('ws', other.id, {
      scriptPath: specKey(harness).replace(/^[^:]*:[^:]*@[^:]*:/, ''),
    });
    await harness.service.setResult('ws', other.id, 'passed');
    expect(harness.author.adaptScript).not.toHaveBeenCalled();
  });
});

describe('re-evaluating a result against the criteria', () => {
  async function failedWithCriteria(harness: ReturnType<typeof setup>) {
    const test = await firstTest(harness);
    await harness.service.updateSuccessCriteria('ws', test.id, 'Acesso negado is shown');
    return test;
  }

  it('promotes a failure the evidence excuses, from the stored screenshots and script', async () => {
    const harness = setup([failedOnTechnicality], { criteriaMet: true });
    const test = await firstTest(harness);
    await harness.service.updateSuccessCriteria('ws', test.id, 'Acesso negado is shown');
    harness.runner.run.mockClear();
    harness.author.writeScript.mockClear();
    harness.author.analyze.mockClear();
    const stored = await harness.store.getTest('ws', test.id);
    for (const step of stored!.stepResults)
      if (step.screenshotKey) await harness.artifacts.put(step.screenshotKey, PNG);

    const reviewed = await harness.service.reevaluate('ws', test.id, 'en-US');

    expect(reviewed).toMatchObject({
      status: 'passed',
      resultSource: 'criteria',
      verdict: 'test_issue',
      analysis: 'Goal: ...',
    });
    expect(harness.runner.run).not.toHaveBeenCalled();
    expect(harness.author.writeScript).not.toHaveBeenCalled();
    const call = harness.author.analyze.mock.calls[0]![0];
    expect(call.creation.locale).toBe('en-US');
    expect(call.script).toContain('TC001');
    expect(call.images).toHaveLength(1);
  });

  it('goes back to the run when criteria that excused it no longer hold, and keeps a manual choice', async () => {
    const harness = setup([failedOnTechnicality], { criteriaMet: true });
    const test = await failedWithCriteria(harness);
    await harness.service.reevaluate('ws', test.id);
    harness.author.analyze.mockResolvedValue({
      verdict: 'app_bug',
      summary: 'not shown',
      criteriaMet: false,
    });
    expect(await harness.service.reevaluate('ws', test.id)).toMatchObject({
      status: 'failed',
      resultSource: 'run',
      analysis: 'not shown',
    });

    await harness.service.setResult('ws', test.id, 'passed');
    expect(await harness.service.reevaluate('ws', test.id)).toMatchObject({
      status: 'passed',
      resultSource: 'manual',
    });
  });

  it('works without a spec in the repository and with screenshots missing', async () => {
    const harness = setup([failedOnTechnicality], { criteriaMet: true });
    const test = await failedWithCriteria(harness);
    await harness.artifacts.removePrefix(`ws/${test.creationId}/steps`);
    await harness.store.updateTest('ws', test.id, { scriptPath: null });
    await harness.service.reevaluate('ws', test.id);
    expect(harness.author.analyze.mock.calls.at(-1)![0]).toMatchObject({ script: '', images: [] });

    await harness.store.updateTest('ws', test.id, { scriptPath: 'tests/e2e/missing.spec.ts' });
    await harness.service.reevaluate('ws', test.id);
    expect(harness.author.analyze.mock.calls.at(-1)![0].script).toBe('');
  });

  it('survives a repository that cannot be read', async () => {
    const harness = setup([failedOnTechnicality], { criteriaMet: true });
    const test = await failedWithCriteria(harness);
    vi.spyOn(harness.scripts, 'readFile').mockRejectedValue(new Error('down'));
    await harness.service.reevaluate('ws', test.id);
    expect(harness.author.analyze.mock.calls.at(-1)![0].script).toBe('');
  });

  it('refuses without an author, without criteria and for a result that is not reviewable', async () => {
    const withoutAuthor = setup([failedOnTechnicality], {}, false);
    const first = await firstTest(withoutAuthor);
    await expect(withoutAuthor.service.reevaluate('ws', first.id)).rejects.toMatchObject({
      code: 'E2E_REVIEW_UNAVAILABLE',
    });

    const harness = setup([failedOnTechnicality, passed]);
    const test = await firstTest(harness);
    await expect(harness.service.reevaluate('ws', test.id)).rejects.toMatchObject({
      code: 'E2E_SUCCESS_CRITERIA_REQUIRED',
    });
    await harness.service.updateSuccessCriteria('ws', test.id, 'criteria');
    await harness.store.updateTest('ws', test.id, { status: 'passed' });
    await expect(harness.service.reevaluate('ws', test.id)).rejects.toMatchObject({
      code: 'E2E_RESULT_NOT_REVIEWABLE',
    });
    await harness.store.updateTest('ws', test.id, { status: 'failed', lastRunAt: null });
    await expect(harness.service.reevaluate('ws', test.id)).rejects.toMatchObject({
      code: 'E2E_RESULT_NOT_REVIEWABLE',
    });
  });
});

describe('evidence for the judge', () => {
  it('picks the failed steps first and the last one, at most three', () => {
    const steps = [
      { status: 'passed' as const, id: 1 },
      { status: 'failed' as const, id: 2 },
      { status: 'failed' as const, id: 3 },
      { status: 'failed' as const, id: 4 },
      { status: 'passed' as const, id: 5 },
    ];
    expect(evidenceSteps(steps).map((step) => step.id)).toEqual([2, 3, 5]);
    expect(evidenceSteps(steps.slice(0, 2)).map((step) => step.id)).toEqual([2]);
    expect(evidenceSteps([])).toEqual([]);
  });

  it('keeps only pictures a model can read', () => {
    const images = toLlmImages([
      PNG,
      null,
      undefined,
      Buffer.from('not an image'),
      new Uint8Array(6_000_000),
    ]);
    expect(images).toEqual([{ mimeType: 'image/png', data: PNG.toString('base64') }]);
  });

  it('promotes only with written criteria and a judge that found them met', () => {
    expect(meetsCriteria({ successCriteria: 'x' }, { criteriaMet: true })).toBe(true);
    expect(meetsCriteria({ successCriteria: 'x' }, { criteriaMet: null })).toBe(false);
    expect(meetsCriteria({ successCriteria: 'x' }, null)).toBe(false);
    expect(meetsCriteria({ successCriteria: '  ' }, { criteriaMet: true })).toBe(false);
    expect(meetsCriteria({ successCriteria: null }, { criteriaMet: true })).toBe(false);
  });
});

describe('snapshot reuse', () => {
  const snapshot = { startUrl: 'http://x', pages: [] };
  const now = Date.parse('2026-11-17T12:00:00Z');

  it('reuses a recent snapshot only', () => {
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect(recentSnapshot({ capturedAt: at(5), snapshot }, now)).toEqual(snapshot);
    expect(recentSnapshot({ capturedAt: at(31), snapshot }, now)).toBeNull();
    expect(recentSnapshot({ capturedAt: at(-5), snapshot }, now)).toBeNull();
    expect(recentSnapshot({ capturedAt: at(1), error: 'offline' }, now)).toBeNull();
    expect(recentSnapshot({ snapshot }, now)).toBeNull();
    expect(recentSnapshot('text', now)).toBeNull();
    expect(recentSnapshot(null, now)).toBeNull();
    expect(recentSnapshot({ capturedAt: new Date().toISOString(), snapshot })).toEqual(snapshot);
  });

  it('reads the application once for the scripts of several runs and again when it is stale', async () => {
    const harness = setup([passed]);
    const test = await firstTest(harness);
    harness.runner.explore.mockClear();
    await harness.service.rerunTest('ws', test.id, true);
    await harness.idle();
    expect(harness.runner.explore).not.toHaveBeenCalled();

    const stale = { capturedAt: '2020-01-01T00:00:00.000Z', snapshot };
    await harness.artifacts.put(
      `ws/${test.creationId}/snapshot.json`,
      Buffer.from(JSON.stringify(stale), 'utf8'),
    );
    await harness.service.rerunTest('ws', test.id, true);
    await harness.idle();
    expect(harness.runner.explore).toHaveBeenCalledOnce();

    // A snapshot that cannot be stored or read never stops the script from being written.
    vi.spyOn(harness.artifacts, 'put').mockRejectedValue(new Error('disk full'));
    vi.spyOn(harness.artifacts, 'get').mockRejectedValue(new Error('disk gone'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await harness.service.rerunTest('ws', test.id, true);
    await harness.idle();
    expect(await harness.service.getTest('ws', test.id)).toMatchObject({ status: 'passed' });
  });
});

describe('pace of the browser', () => {
  it('slows the run less than the recording pace and can be chosen', () => {
    expect(PACES.recorded.slowMo).toBe(SLOW_MO_MS);
    expect(PACES.balanced.slowMo).toBeLessThan(PACES.recorded.slowMo);
    expect(PACES.fast).toMatchObject({ slowMo: 0, glideMs: 0, evidenceHoldMs: 0 });
    expect(resolvePace('fast')).toBe('fast');
    expect(resolvePace('recorded')).toBe('recorded');
    expect(resolvePace('balanced')).toBe('balanced');
    expect(resolvePace('warp')).toBe('balanced');
    expect(resolvePace(undefined)).toBe('balanced');
  });

  it('writes the pace into the config, the evidence module and the recording hold', () => {
    expect(runnerConfig('http://a', 'en-US')).toContain(`slowMo: ${SLOW_MO_MS}`);
    expect(runnerConfig('http://a', 'en-US', false, false, [], 0)).toContain('slowMo: 0');
    expect(evidenceModule('frontend', PACES.fast)).toContain('const GLIDE_MS = 0;');
    expect(evidenceModule('frontend', PACES.fast)).toContain('const EVIDENCE_HOLD_MS = 0;');
    expect(evidenceModule('frontend')).toContain(`const GLIDE_MS = ${PACES.recorded.glideMs};`);
    const spec = withRecordingHold('test();', 'frontend', 321);
    expect(spec).toContain('waitForTimeout(321)');
  });
});
