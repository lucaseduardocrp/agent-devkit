import crypto from 'node:crypto';

export type E2eJobKind = 'generate' | 'execute' | 'explore' | 'publish';
export type E2eJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** One unit of work for a worker: plan + run a creation, or rerun some of its tests. */
export interface E2eJob {
  id: string;
  workspaceId: string;
  creationId: string;
  kind: E2eJobKind;
  /** Tests to run for `execute` jobs; empty for `generate`. */
  testIds: string[];
  status: E2eJobStatus;
  attempts: number;
  workerId: string | null;
  heartbeatAt: Date | null;
  /** User who started the job; a local run's browser work goes to that user's runner. */
  requestedBy: string | null;
  createdAt: Date;
}

export type NewE2eJob = Pick<E2eJob, 'workspaceId' | 'creationId' | 'kind' | 'testIds'> & {
  readonly requestedBy?: string | null;
};

/**
 * Durable work queue shared by the API (producer) and any number of workers (consumers).
 * A creation has at most one queued or running job, so its tests never run twice at once.
 */
export interface E2eJobQueue {
  /** Null when the creation already has an active job. */
  enqueue(input: NewE2eJob): Promise<E2eJob | null>;
  hasActive(workspaceId: string, creationId: string): Promise<boolean>;
  /** Atomically takes the oldest queued job, or null when there is nothing to do. */
  claim(workerId: string): Promise<E2eJob | null>;
  /** Keeps a running job alive; false when it was cancelled, deleted or taken over. */
  heartbeat(jobId: string, workerId: string): Promise<boolean>;
  finish(jobId: string, workerId: string, status: 'succeeded' | 'failed'): Promise<void>;
  /** Cancels the creation's active job; false when it had none. */
  cancel(workspaceId: string, creationId: string): Promise<boolean>;
  /**
   * Running jobs whose worker stopped sending heartbeats go back to the queue, or fail
   * once they used up their attempts.
   */
  sweep(staleBefore: Date, maxAttempts: number): Promise<{ requeued: E2eJob[]; failed: E2eJob[] }>;
}

const ACTIVE = new Set<E2eJobStatus>(['queued', 'running']);

export class InMemoryE2eJobQueue implements E2eJobQueue {
  private readonly jobs = new Map<string, E2eJob>();

  enqueue(input: NewE2eJob): Promise<E2eJob | null> {
    if (this.active(input.creationId)) return Promise.resolve(null);
    const job: E2eJob = {
      ...input,
      testIds: [...input.testIds],
      requestedBy: input.requestedBy ?? null,
      id: crypto.randomUUID(),
      status: 'queued',
      attempts: 0,
      workerId: null,
      heartbeatAt: null,
      createdAt: new Date(),
    };
    this.jobs.set(job.id, job);
    return Promise.resolve(job);
  }

  hasActive(workspaceId: string, creationId: string): Promise<boolean> {
    const job = this.active(creationId);
    return Promise.resolve(job?.workspaceId === workspaceId);
  }

  claim(workerId: string): Promise<E2eJob | null> {
    const next = [...this.jobs.values()]
      .filter((job) => job.status === 'queued')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!next) return Promise.resolve(null);
    const claimed = {
      ...next,
      status: 'running' as const,
      workerId,
      heartbeatAt: new Date(),
      attempts: next.attempts + 1,
    };
    this.jobs.set(claimed.id, claimed);
    return Promise.resolve(claimed);
  }

  heartbeat(jobId: string, workerId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job?.status !== 'running' || job.workerId !== workerId) return Promise.resolve(false);
    this.jobs.set(jobId, { ...job, heartbeatAt: new Date() });
    return Promise.resolve(true);
  }

  finish(jobId: string, workerId: string, status: 'succeeded' | 'failed'): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job?.status === 'running' && job.workerId === workerId)
      this.jobs.set(jobId, { ...job, status });
    return Promise.resolve();
  }

  cancel(workspaceId: string, creationId: string): Promise<boolean> {
    const job = this.active(creationId);
    if (job?.workspaceId !== workspaceId) return Promise.resolve(false);
    this.jobs.set(job.id, { ...job, status: 'cancelled' });
    return Promise.resolve(true);
  }

  sweep(staleBefore: Date, maxAttempts: number) {
    const requeued: E2eJob[] = [];
    const failed: E2eJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' || Number(job.heartbeatAt) >= staleBefore.getTime()) continue;
      const next: E2eJob =
        job.attempts >= maxAttempts
          ? { ...job, status: 'failed' }
          : { ...job, status: 'queued', workerId: null, heartbeatAt: null };
      this.jobs.set(job.id, next);
      (next.status === 'failed' ? failed : requeued).push(next);
    }
    return Promise.resolve({ requeued, failed });
  }

  private active(creationId: string): E2eJob | undefined {
    return [...this.jobs.values()].find(
      (job) => job.creationId === creationId && ACTIVE.has(job.status),
    );
  }
}
