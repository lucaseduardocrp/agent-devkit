import { describe, expect, it } from 'vitest';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { E2eRunnerError, type E2eRunInput } from '../src/modules/e2e/application/e2e-runner.js';
import {
  decodeRunnerInput,
  LocalE2eRunner,
  runnerTaskPrefix,
} from '../src/modules/e2e/application/local-runner.js';
import { E2eLocalRunnerService } from '../src/modules/e2e/application/local-runner-service.js';
import { InMemoryE2eRunnerTaskStore } from '../src/modules/e2e/application/runner-tasks.js';
import type { RequestContext } from '../src/shared/context.js';

const target = { workspaceId: 'ws', creationId: 'c1', testId: 't1', userId: 'user' };
const identity = { id: 'runner-0001', name: 'QA-LAPTOP', platform: 'linux', version: '0.2.0' };
const context: RequestContext = { requestId: 'r', workspaceId: 'ws', actorId: 'user' };
const input: E2eRunInput = {
  script: 'spec',
  mode: 'frontend',
  baseUrl: 'https://tunnel.trycloudflare.com',
  localOrigin: 'http://localhost:8014',
  locale: 'pt-BR',
  credentials: { username: 'qa', password: 'secret-pass' },
  accessToken: { clientId: 'adk-local-x', clientSecret: 'tunnel-secret' },
};

function setup(options: { claimTimeoutMs?: number; staleMs?: number; runTimeoutMs?: number } = {}) {
  const tasks = new InMemoryE2eRunnerTaskStore();
  const artifacts = new InMemoryE2eArtifactStore();
  let clock = 0;
  const local = new LocalE2eRunner({
    tasks,
    artifacts,
    pollMs: 1,
    claimTimeoutMs: options.claimTimeoutMs ?? 1_000,
    staleMs: options.staleMs ?? 1_000,
    runTimeoutMs: options.runTimeoutMs ?? 10_000,
    now: () => clock,
  });
  const service = new E2eLocalRunnerService({
    tasks,
    artifacts,
    store: { getCreation: () => Promise.resolve(null), getTest: () => Promise.resolve(null) },
    pollMs: 1,
  });
  return {
    tasks,
    artifacts,
    service,
    runner: local.for(target),
    advance: (ms: number) => (clock += ms),
  };
}

/** Moves the fake clock forward until the promise settles, letting the poll loop observe it. */
async function settle<T>(promise: Promise<T>, advance: (ms: number) => number): Promise<T> {
  let settled = false;
  const watched = promise.finally(() => (settled = true));
  // The caller asserts the outcome; this only stops Node from flagging it as unhandled meanwhile.
  watched.catch(() => undefined);
  for (let tick = 0; tick < 500 && !settled; tick++) {
    advance(25);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return watched;
}

async function claimed(service: E2eLocalRunnerService) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const task = await service.claim(context, identity, { waitMs: 0 });
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('No task was created.');
}

