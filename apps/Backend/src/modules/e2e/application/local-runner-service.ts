import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eStore } from './e2e-store.js';
import {
  decodeRunnerInput,
  RUNNER_VIDEO_NAME,
  runnerStepScreenshotName,
  runnerTaskPrefix,
} from './local-runner.js';
import type { E2eRunnerErrorCode } from './e2e-runner.js';
import type {
  E2eLocalRunner,
  E2eRunnerIdentity,
  E2eRunnerOutcome,
  E2eRunnerStepOutcome,
  E2eRunnerTask,
  E2eRunnerTaskInput,
  E2eRunnerTaskKind,
  E2eRunnerTaskStore,
} from './runner-tasks.js';

/** A runner that claimed or renewed a task within this window is shown as online. */
export const RUNNER_ONLINE_MS = 60_000;
/** Queued tasks older than this lost their worker (it gives up after five minutes). */
const CLAIMABLE_MS = 10 * 60_000;
/** Runners not seen for this long are not listed at all. */
const LISTED_MS = 24 * 60 * 60_000;

export const MAX_RUNNER_VIDEO_BYTES = 55 * 1024 * 1024;
export const MAX_RUNNER_SCREENSHOT_BYTES = 6 * 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBM = [0x1a, 0x45, 0xdf, 0xa3];
const STEP_SCREENSHOT = /^step-(\d{2})\.png$/;

export interface ClaimedRunnerTask {
  readonly id: string;
  readonly kind: E2eRunnerTaskKind;
  readonly creationId: string;
  readonly testId: string | null;
  /** Human-readable names for the runner's output. */
  readonly label: { readonly run: string; readonly test: string | null };
  readonly input: E2eRunnerTaskInput;
}

export type RunnerCompletion =
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
  | {
      readonly kind: 'error';
      readonly code: E2eRunnerErrorCode | 'E2E_SCRIPT_REJECTED';
      readonly message: string;
    };

export interface E2eLocalRunnerServiceOptions {
  readonly tasks: E2eRunnerTaskStore;
  readonly artifacts: E2eArtifactStore;
  readonly store: Pick<E2eStore, 'getCreation' | 'getTest'>;
  /** How often a waiting claim checks for new work. */
  readonly pollMs?: number;
  readonly now?: () => number;
}

/**
 * The HTTPS side of `devkit runner`: the runner long-polls for its user's tasks, keeps
 * them alive, uploads the evidence and reports the outcome. Every call is scoped to the
 * signed-in user and workspace, so a runner only ever sees its own user's work.
 */
