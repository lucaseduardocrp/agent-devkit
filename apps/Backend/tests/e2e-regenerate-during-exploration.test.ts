import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eService } from '../src/modules/e2e/application/e2e-service.js';
import type { E2eRunResult } from '../src/modules/e2e/application/e2e-runner.js';
import {
  InMemoryE2eJobQueue,
  jobScope,
  scopesCollide,
  type E2eJob,
} from '../src/modules/e2e/application/e2e-queue.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { ExplorationRecorder } from '../src/modules/e2e/application/e2e-exploration.js';
import { LocalE2eDispatcher } from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

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

function setup() {
  const store = new InMemoryE2eStore();
  const artifacts = new InMemoryE2eArtifactStore();
  const scripts = new FakeScriptRepository();
  const author = {
    plan: vi.fn().mockResolvedValue({
      summary: '# PRD',
      tests: [{ title: 'Submit question', description: 'd1', priority: 'high', steps: ['a'] }],
    }),
    writeScript: vi.fn().mockResolvedValue(VALID),
    analyze: vi.fn().mockResolvedValue({ verdict: 'app_bug', summary: 'Goal: ...' }),
  };
  const runner = {
    explore: vi.fn().mockResolvedValue({ startUrl: 'http://localhost:5173/e/123', pages: [] }),
    run: vi.fn().mockResolvedValue(passed),
  };
  const queue = new InMemoryE2eJobQueue();
  const executor = new E2eExecutor({
    store,
    queue,
    artifacts,
    author: author,
    runner,
    scripts,
    testConcurrency: 1,
  });
  const worker = new E2eWorker({ queue, concurrency: 1, heartbeatMs: 5, executor });
  const service = new E2eService({
    store,
    queue,
    dispatcher: new LocalE2eDispatcher(worker),
    artifacts,
    agents: { getAgent: vi.fn().mockResolvedValue({ id: 'agent' }) },
    scripts,
  });
  return { service, store, artifacts, author, queue, worker, executor };
}

const page = (title: string) => ({
  index: 1,
  url: `http://localhost:5173/${title}`,
  title,
  summary: `${title} summary`,
  elements: ['Filter'],
  hasScreenshot: false,
});

describe('the scope of an exploration in the queue', () => {
  it('gives the exploration a scope of its own, apart from every test', () => {
    expect(jobScope({ kind: 'explore', testIds: [] })).toBe('explore');
    expect(jobScope({ kind: 'execute', testIds: ['t1'] })).toBe('t1');
    expect(jobScope({ kind: 'execute', testIds: ['t1', 't2'] })).toBe('');
    expect(scopesCollide('explore', 't1')).toBe(false);
    expect(scopesCollide('explore', 'explore')).toBe(true);
    expect(scopesCollide('explore', '')).toBe(true);
  });

  it('lets a test run next to the exploration of its run, and nothing else', async () => {
    const queue = new InMemoryE2eJobQueue();
    const job = (kind: 'explore' | 'execute' | 'generate', testIds: string[]) => ({
      workspaceId: 'ws',
      creationId: 'c1',
      kind,
      testIds,
    });
    expect(await queue.enqueue(job('explore', []))).not.toBeNull();
    // One test of the run runs while it is explored...
    expect(await queue.enqueue(job('execute', ['t1']))).not.toBeNull();
    expect(await queue.hasActive('ws', 'c1', { testId: 't1' })).toBe(true);
    expect(await queue.hasActive('ws', 'c1', { testId: 't2' })).toBe(false);
    // ...but the run is not explored twice, nor planned or run as a whole meanwhile.
    expect(await queue.enqueue(job('explore', []))).toBeNull();
    expect(await queue.enqueue(job('generate', []))).toBeNull();
    expect(await queue.enqueue(job('execute', ['t1', 't2']))).toBeNull();
  });
});

