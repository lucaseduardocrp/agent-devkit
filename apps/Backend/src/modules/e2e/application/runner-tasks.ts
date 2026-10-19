import crypto from 'node:crypto';
import type { E2eMode } from '../domain/e2e-mode.js';
import type { AccessServiceToken } from './access-routing.js';
import type { E2eCredentials, E2eRunnerErrorCode } from './e2e-runner.js';

/**
 * Browser work a worker delegates to a user's local runner (`devkit runner`).
 * The worker keeps orchestrating (AI planning, healing, analysis, publishing); the runner
 * only executes Playwright on the user's computer and reports back over HTTPS.
 */
export type E2eRunnerTaskKind = 'run' | 'explore';
/** Tasks that end any other way (cancelled run, timeout) are deleted instead. */
export type E2eRunnerTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface E2eRunnerTask {
  readonly id: string;
  readonly workspaceId: string;
  readonly creationId: string;
  readonly testId: string | null;
  /** Only runners signed in as this user may claim the task. */
  readonly userId: string;
  readonly kind: E2eRunnerTaskKind;
  /** Encrypted {@link E2eRunnerTaskInput}; cleared once the task ends. */
  readonly payload: string;
  readonly status: E2eRunnerTaskStatus;
  readonly runnerId: string | null;
  readonly runnerLabel: string | null;
  /** JSON {@link E2eRunnerOutcome} reported by the runner. */
  readonly result: string | null;
  readonly error: string | null;
  readonly heartbeatAt: Date | null;
  readonly createdAt: Date;
}

export type NewE2eRunnerTask = Pick<
  E2eRunnerTask,
  'workspaceId' | 'creationId' | 'testId' | 'userId' | 'kind' | 'payload'
>;

/** What the runner receives when it claims a task. Secrets travel only inside this payload. */
export type E2eRunnerTaskInput =
  | {
      readonly kind: 'run';
      readonly script: string;
      readonly mode: E2eMode;
      readonly baseUrl: string;
      readonly locale: string;
      readonly credentials: E2eCredentials;
      readonly accessToken: AccessServiceToken | null;
    }
  | {
      readonly kind: 'explore';
      readonly mode: E2eMode;
      readonly url: string;
      readonly accessToken: AccessServiceToken | null;
    };

/** One top-level step as reported by the runner; screenshots are uploaded separately. */
export interface E2eRunnerStepOutcome {
  readonly position: number;
  readonly title: string;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error: string | null;
  readonly hasScreenshot: boolean;
}

/** Stored in the task's `result` column when the runner finishes. */
export type E2eRunnerOutcome =
  | {
      readonly kind: 'run';
      readonly status: 'passed' | 'failed';
      readonly durationMs: number;
      readonly error: string | null;
      readonly logs: string;
      readonly steps: readonly E2eRunnerStepOutcome[];
      readonly hasVideo: boolean;
    }
  | { readonly kind: 'explore'; readonly snapshot: unknown }
  | { readonly kind: 'error'; readonly code: E2eRunnerErrorCode | 'E2E_SCRIPT_REJECTED' };

export interface E2eRunnerIdentity {
  /** Stable id of the CLI installation on one computer. */
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
}

export interface E2eLocalRunner extends E2eRunnerIdentity {
  readonly lastSeenAt: Date;
}