export class E2eLocalRunnerService {
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly options: E2eLocalRunnerServiceOptions) {
    this.pollMs = options.pollMs ?? 1_500;
    this.now = options.now ?? Date.now;
  }

  async runners(
    context: RequestContext,
  ): Promise<(E2eLocalRunner & { readonly online: boolean })[]> {
    const { workspaceId, userId } = scope(context);
    const now = this.now();
    const runners = await this.options.tasks.listRunners(
      workspaceId,
      userId,
      new Date(now - LISTED_MS),
    );
    return runners.map((runner) => ({
      ...runner,
      online: now - runner.lastSeenAt.getTime() <= RUNNER_ONLINE_MS,
    }));
  }

  /** Waits up to `waitMs` for a task of the signed-in user; null when there is none. */
  async claim(
    context: RequestContext,
    runner: E2eRunnerIdentity,
    options: {
      readonly creationId?: string;
      readonly waitMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<ClaimedRunnerTask | null> {
    const { workspaceId, userId } = scope(context);
    const { tasks } = this.options;
    const deadline = this.now() + options.waitMs;
    await tasks.seen({ ...runner, workspaceId, userId });
    for (;;) {
      const task = await tasks.claim(
        {
          workspaceId,
          userId,
          createdAfter: new Date(this.now() - CLAIMABLE_MS),
          ...(options.creationId ? { creationId: options.creationId } : {}),
        },
        { id: runner.id, label: runnerLabel(runner) },
      );
      if (task) return this.describe(task);
      if (this.now() >= deadline || options.signal?.aborted) {
        // A long poll counts as presence for its whole duration.
        await tasks.seen({ ...runner, workspaceId, userId });
        return null;
      }
      await wait(Math.min(this.pollMs, deadline - this.now()), options.signal);
    }
  }

  /** Renews a claimed task; `cancelled` tells the runner to stop the browser. */
  async heartbeat(
    context: RequestContext,
    taskId: string,
    runner: E2eRunnerIdentity,
  ): Promise<'running' | 'cancelled'> {
    const { workspaceId, userId } = scope(context);
    await this.options.tasks.seen({ ...runner, workspaceId, userId });
    const task = await this.options.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId || task.userId !== userId) return 'cancelled';
    const status = await this.options.tasks.heartbeat(taskId, runner.id);
    return status === 'running' ? 'running' : 'cancelled';
  }

  /** Stores one evidence file of a running task: the video or a step screenshot. */
  async uploadArtifact(
    context: RequestContext,
    taskId: string,
    runnerId: string,
    name: string,
    content: Uint8Array,
  ): Promise<void> {
    const task = await this.runningTask(context, taskId, runnerId);
    if (task.kind !== 'run' || !validArtifact(name, content))
      throw new ApplicationError('E2E_INVALID_ARTIFACT', 'Invalid evidence file.', 400, [{ name }]);
    await this.options.artifacts.put(`${runnerTaskPrefix(task)}/${name}`, content);
  }

  async complete(
    context: RequestContext,
    taskId: string,
    runnerId: string,
    completion: RunnerCompletion,
  ): Promise<void> {
    const task = await this.runningTask(context, taskId, runnerId);
    const outcome: E2eRunnerOutcome =
      completion.kind === 'error'
        ? { kind: 'error', code: completion.code }
        : completion.kind === 'explore'
          ? { kind: 'explore', snapshot: completion.snapshot }
          : {
              kind: 'run',
              status: completion.status,
              durationMs: completion.durationMs,
              error: completion.error,
              logs: completion.logs,
              steps: completion.steps,
              hasVideo: completion.hasVideo,
            };
    if (completion.kind !== 'error' && completion.kind !== task.kind)
      throw new ApplicationError(
        'E2E_INVALID_ARTIFACT',
        'The result does not match the task.',
        400,
      );
    const stored = await this.options.tasks.complete(taskId, runnerId, {
      status: completion.kind === 'error' ? 'failed' : 'succeeded',
      result: JSON.stringify(outcome),
      error: completion.kind === 'error' ? completion.message : null,
    });
    if (!stored) throw taskNotFound();
  }

  private async describe(task: E2eRunnerTask): Promise<ClaimedRunnerTask> {
    const { store } = this.options;
    const [creation, test] = await Promise.all([
      store.getCreation(task.workspaceId, task.creationId),
      task.testId ? store.getTest(task.workspaceId, task.testId) : null,
    ]);
    return {
      id: task.id,
      kind: task.kind,
      creationId: task.creationId,
      testId: task.testId,
      label: {
        run: creation?.name ?? task.creationId,
        test: test ? `${test.code} - ${test.title}` : null,
      },
      input: decodeRunnerInput(task.payload),
    };
  }

  private async runningTask(
    context: RequestContext,
    taskId: string,
    runnerId: string,
  ): Promise<E2eRunnerTask> {
    const { workspaceId, userId } = scope(context);
    const task = await this.options.tasks.get(taskId);
    if (
      !task ||
      task.workspaceId !== workspaceId ||
      task.userId !== userId ||
      task.runnerId !== runnerId ||
      task.status !== 'running'
    )
      throw taskNotFound();
    return task;
  }
}

export function runnerLabel(runner: Pick<E2eRunnerIdentity, 'name' | 'platform'>): string {
  return `${runner.name} (${runner.platform})`;
}

function validArtifact(name: string, content: Uint8Array): boolean {
  if (name === RUNNER_VIDEO_NAME)
    return content.byteLength <= MAX_RUNNER_VIDEO_BYTES && startsWith(content, WEBM);
  const step = STEP_SCREENSHOT.exec(name);
  return (
    Boolean(step) &&
    name === runnerStepScreenshotName(Number(step![1])) &&
    content.byteLength <= MAX_RUNNER_SCREENSHOT_BYTES &&
    startsWith(content, PNG)
  );
}

function startsWith(content: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => content[index] === byte);
}

function scope(context: RequestContext): { workspaceId: string; userId: string } {
  if (!context.workspaceId)
    throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  if (!context.actorId) throw new ApplicationError('UNAUTHORIZED', 'Sign in to use a runner.', 401);
  return { workspaceId: context.workspaceId, userId: context.actorId };
}

function taskNotFound(): ApplicationError {
  return new ApplicationError('E2E_RUNNER_TASK_NOT_FOUND', 'Runner task not found.', 404);
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
