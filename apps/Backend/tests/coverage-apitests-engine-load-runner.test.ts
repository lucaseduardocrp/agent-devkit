import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const executeRequest = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/apitests/engine/http-request.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/apitests/engine/http-request.js')>()),
  executeRequest,
}));

const { runLoad } = await import('../src/modules/apitests/engine/load-runner.js');
import type {
  ApiRequestSpec,
  LoadPlan,
  LoadThreshold,
  RequestResult,
} from '../src/modules/apitests/engine/types.js';

const spec = (id: string): ApiRequestSpec => ({
  id,
  type: 'request',
  name: `Request ${id}`,
  method: 'GET',
  url: 'https://api.example.test/x',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
});

/** Reaches `vus` after a second, so users exist as soon as the controller looks. */
const steady = (durationSec: number, vus: number) => [
  { durationSec: 1, targetVus: vus },
  { durationSec: durationSec - 1, targetVus: vus },
];

const plan = (extra: Partial<LoadPlan> = {}): LoadPlan => ({
  requests: [{ request: spec('a'), auth: { type: 'none' }, weight: 1 }],
  variables: [],
  stages: steady(3, 2),
  thinkTimeMs: 0,
  thresholds: [],
  ...extra,
});

const result = (extra: Partial<RequestResult> = {}): RequestResult => ({
  requestId: 'a',
  name: 'a',
  path: [],
  method: 'GET',
  url: 'https://api.example.test/x',
  status: 200,
  durationMs: 10,
  sizeBytes: 1,
  passed: true,
  assertions: [],
  ...extra,
});

/** Answers after `ms` of (fake) time, so virtual users never spin on microtasks. */
const answer = (ms: number, value: () => RequestResult) => () =>
  new Promise<RequestResult>((resolve) => setTimeout(() => resolve(value()), ms));

