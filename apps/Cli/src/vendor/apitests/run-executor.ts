import { runCollection } from './collection-runner.js';
import { runLoad } from './load-runner.js';
import type {
  CollectionRunResult,
  LoadSummary,
  RequestResult,
  RunOutcome,
  RunPayload,
} from './types.js';

export interface RunHooks {
  /**
   * Sends the partial result; answers whether the run should go on. Called every
   * `heartbeatMs`; a cancelled or reassigned run stops at the next call.
   */
  readonly report: (
    partial: CollectionRunResult | LoadSummary | null,
  ) => Promise<'running' | 'stopped'>;
  readonly heartbeatMs?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly guard?: (url: URL) => Promise<void>;
}

/** Executes a run on a worker or on `devkit runner`, reporting progress until it ends. */
export async function executeRun(payload: RunPayload, hooks: RunHooks): Promise<RunOutcome> {
  const controller = new AbortController();
  const signal = hooks.signal
    ? AbortSignal.any([hooks.signal, controller.signal])
    : controller.signal;
  let partial: CollectionRunResult | LoadSummary | null = null;
  let reporting = false;
  const beat = setInterval(() => {
    if (reporting) return;
    reporting = true;
    hooks
      .report(partial)
      .then((state) => {
        if (state === 'stopped') controller.abort();
      })
      .catch(() => undefined)
      .finally(() => (reporting = false));
  }, hooks.heartbeatMs ?? 5_000);
  const common = {
    signal,
    ...(hooks.fetch ? { fetch: hooks.fetch } : {}),
    ...(hooks.guard ? { guard: hooks.guard } : {}),
  };
  const run = async (): Promise<RunOutcome> => {
    if (payload.kind === 'integration') {
      const done: RequestResult[] = [];
      const started = performance.now();
      const result = await runCollection(payload.collection, {
        ...common,
        environment: payload.environment,
        itemIds: payload.itemIds,
        bail: payload.bail,
        onResult: (result, _index, total) => {
          done.push(result);
          const passed = done.filter((item) => item.passed).length;
          partial = {
            durationMs: Math.round(performance.now() - started),
            total,
            passed,
            failed: done.length - passed,
            results: [...done],
          };
        },
      });
      return { status: result.failed ? 'failed' : 'passed', result, error: null };
    }
    const summary = await runLoad(payload.plan, {
      ...common,
      maxVus: payload.maxVus,
      onTick: (_tick, current) => {
        partial = current;
      },
    });
    return { status: summary.passed ? 'passed' : 'failed', result: summary, error: null };
  };
  // No finally: every path of the run returns, so a try/finally leaves a branch V8 never takes.
  const outcome = await run().catch((error: unknown): RunOutcome => ({
    status: 'error',
    result: partial,
    error: error instanceof Error ? error.message : String(error),
  }));
  clearInterval(beat);
  return outcome;
}