export interface E2eRunnerTaskStore {
  create(input: NewE2eRunnerTask): Promise<E2eRunnerTask>;
  get(id: string): Promise<E2eRunnerTask | null>;
  /**
   * Atomically takes the user's oldest queued task, optionally only from one run. Tasks
   * created before `createdAfter` are skipped: their worker stopped waiting for them.
   */
  claim(
    scope: {
      readonly workspaceId: string;
      readonly userId: string;
      readonly creationId?: string;
      readonly createdAfter: Date;
    },
    runner: { readonly id: string; readonly label: string },
  ): Promise<E2eRunnerTask | null>;
  /** Keeps a claimed task alive and returns its status; null when it is gone or not this runner's. */
  heartbeat(id: string, runnerId: string): Promise<E2eRunnerTaskStatus | null>;
  /** Records the outcome of a running task claimed by this runner; false otherwise. */
  complete(
    id: string,
    runnerId: string,
    outcome: {
      readonly status: 'succeeded' | 'failed';
      readonly result: string;
      readonly error: string | null;
    },
  ): Promise<boolean>;
  /** Deletes the task; a runner still working on it learns from its next heartbeat. */
  remove(id: string): Promise<void>;
  /** Records that a runner is connected, so ADK can show it as online. */
  seen(
    runner: E2eRunnerIdentity & { readonly workspaceId: string; readonly userId: string },
  ): Promise<void>;
  listRunners(workspaceId: string, userId: string, since: Date): Promise<E2eLocalRunner[]>;
}

export class InMemoryE2eRunnerTaskStore implements E2eRunnerTaskStore {
  private readonly tasks = new Map<string, E2eRunnerTask>();
  private readonly runners = new Map<
    string,
    E2eLocalRunner & { workspaceId: string; userId: string }
  >();

  create(input: NewE2eRunnerTask): Promise<E2eRunnerTask> {
    const task: E2eRunnerTask = {
      ...input,
      id: crypto.randomUUID(),
      status: 'queued',
      runnerId: null,
      runnerLabel: null,
      result: null,
      error: null,
      heartbeatAt: null,
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);
    return Promise.resolve(task);
  }

  get(id: string): Promise<E2eRunnerTask | null> {
    return Promise.resolve(this.tasks.get(id) ?? null);
  }

  claim(
    scope: { workspaceId: string; userId: string; creationId?: string; createdAfter: Date },
    runner: { id: string; label: string },
  ): Promise<E2eRunnerTask | null> {
    const next = [...this.tasks.values()]
      .filter(
        (task) =>
          task.status === 'queued' &&
          task.createdAt >= scope.createdAfter &&
          task.workspaceId === scope.workspaceId &&
          task.userId === scope.userId &&
          (!scope.creationId || task.creationId === scope.creationId),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (!next) return Promise.resolve(null);
    const claimed: E2eRunnerTask = {
      ...next,
      status: 'running',
      runnerId: runner.id,
      runnerLabel: runner.label,
      heartbeatAt: new Date(),
    };
    this.tasks.set(claimed.id, claimed);
    return Promise.resolve(claimed);
  }

  heartbeat(id: string, runnerId: string): Promise<E2eRunnerTaskStatus | null> {
    const task = this.tasks.get(id);
    if (!task || task.runnerId !== runnerId) return Promise.resolve(null);
    if (task.status === 'running') this.tasks.set(id, { ...task, heartbeatAt: new Date() });
    return Promise.resolve(task.status);
  }

  complete(
    id: string,
    runnerId: string,
    outcome: { status: 'succeeded' | 'failed'; result: string; error: string | null },
  ): Promise<boolean> {
    const task = this.tasks.get(id);
    if (task?.status !== 'running' || task.runnerId !== runnerId) return Promise.resolve(false);
    this.tasks.set(id, { ...task, ...outcome, payload: '' });
    return Promise.resolve(true);
  }

  remove(id: string): Promise<void> {
    this.tasks.delete(id);
    return Promise.resolve();
  }

  seen(runner: E2eRunnerIdentity & { workspaceId: string; userId: string }): Promise<void> {
    this.runners.set(`${runner.id}:${runner.workspaceId}`, { ...runner, lastSeenAt: new Date() });
    return Promise.resolve();
  }

  listRunners(workspaceId: string, userId: string, since: Date): Promise<E2eLocalRunner[]> {
    return Promise.resolve(
      [...this.runners.values()]
        .filter(
          (runner) =>
            runner.workspaceId === workspaceId &&
            runner.userId === userId &&
            runner.lastSeenAt >= since,
        )
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map(({ id, name, platform, version, lastSeenAt }) => ({
          id,
          name,
          platform,
          version,
          lastSeenAt,
        })),
    );
  }
}
