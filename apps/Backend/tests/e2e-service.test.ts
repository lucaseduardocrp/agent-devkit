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
import {
  E2eEnvironmentService,
  InMemoryE2eEnvironmentStore,
} from '../src/modules/e2e/application/e2e-environments.js';
import type { RunNotifier } from '../src/modules/messaging/application/run-notifier.js';

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
  notifier?: RunNotifier,
  testConcurrency = 1,
  environments?: E2eEnvironmentService,
  workerConcurrency = 1,
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
    concurrency: workerConcurrency,
    heartbeatMs: 5,
    executor: new E2eExecutor({
      store,
      queue,
      artifacts,
      author: author as unknown as E2eAuthor,
      runner,
      transcoder,
      scripts,
      notifier,
      environments,
      // Mocked results and commits are consumed in order unless a test asks for parallel runs.
      testConcurrency,
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
      environments,
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
      kind: 'spec',
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

  it('writes the analysis of a rerun in the language of the person who reruns it', async () => {
    const { service, author } = setup({}, [failed, failed, failed, failed]);
    const created = await service.create(context, input);
    await service.idle();
    const analyzedIn = () => author.analyze.mock.lastCall?.[0].creation.locale;
    expect(analyzedIn()).toBe('en-US');

    await service.rerun('ws', created.id, 'user', 'pt-BR');
    await service.idle();
    expect(analyzedIn()).toBe('pt-BR');
    expect((await service.get('ws', created.id)).locale).toBe('pt-BR');

    // Without a language the run keeps the one it has; with one, a single test follows it too.
    const [test] = (await service.get('ws', created.id)).tests;
    await service.rerunTest('ws', test!.id);
    await service.idle();
    expect(analyzedIn()).toBe('pt-BR');
    await service.rerunTest('ws', test!.id, false, 'user', {}, undefined, 'en-US');
    await service.idle();
    expect(analyzedIn()).toBe('en-US');
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

  it('writes Before Run and After Run from the test case and runs them around the spec', async () => {
    const before = `import { type Page } from '@playwright/test';
export default async function beforeRun({ page }: { page: Page }) {
  await page.goto('/events/new');
}`;
    const after = `import { type APIRequestContext } from '@playwright/test';
export default async function afterRun({ request }: { request: APIRequestContext }) {
  await request.delete('/api/events/E2E TC001');
}`;
    const writeHook = vi
      .fn()
      .mockImplementation(({ kind }: { kind: string }) =>
        Promise.resolve(kind === 'beforeRun' ? before : null),
      );
    const { service, scripts, author, runner } = setup({ writeHook });
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    expect(scripts.commits.slice(0, 2).map((commit) => [commit.path, commit.message])).toEqual([
      [
        'tests/e2e/tc001-submit-question.before.ts',
        'test(e2e): add Before Run of TC001 - Submit question',
      ],
      ['tests/e2e/tc001-submit-question.spec.ts', 'test(e2e): add TC001 - Submit question'],
    ]);
    // The spec is written knowing what Before Run already prepares.
    expect(author.writeScript.mock.calls[0]?.[0].hooks).toEqual({
      beforeRun: before,
      afterRun: null,
    });
    expect(runner.run.mock.calls[0]?.[0].hooks).toEqual({ beforeRun: before, afterRun: null });

    // A person adds the After Run; the next execution runs the repository's version.
    expect(await service.pushScript('ws', first!.id, after, 'afterRun')).toMatchObject({
      kind: 'afterRun',
      path: 'tests/e2e/tc001-submit-question.after.ts',
      content: after,
    });
    expect(scripts.commits.at(-1)?.message).toBe(
      'test(e2e): update After Run of TC001 - Submit question',
    );
    await expect(service.pushScript('ws', first!.id, VALID, 'beforeRun')).rejects.toMatchObject({
      code: 'E2E_SCRIPT_REJECTED',
    });
    writeHook.mockClear();
    runner.run.mockClear();
    await service.rerunTest('ws', first!.id);
    await service.idle();
    expect(writeHook).not.toHaveBeenCalled();
    expect(runner.run.mock.calls[0]?.[0].hooks).toEqual({ beforeRun: before, afterRun: after });

    // An empty Before Run turns it off.
    await service.pushScript('ws', first!.id, '', 'beforeRun');
    expect(await service.getScript('ws', first!.id, 'beforeRun')).toMatchObject({ content: '' });
    runner.run.mockClear();
    await service.rerunTest('ws', first!.id);
    await service.idle();
    expect(runner.run.mock.calls[0]?.[0].hooks).toEqual({ beforeRun: null, afterRun: after });
  });

  it('passes the saved hook instructions to the author that writes the hook', async () => {
    const writeHook = vi.fn().mockResolvedValue(null);
    const { service } = setup({ writeHook });
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;

    const saved = await service.updateHookInstructions(
      'ws',
      first!.id,
      'beforeRun',
      '<p>Ir para /eventos e clicar em Novo</p>',
    );
    expect(saved).toMatchObject({
      beforeRunInstructions: '<p>Ir para /eventos e clicar em Novo</p>',
      afterRunInstructions: null,
    });

    writeHook.mockClear();
    await service.rerunTest('ws', first!.id, true);
    await service.idle();
    expect(writeHook.mock.calls[0]?.[0].test).toMatchObject({
      beforeRunInstructions: '<p>Ir para /eventos e clicar em Novo</p>',
    });

    // Blank instructions clear them again.
    expect(await service.updateHookInstructions('ws', first!.id, 'beforeRun', '   ')).toMatchObject(
      { beforeRunInstructions: null },
    );
  });

  it('revises a test case in a conversation with the spec, its last run and the images the user sent', async () => {
    const { service, store, artifacts, scripts, queue, worker, agents } = setup({}, [
      { ...failed, error: 'locator not found' },
    ]);
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    const reviseCase = vi.fn().mockResolvedValue({ reply: 'ok', testCase: null });
    const chat = new E2eService({
      store,
      queue,
      dispatcher: new LocalE2eDispatcher(worker),
      artifacts,
      agents: agents as never,
      scripts,
      author: { analyze: vi.fn(), reviseCase },
    });
    const turn = {
      messages: [{ role: 'user' as const, content: 'Start from the menu' }],
      testCase: { title: 'Submit', description: 'd', steps: [] },
    };

    // An image the user attached is read from the attachments of the workspace.
    const imageId = '11111111-1111-4111-8111-111111111111';
    await artifacts.put(
      `attachments/images/ws/${imageId}/meta.json`,
      Buffer.from(JSON.stringify({ kind: 'image', mimeType: 'image/png' })),
    );
    await artifacts.put(
      `attachments/images/ws/${imageId}/content`,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    );
    await chat.reviseTestCase('ws', first!.id, { ...turn, imageIds: [imageId] }, 'pt-BR');
    const sent = reviseCase.mock.calls[0]![0];
    expect(sent.script).toBe(VALID);
    expect(sent.lastRun).toContain('locator not found');
    expect(sent.creation.locale).toBe('pt-BR');
    expect(sent.images).toEqual([
      {
        mimeType: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
          'base64',
        ),
      },
    ]);

    // A spec that cannot be read, or a test that never ran, leaves the AI with the case alone.
    vi.spyOn(scripts, 'readFile').mockRejectedValue(new Error('offline'));
    await chat.reviseTestCase('ws', first!.id, turn);
    expect(reviseCase.mock.calls[1]![0]).toMatchObject({ script: '', images: [] });
    expect(reviseCase.mock.calls[1]![0].creation.locale).toBe('en-US');
    await store.updateTest('ws', first!.id, { scriptPath: null, lastRunAt: null });
    await chat.reviseTestCase('ws', first!.id, turn);
    expect(reviseCase.mock.calls[2]![0]).toMatchObject({ script: '', lastRun: null });

    await expect(service.reviseTestCase('ws', first!.id, turn)).rejects.toMatchObject({
      code: 'E2E_CASE_CHAT_UNAVAILABLE',
    });
    await expect(chat.reviseTestCase('ws', 'missing', turn)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('rewrites a spec with the user instructions and what its last run produced', async () => {
    const { service, author, runner, store } = setup({}, [
      { ...failed, error: 'link intercepts pointer events', logs: 'menu overlaps' },
      passed,
    ]);
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    expect(await service.getTest('ws', first!.id)).toMatchObject({ status: 'failed' });
    const calls = author.writeScript.mock.calls.length;

    await service.rerunTest('ws', first!.id, true, undefined, {
      instructions: '  Open the page by its route  ',
      useLastRun: true,
    });
    await service.idle();
    const rewrite = author.writeScript.mock.calls[calls]?.[0];
    expect(rewrite.test.scriptInstructions).toBe('Open the page by its route');
    expect(rewrite.previous.script).toBe(VALID);
    expect(rewrite.previous.problem).toContain('link intercepts pointer events');
    expect(rewrite.previous.problem).toContain('menu overlaps');
    // The feedback is read once; the instructions stay for later rewrites.
    expect(await service.getTest('ws', first!.id)).toMatchObject({
      scriptInstructions: 'Open the page by its route',
    });
    expect((await store.getTest('ws', first!.id))?.regenerationFeedback).toBeNull();

    await service.rerunTest('ws', first!.id, true);
    await service.idle();
    const plain = author.writeScript.mock.calls[calls + 1]?.[0];
    expect(plain.previous).toBeUndefined();
    expect(plain.test.scriptInstructions).toBe('Open the page by its route');

    // Empty instructions clear them; a rerun without regeneration ignores the guidance.
    await service.rerunTest('ws', first!.id, true, undefined, { instructions: ' ' });
    await service.idle();
    expect(await service.getTest('ws', first!.id)).toMatchObject({ scriptInstructions: null });
    await service.rerunTest('ws', first!.id, false, undefined, { instructions: 'ignored' });
    await service.idle();
    expect(await service.getTest('ws', first!.id)).toMatchObject({ scriptInstructions: null });
    expect(runner.run).toHaveBeenCalled();
  });

  it('keeps the pictures of the instructions of a test for as long as they show them', async () => {
    const { store, artifacts, scripts, queue, worker, agents, service: plain } = setup();
    const created = await plain.create(context, input);
    await plain.idle();
    const [first, second] = (await plain.get('ws', created.id)).tests;
    const attachments = new InMemoryE2eArtifactStore();
    const service = new E2eService({
      store,
      queue,
      dispatcher: new LocalE2eDispatcher(worker),
      artifacts,
      attachments,
      agents: agents as never,
      scripts,
    });
    const uploaded = async (id: string) => {
      const meta = {
        id,
        name: 'tela.png',
        kind: 'image',
        mimeType: 'image/png',
        size: 1,
        scope: 'e2e',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      await attachments.put(
        `attachments/images/ws/${id}/meta.json`,
        Buffer.from(JSON.stringify(meta)),
      );
      await attachments.put(`attachments/images/ws/${id}/content`, Buffer.from('png'));
    };
    const stateOf = async (id: string) =>
      JSON.parse(
        (await attachments.get(`attachments/images/ws/${id}/meta.json`))?.toString() ?? 'null',
      ) as { status: string; owner?: string } | null;
    const shown = '11111111-1111-4111-8111-111111111111';
    const replaced = '22222222-2222-4222-8222-222222222222';
    await uploaded(shown);
    await uploaded(replaced);

    // Saved with the instructions, the picture is claimed by the test: the cleanup of unsaved
    // uploads leaves it alone.
    await service.rerunTest('ws', first!.id, true, undefined, {
      instructions: `Open it like this:\n\n![tela](/attachments/files/${replaced})`,
    });
    await plain.idle();
    expect(await stateOf(replaced)).toMatchObject({
      status: 'committed',
      owner: `e2e-test:${first!.id}`,
    });

    // A new text that no longer shows it removes it; the one it shows is kept.
    await service.rerunTest('ws', first!.id, true, undefined, {
      instructions: `![tela](/attachments/files/${shown})`,
    });
    await plain.idle();
    expect(await stateOf(replaced)).toBeNull();
    expect(await stateOf(shown)).toMatchObject({ owner: `e2e-test:${first!.id}` });

    // Another test, or a rewrite that leaves the instructions alone, does not take it away.
    await service.rerunTest('ws', second!.id, true, undefined, { instructions: 'no pictures' });
    await plain.idle();
    await service.rerunTest('ws', first!.id, true);
    await plain.idle();
    expect(await stateOf(shown)).toMatchObject({ status: 'committed' });

    // Deleting the run deletes the pictures with it.
    await service.delete('ws', created.id);
    expect(await stateOf(shown)).toBeNull();
    expect(await attachments.listKeys('attachments')).toEqual([]);
  });

  describe('environment of a single test', () => {
    async function withEnvironments() {
      const environments = new E2eEnvironmentService(new InMemoryE2eEnvironmentStore());
      const admin = await environments.create('ws', {
        name: 'Admin',
        baseUrl: 'http://admin.local',
        username: 'admin@example.com',
        password: 'admin-pass',
        variables: [{ key: 'role', value: 'admin' }],
      });
      const viewer = await environments.create('ws', {
        name: 'Viewer',
        baseUrl: 'http://viewer.local',
        username: 'viewer@example.com',
        password: 'viewer-pass',
        variables: [{ key: 'role', value: 'viewer' }],
      });
      const harness = setup({}, [passed], undefined, undefined, 1, environments);
      const created = await harness.service.create(context, {
        ...input,
        environmentId: admin.id,
      });
      await harness.service.idle();
      const [first, second] = (await harness.service.get('ws', created.id)).tests;
      harness.runner.run.mockClear();
      const lastRun = () => harness.runner.run.mock.lastCall![0];
      return {
        ...harness,
        environments,
        admin,
        viewer,
        first: first!,
        second: second!,
        lastRun,
      };
    }

    it("runs a test with its own environment while the others inherit the run's", async () => {
      const { service, runner, environments, viewer, first, second, lastRun } =
        await withEnvironments();

      await service.rerunTest('ws', first.id, false, undefined, {}, viewer.id);
      await service.idle();
      expect(lastRun()).toMatchObject({
        baseUrl: 'http://viewer.local',
        credentials: { username: 'viewer@example.com', password: 'viewer-pass' },
        variables: { ROLE: 'viewer' },
      });
      expect(await service.getTest('ws', first.id)).toMatchObject({
        environmentId: viewer.id,
        creation: { environmentId: expect.any(String) },
      });

      // Without a choice the test keeps its environment; another test of the run is untouched.
      await service.rerunTest('ws', first.id);
      await service.idle();
      expect(lastRun().credentials.username).toBe('viewer@example.com');
      runner.run.mockClear();
      await service.rerunTest('ws', second.id);
      await service.idle();
      expect(lastRun()).toMatchObject({
        baseUrl: 'http://localhost:5173',
        credentials: { username: 'qa@example.com', password: 'secret-pass' },
        variables: { ROLE: 'admin' },
      });

      // Null goes back to inheriting; an environment deleted since is inherited too.
      await service.rerunTest('ws', first.id, false, undefined, {}, null);
      await service.idle();
      expect(await service.getTest('ws', first.id)).toMatchObject({ environmentId: null });
      expect(lastRun().credentials.username).toBe('qa@example.com');
      await service.rerunTest('ws', first.id, false, undefined, {}, viewer.id);
      await service.idle();
      await environments.delete('ws', viewer.id);
      await service.rerunTest('ws', first.id);
      await service.idle();
      expect(lastRun().credentials.username).toBe('qa@example.com');
    });

    it('rejects an unknown environment and leaves the test as it was', async () => {
      const { service, runner, first } = await withEnvironments();
      await expect(
        service.rerunTest('ws', first.id, false, undefined, {}, 'missing'),
      ).rejects.toMatchObject({ code: 'E2E_ENVIRONMENT_NOT_FOUND' });
      expect(await service.getTest('ws', first.id)).toMatchObject({ environmentId: null });
      expect(runner.run).not.toHaveBeenCalled();
      // Without saved environments at all there is nothing to choose from.
      const bare = setup();
      const created = await bare.service.create(context, input);
      await bare.service.idle();
      const [test] = (await bare.service.get('ws', created.id)).tests;
      await expect(
        bare.service.rerunTest('ws', test!.id, false, undefined, {}, 'any'),
      ).rejects.toMatchObject({ code: 'E2E_ENVIRONMENT_NOT_FOUND' });
    });

    it("keeps the run's own account when the test points to the run's environment", async () => {
      const { service, admin, first, lastRun } = await withEnvironments();
      await service.rerunTest('ws', first.id, false, undefined, {}, admin.id);
      await service.idle();
      // The run was configured from this environment but signs in with the account typed on it.
      expect(lastRun()).toMatchObject({
        baseUrl: 'http://localhost:5173',
        credentials: { username: 'qa@example.com' },
        variables: { ROLE: 'admin' },
      });
    });

    it("keeps the tunnel origin and Access token only for the run's own address", async () => {
      const environments = new E2eEnvironmentService(new InMemoryE2eEnvironmentStore());
      const same = await environments.create('ws', {
        name: 'Same address',
        baseUrl: 'https://sample.trycloudflare.com',
        username: 'other@example.com',
        password: 'other-pass',
      });
      const elsewhere = await environments.create('ws', {
        name: 'Elsewhere',
        baseUrl: 'https://other.example.com',
      });
      const { service, runner } = setup({}, [passed], undefined, undefined, 1, environments);
      const created = await service.create(context, {
        ...input,
        baseUrl: 'https://sample.trycloudflare.com',
        localOrigin: 'http://localhost:5173',
        accessClientId: 'id.access',
        accessClientSecret: 'secret',
      });
      await service.idle();
      const [test] = (await service.get('ws', created.id)).tests;

      await service.rerunTest('ws', test!.id, false, undefined, {}, same.id);
      await service.idle();
      expect(runner.run.mock.lastCall![0]).toMatchObject({
        baseUrl: 'https://sample.trycloudflare.com',
        localOrigin: 'http://localhost:5173',
        accessToken: { clientId: 'id.access' },
        credentials: { username: 'other@example.com' },
      });

      await service.rerunTest('ws', test!.id, false, undefined, {}, elsewhere.id);
      await service.idle();
      expect(runner.run.mock.lastCall![0]).toMatchObject({
        baseUrl: 'https://other.example.com',
        localOrigin: null,
        accessToken: null,
        credentials: { username: null, password: null },
      });
    });

    it('ignores the environment of a test when the executor has none, and fails it on other errors', async () => {
      const bare = setup();
      const created = await bare.service.create(context, input);
      await bare.service.idle();
      const [test] = (await bare.service.get('ws', created.id)).tests;
      await bare.store.updateTest('ws', test!.id, { environmentId: 'saved-elsewhere' });
      await bare.service.rerunTest('ws', test!.id);
      await bare.service.idle();
      expect(await bare.service.getTest('ws', test!.id)).toMatchObject({ status: 'passed' });

      const { service, environments, viewer, first } = await withEnvironments();
      await service.rerunTest('ws', first.id, false, undefined, {}, viewer.id);
      await service.idle();
      vi.spyOn(environments, 'find').mockRejectedValueOnce(new Error('database down'));
      await service.rerunTest('ws', first.id);
      await service.idle();
      expect(await service.getTest('ws', first.id)).toMatchObject({
        status: 'error',
        error: expect.stringContaining('database down'),
      });
    });
  });

  it('blocks unsafe hooks committed to the repository', async () => {
    const { service, scripts, runner } = setup();
    const created = await service.create(context, input);
    await service.idle();
    const [first] = (await service.get('ws', created.id)).tests;
    scripts.seed(
      created.repository!,
      'tests/e2e/tc001-submit-question.before.ts',
      "import fs from 'node:fs';\nexport default async function beforeRun() {}",
    );
    runner.run.mockClear();
    await service.rerunTest('ws', first!.id);
    await service.idle();
    expect(runner.run).not.toHaveBeenCalled();
    const after = await service.getTest('ws', first!.id);
    expect(after).toMatchObject({ status: 'error' });
    expect(after.error).toContain('Before Run: import from "node:fs" is not allowed');
  });

  it('rewrites an unsafe hook once and rejects it when it stays unsafe', async () => {
    const unsafe = "import fs from 'node:fs';\nexport default async function beforeRun() {}";
    const safe = 'export default async function beforeRun() {}';
    const writeHook = vi
      .fn()
      .mockImplementation(({ kind, previous }: { kind: string; previous?: unknown }) =>
        Promise.resolve(kind === 'beforeRun' ? (previous ? safe : unsafe) : null),
      );
    const { service, scripts } = setup({ writeHook });
    const created = await service.create(context, input);
    await service.idle();
    const retry = writeHook.mock.calls.find(([request]) => request.previous)?.[0];
    expect(retry.previous.problem).toContain(
      'The script was rejected by the security checks: import from "node:fs" is not allowed',
    );
    expect(scripts.commits.find((commit) => commit.path.endsWith('.before.ts'))?.message).toContain(
      'Before Run of TC001',
    );
    expect((await service.get('ws', created.id)).tests[0]?.status).toBe('passed');

    const stubborn = setup({ writeHook: vi.fn().mockResolvedValue(unsafe) });
    const failed = await stubborn.service.create(context, input);
    await stubborn.service.idle();
    const detail = await stubborn.service.get('ws', failed.id);
    expect(detail.tests[0]?.status).toBe('error');
    expect(detail.tests[0]?.error).toContain('Before Run: import from "node:fs" is not allowed');
  });

  it('writes no Before Run when the rewrite of an unsafe one finds nothing to prepare', async () => {
    const unsafe =
      "import fs from 'node:fs';" +
      String.fromCharCode(10) +
      'export default async function beforeRun() {}';
    const writeHook = vi
      .fn()
      .mockImplementation(({ previous }: { previous?: unknown }) =>
        Promise.resolve(previous ? null : unsafe),
      );
    const { service, scripts } = setup({ writeHook });
    const created = await service.create(context, input);
    await service.idle();
    expect(scripts.commits.some((commit) => commit.path.endsWith('.before.ts'))).toBe(false);
    expect((await service.get('ws', created.id)).tests[0]?.status).toBe('passed');
  });

  it('tells the paired chats when a run fails before its tests finish', async () => {
    const notifier = { runFinished: vi.fn().mockResolvedValue(undefined) };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { service } = setup(
      { plan: vi.fn().mockRejectedValue(new Error('Model unavailable\nretry later')) },
      [passed],
      undefined,
      notifier,
    );
    const created = await service.create(context, input);
    await service.idle();
    expect((await service.get('ws', created.id)).status).toBe('failed');
    expect(notifier.runFinished).toHaveBeenCalledWith({
      workspaceId: 'ws',
      kind: 'e2e',
      name: 'ama',
      status: 'error',
      summary: expect.stringContaining('Model unavailable'),
    });
    expect(notifier.runFinished.mock.calls[0]![0].summary).not.toContain('\n');
    errorLog.mockRestore();
  });

  it('commits the hooks of a plan written by the MCP host and rejects unsafe ones', async () => {
    const { service, scripts } = setup();
    const created = await service.create(context, { ...input, planning: 'host' });
    await service.idle();
    const test = {
      title: 'Create event',
      description: 'd',
      priority: 'high' as const,
      steps: ['a'],
      script: VALID,
    };
    const beforeRun = 'export default async function beforeRun() {}';
    await expect(
      service.savePlan('ws', created.id, {
        tests: [{ ...test, beforeRun: "import fs from 'node:fs';", afterRun: '   ' }],
      }),
    ).rejects.toMatchObject({
      code: 'E2E_SCRIPT_REJECTED',
      technicalMessage: expect.stringContaining('TC001: Before Run: '),
    });
    await service.savePlan('ws', created.id, {
      tests: [{ ...test, beforeRun, afterRun: '   ' }],
    });
    expect(scripts.commits.map((commit) => commit.path)).toEqual([
      'tests/e2e/tc001-create-event.spec.ts',
      'tests/e2e/tc001-create-event.before.ts',
    ]);
    expect(scripts.commits[1]?.message).toBe('test(e2e): add Before Run of TC001 - Create event');
    await service.idle();
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

  it('runs the tests of an execution in parallel browsers', async () => {
    const { service, runner } = setup({}, [passed], undefined, undefined, 2);
    let active = 0;
    let peak = 0;
    runner.run.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return passed;
    });
    const created = await service.create(context, input);
    await service.idle();
    const detail = await service.get('ws', created.id);
    expect(detail.status).toBe('completed');
    expect(detail.tests.map((test) => test.status)).toEqual(['passed', 'passed']);
    expect(peak).toBe(2);
  });

  it('never runs more browsers than the concurrency allows', async () => {
    const { service, runner } = setup({}, [passed], undefined, undefined, 1);
    let active = 0;
    let peak = 0;
    runner.run.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return passed;
    });
    await service.create(context, input);
    await service.idle();
    expect(peak).toBe(1);
  });

  it('commits the specs of parallel tests one at a time', async () => {
    const { service, scripts } = setup({}, [passed], undefined, undefined, 2);
    let writing = 0;
    let overlap = false;
    const write = scripts.writeFile.bind(scripts);
    scripts.writeFile = async (...args: Parameters<typeof write>) => {
      if (++writing > 1) overlap = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await write(...args);
      } finally {
        writing--;
      }
    };
    await service.create(context, input);
    await service.idle();
    expect(overlap).toBe(false);
    expect(scripts.commits.length).toBeGreaterThanOrEqual(2);
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
    await service.rerunTest('ws', first!.id, true);
    await service.idle();
    expect(author.writeScript).toHaveBeenCalledOnce();
    // The rewrite reuses the snapshot the plan captured minutes ago instead of opening the site.
    expect(author.writeScript.mock.calls[0]?.[0].snapshot).toEqual({
      startUrl: 'http://localhost:5173/e/123',
      pages: [],
    });
    expect(runner.explore).not.toHaveBeenCalled();
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

  it('never lets the execution of one test get in the way of another test of the run', async () => {
    const { service, runner, store } = setup({}, [passed], undefined, undefined, 1, undefined, 2);
    const created = await service.create(context, input);
    await service.idle();
    const [first, second] = (await service.get('ws', created.id)).tests;
    let release!: (result: E2eRunResult) => void;
    runner.run.mockImplementationOnce(
      () =>
        new Promise<E2eRunResult>((resolve) => {
          release = resolve;
        }),
    );

    await service.rerunTest('ws', first!.id, false);
    await vi.waitFor(async () =>
      expect((await service.getTest('ws', first!.id)).status).toBe('running'),
    );

    // The same test, or the whole run, still cannot start twice...
    await expect(service.rerunTest('ws', first!.id)).rejects.toMatchObject({
      code: 'E2E_ALREADY_RUNNING',
    });
    await expect(service.pushScript('ws', first!.id, VALID)).rejects.toMatchObject({
      code: 'E2E_ALREADY_RUNNING',
    });
    await expect(service.rerun('ws', created.id)).rejects.toMatchObject({
      code: 'E2E_ALREADY_RUNNING',
    });
    // ...but the other test is free to be edited, regenerated and run meanwhile.
    expect(await service.pushScript('ws', second!.id, VALID)).toMatchObject({ content: VALID });
    await service.rerunTest('ws', second!.id, true);
    await vi.waitFor(async () =>
      expect((await service.getTest('ws', second!.id)).status).toBe('passed'),
    );
    await vi.waitFor(async () => expect(await store.getCreation('ws', created.id)).toBeTruthy());

    // The first test is untouched by the other one ending, and so is the run's status.
    expect((await service.getTest('ws', first!.id)).status).toBe('running');
    expect((await service.get('ws', created.id)).status).toBe('running');

    release(passed);
    await service.idle();
    expect((await service.getTest('ws', first!.id)).status).toBe('passed');
    expect((await service.get('ws', created.id)).status).toBe('completed');
  });

  it('only fails the test of the job that crashed, not the ones other jobs are running', async () => {
    const { service, runner } = setup({}, [passed], undefined, undefined, 1, undefined, 2);
    const created = await service.create(context, input);
    await service.idle();
    const [first, second] = (await service.get('ws', created.id)).tests;
    let release!: (result: E2eRunResult) => void;
    runner.run
      .mockImplementationOnce(
        () =>
          new Promise<E2eRunResult>((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValueOnce(new E2eRunnerError('E2E_BROWSER_NOT_INSTALLED', 'no browser'));

    await service.rerunTest('ws', first!.id, false);
    await vi.waitFor(async () =>
      expect((await service.getTest('ws', first!.id)).status).toBe('running'),
    );
    await service.rerunTest('ws', second!.id, false);
    await vi.waitFor(async () =>
      expect((await service.getTest('ws', second!.id)).status).toBe('error'),
    );
    expect((await service.getTest('ws', first!.id)).status).toBe('running');
    expect((await service.get('ws', created.id)).status).toBe('running');

    release(passed);
    await service.idle();
    expect((await service.getTest('ws', first!.id)).status).toBe('passed');
    expect((await service.get('ws', created.id)).status).toBe('completed');
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

  it('saves a host plan with Before Run and After Run, and rejects an unsafe one', async () => {
    const { service, scripts } = setup();
    const created = await service.create(context, { ...input, planning: 'host' });
    await service.idle();
    const login = {
      title: 'Valid login',
      description: 'd',
      priority: 'high',
      steps: ['a'],
    } as const;
    await expect(
      service.savePlan('ws', created.id, {
        tests: [{ ...login, script: VALID, beforeRun: 'not a hook at all' }],
      }),
    ).rejects.toMatchObject({ code: 'E2E_SCRIPT_REJECTED', technicalMessage: /Before Run: / });

    await service.savePlan('ws', created.id, {
      tests: [
        {
          ...login,
          script: VALID,
          beforeRun: 'export default async function beforeRun() {}',
          afterRun: 'export default async function afterRun() {}',
        },
      ],
    });
    expect(scripts.commits.map((commit) => commit.path)).toEqual([
      'tests/e2e/tc001-valid-login.spec.ts',
      'tests/e2e/tc001-valid-login.before.ts',
      'tests/e2e/tc001-valid-login.after.ts',
    ]);
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
    const { service, store, queue } = setup();
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
    // A run whose job is still held by a worker is left running.
    const held = await store.createCreation({ ...(await store.getCreation('ws', creation.id))! });
    await store.updateCreation('ws', held.id, { status: 'running' });
    vi.spyOn(queue, 'hasActive').mockImplementation(async (_ws, id) => id === held.id);
    await service.recover(0);
    expect((await store.getCreation('ws', held.id))?.status).toBe('running');
    const detail = await service.get('ws', creation.id);
    expect(detail).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('reiniciado'),
    });
    expect(detail.tests.map((item) => item.status)).toEqual(['passed', 'error']);
  });

  it('wakes the worker again after startup, to find the jobs the previous process abandoned', async () => {
    vi.useFakeTimers();
    try {
      const wake = vi.fn().mockResolvedValue(undefined);
      const { store, artifacts, queue } = setup();
      const restarted = new E2eService({
        store,
        artifacts,
        queue,
        dispatcher: { wake },
        agents: {} as never,
        scripts: new FakeScriptRepository(),
      });
      await restarted.recover();
      expect(wake).toHaveBeenCalledTimes(1);
      // Its heartbeats are still recent at startup: it is judged abandoned only a while later.
      await vi.advanceTimersByTimeAsync(129_000);
      expect(wake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(wake).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

describe('E2eService with a folder of this computer', () => {
  const local = {
    provider: 'local' as const,
    id: 'D:\Projects\finance-app-demo',
    branch: '',
    path: 'tests/e2e',
  };

  it('keeps the specs in the chosen folder when the app can read it', async () => {
    const { service, scripts } = setup();
    Object.assign(scripts, {
      resolveFolder: vi
        .fn()
        .mockResolvedValue({ id: local.id, name: 'finance-app-demo', defaultBranch: 'main' }),
    });
    const created = await service.create(context, { ...input, repository: local });
    expect(created.repository).toEqual({
      provider: 'local',
      id: local.id,
      name: 'finance-app-demo',
      branch: 'main',
      path: 'tests/e2e',
    });
    // A branch picked by the user wins over the one checked out.
    const named = await service.create(context, {
      ...input,
      repository: { ...local, branch: 'feature/x' },
    });
    expect(named.repository?.branch).toBe('feature/x');
    await service.idle();
  });

  it('refuses a folder where the app cannot read the disk (hosted ADK)', async () => {
    const { service } = setup();
    await expect(service.create(context, { ...input, repository: local })).rejects.toMatchObject({
      code: 'E2E_LOCAL_FOLDER_UNAVAILABLE',
      statusCode: 409,
    });
  });
});
