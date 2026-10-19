import { describe, expect, it, vi } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { LocalE2eRunner } from '../src/modules/e2e/application/local-runner.js';
import { E2eLocalRunnerService } from '../src/modules/e2e/application/local-runner-service.js';
import {
  InMemoryE2eRunnerTaskStore,
  type E2eRunnerTask,
} from '../src/modules/e2e/application/runner-tasks.js';
import type { RequestContext } from '../src/shared/context.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';

const context: RequestContext = { requestId: 'r', workspaceId: 'ws', actorId: 'user' };
const identity = { id: 'runner-0001', name: 'QA', platform: 'linux', version: '0.2.0' };
const target = { workspaceId: 'ws', creationId: 'c1', testId: null, userId: 'user' };

/** A store whose tasks are finished by the test itself, as a runner would. */
function finishedBy(result: string | null, status: 'succeeded' | 'failed', error: string | null) {
  const tasks = new InMemoryE2eRunnerTaskStore();
  const get = tasks.get.bind(tasks);
  vi.spyOn(tasks, 'get').mockImplementation(async (id) => {
    const task = await get(id);
    return task && ({ ...task, status, result, error, runnerLabel: 'QA' } satisfies E2eRunnerTask);
  });
  return new LocalE2eRunner({ tasks, artifacts: new InMemoryE2eArtifactStore(), pollMs: 1 }).for(
    target,
  );
}

const runInput = {
  script: 's',
  mode: 'frontend' as const,
  baseUrl: 'http://localhost:1',
  locale: 'en-US',
  credentials: { username: null, password: null },
};