beforeEach(() => {
  executeRequest.mockReset();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const finish = async (promise: Promise<unknown>, ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
};

describe('runLoad', () => {
  it('needs at least one request', async () => {
    await expect(runLoad(plan({ requests: [] }))).rejects.toThrow(
      'A load test needs at least one request.',
    );
  });

  it('evaluates every metric and operator of the thresholds', async () => {
    const durations = [5, 70_000, -3, 20];
    let call = 0;
    executeRequest.mockImplementation(
      answer(10, () =>
        result({
          durationMs: durations[call++ % durations.length]!,
          assertions: [
            { id: '1', label: 'ok', passed: true },
            { id: '2', label: 'bad', passed: call % 2 === 0 },
          ],
        }),
      ),
    );
    const metrics = [
      'min',
      'avg',
      'p50',
      'p90',
      'p95',
      'p99',
      'max',
      'errorRate',
      'rps',
      'checksRate',
    ] as const;
    const operators = ['lt', 'lte', 'gt', 'gte'] as const;
    const thresholds: LoadThreshold[] = metrics.map((metric, index) => ({
      metric,
      operator: operators[index % operators.length]!,
      value: 1,
    }));
    const summary = (await finish(
      runLoad(plan({ thresholds, stages: steady(2, 2) }), {
        controlMs: 50,
        tickMs: 500,
      }),
      4_000,
    )) as Awaited<ReturnType<typeof runLoad>>;
    expect(summary.thresholds.map((item) => item.metric)).toEqual([...metrics]);
    expect(summary.thresholds.map((item) => item.passed)).toEqual([
      true, // min lt 1: min is 0 (clamped negative)
      false, // avg lte 1
      true, // p50 gt 1
      true, // p90 gte 1
      false, // p95 lt 1
      false, // p99 lte 1
      true, // max gt 1
      false, // errorRate gte 1
      false, // rps lt 1 (many requests per second)
      true, // checksRate lte 1
    ]);
    expect(summary.latency.max).toBe(70_000);
    expect(summary.latency.p99).toBe(60_000);
    expect(summary.latency.min).toBe(0);
    expect(summary.totalRequests).toBeGreaterThan(4);
    expect(summary.checks.passed).toBeGreaterThan(0);
    expect(summary.checks.failed).toBeGreaterThan(0);
    expect(summary.passed).toBe(false);
    expect(summary.abortedBy).toBeUndefined();
  });

  it('reports empty runs without dividing by zero', async () => {
    const summary = await finish(
      runLoad(
        plan({
          stages: [{ durationSec: 1, targetVus: 0 }],
          thresholds: [
            { metric: 'errorRate', operator: 'lt', value: 1 },
            { metric: 'checksRate', operator: 'gte', value: 1 },
            { metric: 'avg', operator: 'lt', value: 1 },
            { metric: 'p95', operator: 'lt', value: 1 },
          ],
        }),
        { controlMs: 100, tickMs: 500 },
      ),
      2_000,
    );
    expect(executeRequest).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      totalRequests: 0,
      errorRate: 0,
      latency: { min: 0, avg: 0, p50: 0, max: 0 },
      passed: true,
    });
  });

  it('records failures by status and reason and aborts a failing threshold after 10 seconds', async () => {
    const results = [
      result({ status: 500, error: 'server said no', durationMs: 20 }),
      result({ status: null, error: 'x'.repeat(200), durationMs: 5, passed: false }),
      result({ status: 404, durationMs: 7 }),
      result({ status: null, durationMs: 7, passed: false }),
    ];
    let call = 0;
    executeRequest.mockImplementation(answer(50, () => results[call++ % results.length]!));
    const ticks: number[] = [];
    const summary = await finish(
      runLoad(
        plan({
          stages: steady(60, 2),
          thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.1, abortOnFail: true }],
        }),
        { controlMs: 100, tickMs: 1_000, onTick: (tick) => void ticks.push(tick.t) },
      ),
      15_000,
    );
    expect(summary.abortedBy).toBe('errorRate');
    expect(summary.durationSec).toBeGreaterThanOrEqual(10);
    expect(summary.durationSec).toBeLessThan(13);
    expect(summary.statusCodes).toMatchObject({
      '500': expect.any(Number),
      error: expect.any(Number),
    });
    expect(summary.errors['server said no']).toBeGreaterThan(0);
    expect(summary.errors['x'.repeat(120)]).toBeGreaterThan(0);
    expect(summary.errors['HTTP 404']).toBeGreaterThan(0);
    expect(summary.errors['HTTP null']).toBeGreaterThan(0);
    expect(summary.failedRequests).toBe(summary.totalRequests);
    expect(summary.perRequest[0]).toMatchObject({ requestId: 'a', failed: summary.totalRequests });
    expect(ticks.length).toBeGreaterThanOrEqual(10);
  });

  it('does not abort a threshold that holds, even with abortOnFail, and keeps the first failure', async () => {
    executeRequest.mockImplementation(answer(100, () => result({ status: 500, durationMs: 1 })));
    const summary = await finish(
      runLoad(
        plan({
          stages: steady(14, 1),
          thresholds: [
            { metric: 'p95', operator: 'lt', value: 1_000, abortOnFail: true },
            { metric: 'errorRate', operator: 'lt', value: 0.1, abortOnFail: true },
            { metric: 'max', operator: 'lt', value: 0.5, abortOnFail: true },
          ],
        }),
        { controlMs: 100, tickMs: 1_000 },
      ),
      16_000,
    );
    // The first broken threshold (in plan order) is the one that stopped the run.
    expect(summary.abortedBy).toBe('errorRate');
  });

  it('stops when the signal is aborted, during a request or during think time', async () => {
    const before = new AbortController();
    before.abort();
    const early = await runLoad(plan(), { signal: before.signal });
    expect(early.totalRequests).toBe(0);
    expect(executeRequest).not.toHaveBeenCalled();

    // Cut by the end of the test while a request is in flight: not a result.
    const during = new AbortController();
    executeRequest.mockImplementationOnce(async () => {
      during.abort();
      return result({ status: null, error: 'aborted', passed: false });
    });
    const cut = (await finish(
      runLoad(plan({ thinkTimeMs: 50 }), { signal: during.signal, controlMs: 10 }),
      2_000,
    )) as Awaited<ReturnType<typeof runLoad>>;
    expect(cut.totalRequests).toBe(0);

    // Aborted right after a request finished: counted, and the think time is skipped.
    const after = new AbortController();
    executeRequest.mockImplementationOnce(async () => {
      after.abort();
      return result();
    });
    const counted = (await finish(
      runLoad(plan({ thinkTimeMs: 60_000 }), { signal: after.signal, controlMs: 10 }),
      2_000,
    )) as Awaited<ReturnType<typeof runLoad>>;
    expect(counted.totalRequests).toBe(1);

    // Aborted while waiting out the think time.
    const sleeping = new AbortController();
    executeRequest.mockImplementation(answer(10, () => result()));
    const promise = runLoad(plan({ thinkTimeMs: 60_000 }), {
      signal: sleeping.signal,
      controlMs: 10,
      maxVus: 1,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    sleeping.abort();
    expect((await promise).totalRequests).toBe(1);
  });

  it('keeps going when a tick listener fails', async () => {
    executeRequest.mockImplementation(answer(100, () => result()));
    const onTick = vi.fn(() => Promise.reject(new Error('listener down')));
    const summary = await finish(
      runLoad(plan({ stages: steady(2, 1) }), {
        onTick,
        controlMs: 50,
        tickMs: 500,
      }),
      4_000,
    );
    expect(onTick).toHaveBeenCalled();
    expect(summary.totalRequests).toBeGreaterThan(0);
  });

  it('never runs more virtual users than allowed', async () => {
    executeRequest.mockImplementation(answer(100, () => result()));
    const summary = await finish(
      runLoad(plan({ stages: steady(2, 50) }), {
        maxVus: 0,
        controlMs: 50,
        tickMs: 500,
      }),
      4_000,
    );
    expect(summary.maxVus).toBe(1);
  });
});
