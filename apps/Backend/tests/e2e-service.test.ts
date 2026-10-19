import { describe, expect, it, vi, type Mock } from 'vitest';
import { ApplicationError } from '../src/shared/errors.js';
import { decryptSecret } from '../src/shared/encryption.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eService, describeError } from '../src/modules/e2e/application/e2e-service.js';
import {
  E2eRunnerError,
  type E2eRunResult,
  type E2eVideoTranscoder,
} from '../src/modules/e2e/application/e2e-runner.js';
import type { E2eAuthor } from '../src/modules/e2e/application/e2e-author.js';
import { InMemoryE2eJobQueue } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';
import { snapshotKey } from '../src/modules/e2e/domain/e2e.js';

const VALID = `import { test, expect } from '@playwright/test';
test('TC001 - ok', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('x');
});`;
const passed: E2eRunResult = {
  status: 'passed',
  durationMs: 1200,
  error: null,
  logs: 'ok',
  video: Buffer.from('webm-bytes'),
  steps: [],
};
const failed: E2eRunResult = {
  status: 'failed',
  durationMs: 900,
  error: 'locator not found',
  logs: 'boom',
  video: Buffer.from('failed-video'),
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
  prd: 'Users submit questions and vote.',
  prdFileNames: ['prd.md'],
  repository: { provider: 'github' as const, id: '42', branch: 'main', path: '/tests/e2e/' },
};

function setup(
  overrides: Partial<E2eAuthor> = {},
  runResults: E2eRunResult[] = [passed],
  transcoder?: E2eVideoTranscoder,
) {
  const store = new InMemoryE2eStore();
  const artifacts = new InMemoryE2eArtifactStore();
  const scripts = new FakeScriptRepository();
  const author = {
    plan: vi.fn().mockResolvedValue({
      summary: '# PRD',
      tests: [
        { title: 'Submit question', description: 'd1', priority: 'high', steps: ['a'] },
        { title: 'Vote once', description: 'd2', priority: 'medium', steps: ['b'] },
      ],
    }),
    writeScript: vi.fn().mockResolvedValue(VALID),
    analyze: vi.fn().mockResolvedValue({ verdict: 'app_bug', summary: 'Goal: ...' }),
    ...overrides,
  } as unknown as { plan: Mock; writeScript: Mock; analyze: Mock };
  const results = [...runResults];
  const runner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'http://localhost:5173/e/123', pages: [] }),
    run: vi
      .fn()
      .mockImplementation(() => Promise.resolve(results.length > 1 ? results.shift() : results[0])),
  };
  const agents = { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) };
  // The full pipeline in one process: queue -> worker -> executor, like local development.
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
      transcoder,
      scripts,
    }),
  });
  const service = Object.assign(
    new E2eService({
      store,
      queue,
      dispatcher: new LocalE2eDispatcher(worker),
      artifacts,
      agents: agents as never,
      transcoder,
      scripts,
    }),
    { idle: () => worker.idle() },
  );
  return { service, store, artifacts, author, runner, agents, scripts, queue, worker };
}