describe('LocalE2eRunner', () => {
  it('sends the localhost target instead of the tunnel and keeps secrets encrypted at rest', async () => {
    const { tasks, service, runner, artifacts } = setup();
    const pending = runner.run(input);
    const task = await claimed(service);
    expect(task.input).toEqual({
      kind: 'run',
      script: 'spec',
      mode: 'frontend',
      baseUrl: 'http://localhost:8014',
      locale: 'pt-BR',
      credentials: { username: 'qa', password: 'secret-pass' },
      accessToken: null,
    });
    const stored = await tasks.get(task.id);
    expect(stored?.payload).not.toContain('secret-pass');
    expect(decodeRunnerInput(stored!.payload)).toEqual(task.input);

    await service.complete(context, task.id, identity.id, {
      kind: 'run',
      status: 'failed',
      durationMs: 7,
      error: 'expected title',
      logs: 'logs',
      steps: [
        {
          position: 1,
          title: 'Open',
          status: 'failed',
          durationMs: 3,
          error: 'x',
          hasScreenshot: false,
        },
      ],
      hasVideo: false,
    });
    await expect(pending).resolves.toEqual({
      status: 'failed',
      durationMs: 7,
      error: 'expected title',
      logs: 'logs',
      video: null,
      steps: [
        {
          position: 1,
          title: 'Open',
          status: 'failed',
          durationMs: 3,
          error: 'x',
          screenshot: null,
        },
      ],
      executedOn: 'QA-LAPTOP (linux)',
    });
    expect(await tasks.get(task.id)).toBeNull();
    expect(
      await artifacts.get(`${runnerTaskPrefix({ ...target, id: task.id })}/video.webm`),
    ).toBeNull();
  });

  it('explores through the runner and keeps a direct target token', async () => {
    const { service, runner } = setup();
    const pending = runner.explore({
      mode: 'frontend',
      url: 'https://app.example.com/login',
      accessToken: { clientId: 'id', clientSecret: 'secret' },
    });
    const task = await claimed(service);
    expect(task.input).toEqual({
      kind: 'explore',
      mode: 'frontend',
      url: 'https://app.example.com/login',
      accessToken: { clientId: 'id', clientSecret: 'secret' },
    });
    await service.complete(context, task.id, identity.id, {
      kind: 'explore',
      snapshot: { startUrl: 'https://app.example.com/login', pages: [] },
    });
    await expect(pending).resolves.toEqual({
      startUrl: 'https://app.example.com/login',
      pages: [],
    });
  });

  it('fails when no runner claims the task in time', async () => {
    const { tasks, runner, advance } = setup({ claimTimeoutMs: 50 });
    await expect(settle(runner.run(input), advance)).rejects.toMatchObject({
      code: 'E2E_LOCAL_RUNNER_UNAVAILABLE',
    });
    expect(
      await tasks.claim(
        { workspaceId: 'ws', userId: 'user', createdAfter: new Date(0) },
        { id: 'r', label: 'r' },
      ),
    ).toBeNull();
  });

  it('fails when the runner stops sending heartbeats or takes too long', async () => {
    const lost = setup({ staleMs: 50 });
    const pending = lost.runner.run(input);
    await claimed(lost.service);
    await expect(settle(pending, lost.advance)).rejects.toMatchObject({
      code: 'E2E_LOCAL_RUNNER_LOST',
    });

    const slow = setup({ staleMs: 1_000_000, runTimeoutMs: 50 });
    const running = slow.runner.run(input);
    const task = await claimed(slow.service);
    await expect(settle(running, slow.advance)).rejects.toMatchObject({
      code: 'E2E_RUNNER_FAILED',
    });
    // The runner learns that its task is gone and stops the browser.
    await expect(slow.service.heartbeat(context, task.id, identity)).resolves.toBe('cancelled');
  });

  it('reports the runner error code and stops on cancellation', async () => {
    const failing = setup();
    const pending = failing.runner.run(input);
    const task = await claimed(failing.service);
    await failing.service.complete(context, task.id, identity.id, {
      kind: 'error',
      code: 'E2E_BROWSER_NOT_INSTALLED',
      message: 'Run devkit e2e setup.',
    });
    const error = await pending.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(E2eRunnerError);
    expect(error).toMatchObject({
      code: 'E2E_BROWSER_NOT_INSTALLED',
      message: 'Run devkit e2e setup.',
    });

    const cancelled = setup();
    const controller = new AbortController();
    const aborted = cancelled.runner.run({ ...input, signal: controller.signal });
    const claimedTask = await claimed(cancelled.service);
    controller.abort();
    await expect(aborted).rejects.toThrow('cancelled');
    await expect(cancelled.service.heartbeat(context, claimedTask.id, identity)).resolves.toBe(
      'cancelled',
    );
  });

  it('long-polls for work, lists online runners and rejects foreign evidence', async () => {
    const { service, runner } = setup();
    await expect(service.claim(context, identity, { waitMs: 5 })).resolves.toBeNull();
    await expect(service.runners(context)).resolves.toEqual([
      expect.objectContaining({ id: identity.id, online: true }),
    ]);
    void runner.run(input).catch(() => undefined);
    const task = await claimed(service);
    await expect(
      service.uploadArtifact(context, task.id, identity.id, 'step-1.png', new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'E2E_INVALID_ARTIFACT' });
    await expect(
      service.uploadArtifact(
        { ...context, actorId: 'intruder' },
        task.id,
        identity.id,
        'video.webm',
        new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      ),
    ).rejects.toMatchObject({ code: 'E2E_RUNNER_TASK_NOT_FOUND' });
    await expect(
      service.complete(context, task.id, identity.id, {
        kind: 'explore',
        snapshot: { startUrl: 'x', pages: [] },
      }),
    ).rejects.toMatchObject({ code: 'E2E_INVALID_ARTIFACT' });
    await expect(service.claim({ requestId: 'r' }, identity, { waitMs: 0 })).rejects.toMatchObject({
      code: 'WORKSPACE_REQUIRED',
    });
  });
});
