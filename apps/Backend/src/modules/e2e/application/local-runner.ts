import { decryptSecret, encryptSecret } from '../../../shared/encryption.js';
import type { E2eArtifactStore } from './artifact-store.js';
import {
  E2eRunnerError,
  type E2eRunInput,
  type E2eRunResult,
  type E2eRunner,
  type E2eSnapshot,
  type E2eStepEvidence,
} from './e2e-runner.js';
import type {
  E2eRunnerOutcome,
  E2eRunnerTask,
  E2eRunnerTaskInput,
  E2eRunnerTaskKind,
  E2eRunnerTaskStore,
} from './runner-tasks.js';

export interface LocalE2eRunnerOptions {
  readonly tasks: E2eRunnerTaskStore;
  readonly artifacts: E2eArtifactStore;
  /** How often the worker checks the task while it waits. */
  readonly pollMs?: number;
  /** A task nobody claims in this time fails the run: the user's runner is not connected. */
  readonly claimTimeoutMs?: number;
  /** A claimed task without heartbeats for this long is treated as lost. */
  readonly staleMs?: number;
  /** Upper bound for one claimed task, on top of the runner's own Playwright timeout. */
  readonly runTimeoutMs?: number;
  readonly now?: () => number;
}

/** Whose computer runs the browser, and for which run and test. */
export interface LocalRunTarget {
  readonly workspaceId: string;
  readonly creationId: string;
  readonly testId: string | null;
  /** Only runners signed in as this user may claim the work. */
  readonly userId: string;
}

/** Folder of the evidence a runner uploads for one task; removed once the worker read it. */
export function runnerTaskPrefix(
  task: Pick<E2eRunnerTask, 'workspaceId' | 'creationId' | 'id'>,
): string {
  return `${task.workspaceId}/${task.creationId}/runner-tasks/${task.id}`;
}

export function runnerStepScreenshotName(position: number): string {
  return `step-${String(position).padStart(2, '0')}.png`;
}

export const RUNNER_VIDEO_NAME = 'video.webm';

export function encodeRunnerInput(input: E2eRunnerTaskInput): string {
  return encryptSecret(JSON.stringify(input));
}

export function decodeRunnerInput(payload: string): E2eRunnerTaskInput {
  return JSON.parse(decryptSecret(payload)) as E2eRunnerTaskInput;
}

class TaskAborted extends Error {}

/**
 * Runs the browser on the user's computer: each `run`/`explore` becomes a task that the
 * user's `devkit runner` claims over HTTPS (no inbound connection or tunnel). The worker
 * waits for the outcome and hands it to the executor like any other runner result.
 */