describe('E2eService', () => {
  it('routes a tunnelled frontend through the original localhost origin', async () => {
    const { service, runner } = setup();
    const tunnel = {
      ...input,
      baseUrl: 'https://sample.trycloudflare.com',
      localOrigin: 'http://localhost:5173',
    };
    const created = await service.create(context, tunnel);
    expect(created).toMatchObject({ baseUrl: tunnel.baseUrl, localOrigin: tunnel.localOrigin });
    await service.idle();
    expect(runner.explore).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:5173/e/123',
        transportUrl: tunnel.baseUrl,
      }),
    );
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: tunnel.baseUrl,
        localOrigin: tunnel.localOrigin,
      }),
    );
    const test = (await service.get('ws', created.id)).tests[0]!;
    expect((await service.getTest('ws', test.id)).creation).toMatchObject({
      localOrigin: tunnel.localOrigin,
    });
    const updated = await service.update('ws', created.id, { ...tunnel, localOrigin: undefined });
    expect(updated.localOrigin).toBe(tunnel.localOrigin);
    await expect(
      service.update('ws', created.id, { ...tunnel, baseUrl: 'http://example.com' }),
    ).rejects.toMatchObject({ code: 'E2E_INVALID_URL' });
  });

  it('plans, writes, runs and records every test with its video', async () => {
    const { service, store, runner, author, artifacts, scripts } = setup();
    const created = await service.create(context, input);
    expect(created).toMatchObject({
      status: 'queued',
      baseUrl: 'http://localhost:5173',
      path: '/e/123',
      hasPassword: true,
      locale: 'en-US',
    });
    expect(created).not.toHaveProperty('passwordSecret');
    await service.idle();

    const detail = await service.get('ws', created.id);
    expect(detail).toMatchObject({ status: 'completed', prdSummary: '# PRD' });
    expect(detail.tests.map((test) => [test.code, test.status, test.hasVideo])).toEqual([
      ['TC001', 'passed', true],
      ['TC002', 'passed', true],
    ]);
    expect(runner.explore).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'frontend', url: 'http://localhost:5173/e/123' }),
    );
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: { username: 'qa@example.com', password: 'secret-pass' },
      }),
    );
    expect(author.analyze).not.toHaveBeenCalled();
    const stored = await store.getCreation('ws', created.id);
    expect(decryptSecret(stored!.passwordSecret!)).toBe('secret-pass');

    const [first] = detail.tests;
    expect(await service.video('ws', first!.id)).toEqual({
      content: Buffer.from('webm-bytes'),
      mimeType: 'video/webm',
    });
    const full = await service.getTest('ws', first!.id);
    expect(full).toMatchObject({
      scriptPath: 'tests/e2e/tc001-submit-question.spec.ts',
      logs: 'ok',
      attempts: 1,
      hasVideo: true,
    });
    expect(full).not.toHaveProperty('script');
    expect(full.creation).toMatchObject({ id: created.id, mode: 'frontend' });
    expect(created.repository).toEqual({
      provider: 'github',
      id: '42',
      name: 'acme/demo-app',
      branch: 'main',
      path: 'tests/e2e',
    });
    // The script lives in the repository, committed on the chosen branch.
    expect(scripts.commits.map((commit) => [commit.path, commit.message, commit.branch])).toEqual([
      ['tests/e2e/tc001-submit-question.spec.ts', 'test(e2e): add TC001 - Submit question', 'main'],
      ['tests/e2e/tc002-vote-once.spec.ts', 'test(e2e): add TC002 - Vote once', 'main'],
    ]);
    expect(await service.getScript('ws', first!.id)).toEqual({
      path: 'tests/e2e/tc001-submit-question.spec.ts',
      content: VALID,
      url: 'https://example.test/acme/demo-app/blob/main/tests/e2e/tc001-submit-question.spec.ts',
      repository: created.repository,
    });

    const list = await service.list('ws');
    expect(list[0]).toMatchObject({ passed: 2, total: 2 });
    expect(list[0]).not.toHaveProperty('prd');

    await service.delete('ws', created.id);
    expect(await artifacts.get(`ws/${created.id}/${first!.id}.webm`)).toBeNull();
    await expect(service.get('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_CREATION_NOT_FOUND',
    });
  });

  it('rewrites a script once when the AI blames the test and reruns it', async () => {
    const { service, author, runner } = setup(
      {
        plan: vi.fn().mockResolvedValue({
          summary: 's',
          tests: [{ title: 'Order', description: '', priority: 'low', steps: [] }],
        }),
        analyze: vi.fn().mockResolvedValue({ verdict: 'test_issue', summary: 'bad locator' }),
      },
      [failed, passed],
    );
    const created = await service.create(context, { ...input, password: undefined });
    await service.idle();
    const [test] = (await service.get('ws', created.id)).tests;
    expect(test).toMatchObject({ status: 'passed', attempts: 2, analysis: null, verdict: null });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(author.writeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previous: { script: VALID, problem: 'locator not found\n\nbad locator' },
      }),
    );
  });

  it('keeps the failure analysis when the application is at fault', async () => {
    const { service } = setup({}, [failed]);
    const created = await service.create(context, input);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('completed');
    expect(detail.tests[0]).toMatchObject({
      status: 'failed',
      error: 'locator not found',
      analysis: 'Goal: ...',
      verdict: 'app_bug',
    });
  });

  it('records a failure without analysis when the analysis call fails', async () => {
    const { service } = setup({ analyze: vi.fn().mockRejectedValue(new Error('llm down')) }, [
      { ...failed, video: null },
    ]);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const created = await service.create(context, input);
    await service.idle();
    const [test] = (await service.get('ws', created.id)).tests;
    expect(test).toMatchObject({ status: 'failed', analysis: null, hasVideo: false });
    errorLog.mockRestore();
  });

  it('asks for a second script after a security rejection and blocks a second violation', async () => {
    const writeScript = vi
      .fn()
      .mockResolvedValueOnce("import fs from 'node:fs';\ntest('x', async () => {});")
      .mockResolvedValueOnce(VALID)
      .mockResolvedValue(
        "import { test } from '@playwright/test';\ntest('x', async () => { process.exit(1); });",
      );
    const { service, scripts } = setup({ writeScript });
    const created = await service.create(context, input);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.tests.map((test) => test.status)).toEqual(['passed', 'error']);
    expect(detail.tests[1]?.error).toContain('process access is not allowed');
    expect(writeScript.mock.calls[1]?.[0].previous.problem).toContain('rejected by the security');
    // Rejected code is never pushed to the repository.
    expect(scripts.commits).toHaveLength(1);
    expect(detail.tests[1]?.scriptPath).toBeNull();
  });

  it('runs the spec currently in the repository and blocks unsafe edits made there', async () => {
    const { service, scripts, author, runner } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first, second] = (await service.get('ws', created.id)).tests;
    const repository = created.repository!;
    const edited = VALID.replace("toHaveTitle('x')", "toHaveTitle('edited')");
    scripts.seed(repository, first!.scriptPath!, edited);
    scripts.seed(
      repository,
      second!.scriptPath!,
      "import fs from 'node:fs';\ntest('x', () => {});",
    );
    author.writeScript.mockClear();
    runner.run.mockClear();
    await service.rerun('ws', created.id);
    await service.idle();
    expect(author.writeScript).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run.mock.calls[0]?.[0].script).toBe(edited);
    const after = (await service.get('ws', created.id)).tests;
    expect(after[1]).toMatchObject({ status: 'error' });
    expect(after[1]?.error).toContain('import from "node:fs" is not allowed');
  });

  it('rewrites specs that were deleted from the repository', async () => {
    const { service, scripts, author } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    scripts.files.clear();
    author.writeScript.mockClear();
    await service.rerunTest('ws', first!.id);
    await service.idle();
    expect(author.writeScript).toHaveBeenCalledOnce();
    expect(scripts.commits.at(-1)?.message).toBe('test(e2e): add TC001 - Submit question');
  });

  it('pushes edited scripts and pulls the repository folder', async () => {
    const { service, scripts, store } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first, second] = (await service.get('ws', created.id)).tests;
    const repository = created.repository!;

    const edited = VALID.replace("toHaveTitle('x')", "toHaveTitle('pushed')");
    const pushed = await service.pushScript('ws', first!.id, edited);
    expect(pushed.content).toBe(edited);
    expect(scripts.commits.at(-1)).toMatchObject({
      path: first!.scriptPath,
      message: 'test(e2e): update TC001 - Submit question',
    });
    await expect(service.pushScript('ws', first!.id, 'eval(1)')).rejects.toMatchObject({
      code: 'E2E_SCRIPT_REJECTED',
    });

    scripts.files.delete(`github:42@main:${second!.scriptPath}`);
    scripts.seed(
      repository,
      'tests/e2e/checkout.spec.ts',
      "import { test } from '@playwright/test';\ntest('TC010 - Checkout with coupon', async () => {});",
    );
    scripts.seed(repository, 'tests/e2e/helpers.ts', 'export {};');
    scripts.seed({ ...repository, path: '' }, 'docs/readme.spec.ts', 'outside the folder');
    expect(await service.pull('ws', created.id)).toEqual({ linked: 1, imported: 1, missing: 1 });
    const tests = (await service.get('ws', created.id)).tests;
    expect(tests.map((test) => [test.code, test.title, test.scriptPath])).toEqual([
      ['TC001', 'Submit question', first!.scriptPath],
      ['TC002', 'Vote once', null],
      ['TC003', 'Checkout with coupon', 'tests/e2e/checkout.spec.ts'],
    ]);
    expect((await service.getScript('ws', tests[1]!.id)).content).toBeNull();
    // Pushing a spec for a test that lost its file writes it back at the expected path.
    await service.pushScript('ws', tests[1]!.id, VALID);
    expect((await service.getTest('ws', tests[1]!.id)).scriptPath).toBe(second!.scriptPath);
    scripts.files.delete(`github:42@main:${second!.scriptPath}`);
    await store.updateTest('ws', tests[1]!.id, { scriptPath: null });
    expect(await service.pull('ws', created.id)).toEqual({ linked: 2, imported: 0, missing: 0 });

    // A spec that disappears between listing and reading is named after its file.
    scripts.seed(repository, 'tests/e2e/race.spec.ts', 'gone');
    vi.spyOn(scripts, 'readFile').mockResolvedValueOnce(null);
    expect(await service.pull('ws', created.id)).toMatchObject({ imported: 1 });
    expect((await service.get('ws', created.id)).tests.at(-1)?.title).toBe('race');
  });

  it('re-links specs found at the expected path and lists repositories and branches', async () => {
    const { service, scripts, store } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    await store.updateTest('ws', first!.id, { scriptPath: null });
    expect(await service.pull('ws', created.id)).toMatchObject({ linked: 2, imported: 0 });
    expect((await service.getTest('ws', first!.id)).scriptPath).toBe(first!.scriptPath);
    expect((await service.repositories('ws')).repositories).toHaveLength(2);
    expect(await service.branches('ws', 'azure_devops', 'guid-1')).toEqual([
      { name: 'develop', isDefault: true },
      { name: 'feature/e2e', isDefault: false },
    ]);
    expect(scripts.commits).toHaveLength(2);
  });

  it('requires a known repository and blocks script actions on runs without one', async () => {
    const { service, store } = setup();
    await expect(
      service.create(context, { ...input, repository: { ...input.repository, id: 'nope' } }),
    ).rejects.toMatchObject({ code: 'E2E_REPOSITORY_NOT_FOUND' });
    await expect(
      service.create(context, { ...input, repository: { ...input.repository, path: '../x' } }),
    ).rejects.toMatchObject({ code: 'E2E_INVALID_SCRIPT_PATH' });
    const fallback = await service.create(context, {
      ...input,
      repository: { provider: 'azure_devops', id: 'guid-1', branch: ' ', path: '' },
    });
    expect(fallback.repository).toMatchObject({ branch: 'develop', path: '', name: 'Finance/app' });
    await service.idle();
    expect((await service.get('ws', fallback.id)).tests[0]?.scriptPath).toBe(
      'tc001-submit-question.spec.ts',
    );

    const legacy = await store.createCreation({
      ...(await store.getCreation('ws', fallback.id))!,
      repository: null,
    });
    const [test] = await store.replaceTests(legacy, [
      { title: 'Old', description: '', priority: 'low', steps: [] },
    ]);
    await expect(service.getScript('ws', test!.id)).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_REQUIRED',
    });
    await expect(service.pull('ws', legacy.id)).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_REQUIRED',
    });
    await service.rerunTest('ws', test!.id);
    await service.idle();
    expect((await service.getTest('ws', test!.id)).error).toBe(
      'This run has no repository for its scripts.',
    );
  });

  it('fails the run when the target is unreachable', async () => {
    const { service, runner } = setup();
    runner.explore.mockRejectedValue(new E2eRunnerError('E2E_TARGET_UNREACHABLE', 'ECONNREFUSED'));
    const created = await service.create(context, input);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('failed');
    expect(detail.error).toContain('Could not reach the application');
    expect(detail.error).toContain('ECONNREFUSED');
    expect(detail.tests).toEqual([]);
  });

  it('stops the remaining tests when the browser is missing', async () => {
    const { service, runner } = setup();
    runner.run.mockRejectedValue(new E2eRunnerError('E2E_BROWSER_NOT_INSTALLED', 'missing'));
    const created = await service.create(context, input);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('failed');
    expect(detail.tests.map((test) => test.status)).toEqual(['error', 'error']);
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it('continues with the next test when one test errors', async () => {
    const { service, runner } = setup();
    runner.run.mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValue(passed);
    const created = await service.create(context, input);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('completed');
    expect(detail.tests.map((test) => [test.status, test.error])).toEqual([
      ['error', 'spawn failed'],
      ['passed', null],
    ]);
  });

  it('reruns all tests with their stored scripts and single tests with regeneration', async () => {
    const { service, author, runner } = setup();
    const created = await service.create(context, input);
    await service.idle();
    author.writeScript.mockClear();
    runner.explore.mockClear();

    const queued = await service.rerun('ws', created.id);
    expect(queued.status).toBe('queued');
    await expect(service.rerun('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_ALREADY_RUNNING',
    });
    await service.idle();
    expect(author.writeScript).not.toHaveBeenCalled();
    expect(runner.explore).not.toHaveBeenCalled();
    expect((await service.get('ws', created.id)).status).toBe('completed');

    const [first] = (await service.get('ws', created.id)).tests;
    runner.explore.mockRejectedValueOnce(new Error('offline'));
    await service.rerunTest('ws', first!.id, true);
    await service.idle();
    expect(author.writeScript).toHaveBeenCalledOnce();
    expect(author.writeScript.mock.calls[0]?.[0].snapshot).toBeNull();
    const test = await service.getTest('ws', first!.id);
    expect(test).toMatchObject({ status: 'passed', attempts: 3 });
  });

  it('starts over from planning when a failed run has no tests', async () => {
    const { service, author } = setup({
      plan: vi
        .fn()
        .mockRejectedValueOnce(new ApplicationError('E2E_PLAN_INVALID', 'bad json', 502))
        .mockResolvedValue({
          summary: 's',
          tests: [{ title: 'One', description: '', priority: 'high', steps: [] }],
        }),
    });
    const created = await service.create(context, input);
    await service.idle();
    expect((await service.get('ws', created.id)).error).toBe(
      'The AI did not return a valid test plan. Try again.',
    );
    await service.rerun('ws', created.id);
    await service.idle();
    expect(author.plan).toHaveBeenCalledTimes(2);
    expect((await service.get('ws', created.id)).tests).toHaveLength(1);
  });

  it('edits the configuration of an idle run, keeping its tests', async () => {
    const { service, store } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const scriptPaths = async () =>
      (await service.get('ws', created.id)).tests.map((test) => test.scriptPath);
    const linked = await scriptPaths();
    expect(linked.every(Boolean)).toBe(true);

    const renamed = await service.update('ws', created.id, {
      ...input,
      name: ' Renamed ',
      password: undefined,
    });
    expect(renamed).toMatchObject({ name: 'Renamed', hasPassword: true, prdSummary: '# PRD' });
    expect(decryptSecret((await store.getCreation('ws', created.id))!.passwordSecret!)).toBe(
      'secret-pass',
    );
    expect(await scriptPaths()).toEqual(linked);

    await service.update('ws', created.id, { ...input, password: 'new-pass' });
    expect(decryptSecret((await store.getCreation('ws', created.id))!.passwordSecret!)).toBe(
      'new-pass',
    );
    expect(
      await service.update('ws', created.id, { ...input, username: ' ', password: undefined }),
    ).toMatchObject({ username: null, hasPassword: false });

    const moved = await service.update('ws', created.id, {
      ...input,
      prd: 'A new product document.',
      repository: { ...input.repository, path: 'tests/other' },
    });
    expect(moved).toMatchObject({
      prd: 'A new product document.',
      prdSummary: null,
      repository: { path: 'tests/other' },
    });
    expect(await scriptPaths()).toEqual([null, null]);
    expect((await service.get('ws', created.id)).tests).toHaveLength(2);

    // Runs created before scripts moved to repositories gain one when edited.
    await store.updateCreation('ws', created.id, { repository: null });
    expect(await service.update('ws', created.id, input)).toMatchObject({
      repository: { name: 'acme/demo-app', path: 'tests/e2e' },
    });

    await service.rerun('ws', created.id);
    await expect(service.update('ws', created.id, input)).rejects.toMatchObject({
      code: 'E2E_ALREADY_RUNNING',
    });
    await service.idle();
    await expect(service.update('ws', 'missing', input)).rejects.toMatchObject({
      code: 'E2E_CREATION_NOT_FOUND',
    });
  });

  it('lets the MCP host plan and write the specs without a workspace LLM', async () => {
    const noProvider = new ApplicationError('PROVIDER_NOT_AVAILABLE', 'none', 503);
    const { service, author, runner, scripts, store, artifacts, agents } = setup(
      { analyze: vi.fn().mockRejectedValue(noProvider) },
      [passed, failed],
    );
    agents.getAgent.mockResolvedValue({ id: 'agent', name: 'QA', instructions: 'Be strict.' });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const created = await service.create(context, {
      ...input,
      planning: 'host',
      instructions: 'Login only',
    });
    expect(created.status).toBe('draft');
    await service.idle();
    expect(author.plan).not.toHaveBeenCalled();
    expect(runner.explore).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://localhost:5173/e/123' }),
    );
    expect((await service.get('ws', created.id)).status).toBe('draft');

    const brief = await service.brief('ws', created.id);
    expect(brief).toMatchObject({
      run: {
        status: 'draft',
        targetUrl: 'http://localhost:5173/e/123',
        testAccount: { username: 'qa@example.com', hasPassword: true },
        repository: { name: 'acme/demo-app', path: 'tests/e2e' },
      },
      agent: { name: 'QA', instructions: 'Be strict.' },
      documents: { prd: input.prd, instructions: 'Login only', diff: null },
      snapshot: { status: 'ready', data: { pages: [] } },
      limits: { maxTests: 10, maxScriptLength: 60_000 },
      existingTests: [],
      warnings: [],
    });
    expect(brief.rules.script.join('\n')).toContain('process.env.E2E_PASSWORD');
    expect(brief.rules.plan.join('\n')).toContain('Write every text value in English.');

    const login = {
      title: 'Valid login',
      description: 'd',
      priority: 'high',
      steps: ['a'],
    } as const;
    await expect(
      service.savePlan('ws', created.id, { tests: [{ ...login, script: 'process.exit(1)' }] }),
    ).rejects.toMatchObject({ code: 'E2E_SCRIPT_REJECTED', technicalMessage: /^TC001: / });
    const queued = await service.savePlan('ws', created.id, {
      summary: ' # Login ',
      tests: [
        { ...login, script: VALID },
        { ...login, title: 'Wrong password', script: VALID },
      ],
    });
    expect(queued).toMatchObject({ status: 'queued', prdSummary: '# Login' });
    expect(scripts.commits.map((commit) => [commit.path, commit.message])).toEqual([
      ['tests/e2e/tc001-valid-login.spec.ts', 'test(e2e): add TC001 - Valid login'],
      ['tests/e2e/tc002-wrong-password.spec.ts', 'test(e2e): add TC002 - Wrong password'],
    ]);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('completed');
    expect(detail.tests.map((test) => [test.code, test.status, test.analysis])).toEqual([
      ['TC001', 'passed', null],
      ['TC002', 'failed', null],
    ]);
    expect(author.writeScript).not.toHaveBeenCalled();
    expect((await service.brief('ws', created.id)).existingTests).toHaveLength(2);

    // A new plan replaces the tests and drops their videos.
    const videos = (await store.listTests('ws', created.id)).map((test) => test.videoKey!);
    await service.savePlan('ws', created.id, { tests: [{ ...login, script: VALID }] });
    for (const key of videos) expect(await artifacts.get(key)).toBeNull();
    await service.idle();
    expect((await service.get('ws', created.id)).tests).toHaveLength(1);
    errorLog.mockRestore();
  });

  it('recaptures the application for the host brief when asked or when it changes', async () => {
    const { service, runner, artifacts, store } = setup();
    let release!: () => void;
    runner.explore.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ startUrl: 'http://localhost:5173/e/123', pages: [] });
        }),
    );
    const created = await service.create(context, {
      ...input,
      planning: 'host',
      password: undefined,
    });
    await vi.waitFor(() => expect(runner.explore).toHaveBeenCalledOnce());
    // The worker is still exploring: nothing is queued twice or removed.
    const busy = await service.brief('ws', created.id, true);
    expect(busy.snapshot).toEqual({ status: 'capturing' });
    expect(busy.warnings[0]).toContain('no password');
    await expect(
      service.savePlan('ws', created.id, {
        tests: [{ title: 't', description: '', priority: 'low', steps: [], script: VALID }],
      }),
    ).rejects.toMatchObject({ code: 'E2E_ALREADY_RUNNING' });
    release();
    await service.idle();
    expect((await service.brief('ws', created.id)).snapshot.status).toBe('ready');

    expect((await service.brief('ws', created.id, true)).snapshot).toEqual({
      status: 'capturing',
    });
    await service.idle();
    expect(runner.explore).toHaveBeenCalledTimes(2);

    runner.explore.mockRejectedValueOnce(new E2eRunnerError('E2E_TARGET_UNREACHABLE', 'refused'));
    await service.update('ws', created.id, { ...input, baseUrl: 'http://localhost:4000' });
    expect((await service.brief('ws', created.id)).snapshot.status).toBe('capturing');
    await service.idle();
    const unreachable = await service.brief('ws', created.id);
    expect(unreachable.snapshot).toMatchObject({ status: 'failed', error: /refused/ });
    expect(unreachable.warnings).toEqual([expect.stringContaining('could not be captured')]);

    // An unreadable snapshot is captured again.
    await artifacts.put(snapshotKey(created), Buffer.from('{'));
    expect((await service.brief('ws', created.id)).snapshot.status).toBe('capturing');
    await service.idle();

    await store.updateCreation('ws', created.id, { repository: null });
    await expect(service.brief('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_REQUIRED',
    });
    await expect(service.savePlan('ws', created.id, { tests: [] })).rejects.toMatchObject({
      code: 'E2E_REPOSITORY_REQUIRED',
    });
  });

  it('cancels an active run and marks pending tests as cancelled', async () => {
    let release!: () => void;
    const { service, runner } = setup();
    runner.run.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          release = () => resolve(passed);
          signal.addEventListener('abort', () => resolve(failed));
        }),
    );
    const created = await service.create(context, input);
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());
    const cancelled = await service.cancel('ws', created.id);
    expect(cancelled.status).toBe('cancelled');
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('cancelled');
    expect(detail.tests.map((test) => test.status)).toEqual(['cancelled', 'cancelled']);
    expect(release).toBeTypeOf('function');
    await expect(service.cancel('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_NOT_RUNNING',
    });
  });

  it('cancels a queued run before it starts and stops quietly when deleted mid-run', async () => {
    const { service, runner, author } = setup();
    let unblock!: () => void;
    runner.explore.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          unblock = () => resolve({ startUrl: 'x', pages: [] });
        }),
    );
    const first = await service.create(context, input);
    const second = await service.create(context, { ...input, name: 'second' });
    await vi.waitFor(() => expect(runner.explore).toHaveBeenCalledOnce());
    await service.cancel('ws', second.id);
    await service.delete('ws', first.id);
    unblock();
    await service.idle();
    expect(author.plan).not.toHaveBeenCalled();
    expect((await service.get('ws', second.id)).status).toBe('cancelled');
  });

  it('marks interrupted runs as failed on recovery', async () => {
    const { service, store } = setup();
    const creation = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'ws',
      actorId: 'u',
      agentId: 'agent',
      name: 'x',
      mode: 'backend',
      scope: 'codebase',
      baseUrl: 'http://api',
      path: '/',
      username: null,
      passwordSecret: null,
      prd: 'p',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'pt-BR',
      repository: null,
    });
    await store.updateCreation('ws', creation.id, { status: 'running' });
    const [test] = await store.replaceTests(creation, [
      { title: 't', description: '', priority: 'low', steps: [] },
    ]);
    await store.updateTest('ws', test!.id, { status: 'passed' });
    await store.replaceTests(creation, [
      { title: 'a', description: '', priority: 'low', steps: [] },
      { title: 'b', description: '', priority: 'low', steps: [] },
    ]);
    const [done] = await store.listTests('ws', creation.id);
    await store.updateTest('ws', done!.id, { status: 'passed' });
    await service.recover(0);
    const detail = await service.get('ws', creation.id);
    expect(detail).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('reiniciado'),
    });
    expect(detail.tests.map((item) => item.status)).toEqual(['passed', 'error']);
  });

  it('validates input and lookups', async () => {
    const { service, agents } = setup();
    await expect(service.create({ requestId: 'r' }, input)).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
    });
    await expect(service.create(context, { ...input, baseUrl: 'ftp://x' })).rejects.toMatchObject({
      code: 'E2E_INVALID_URL',
    });
    await expect(
      service.create(context, { ...input, scope: 'diff', diff: ' ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    agents.getAgent.mockRejectedValueOnce(new ApplicationError('AGENT_NOT_FOUND', 'no', 404));
    await expect(service.create(context, input)).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await expect(service.getTest('ws', 'missing')).rejects.toMatchObject({
      code: 'E2E_TEST_NOT_FOUND',
    });
    await expect(service.cancel('ws', 'missing')).rejects.toMatchObject({
      code: 'E2E_CREATION_NOT_FOUND',
    });

    const created = await service.create(
      { requestId: 'r', workspaceId: 'ws' },
      {
        ...input,
        mode: 'backend',
        scope: 'diff',
        diff: '+ new endpoint',
        username: ' ',
        password: undefined,
        prdFileNames: undefined,
        instructions: '  focus on votes ',
      },
    );
    expect(created).toMatchObject({
      ownerId: 'ws',
      actorId: 'unknown',
      username: null,
      hasPassword: false,
      diff: '+ new endpoint',
      instructions: 'focus on votes',
      prdFileNames: [],
      locale: 'pt-BR',
    });
    await service.idle();
    const [test] = (await service.get('ws', created.id)).tests;
    await expect(service.video('ws', test!.id)).resolves.toMatchObject({ mimeType: 'video/webm' });
  });

  it('fails a rerun when the browser disappears', async () => {
    const { service, runner } = setup();
    const created = await service.create(context, input);
    await service.idle();
    runner.run.mockRejectedValue(new E2eRunnerError('E2E_BROWSER_NOT_INSTALLED', 'missing'));
    await service.rerun('ws', created.id);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('failed');
    expect(detail.tests.map((test) => test.status)).toEqual(['error', 'error']);
  });

  it('heals failures that have no error message', async () => {
    const { service, author } = setup(
      { analyze: vi.fn().mockResolvedValue({ verdict: 'test_issue', summary: 'flaky' }) },
      [{ ...failed, error: null }],
    );
    const created = await service.create(context, input);
    await service.idle();
    expect(author.analyze).toHaveBeenCalledWith(expect.objectContaining({ error: '' }));
    expect(author.writeScript).toHaveBeenCalledWith(
      expect.objectContaining({ previous: { script: VALID, problem: '\n\nflaky' } }),
    );
    expect((await service.get('ws', created.id)).tests[0]?.status).toBe('failed');
  });

  it('stops quietly when the run disappears from the store', async () => {
    const { service, store, author } = setup();
    vi.spyOn(store, 'updateCreation').mockResolvedValueOnce(null);
    await service.create(context, input);
    await service.idle();
    expect(author.plan).not.toHaveBeenCalled();
  });

  it('stores MP4 recordings, replaces old videos and keeps WebM when conversion fails', async () => {
    const toMp4 = vi
      .fn()
      .mockResolvedValueOnce(Buffer.from('mp4-1'))
      .mockResolvedValueOnce(Buffer.from('mp4-2'))
      .mockResolvedValue(null);
    const { service, artifacts } = setup({}, [passed], { toMp4 });
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    expect(await service.video('ws', first!.id)).toEqual({
      content: Buffer.from('mp4-1'),
      mimeType: 'video/mp4',
    });
    expect(toMp4).toHaveBeenCalledWith(passed.video);

    await service.rerunTest('ws', first!.id);
    await service.idle();
    expect(await artifacts.get(`ws/${created.id}/${first!.id}.mp4`)).toBeNull();
    expect(await service.video('ws', first!.id)).toEqual({
      content: Buffer.from('webm-bytes'),
      mimeType: 'video/webm',
    });
  });

  it('drops the previous video when a rerun records none', async () => {
    const { service, artifacts, runner } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    runner.run.mockResolvedValue({ ...passed, video: null });
    await service.rerunTest('ws', first!.id);
    await service.idle();
    expect(await artifacts.get(`ws/${created.id}/${first!.id}.webm`)).toBeNull();
    expect((await service.getTest('ws', first!.id)).hasVideo).toBe(false);
  });

  it('converts previously stored WebM videos on first view', async () => {
    const { service, artifacts, store, queue } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    const upgraded = new E2eService({
      store,
      artifacts,
      queue,
      dispatcher: { wake: () => Promise.resolve() },
      agents: {} as never,
      scripts: new FakeScriptRepository(),
      transcoder: { toMp4: vi.fn().mockResolvedValue(Buffer.from('converted')) },
    });
    expect(await upgraded.video('ws', first!.id)).toEqual({
      content: Buffer.from('converted'),
      mimeType: 'video/mp4',
    });
    expect(await artifacts.get(`ws/${created.id}/${first!.id}.webm`)).toBeNull();
    expect((await store.getTest('ws', first!.id))?.videoKey).toBe(
      `ws/${created.id}/${first!.id}.mp4`,
    );
  });

  it('rejects a rerun that loses the race for the queue and survives a sleeping worker', async () => {
    const { service, queue } = setup();
    const created = await service.create(context, input);
    await service.idle();
    vi.spyOn(queue, 'enqueue').mockResolvedValueOnce(null);
    await expect(service.rerun('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_ALREADY_RUNNING',
    });

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const remote = new E2eService({
      store: new InMemoryE2eStore(),
      queue: new InMemoryE2eJobQueue(),
      dispatcher: { wake: () => Promise.reject(new Error('worker asleep')) },
      artifacts: new InMemoryE2eArtifactStore(),
      scripts: new FakeScriptRepository(),
      agents: { getAgent: vi.fn().mockResolvedValue({}) } as never,
    });
    const queued = await remote.create(context, input);
    expect(queued.status).toBe('queued');
    await vi.waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith(
        '[E2eService] Could not wake a worker:',
        expect.any(Error),
      ),
    );
    // Recently touched runs are left alone: their job may be about to be enqueued.
    await remote.recover();
    expect((await remote.get('ws', queued.id)).status).toBe('queued');
    errorLog.mockRestore();
  });

  it('hands out signed video URLs when the storage supports them', async () => {
    const { service, artifacts, store, queue } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first, second] = (await service.get('ws', created.id)).tests;
    // In-memory/Postgres storage cannot sign: the client downloads through the API.
    expect(await service.videoUrl('ws', first!.id)).toBeNull();

    const signedUrl = vi.fn((key: string, expires: number) =>
      Promise.resolve(`https://r2.test/${key}?expires=${expires}`),
    );
    const signing = Object.assign(artifacts, { signedUrl });
    const toMp4 = vi.fn().mockResolvedValue(Buffer.from('mp4'));
    const withR2 = new E2eService({
      store,
      queue,
      artifacts: signing,
      dispatcher: { wake: () => Promise.resolve() },
      agents: {} as never,
      scripts: new FakeScriptRepository(),
      transcoder: { toMp4 },
    });
    // Old WebM recordings are converted to MP4 before being shared.
    expect(await withR2.videoUrl('ws', first!.id)).toEqual({
      url: `https://r2.test/ws/${created.id}/${first!.id}.mp4?expires=3600`,
      mimeType: 'video/mp4',
      expiresInSeconds: 3600,
    });
    expect(toMp4).toHaveBeenCalledOnce();

    const noTranscoder = new E2eService({
      store,
      queue,
      artifacts: signing,
      dispatcher: { wake: () => Promise.resolve() },
      agents: {} as never,
      scripts: new FakeScriptRepository(),
    });
    expect((await noTranscoder.videoUrl('ws', second!.id))?.mimeType).toBe('video/webm');
    await store.updateTest('ws', second!.id, { videoKey: null });
    await expect(noTranscoder.videoUrl('ws', second!.id)).rejects.toMatchObject({
      code: 'E2E_VIDEO_NOT_FOUND',
    });
  });

  it('reports missing videos', async () => {
    const { service } = setup({}, [{ ...passed, video: null }]);
    const created = await service.create(context, input);
    await service.idle();
    const [test] = (await service.get('ws', created.id)).tests;
    await expect(service.video('ws', test!.id)).rejects.toMatchObject({
      code: 'E2E_VIDEO_NOT_FOUND',
    });
  });

  it('logs unexpected job failures', async () => {
    const { service, store } = setup();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(store, 'updateCreation').mockRejectedValue(new Error('db down'));
    await service.create(context, input);
    await service.idle();
    expect(errorLog).toHaveBeenCalledWith('[E2eWorker] Job failed:', expect.any(Error));
    errorLog.mockRestore();
  });
});

describe('describeError', () => {
  it('localizes known failures and keeps useful technical detail', () => {
    expect(describeError(new E2eRunnerError('E2E_BROWSER_NOT_INSTALLED', 'x'), 'en-US')).toContain(
      'npx playwright install chromium',
    );
    expect(describeError(new E2eRunnerError('E2E_RUNNER_FAILED', 'crash'), 'pt-BR')).toBe(
      'O executor de testes E2E falhou. crash',
    );
    expect(
      describeError(new ApplicationError('LLM_RATE_LIMITED', 'HTTP 429 slow down', 429), 'en-US'),
    ).toContain('(HTTP 429 slow down)');
    expect(describeError(new ApplicationError('CUSTOM_CODE', 'raw text', 500), 'en-US')).toBe(
      'raw text',
    );
    expect(describeError('plain', 'en-US')).toBe('plain');
  });
});
