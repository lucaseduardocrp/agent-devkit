import type { RunnerIdentity } from '../e2e/local-runner/playwright-setup.js';
import { executeRun } from '../vendor/apitests/run-executor.js';
import type { RunOutcome, RunPayload } from '../vendor/apitests/types.js';

interface RunnerApi {
  request<T = unknown>(request: {
    readonly method: 'POST';
    readonly path: string;
    readonly body?: unknown;
    readonly timeoutMs?: number;
  }): Promise<T>;
}

interface ClaimedRun {
  readonly id: string;
  readonly kind: 'integration' | 'load';
  readonly name: string;
  readonly payload: RunPayload;
}

export type ApiRunnerEvent =
  | { readonly type: 'claimed'; readonly run: Pick<ClaimedRun, 'id' | 'kind' | 'name'> }
  | {
      readonly type: 'finished';
      readonly run: Pick<ClaimedRun, 'id' | 'kind' | 'name'>;
      readonly outcome: RunOutcome;
      readonly saved: boolean;
    }
  | { readonly type: 'offline'; readonly message: string; readonly retryInMs: number };

export interface ApiTestRunnerAgentOptions {
  readonly api: RunnerApi;
  readonly identity: RunnerIdentity;
  readonly heartbeatMs?: number;
  readonly onEvent?: (event: ApiRunnerEvent) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly fetch?: typeof fetch;
}

const isAuthError = (error: unknown) =>
  error instanceof Error &&
  'status' in error &&
  [401, 403].includes((error as { status: number }).status);

/**
 * Executes the signed-in user's local integration and load runs on this computer, so they reach
 * localhost and internal networks. Like the E2E agent, every connection is outbound HTTPS: it
 * long-polls for runs, reports progress while they execute and uploads the result.
 */
export class ApiTestRunnerAgent {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  public constructor(private readonly options: ApiTestRunnerAgentOptions) {
    this.sleep = options.sleep ?? wait;
  }

  /** Claims and executes one run; null when none arrived within the wait. */
  public async poll(
    options: { readonly waitSeconds?: number; readonly signal?: AbortSignal } = {},
  ) {
    const waitSeconds = options.waitSeconds ?? 20;
    const { run } = await this.options.api.request<{ run: ClaimedRun | null }>({
      method: 'POST',
      path: '/api-tests/runner/claim',
      body: { runner: this.options.identity, waitSeconds },
      timeoutMs: (waitSeconds + 30) * 1_000,
    });
    if (!run) return null;
    const summary = { id: run.id, kind: run.kind, name: run.name };
    this.options.onEvent?.({ type: 'claimed', run: summary });
    const outcome = await executeRun(run.payload, {
      heartbeatMs: this.options.heartbeatMs ?? 5_000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      report: async (partial) => {
        const { status } = await this.options.api.request<{ status: string }>({
          method: 'POST',
          path: `/api-tests/runner/runs/${encodeURIComponent(run.id)}/heartbeat`,
          body: { runnerId: this.options.identity.id, partial },
        });
        return status === 'running' ? 'running' : 'stopped';
      },
    });
    const { saved } = await this.options.api.request<{ saved: boolean }>({
      method: 'POST',
      path: `/api-tests/runner/runs/${encodeURIComponent(run.id)}/complete`,
      body: { runnerId: this.options.identity.id, ...outcome },
    });
    this.options.onEvent?.({ type: 'finished', run: summary, outcome, saved });
    return run;
  }

  /** Serves runs until the signal aborts; connection problems are retried with backoff. */
  public async serve(
    options: { readonly waitSeconds?: number; readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    let backoff = 0;
    while (!options.signal?.aborted) {
      try {
        await this.poll(options);
        backoff = 0;
      } catch (error) {
        if (isAuthError(error)) throw error;
        backoff = Math.min(backoff ? backoff * 2 : 2_000, 30_000);
        this.options.onEvent?.({
          type: 'offline',
          message: error instanceof Error ? error.message : String(error),
          retryInMs: backoff,
        });
        await this.sleep(backoff, options.signal);
      }
    }
  }
}

/** One line for the terminal. */
export function formatApiRunnerEvent(event: ApiRunnerEvent): string {
  const label = (run: { kind: string; name: string }) =>
    `${run.kind === 'load' ? 'Load test' : 'API tests'} "${run.name}"`;
  switch (event.type) {
    case 'claimed':
      return `[devkit] ${label(event.run)} started on this computer.`;
    case 'finished': {
      const { outcome } = event;
      const result = outcome.result;
      const detail = !result
        ? (outcome.error ?? '')
        : 'results' in result
          ? `${result.passed}/${result.total} requests passed`
          : `${result.totalRequests} requests, p95 ${result.latency.p95} ms, ${(result.errorRate * 100).toFixed(2)} % errors, ${result.rps} req/s`;
      return `[devkit] ${label(event.run)} ${outcome.status}${detail ? `: ${detail}` : ''}${event.saved ? '' : ' (cancelled in ADK; result not saved)'}.`;
    }
    case 'offline':
      return `[devkit] ADK is unreachable (${event.message}); retrying API test runs in ${Math.round(event.retryInMs / 1000)} s.`;
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
