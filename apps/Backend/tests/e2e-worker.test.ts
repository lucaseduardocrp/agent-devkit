import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryE2eJobQueue, type E2eJob } from '../src/modules/e2e/application/e2e-queue.js';
import { E2eWorker } from '../src/modules/e2e/application/e2e-worker.js';
import { E2eExecutor } from '../src/modules/e2e/application/e2e-executor.js';
import { InMemoryE2eStore } from '../src/modules/e2e/application/e2e-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { snapshotKey } from '../src/modules/e2e/domain/e2e.js';
import {
  HttpE2eDispatcher,
  LocalE2eDispatcher,
} from '../src/modules/e2e/adapters/e2e-dispatchers.js';
import { createE2eWorkerApp } from '../src/adapters/http/e2e-worker-app.js';

const job = (creationId: string, workspaceId = 'ws') => ({
  workspaceId,
  creationId,
  kind: 'execute' as const,
  testIds: ['t1'],
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe('InMemoryE2eJobQueue', () => {
  it('keeps one active job per creation and hands jobs out oldest first', async () => {
    const queue = new InMemoryE2eJobQueue();
    const first = await queue.enqueue(job('c1'));
    expect(first).toMatchObject({ status: 'queued', attempts: 0, testIds: ['t1'] });
    expect(await queue.enqueue(job('c1'))).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await queue.enqueue(job('c2'));
    expect(await queue.hasActive('ws', 'c1')).toBe(true);
    expect(await queue.hasActive('other', 'c1')).toBe(false);
    expect(await queue.hasActive('ws', 'c3')).toBe(false);

    const claimed = await queue.claim('w1');
    expect(claimed).toMatchObject({
      creationId: 'c1',
      status: 'running',
      workerId: 'w1',
      attempts: 1,
    });
    expect(await queue.heartbeat(claimed!.id, 'w1')).toBe(true);
    expect(await queue.heartbeat(claimed!.id, 'w2')).toBe(false);
    expect(await queue.heartbeat('missing', 'w1')).toBe(false);
    await queue.finish(claimed!.id, 'w2', 'failed');
    expect(await queue.hasActive('ws', 'c1')).toBe(true);
    await queue.finish(claimed!.id, 'w1', 'succeeded');
    expect(await queue.hasActive('ws', 'c1')).toBe(false);
    expect(await queue.enqueue(job('c1'))).not.toBeNull();

    expect(await queue.cancel('other', 'c2')).toBe(false);
    expect(await queue.cancel('ws', 'c2')).toBe(true);
    expect(await queue.cancel('ws', 'c2')).toBe(false);
    expect((await queue.claim('w1'))?.creationId).toBe('c1');
    expect(await queue.claim('w1')).toBeNull();
  });

  it('requeues abandoned jobs and fails them after the last attempt', async () => {
    const queue = new InMemoryE2eJobQueue();
    await queue.enqueue(job('c1'));
    await queue.enqueue(job('c2'));
    const a = await queue.claim('dead');
    await queue.claim('alive');
    const future = new Date(Date.now() + 60_000);
    const live = await queue.claim('none');
    expect(live).toBeNull();

    const first = await queue.sweep(future, 2);
    expect(first.requeued.map((item) => item.creationId).sort()).toEqual(['c1', 'c2']);
    expect(first.failed).toEqual([]);
    expect(await queue.sweep(new Date(0), 2)).toEqual({ requeued: [], failed: [] });

    const again = await queue.claim('dead');
    expect(again).toMatchObject({ id: a!.id, attempts: 2 });
    const second = await queue.sweep(future, 2);
    expect(second.failed.map((item) => item.id)).toEqual([a!.id]);
    expect(await queue.hasActive('ws', 'c1')).toBe(false);
  });
});

describe('E2eWorker', () => {
  it('runs different runs in parallel up to its concurrency and goes idle', async () => {
    const queue = new InMemoryE2eJobQueue();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let running = 0;
    let peak = 0;
    const executor = {
      run: vi.fn(async (claimed: E2eJob) => {
        running += 1;
        peak = Math.max(peak, running);
        const gate = deferred();
        gates.set(claimed.creationId, gate);
        await gate.promise;
        running -= 1;
      }),
      interrupt: vi.fn(),
    };
    const onIdle = vi.fn();
    const worker = new E2eWorker({ queue, executor, concurrency: 2, workerId: 'w', onIdle });
    for (const id of ['c1', 'c2', 'c3']) await queue.enqueue(job(id));
    worker.wake();
    worker.wake();
    await vi.waitFor(() => expect(running).toBe(2));
    expect(worker.status).toMatchObject({ workerId: 'w', active: 2, draining: true });
    gates.get('c1')!.resolve();
    await vi.waitFor(() => expect(gates.has('c3')).toBe(true));
    gates.get('c2')!.resolve();
    gates.get('c3')!.resolve();
    await worker.idle();
    expect(peak).toBe(2);
    expect(executor.run).toHaveBeenCalledTimes(3);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(worker.status).toMatchObject({ active: 0, draining: false });
    expect(await queue.hasActive('ws', 'c1')).toBe(false);
  });

  it('picks up work enqueued while it was finishing', async () => {
    const queue = new InMemoryE2eJobQueue();
    const worker = new E2eWorker({
      queue,
      executor: { run: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn() },
    });
    const claim = queue.claim.bind(queue);
    let calls = 0;
    vi.spyOn(queue, 'claim').mockImplementation(async (id) => {
      calls += 1;
      // The API enqueues and wakes right as the worker sees an empty queue.
      if (calls === 1) {
        await queue.enqueue(job('late'));
        worker.wake();
        return null;
      }
      return claim(id);
    });
    worker.wake();
    await worker.idle();
    expect(await queue.hasActive('ws', 'late')).toBe(false);
    expect(worker.workerId).toMatch(/^worker-/);
  });

  it('aborts a job cancelled through the queue and records failures', async () => {
    const queue = new InMemoryE2eJobQueue();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const executor = {
      run: vi.fn(async (claimed: E2eJob, signal: AbortSignal) => {
        if (claimed.creationId === 'boom') throw new Error('crash');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      }),
      interrupt: vi.fn(),
    };
    const worker = new E2eWorker({ queue, executor, heartbeatMs: 5, concurrency: 1 });
    await queue.enqueue(job('long'));
    await queue.enqueue(job('boom'));
    worker.wake();
    await vi.waitFor(() => expect(executor.run).toHaveBeenCalledOnce());
    await queue.cancel('ws', 'long');
    await worker.idle();
    expect(executor.run).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith('[E2eWorker] Job failed:', expect.any(Error));
    expect(await queue.hasActive('ws', 'boom')).toBe(false);
  });

  it('logs heartbeat, finish and drain failures without stopping', async () => {
    const queue = new InMemoryE2eJobQueue();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(queue, 'heartbeat').mockRejectedValue(new Error('db blip'));
    vi.spyOn(queue, 'finish').mockRejectedValue(new Error('db down'));
    const worker = new E2eWorker({
      queue,
      heartbeatMs: 2,
      executor: {
        run: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20))),
        interrupt: vi.fn(),
      },
    });
    await queue.enqueue(job('c1'));
    worker.wake();
    await worker.idle();
    expect(errorLog).toHaveBeenCalledWith('[E2eWorker] Heartbeat failed:', expect.any(Error));
    expect(errorLog).toHaveBeenCalledWith('[E2eWorker] Could not finish job:', expect.any(Error));

    vi.spyOn(queue, 'sweep').mockRejectedValueOnce(new Error('no db'));
    worker.wake();
    await worker.idle();
    expect(errorLog).toHaveBeenCalledWith('[E2eWorker] Drain failed:', expect.any(Error));
  });

  it('interrupts runs whose jobs were abandoned too many times', async () => {
    const queue = new InMemoryE2eJobQueue();
    const executor = { run: vi.fn(), interrupt: vi.fn().mockResolvedValue(undefined) };
    vi.spyOn(queue, 'sweep').mockResolvedValueOnce({
      requeued: [],
      failed: [{ id: 'j', workspaceId: 'ws', creationId: 'c9' } as E2eJob],
    });
    const worker = new E2eWorker({ queue, executor, concurrency: 0, staleMs: 1, maxAttempts: 3 });
    worker.wake();
    await worker.idle();
    expect(queue.sweep).toHaveBeenCalledWith(expect.any(Date), 3);
    expect(executor.interrupt).toHaveBeenCalledWith(expect.objectContaining({ creationId: 'c9' }));
  });
});