export class LocalE2eRunner {
  private readonly pollMs: number;
  private readonly claimTimeoutMs: number;
  private readonly staleMs: number;
  private readonly runTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: LocalE2eRunnerOptions) {
    this.pollMs = options.pollMs ?? 1_000;
    this.claimTimeoutMs = options.claimTimeoutMs ?? 5 * 60_000;
    this.staleMs = options.staleMs ?? 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** A runner bound to one user's computer and to the run (and test) it works for. */
  for(target: LocalRunTarget): E2eRunner {
    return {
      explore: async (input) => {
        const task = await this.delegate(
          target,
          'explore',
          {
            kind: 'explore',
            mode: input.mode,
            url: input.url,
            // Through a tunnel `url` is already the localhost origin; the token is the tunnel's.
            accessToken: input.transportUrl ? null : (input.accessToken ?? null),
          },
          input.signal,
        );
        const outcome = parseOutcome(task);
        await this.options.tasks.remove(task.id);
        if (outcome?.kind !== 'explore')
          throw new E2eRunnerError('E2E_RUNNER_FAILED', 'The local runner sent no snapshot.');
        return outcome.snapshot as E2eSnapshot;
      },
      run: async (input) => {
        const task = await this.delegate(target, 'run', runInput(input), input.signal);
        try {
          return await this.readRun(task);
        } finally {
          await this.options.artifacts.removePrefix(runnerTaskPrefix(task));
          await this.options.tasks.remove(task.id);
        }
      },
    };
  }

  private async readRun(task: E2eRunnerTask): Promise<E2eRunResult> {
    const outcome = parseOutcome(task);
    if (outcome?.kind !== 'run')
      throw new E2eRunnerError('E2E_RUNNER_FAILED', 'The local runner sent no test result.');
    const prefix = runnerTaskPrefix(task);
    const { artifacts } = this.options;
    const steps: E2eStepEvidence[] = [];
    for (const step of outcome.steps)
      steps.push({
        position: step.position,
        title: step.title,
        status: step.status,
        durationMs: step.durationMs,
        error: step.error,
        screenshot: step.hasScreenshot
          ? await artifacts.get(`${prefix}/${runnerStepScreenshotName(step.position)}`)
          : null,
      });
    return {
      status: outcome.status,
      durationMs: outcome.durationMs,
      error: outcome.error,
      logs: outcome.logs,
      video: outcome.hasVideo ? await artifacts.get(`${prefix}/${RUNNER_VIDEO_NAME}`) : null,
      steps,
      executedOn: task.runnerLabel,
    };
  }

  /** Creates the task and waits until the runner finishes it; throws on any other ending. */
  private async delegate(
    target: LocalRunTarget,
    kind: E2eRunnerTaskKind,
    input: E2eRunnerTaskInput,
    signal: AbortSignal | undefined,
  ): Promise<E2eRunnerTask> {
    const { tasks } = this.options;
    const created = await tasks.create({ ...target, kind, payload: encodeRunnerInput(input) });
    const startedAt = this.now();
    let claimedAt: number | null = null;
    // Staleness uses this worker's clock only: when it last saw the heartbeat change.
    let lastBeat: number | null = null;
    let lastBeatSeenAt = startedAt;
    try {
      for (;;) {
        if (signal?.aborted) throw new TaskAborted();
        const task = await tasks.get(created.id);
        if (!task) throw new TaskAborted();
        if (task.status === 'succeeded') return task;
        if (task.status === 'failed') throw failure(task);
        const now = this.now();
        if (task.status === 'queued' && now - startedAt > this.claimTimeoutMs)
          throw new E2eRunnerError(
            'E2E_LOCAL_RUNNER_UNAVAILABLE',
            'No local runner claimed the task.',
          );
        if (task.status === 'running') {
          claimedAt ??= now;
          const beat = task.heartbeatAt?.getTime() ?? 0;
          if (beat !== lastBeat) {
            lastBeat = beat;
            lastBeatSeenAt = now;
          }
          if (now - lastBeatSeenAt > this.staleMs)
            throw new E2eRunnerError(
              'E2E_LOCAL_RUNNER_LOST',
              'The local runner stopped responding.',
            );
          if (now - claimedAt > this.runTimeoutMs)
            throw new E2eRunnerError('E2E_RUNNER_FAILED', 'The local runner took too long.');
        }
        await wait(this.pollMs, signal);
      }
    } catch (error) {
      // A runner still working sees the task disappear on its next heartbeat and stops.
      await tasks.remove(created.id);
      await this.options.artifacts.removePrefix(runnerTaskPrefix(created));
      throw error instanceof TaskAborted ? new Error('Local run cancelled.') : error;
    }
  }
}

/** The runner reaches the app directly: a tunnel's localhost origin becomes the target. */
function runInput(input: E2eRunInput): E2eRunnerTaskInput {
  return {
    kind: 'run',
    script: input.script,
    mode: input.mode,
    baseUrl: input.localOrigin || input.baseUrl,
    locale: input.locale,
    credentials: input.credentials,
    accessToken: input.localOrigin ? null : (input.accessToken ?? null),
  };
}

function parseOutcome(task: E2eRunnerTask): E2eRunnerOutcome | null {
  if (!task.result) return null;
  try {
    return JSON.parse(task.result) as E2eRunnerOutcome;
  } catch {
    return null;
  }
}

function failure(task: E2eRunnerTask): Error {
  const outcome = parseOutcome(task);
  const message = task.error || 'The local runner failed.';
  if (outcome?.kind === 'error' && outcome.code !== 'E2E_SCRIPT_REJECTED')
    return new E2eRunnerError(outcome.code, message);
  return new E2eRunnerError('E2E_RUNNER_FAILED', message);
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
