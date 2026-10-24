import { randomUUID } from 'node:crypto';
import type { ApiRun } from '../domain/api-test.js';
import { executeRun } from '../engine/run-executor.js';
import type { ApiTestService } from './api-test-service.js';
import { remoteTargetGuard } from './target-guard.js';

export interface ApiTestWorkerOptions {
  readonly service: Pick<
    ApiTestService,
    'claimRemote' | 'payloadOf' | 'heartbeat' | 'finish' | 'sweep'
  >;
  readonly workerId?: string;
  /** Runs executed at the same time by this worker instance. */
  readonly concurrency?: number;
  readonly heartbeatMs?: number;
  /** A running run without heartbeats for this long is considered abandoned. */
  readonly staleMs?: number;
  readonly maxAttempts?: number;
  /** Self-hosted setups may test services on their own private network. */
  readonly allowPrivateNetwork?: boolean;
  readonly fetch?: typeof fetch;
  /** Replaces the network guard (tests only). */
  readonly guard?: (url: URL) => Promise<void>;
  readonly onIdle?: () => void;
}

/**
 * Executes the remote integration and load runs. Like the E2E worker, it drains the queue when
 * woken and then stops querying, so an on-demand host can sleep.
 */
export class ApiTestWorker {
  readonly workerId: string;
  private readonly tasks = new Set<Promise<void>>();
  private draining: Promise<void> | null = null;
  private wakeRequested = false;

  constructor(private readonly options: ApiTestWorkerOptions) {
    this.workerId = options.workerId ?? `api-worker-${randomUUID()}`;
  }

  get status() {
    return { workerId: this.workerId, active: this.tasks.size, draining: Boolean(this.draining) };
  }

  wake(): void {
    this.wakeRequested = true;
    if (this.draining) return;
    this.draining = this.drain()
      .catch((error: unknown) => console.error('[ApiTestWorker] Drain failed:', error))
      .finally(() => {
        this.draining = null;
        if (this.wakeRequested) this.wake();
        else this.options.onIdle?.();
      });
  }

  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private async drain(): Promise<void> {
    this.wakeRequested = false;
    await this.options.service.sweep(
      new Date(Date.now() - (this.options.staleMs ?? 120_000)),
      this.options.maxAttempts ?? 2,
    );
    await this.fill();
    while (this.tasks.size) {
      await Promise.race(this.tasks);
      await this.fill();
    }
  }

  private async fill(): Promise<void> {
    while (this.tasks.size < Math.max(1, this.options.concurrency ?? 2)) {
      const run = await this.options.service.claimRemote(this.workerId);
      if (!run) return;
      const task: Promise<void> = this.process(run).finally(() => this.tasks.delete(task));
      this.tasks.add(task);
    }
  }

  private async process(run: ApiRun): Promise<void> {
    const { service } = this.options;
    let outcome;
    try {
      outcome = await executeRun(service.payloadOf(run), {
        heartbeatMs: this.options.heartbeatMs ?? 5_000,
        report: async (partial) =>
          (await service.heartbeat(run.id, this.workerId, partial)) === 'running'
            ? 'running'
            : 'stopped',
        guard:
          this.options.guard ??
          remoteTargetGuard({ allowPrivateNetwork: this.options.allowPrivateNetwork }),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    } catch (error) {
      outcome = {
        status: 'error' as const,
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // A cancelled run is not overwritten: finish only applies to runs this worker still holds.
    await service.finish(run.id, this.workerId, outcome).catch((error: unknown) => {
      console.error('[ApiTestWorker] Could not finish run:', error);
    });
  }
}