describe('E2eExecutor.interrupt', () => {
  it('fails the run and closes its active tests, ignoring deleted runs', async () => {
    const store = new InMemoryE2eStore();
    const creation = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'ws',
      actorId: 'u',
      agentId: 'a',
      name: 'x',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://x',
      path: '/',
      username: null,
      passwordSecret: null,
      prd: 'p',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'en-US',
      repository: null,
    });
    await store.replaceTests(creation, [
      { title: 't', description: '', priority: 'low', steps: [] },
    ]);
    const executor = new E2eExecutor({ store } as never);
    await executor.interrupt({ workspaceId: 'ws', creationId: creation.id });
    expect(await store.getCreation('ws', creation.id)).toMatchObject({
      status: 'failed',
      error: 'The backend restarted during the run. Run it again.',
    });
    expect((await store.listTests('ws', creation.id))[0]?.status).toBe('error');
    await expect(
      executor.interrupt({ workspaceId: 'ws', creationId: 'gone' }),
    ).resolves.toBeUndefined();

    // A job cancelled before it started does nothing.
    const aborted = new AbortController();
    aborted.abort();
    await executor.run(
      { workspaceId: 'ws', creationId: creation.id, kind: 'generate' } as E2eJob,
      aborted.signal,
    );
    expect((await store.getCreation('ws', creation.id))?.status).toBe('failed');
  });

  it('leaves idle runs alone and stores nothing when an exploration is cancelled', async () => {
    const store = new InMemoryE2eStore();
    const artifacts = new InMemoryE2eArtifactStore();
    const creation = await store.createCreation({
      workspaceId: 'ws',
      ownerId: 'ws',
      actorId: 'u',
      agentId: 'a',
      name: 'x',
      mode: 'frontend',
      scope: 'codebase',
      baseUrl: 'http://x',
      path: '/',
      username: null,
      passwordSecret: null,
      prd: 'p',
      prdFileNames: [],
      diff: null,
      instructions: null,
      locale: 'en-US',
      repository: null,
      status: 'draft',
    });
    const aborted = new AbortController();
    const runner = {
      explore: vi.fn(() => {
        aborted.abort();
        return Promise.resolve({ startUrl: 'http://x/', pages: [] });
      }),
    };
    const executor = new E2eExecutor({ store, artifacts, runner } as never);
    await executor.interrupt({ workspaceId: 'ws', creationId: creation.id });
    expect((await store.getCreation('ws', creation.id))?.status).toBe('draft');
    await executor.run(
      { workspaceId: 'ws', creationId: creation.id, kind: 'explore' } as E2eJob,
      aborted.signal,
    );
    expect(runner.explore).toHaveBeenCalledOnce();
    expect(await artifacts.get(snapshotKey(creation))).toBeNull();
  });
});

