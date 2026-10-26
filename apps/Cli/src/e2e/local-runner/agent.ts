import {
  E2eRunnerError,
  type E2eRunInput,
  type E2eRunResult,
  type E2eSnapshot,
} from '../../vendor/backend/modules/e2e/application/e2e-runner.js';
import type { AccessServiceToken } from '../../vendor/backend/modules/e2e/application/access-routing.js';
import type { E2eMode } from '../../vendor/backend/modules/e2e/domain/e2e-mode.js';
import { checkScript } from '../../vendor/backend/modules/e2e/application/script-guard.js';
import type { RunnerIdentity } from './playwright-setup.js';

interface RunnerApiRequest {
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly body?: unknown;
  readonly rawBody?: { readonly data: Uint8Array; readonly contentType: string };
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

interface RunnerApi {
  request<T = unknown>(request: RunnerApiRequest): Promise<T>;
}

interface AdkApiErrorLike extends Error {
  readonly status: number;
  readonly code: string;
}

function isAdkApiError(error: unknown): error is AdkApiErrorLike {
  return (
    error instanceof Error &&
    error.name === 'AdkApiError' &&
    'status' in error &&
    typeof error.status === 'number' &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

function segment(value: string): string {
  if (!value || value === '.' || value === '..') throw new Error(`Invalid identifier: "${value}".`);
  return encodeURIComponent(value);
}

/** The part of the Playwright runner the agent drives. */
export interface LocalBrowser {
  run(input: E2eRunInput): Promise<E2eRunResult>;
  explore(input: {
    mode: E2eMode;
    url: string;
    signal?: AbortSignal;
    accessToken?: AccessServiceToken | null;
  }): Promise<E2eSnapshot>;
}

export type RunnerTaskInput =
  | {
      readonly kind: 'run';
      readonly script: string;
      readonly mode: E2eMode;
      readonly baseUrl: string;
      readonly locale: string;
      readonly credentials: { readonly username: string | null; readonly password: string | null };
      readonly accessToken: AccessServiceToken | null;
    }
  | {
      readonly kind: 'explore';
      readonly mode: E2eMode;
      readonly url: string;
      readonly accessToken: AccessServiceToken | null;
    };

export interface ClaimedTask {
  readonly id: string;
  readonly kind: 'run' | 'explore';
  readonly creationId: string;
  readonly testId: string | null;
  readonly label: { readonly run: string; readonly test: string | null };
  readonly input: RunnerTaskInput;
}

/** Local settings that win over the run's saved ones on this computer. */
export interface LocalOverrides {
  /** Origin to test instead of the saved one, e.g. http://localhost:8014. */
  readonly baseUrl?: string;
  readonly username?: string;
  readonly password?: string;
}

export type RunnerEvent =
  | { readonly type: 'claimed'; readonly task: ClaimedTask }
  | {
      readonly type: 'finished';
      readonly task: ClaimedTask;
      readonly status: 'passed' | 'failed';
      readonly durationMs: number;
      readonly error: string | null;
    }
  | { readonly type: 'explored'; readonly task: ClaimedTask }
  | { readonly type: 'failed'; readonly task: ClaimedTask; readonly message: string }
  | { readonly type: 'cancelled'; readonly task: ClaimedTask }
  | { readonly type: 'offline'; readonly message: string; readonly retryInMs: number };

export interface LocalRunnerAgentOptions {
  readonly api: RunnerApi;
  readonly browser: LocalBrowser;
  readonly identity: RunnerIdentity;
  readonly overrides?: LocalOverrides;
  readonly heartbeatMs?: number;
  readonly onEvent?: (event: RunnerEvent) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Codes the ADK API accepts from a runner; anything else is reported as a runner failure. */
const REPORTED_CODES = new Set([
  'E2E_BROWSER_NOT_INSTALLED',
  'E2E_TARGET_UNREACHABLE',
  'E2E_RUNNER_FAILED',
]);
const MAX_MESSAGE = 20_000;
const MAX_LOGS = 70_000;

/**
 * Executes the signed-in user's ADK tasks on this computer. Every connection is outbound
 * HTTPS: the agent long-polls for work, runs Playwright locally against the app (localhost
 * included), and uploads the result and evidence to ADK, where the run continues.
 */
export class LocalRunnerAgent {
  private readonly heartbeatMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  public constructor(private readonly options: LocalRunnerAgentOptions) {
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.sleep = options.sleep ?? wait;
  }

  /** Claims and executes one task; null when none arrived within the wait. */
  public async poll(
    options: {
      readonly creationId?: string;
      readonly waitSeconds?: number;
      /** Stops the browser of the task in progress, e.g. on Ctrl+C. */
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ClaimedTask | null> {
    const waitSeconds = options.waitSeconds ?? 20;
    const { task } = await this.options.api.request<{ task: ClaimedTask | null }>({
      method: 'POST',
      path: '/e2e/runner/claim',
      body: {
        runner: this.options.identity,
        waitSeconds,
        ...(options.creationId ? { creationId: options.creationId } : {}),
      },
      timeoutMs: (waitSeconds + 30) * 1_000,
    });
    if (!task) return null;
    this.emit({ type: 'claimed', task });
    await this.execute(task, options.signal);
    return task;
  }

  /**
   * Serves tasks until the signal aborts or `done` says to stop. Connection problems are
   * retried with backoff; a sign-in or permission problem ends the loop.
   */
  public async serve(
    options: {
      readonly creationId?: string;
      readonly waitSeconds?: number;
      readonly signal?: AbortSignal;
      readonly done?: () => Promise<boolean>;
    } = {},
  ): Promise<void> {
    let backoff = 0;
    while (!options.signal?.aborted) {
      try {
        await this.poll({
          ...(options.creationId ? { creationId: options.creationId } : {}),
          ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        backoff = 0;
        if (await options.done?.()) return;
      } catch (error) {
        if (isAdkApiError(error) && [401, 403].includes(error.status)) throw error;
        backoff = Math.min(backoff ? backoff * 2 : 2_000, 30_000);
        this.emit({ type: 'offline', message: describe(error), retryInMs: backoff });
        await this.sleep(backoff, options.signal);
      }
    }
  }

  private async execute(task: ClaimedTask, stop?: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    stop?.addEventListener('abort', abort, { once: true });
    const beat = setInterval(() => {
      void this.heartbeat(task)
        .then((status) => {
          if (status === 'cancelled') controller.abort();
        })
        // A missed heartbeat is retried on the next tick; ADK waits a minute before giving up.
        .catch(() => undefined);
    }, this.heartbeatMs);
    try {
      if (task.input.kind === 'explore') await this.explore(task, task.input, controller.signal);
      else await this.run(task, task.input, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || isGone(error)) {
        this.emit({ type: 'cancelled', task });
        return;
      }
      const message = describe(error);
      const code =
        error instanceof E2eRunnerError && REPORTED_CODES.has(error.code)
          ? error.code
          : 'E2E_RUNNER_FAILED';
      await this.complete(task, { kind: 'error', code, message: message.slice(0, MAX_MESSAGE) })
        .then(() => this.emit({ type: 'failed', task, message }))
        .catch((reason: unknown) => {
          if (!isGone(reason)) throw reason;
          this.emit({ type: 'cancelled', task });
        });
    } finally {
      clearInterval(beat);
      stop?.removeEventListener('abort', abort);
    }
  }

  private async explore(
    task: ClaimedTask,
    input: Extract<RunnerTaskInput, { kind: 'explore' }>,
    signal: AbortSignal,
  ): Promise<void> {
    const target = this.target(input.url, input.accessToken);
    const snapshot = await this.options.browser.explore({
      mode: input.mode,
      url: target.url,
      accessToken: target.accessToken,
      signal,
    });
    if (signal.aborted) throw new Cancelled();
    await this.complete(task, { kind: 'explore', snapshot });
    this.emit({ type: 'explored', task });
  }

  private async run(
    task: ClaimedTask,
    input: Extract<RunnerTaskInput, { kind: 'run' }>,
    signal: AbortSignal,
  ): Promise<void> {
    // Same rules as the ADK workers: the spec stays inside the browser-automation surface.
    const check = checkScript(input.script);
    if (!check.ok) {
      const message = check.violations.join('; ');
      await this.complete(task, {
        kind: 'error',
        code: 'E2E_SCRIPT_REJECTED',
        message: message.slice(0, MAX_MESSAGE),
      });
      this.emit({ type: 'failed', task, message });
      return;
    }
    const { overrides } = this.options;
    const target = this.target(input.baseUrl, input.accessToken);
    const result = await this.options.browser.run({
      script: input.script,
      mode: input.mode,
      baseUrl: new URL(target.url).origin,
      localOrigin: null,
      locale: input.locale,
      credentials: {
        username: overrides?.username ?? input.credentials.username,
        password: overrides?.password ?? input.credentials.password,
      },
      accessToken: target.accessToken,
      signal,
    });
    if (signal.aborted) throw new Cancelled();
    if (result.video) await this.upload(task, 'video.webm', result.video, 'video/webm');
    for (const step of result.steps)
      if (step.screenshot)
        await this.upload(
          task,
          `step-${String(step.position).padStart(2, '0')}.png`,
          step.screenshot,
          'image/png',
        );
    await this.complete(task, {
      kind: 'run',
      status: result.status,
      durationMs: Math.round(result.durationMs),
      error: result.error?.slice(0, MAX_MESSAGE) ?? null,
      logs: result.logs.slice(-MAX_LOGS),
      steps: result.steps.map((step) => ({
        position: step.position,
        title: step.title.slice(0, 500),
        status: step.status,
        durationMs: Math.round(step.durationMs),
        error: step.error?.slice(0, MAX_MESSAGE) ?? null,
        hasScreenshot: Boolean(step.screenshot),
      })),
      hasVideo: Boolean(result.video),
    });
    this.emit({
      type: 'finished',
      task,
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
    });
  }

  /** Applies the local base URL; the saved token belongs to the saved address only. */
  private target(
    url: string,
    accessToken: AccessServiceToken | null,
  ): { url: string; accessToken: AccessServiceToken | null } {
    const override = this.options.overrides?.baseUrl;
    if (!override) return { url, accessToken };
    const saved = new URL(url);
    return {
      url: new URL(`${saved.pathname}${saved.search}`, new URL(override).origin).toString(),
      accessToken: null,
    };
  }

  private async heartbeat(task: ClaimedTask): Promise<'running' | 'cancelled'> {
    const { status } = await this.options.api.request<{ status: 'running' | 'cancelled' }>({
      method: 'POST',
      path: `/e2e/runner/tasks/${segment(task.id)}/heartbeat`,
      body: { runner: this.options.identity },
    });
    return status;
  }

  private async upload(
    task: ClaimedTask,
    name: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.options.api.request({
      method: 'PUT',
      path: `/e2e/runner/tasks/${segment(task.id)}/artifacts/${segment(name)}`,
      rawBody: { data, contentType },
      headers: { 'x-adk-runner-id': this.options.identity.id },
      timeoutMs: 300_000,
    });
  }

  private async complete(task: ClaimedTask, outcome: Record<string, unknown>): Promise<void> {
    await this.options.api.request({
      method: 'POST',
      path: `/e2e/runner/tasks/${segment(task.id)}/complete`,
      body: { runnerId: this.options.identity.id, outcome },
    });
  }

  private emit(event: RunnerEvent): void {
    this.options.onEvent?.(event);
  }
}

class Cancelled extends Error {}

/** ADK removed the task: the run was cancelled or the worker stopped waiting. */
function isGone(error: unknown): boolean {
  return (
    error instanceof Cancelled ||
    (isAdkApiError(error) && error.code === 'E2E_RUNNER_TASK_NOT_FOUND')
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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

/** One terminal line per runner event. */
export function formatRunnerEvent(event: RunnerEvent): string {
  switch (event.type) {
    case 'claimed':
      return event.task.kind === 'explore'
        ? `▶ Exploring the application for "${event.task.label.run}"`
        : `▶ ${event.task.label.test ?? 'Test'} ("${event.task.label.run}")`;
    case 'finished': {
      const time = `${(event.durationMs / 1000).toFixed(1)}s`;
      return event.status === 'passed'
        ? `  ✔ passed in ${time}`
        : `  ✖ failed in ${time}${event.error ? `: ${event.error.split('\n')[0]}` : ''}`;
    }
    case 'explored':
      return '  ✔ snapshot sent to ADK';
    case 'failed':
      return `  ✖ ${event.message.split('\n')[0]}`;
    case 'cancelled':
      return '  ■ stopped: the run was cancelled in ADK';
    case 'offline':
      return `ADK unavailable (${event.message}). Retrying in ${Math.round(event.retryInMs / 1000)}s.`;
  }
}
