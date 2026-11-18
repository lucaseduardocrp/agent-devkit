import crypto from 'node:crypto';

export type E2eJobKind = 'generate' | 'execute' | 'explore' | 'publish' | 'document';
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

/** The scope of the jobs that explore the application: it is no test's id, so it never equals one. */
export const EXPLORE_SCOPE = 'explore';

/**
 * What a job occupies in its run: the single test an `execute` job runs, 'explore' for the
 * exploration of the application (a test can be rewritten while it goes on), or the whole run ('')
 * for planning, publishing, documenting and executions of several tests.
 */
export function jobScope(job: Pick<E2eJob, 'kind' | 'testIds'>): string {
  if (job.kind === 'explore') return EXPLORE_SCOPE;
  return job.kind === 'execute' && job.testIds.length === 1 ? job.testIds[0]! : '';
}

/** Two jobs of one run collide when either takes the whole run or both take the same test. */
export function scopesCollide(a: string, b: string): boolean {
  return a === '' || b === '' || a === b;
}

export interface ActiveJobFilter {
  /** Only the jobs that keep this test from being changed: its own and those of the whole run. */
  readonly testId?: string;
  /** Ignores this job, so a running job can ask whether others are still working on the run. */
  readonly exceptJobId?: string;
}

/**
 * Durable work queue shared by the API (producer) and any number of workers (consumers).
 * A run has at most one queued or running job per scope: its tests run again independently of
 * each other, but a test never runs twice at once.
 */
export interface E2eJobQueue {
  /** Null when the job's scope in the creation is already taken by an active job. */
  enqueue(input: NewE2eJob): Promise<E2eJob | null>;
  hasActive(workspaceId: string, creationId: string, filter?: ActiveJobFilter): Promise<boolean>;
  /** Atomically takes the oldest queued job, or null when there is nothing to do. */
  claim(workerId: string): Promise<E2eJob | null>;
  /** Keeps a running job alive; false when it was cancelled, deleted or taken over. */
  heartbeat(jobId: string, workerId: string): Promise<boolean>;
  finish(jobId: string, workerId: string, status: 'succeeded' | 'failed'): Promise<void>;
  /** Cancels the creation's active jobs; false when it had none. */
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
    const scope = jobScope(input);
    if (this.active(input.creationId).some((job) => scopesCollide(jobScope(job), scope)))
      return Promise.resolve(null);
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

  hasActive(
    workspaceId: string,
    creationId: string,
    filter: ActiveJobFilter = {},
  ): Promise<boolean> {
    return Promise.resolve(
      this.active(creationId).some(
        (job) =>
          job.workspaceId === workspaceId &&
          job.id !== filter.exceptJobId &&
          (filter.testId === undefined || scopesCollide(jobScope(job), filter.testId)),
      ),
    );
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
    const jobs = this.active(creationId).filter((job) => job.workspaceId === workspaceId);
    for (const job of jobs) this.jobs.set(job.id, { ...job, status: 'cancelled' });
    return Promise.resolve(jobs.length > 0);
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

  private active(creationId: string): E2eJob[] {
    return [...this.jobs.values()].filter(
      (job) => job.creationId === creationId && ACTIVE.has(job.status),
    );
  }
}