describe('regenerating a script while the run is being explored', () => {
  async function runWithExploration() {
    const env = setup();
    const created = await env.service.create(context, input);
    await env.worker.idle();
    return { ...env, created };
  }

  /** The exploration job being worked on by another worker, with the state the page follows. */
  async function startExploring(
    env: Awaited<ReturnType<typeof runWithExploration>>,
  ): Promise<E2eJob> {
    const creation = (await env.store.getCreation('ws', env.created.id))!;
    await ExplorationRecorder.start(env.artifacts, creation, false, Date.now, {});
    await env.queue.enqueue({
      workspaceId: 'ws',
      creationId: creation.id,
      kind: 'explore',
      testIds: [],
    });
    return (await env.queue.claim('another-worker'))!;
  }

  it('is accepted, and the script uses the last exploration that finished', async () => {
    const env = await runWithExploration();
    const { store, queue, worker, service, author, created } = env;
    const [test] = await store.listTests('ws', created.id);
    const creation = (await store.getCreation('ws', created.id))!;
    // An earlier exploration of the run ended well; the next one has just started.
    await store.saveExplorationScript({
      workspaceId: 'ws',
      creationId: creation.id,
      description: null,
      status: 'ready',
      error: null,
      signedInMs: null,
      script: [],
      pages: [page('Documental compliance')],
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const exploring = await startExploring(env);
    author.writeScript.mockClear();

    await service.rerunTest('ws', test!.id, true, 'user', { instructions: 'Use few filters' });
    await worker.idle();

    expect(author.writeScript).toHaveBeenCalledTimes(1);
    expect(author.writeScript.mock.calls[0]![0].exploration.pages).toEqual([
      expect.objectContaining({ name: 'Documental compliance' }),
    ]);
    expect((await store.getTest('ws', test!.id))?.status).toBe('passed');
    // The exploration still goes on: the run is not closed under it...
    expect((await store.getCreation('ws', created.id))?.status).toBe('running');
    expect(await queue.hasActive('ws', created.id)).toBe(true);
    // ...and closes when the exploration ends.
    await queue.finish(exploring.id, 'another-worker', 'succeeded');
    await env.executor.settle(exploring);
    expect((await store.getCreation('ws', created.id))?.status).toBe('completed');
  });

  it('writes the script without exploration context when none ever finished', async () => {
    const env = await runWithExploration();
    const { store, service, worker, author, created } = env;
    const [test] = await store.listTests('ws', created.id);
    await startExploring(env);
    author.writeScript.mockClear();

    await service.rerunTest('ws', test!.id, true, 'user', {});
    await worker.idle();

    expect(author.writeScript).toHaveBeenCalledTimes(1);
    expect(author.writeScript.mock.calls[0]![0].exploration).toBeNull();
    expect((await store.getTest('ws', test!.id))?.status).toBe('passed');
  });

  it('still writes the script when the finished explorations cannot be read', async () => {
    const env = await runWithExploration();
    const { store, service, worker, author, created } = env;
    const [test] = await store.listTests('ws', created.id);
    await startExploring(env);
    author.writeScript.mockClear();
    vi.spyOn(store, 'listExplorationScripts').mockRejectedValue(new Error('db down'));

    await service.rerunTest('ws', test!.id, true, 'user', {});
    await worker.idle();

    expect(author.writeScript.mock.calls[0]![0].exploration).toBeNull();
  });

  it('does not fail what else works on the run when the exploration is lost', async () => {
    const env = await runWithExploration();
    const { store, queue, executor, created } = env;
    const [test] = await store.listTests('ws', created.id);
    const exploring = await startExploring(env);
    // A test is being executed (a job nobody has claimed yet) while the exploration is abandoned.
    await store.updateCreation('ws', created.id, { status: 'running' });
    await store.updateTest('ws', test!.id, { status: 'running' });
    await queue.enqueue({
      workspaceId: 'ws',
      creationId: created.id,
      kind: 'execute',
      testIds: [test!.id],
    });
    await queue.finish(exploring.id, 'another-worker', 'failed');

    await executor.interrupt(exploring);

    expect((await store.getCreation('ws', created.id))?.status).toBe('running');
    expect((await store.getTest('ws', test!.id))?.status).toBe('running');
  });

  it('closes a run left active by an exploration that was the last job', async () => {
    const env = await runWithExploration();
    const { store, queue, executor, created } = env;
    const exploring = await startExploring(env);
    await store.updateCreation('ws', created.id, { status: 'running' });
    await queue.finish(exploring.id, 'another-worker', 'failed');

    await executor.interrupt(exploring);

    expect((await store.getCreation('ws', created.id))?.status).toBe('completed');
  });
});