describe('local runner edge cases', () => {
  it('turns unexpected runner outcomes into runner failures', async () => {
    await expect(finishedBy('{not json', 'succeeded', null).run(runInput)).rejects.toMatchObject({
      code: 'E2E_RUNNER_FAILED',
      message: 'The local runner sent no test result.',
    });
    await expect(
      finishedBy('{"kind":"run"}', 'succeeded', null).explore({ mode: 'frontend', url: 'x' }),
    ).rejects.toMatchObject({ message: 'The local runner sent no snapshot.' });
    await expect(finishedBy(null, 'succeeded', null).run(runInput)).rejects.toMatchObject({
      code: 'E2E_RUNNER_FAILED',
    });
    await expect(
      finishedBy('{"kind":"error","code":"E2E_SCRIPT_REJECTED"}', 'failed', 'Blocked.').run(
        runInput,
      ),
    ).rejects.toMatchObject({ code: 'E2E_RUNNER_FAILED', message: 'Blocked.' });
    await expect(finishedBy(null, 'failed', null).run(runInput)).rejects.toMatchObject({
      message: 'The local runner failed.',
    });
  });

  it('explores without a token and treats a claim without heartbeat as lost', async () => {
    const snapshot = { startUrl: 'http://localhost:1/', pages: [] };
    await expect(
      finishedBy(JSON.stringify({ kind: 'explore', snapshot }), 'succeeded', null).explore({
        mode: 'frontend',
        url: 'http://localhost:1/',
      }),
    ).resolves.toEqual(snapshot);

    const tasks = new InMemoryE2eRunnerTaskStore();
    const get = tasks.get.bind(tasks);
    vi.spyOn(tasks, 'get').mockImplementation(async (id) => {
      const task = await get(id);
      return task && { ...task, status: 'running', heartbeatAt: null };
    });
    let clock = 0;
    const runner = new LocalE2eRunner({
      tasks,
      artifacts: new InMemoryE2eArtifactStore(),
      pollMs: 1,
      staleMs: 10,
      now: () => (clock += 20),
    }).for(target);
    await expect(runner.run(runInput)).rejects.toMatchObject({ code: 'E2E_LOCAL_RUNNER_LOST' });
    // Only the runner that claimed a task can complete it.
    const queued = await tasks.create({ ...target, kind: 'run', payload: 'p' });
    expect(
      await tasks.complete(queued.id, 'someone', { status: 'failed', result: '{}', error: null }),
    ).toBe(false);
  });

  it('answers cancelled heartbeats and late completions', async () => {
    const tasks = new InMemoryE2eRunnerTaskStore();
    const service = new E2eLocalRunnerService({
      tasks,
      artifacts: new InMemoryE2eArtifactStore(),
      store: { getCreation: () => Promise.resolve(null), getTest: () => Promise.resolve(null) },
    });
    await tasks.create({ ...target, kind: 'explore', payload: 'p' });
    const claimed = await tasks.claim(
      { workspaceId: 'ws', userId: 'user', createdAfter: new Date(0) },
      { id: identity.id, label: 'QA' },
    );
    await tasks.complete(claimed!.id, identity.id, {
      status: 'succeeded',
      result: '{}',
      error: null,
    });
    // Finished tasks are not renewed; the runner is told to stop.
    await expect(service.heartbeat(context, claimed!.id, identity)).resolves.toBe('cancelled');
    expect(await tasks.heartbeat(claimed!.id, identity.id)).toBe('succeeded');
    expect(await tasks.heartbeat(claimed!.id, 'another')).toBeNull();
    await expect(service.heartbeat(context, 'missing', identity)).resolves.toBe('cancelled');
    await expect(
      service.complete(context, claimed!.id, identity.id, {
        kind: 'explore',
        snapshot: { startUrl: 'x', pages: [] },
      }),
    ).rejects.toMatchObject({ code: 'E2E_RUNNER_TASK_NOT_FOUND' });
    await expect(service.runners({ requestId: 'r', workspaceId: 'ws' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    // A completion that loses the race against the worker (task removed meanwhile).
    await tasks.create({ ...target, kind: 'explore', payload: 'p' });
    const raced = await tasks.claim(
      { workspaceId: 'ws', userId: 'user', createdAfter: new Date(0) },
      { id: identity.id, label: 'QA' },
    );
    vi.spyOn(tasks, 'complete').mockResolvedValueOnce(false);
    await expect(
      service.complete(context, raced!.id, identity.id, {
        kind: 'error',
        code: 'E2E_RUNNER_FAILED',
        message: 'x',
      }),
    ).rejects.toMatchObject({ code: 'E2E_RUNNER_TASK_NOT_FOUND' });
  });

  it('lists only recent runners of the user, newest first', async () => {
    const tasks = new InMemoryE2eRunnerTaskStore();
    await tasks.seen({ ...identity, workspaceId: 'ws', userId: 'user' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tasks.seen({ ...identity, id: 'runner-0002', workspaceId: 'ws', userId: 'user' });
    await tasks.seen({ ...identity, id: 'runner-0003', workspaceId: 'ws', userId: 'other' });
    await tasks.seen({ ...identity, id: 'runner-0004', workspaceId: 'other', userId: 'user' });
    expect((await tasks.listRunners('ws', 'user', new Date(0))).map((runner) => runner.id)).toEqual(
      ['runner-0002', 'runner-0001'],
    );
    expect(await tasks.listRunners('ws', 'user', new Date(Date.now() + 60_000))).toEqual([]);
  });

  it('fails a local run when the worker has no local runner support', async () => {
    const store = new InMemoryE2eStore();
    const creation = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'ws',
      actorId: 'user',
      agentId: 'a',
      name: 'local',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://localhost:8014',
      executionTarget: 'local',
      path: '/',
      username: null,
      passwordSecret: null,
      prd: 'p',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'en-US',
      repository: { provider: 'github', id: '1', name: 'o/r', branch: 'main', path: 'e2e' },
    });
    const runner = { explore: vi.fn(), run: vi.fn() };
    const executor = new E2eExecutor({
      store,
      runner,
      artifacts: new InMemoryE2eArtifactStore(),
      scripts: new FakeScriptRepository(),
      author: { plan: vi.fn(), writeScript: vi.fn(), analyze: vi.fn() },
    });
    await executor.run(
      {
        id: 'j',
        workspaceId: 'ws',
        creationId: creation.id,
        kind: 'generate',
        testIds: [],
        status: 'running',
        attempts: 1,
        workerId: 'w',
        heartbeatAt: null,
        requestedBy: null,
        createdAt: new Date(),
      },
      new AbortController().signal,
    );
    expect(runner.explore).not.toHaveBeenCalled();
    expect(await store.getCreation('ws', creation.id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('devkit runner'),
    });

    // Jobs from before the requester was recorded go to the run's creator.
    const local = { for: vi.fn(() => runner) };
    runner.explore.mockRejectedValue(new Error('offline'));
    await new E2eExecutor({
      store,
      runner,
      localRunner: local as unknown as LocalE2eRunner,
      artifacts: new InMemoryE2eArtifactStore(),
      scripts: new FakeScriptRepository(),
      author: { plan: vi.fn(), writeScript: vi.fn(), analyze: vi.fn() },
    }).run(
      {
        id: 'j2',
        workspaceId: 'ws',
        creationId: creation.id,
        kind: 'explore',
        testIds: [],
        status: 'running',
        attempts: 1,
        workerId: 'w',
        heartbeatAt: null,
        requestedBy: null,
        createdAt: new Date(),
      },
      new AbortController().signal,
    );
    expect(local.for).toHaveBeenCalledWith({
      workspaceId: 'ws',
      creationId: creation.id,
      testId: null,
      userId: 'user',
    });
  });
});
