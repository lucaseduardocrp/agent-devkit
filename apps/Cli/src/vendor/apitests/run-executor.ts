import { describeGrpc, runCollectionWithState, selectRequests } from './collection-runner.js';
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
  /** Maps the host connected to (host access of a local install: localhost → the host alias). */
  readonly connectHost?: (hostname: string) => string;
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
    ...(hooks.connectHost ? { connectHost: hooks.connectHost } : {}),
  };
  const run = async (): Promise<RunOutcome> => {
    if (payload.kind === 'integration' && payload.mode === 'grpc-reflect') {
      return await reflect(payload, common);
    }
    if (payload.kind === 'integration') {
      const done: RequestResult[] = [];
      const started = performance.now();
      const { result, runtime } = await runCollectionWithState(payload.collection, {
        ...common,
        environment: payload.environment,
        ...(payload.environmentName ? { environmentName: payload.environmentName } : {}),
        itemIds: payload.itemIds,
        bail: payload.bail,
        ...(payload.runtime ? { runtime: payload.runtime } : {}),
        ...(payload.iterations ? { iterations: payload.iterations } : {}),
        ...(payload.data ? { data: payload.data } : {}),
        ...(payload.delayMs ? { delayMs: payload.delayMs } : {}),
        ...(payload.previewBytes ? { previewBytes: payload.previewBytes } : {}),
        onResult: (result, _index, total) => {
          done.push(result);
          const passed = done.filter((item) => item.passed && !item.skipped).length;
          const skipped = done.filter((item) => item.skipped).length;
          partial = {
            durationMs: Math.round(performance.now() - started),
            total,
            passed,
            failed: done.length - passed - skipped,
            ...(skipped ? { skipped } : {}),
            results: [...done],
          };
        },
      });
      return { status: result.failed ? 'failed' : 'passed', result, error: null, runtime };
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

/** Lists a gRPC request's services; the list is the result's body, as JSON. */
async function reflect(
  payload: Extract<RunPayload, { kind: 'integration' }>,
  common: Pick<RunHooks, 'fetch' | 'guard' | 'connectHost'> & { readonly signal: AbortSignal },
): Promise<RunOutcome> {
  const started = performance.now();
  const entry = selectRequests(payload.collection, payload.itemIds)[0];
  if (!entry) throw new Error('There is no gRPC request to describe.');
  const base = {
    requestId: entry.request.id,
    name: entry.request.name,
    kind: 'grpc' as const,
    path: entry.path,
    method: entry.request.method,
    url: entry.request.url,
    sizeBytes: 0,
    assertions: [],
  };
  let result: RequestResult;
  try {
    const list = await describeGrpc(payload.collection, entry.request.id, {
      ...common,
      environment: payload.environment,
      ...(payload.runtime ? { runtime: payload.runtime } : {}),
    });
    const body = JSON.stringify(list);
    result = {
      ...base,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      sizeBytes: body.length,
      passed: true,
      response: { headers: {}, bodyPreview: body },
    };
  } catch (error) {
    result = {
      ...base,
      status: null,
      durationMs: Math.round(performance.now() - started),
      passed: false,
      // describeGrpc only ever rejects with a real Error: application throws use `new Error`,
      // and the network layer normalizes everything through `toError`.
      /* v8 ignore next */
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    status: result.passed ? 'passed' : 'failed',
    result: {
      durationMs: result.durationMs,
      total: 1,
      passed: result.passed ? 1 : 0,
      failed: result.passed ? 0 : 1,
      results: [result],
    },
    error: null,
  };
}
