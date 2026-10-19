import crypto from 'node:crypto';
import type { E2eJob, E2eJobQueue } from './e2e-queue.js';
import type { E2eExecutor } from './e2e-executor.js';

export interface E2eWorkerOptions {
  readonly queue: E2eJobQueue;
  readonly executor: Pick<E2eExecutor, 'run' | 'interrupt'>;
  readonly workerId?: string;
  /** Runs (from any users) executed in parallel by this worker instance. */
  readonly concurrency?: number;
  readonly heartbeatMs?: number;
  /** A running job without heartbeats for this long is considered abandoned. */
  readonly staleMs?: number;
  /** Claims per job before an abandoned job is failed instead of retried. */
  readonly maxAttempts?: number;
  /** Called whenever the worker runs out of work and stops touching the queue. */
  readonly onIdle?: () => void;
}

/**
 * Consumes the E2E queue on demand. `wake()` starts draining; once the queue is empty and
 * nothing is running, the worker stops issuing queries, so an on-demand host can sleep it.
 */
export class E2eWorker {
  readonly workerId: string;
  private readonly concurrency: number;
  private readonly heartbeatMs: number;
  private readonly staleMs: number;
  private readonly maxAttempts: number;
  private readonly tasks = new Set<Promise<void>>();
  private draining: Promise<void> | null = null;
  private wakeRequested = false;

  constructor(private readonly options: E2eWorkerOptions) {
    this.workerId = options.workerId ?? `worker-${crypto.randomUUID()}`;
    this.concurrency = Math.max(1, options.concurrency ?? 2);
    this.heartbeatMs = options.heartbeatMs ?? 5_000;
    this.staleMs = options.staleMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  get status() {
    return { workerId: this.workerId, active: this.tasks.size, draining: Boolean(this.draining) };
  }

  /** Starts (or keeps) draining the queue. Safe to call any number of times. */
  wake(): void {
    this.wakeRequested = true;
    if (this.draining) return;
    this.draining = this.drain()
      .catch((error: unknown) => console.error('[E2eWorker] Drain failed:', error))
      .finally(() => {
        this.draining = null;
        // Work enqueued during the last empty claim would otherwise wait for the next wake.
        if (this.wakeRequested) this.wake();
        else this.options.onIdle?.();
      });
  }

  /** Resolves once the worker has nothing left to do. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    this.wakeRequested = false;
    await this.sweep();
    await this.fill();
    while (this.tasks.size) {
      await Promise.race(this.tasks);
      await this.fill();
    }
  }

  private async fill(): Promise<void> {
    while (this.tasks.size < this.concurrency) {
      const job = await this.options.queue.claim(this.workerId);
      if (!job) return;
      const task: Promise<void> = this.process(job).finally(() => this.tasks.delete(task));
      this.tasks.add(task);
    }
  }

  private async sweep(): Promise<void> {
    const { failed } = await this.options.queue.sweep(
      new Date(Date.now() - this.staleMs),
      this.maxAttempts,
    );
    for (const job of failed) await this.options.executor.interrupt(job);
  }

  private async process(job: E2eJob): Promise<void> {
    const controller = new AbortController();
    const beat = setInterval(() => {
      this.options.queue
        .heartbeat(job.id, this.workerId)
        // Cancelled or deleted by the API: stop at the next step.
        .then((alive) => {
          if (!alive) controller.abort();
        })
        .catch((error: unknown) => console.error('[E2eWorker] Heartbeat failed:', error));
    }, this.heartbeatMs);
    let status: 'succeeded' | 'failed' = 'succeeded';
    try {
      await this.options.executor.run(job, controller.signal);
    } catch (error) {
      status = 'failed';
      console.error('[E2eWorker] Job failed:', error);
    } finally {
      clearInterval(beat);
    }
    await this.options.queue
      .finish(job.id, this.workerId, status)
      .catch((error: unknown) => console.error('[E2eWorker] Could not finish job:', error));
  }
}
