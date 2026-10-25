import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLoad } from '../src/modules/apitests/engine/load-runner.js';
import type { ApiRequestSpec, LoadPlan } from '../src/modules/apitests/engine/types.js';

const request = (id: string): ApiRequestSpec => ({
  id,
  type: 'request',
  name: id,
  method: 'GET',
  url: `http://api.test/${id}`,
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
});

const plan = (overrides: Partial<LoadPlan> = {}): LoadPlan => ({
  requests: [{ request: request('a'), auth: { type: 'none' }, weight: 1 }],
  variables: [],
  stages: [{ durationSec: 60, targetVus: 2 }],
  thinkTimeMs: 1,
  thresholds: [],
  ...overrides,
});

/** Moves `performance.now()` forward, to reach the 10 s mark without waiting. */
function shiftClock() {
  const real = performance.now.bind(performance);
  const clock = { offset: 0 };
  vi.spyOn(performance, 'now').mockImplementation(() => real() + clock.offset);
  return clock;
}

afterEach(() => vi.restoreAllMocks());

describe('runLoad edges', () => {
  it('refuses a plan without requests', async () => {
    await expect(runLoad(plan({ requests: [] }))).rejects.toThrow(/at least one request/);
  });

  it('returns an empty summary when cancelled before it starts', async () => {
    const summary = await runLoad(
      plan({
        thresholds: [
          { metric: 'errorRate', operator: 'lte', value: 0 },
          { metric: 'rps', operator: 'gte', value: 0 },
          { metric: 'checksRate', operator: 'gt', value: 0.5 },
          { metric: 'avg', operator: 'lt', value: 1 },
        ],
      }),
      { signal: AbortSignal.abort() },
    );
    expect(summary).toMatchObject({ totalRequests: 0, maxVus: 0, errorRate: 0, timeline: [] });
    expect(summary.latency).toEqual({ min: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
    expect(summary.thresholds.map((threshold) => threshold.actual)).toEqual([0, 0, 1, 0]);
    expect(summary.passed).toBe(true);
    expect(summary.abortedBy).toBeUndefined();
  });

  it('stops after 10 s when a threshold marked abortOnFail fails', async () => {
    const clock = shiftClock();
    const guard = vi.fn(async () => undefined);
    // Answers after a while whatever the signal says, so requests end after the stop too.
    const fetch = vi.fn(async () => {
      clock.offset = 10_000;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response('down', { status: 500 });
    });
    const summary = await runLoad(
      plan({
        timeoutMs: 5_000,
        requests: [
          {
            request: {
              ...request('a'),
              assertions: [{ id: 'c', source: 'status', operator: 'eq', expected: '200' }],
            },
            auth: { type: 'none' },
            weight: 1,
          },
        ],
        thresholds: [
          { metric: 'rps', operator: 'gt', value: 0, abortOnFail: true },
          { metric: 'errorRate', operator: 'lt', value: 0.5, abortOnFail: true },
          { metric: 'checksRate', operator: 'gte', value: 1 },
          { metric: 'p50', operator: 'lte', value: 100_000 },
        ],
      }),
      { fetch: fetch as unknown as typeof globalThis.fetch, guard, tickMs: 10, controlMs: 5 },
    );
    expect(summary.abortedBy).toBe('errorRate');
    expect(summary.statusCodes['500']).toBe(summary.totalRequests);
    expect(summary.errors).toEqual({ 'HTTP 500': summary.totalRequests });
    expect(summary.checks.failed).toBe(summary.totalRequests);
    expect(summary.thresholds.map((threshold) => threshold.passed)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect(guard).toHaveBeenCalled();
    expect(summary.timeline.length).toBeGreaterThan(0);
  });

  it('shares traffic equally without weights, counts network errors and drops cut requests', async () => {
    const clock = shiftClock();
    clock.offset = 0;
    // A roll at the very top of the range lands on the last request.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    let calls = 0;
    const fetch: typeof globalThis.fetch = (_input, init) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('connection reset'));
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const controller = new AbortController();
    setTimeout(() => {
      clock.offset = 10_000;
      setTimeout(() => controller.abort(), 40);
    }, 30);
    const summary = await runLoad(
      plan({
        requests: [
          { request: request('a'), auth: { type: 'none' }, weight: 0 },
          { request: request('b'), auth: { type: 'none' }, weight: -1 },
        ],
        stages: [{ durationSec: 60, targetVus: 1 }],
        thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.5 }],
      }),
      { fetch, signal: controller.signal, tickMs: 10, controlMs: 5 },
    );
    expect(summary.totalRequests).toBe(1);
    expect(summary.statusCodes).toEqual({ error: 1 });
    expect(summary.errors).toEqual({ 'connection reset': 1 });
    expect(summary.perRequest.map((entry) => entry.count)).toEqual([0, 1]);
    // The threshold fails but does not abort the run: the cancel ended it.
    expect(summary.abortedBy).toBeUndefined();
    expect(summary.passed).toBe(false);
  });
});