describe('dispatchers', () => {
  it('wakes an in-process worker', async () => {
    const worker = { wake: vi.fn() };
    await new LocalE2eDispatcher(worker).wake();
    expect(worker.wake).toHaveBeenCalledOnce();
  });

  it('wakes a remote worker with its token and retries transient failures', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('booting'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    const dispatcher = new HttpE2eDispatcher({
      url: 'https://worker.test/',
      token: 'secret-token-123456',
      fetcher: fetcher as unknown as typeof fetch,
      retryDelayMs: 1,
    });
    await dispatcher.wake();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher).toHaveBeenCalledWith(
      'https://worker.test/wake',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: 'Bearer secret-token-123456' },
      }),
    );
  });

  it('gives up after the last attempt and on a rejected token', async () => {
    const down = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      new HttpE2eDispatcher({
        url: 'https://worker.test',
        token: 't',
        fetcher: down as unknown as typeof fetch,
        attempts: 2,
        retryDelayMs: 1,
      }).wake(),
    ).rejects.toThrow('offline');
    expect(down).toHaveBeenCalledTimes(2);

    const unauthorized = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    await expect(
      new HttpE2eDispatcher({
        url: 'https://worker.test',
        token: 't',
        fetcher: unauthorized as unknown as typeof fetch,
      }).wake(),
    ).rejects.toThrow('Worker answered HTTP 401');
    expect(unauthorized).toHaveBeenCalledOnce();

    // Defaults: global fetch and a 2s backoff while a sleeping worker boots.
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('booting'))
        .mockResolvedValue(new Response('', { status: 202 })),
    );
    const woke = new HttpE2eDispatcher({ url: 'https://worker.test', token: 't' }).wake();
    await vi.advanceTimersByTimeAsync(2_000);
    await woke;
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

describe('worker HTTP app', () => {
  it('wakes the worker only with the right token and reports health', async () => {
    const worker = {
      wake: vi.fn(),
      status: { workerId: 'w', active: 1, draining: true },
    };
    const app = createE2eWorkerApp(worker, 'secret-token-123456');
    expect((await request(app).get('/health').expect(200)).body).toEqual({
      status: 'ok',
      workerId: 'w',
      active: 1,
      draining: true,
    });
    await request(app).post('/wake').expect(401);
    await request(app).post('/wake').set('authorization', 'Bearer wrong').expect(401);
    expect(worker.wake).not.toHaveBeenCalled();
    const woke = await request(app)
      .post('/wake')
      .set('authorization', 'Bearer secret-token-123456')
      .expect(202);
    expect(woke.body).toMatchObject({ status: 'waking', active: 1 });
    expect(worker.wake).toHaveBeenCalledOnce();
  });
});
