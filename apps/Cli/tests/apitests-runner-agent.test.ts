import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ApiTestRunnerAgent,
  formatApiRunnerEvent,
  type ApiRunnerEvent,
  type ApiTestRunnerAgentOptions,
} from '../src/apitests/runner-agent.js';
import type { RunPayload } from '../src/vendor/apitests/types.js';

/** A rejection that is not an Error instance (e.g. thrown by code in another realm). */
const notAnError = (text: string): Error =>
  Object.assign({ name: 'Fault', message: '' }, { toString: () => text });

let base = '';
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 2_000);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const identity = { id: 'runner-12345', name: 'Laptop', platform: 'linux', version: '1.0.0' };

const integration = (url: string): RunPayload => ({
  kind: 'integration',
  collection: {
    name: 'Local API',
    variables: [{ key: 'base', value: base }],
    auth: { type: 'none' },
    items: [
      {
        id: 'r1',
        type: 'request',
        name: 'Health',
        method: 'GET',
        url,
        headers: [],
        query: [],
        body: { mode: 'none' },
        auth: { type: 'inherit' },
        assertions: [{ id: 'a', source: 'json', path: 'ok', operator: 'eq', expected: 'true' }],
        captures: [],
      },
    ],
  },
  environment: [],
  itemIds: [],
  bail: false,
});

function fakeApi(payload: RunPayload, heartbeatStatus = 'running') {
  const calls: { path: string; body?: unknown }[] = [];
  let claimed = false;
  const api = {
    request: vi.fn((request: { path: string; body?: unknown }) => {
      calls.push(request);
      if (request.path === '/api-tests/runner/claim') {
        if (claimed) return Promise.resolve({ run: null });
        claimed = true;
        return Promise.resolve({
          run: { id: 'run-1', kind: payload.kind, name: 'Local API', payload },
        });
      }
      if (request.path.endsWith('/heartbeat')) return Promise.resolve({ status: heartbeatStatus });
      return Promise.resolve({ saved: heartbeatStatus === 'running' });
    }),
  };
  return { api: api as unknown as ApiTestRunnerAgentOptions['api'], calls };
}

describe('devkit runner for API tests', () => {
  it('claims a local run, executes it against localhost and reports the result', async () => {
    const { api, calls } = fakeApi(integration('{{base}}/health'));
    const events: ApiRunnerEvent[] = [];
    const agent = new ApiTestRunnerAgent({ api, identity, onEvent: (event) => events.push(event) });
    expect((await agent.poll({ waitSeconds: 0 }))?.id).toBe('run-1');
    const complete = calls.find((call) => call.path === '/api-tests/runner/runs/run-1/complete');
    expect(complete?.body).toMatchObject({
      runnerId: identity.id,
      status: 'passed',
      error: null,
      result: { total: 1, passed: 1 },
    });
    expect(calls[0]!.body).toEqual({ runner: identity, waitSeconds: 0 });
    expect(events.map((event) => event.type)).toEqual(['claimed', 'finished']);
    expect(formatApiRunnerEvent(events[1]!)).toBe(
      '[devkit] API tests "Local API" passed: 1/1 requests passed.',
    );
    expect(await agent.poll({ waitSeconds: 0 })).toBeNull();
  });

  it('stops when ADK says the run was cancelled', async () => {
    const { api, calls } = fakeApi(integration(`${base}/slow`), 'cancelled');
    const events: ApiRunnerEvent[] = [];
    const agent = new ApiTestRunnerAgent({
      api,
      identity,
      heartbeatMs: 20,
      onEvent: (event) => events.push(event),
    });
    const started = Date.now();
    await agent.poll({ waitSeconds: 0 });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(calls.some((call) => call.path.endsWith('/heartbeat'))).toBe(true);
    expect(formatApiRunnerEvent(events[1]!)).toContain('(cancelled in ADK; result not saved)');
  });

  it('describes load results and retries when ADK is offline', async () => {
    expect(
      formatApiRunnerEvent({
        type: 'finished',
        run: { id: 'r', kind: 'load', name: 'Peak' },
        saved: true,
        outcome: {
          status: 'failed',
          error: null,
          result: {
            durationSec: 60,
            maxVus: 50,
            totalRequests: 1200,
            failedRequests: 30,
            errorRate: 0.025,
            rps: 20,
            latency: { min: 5, avg: 80, p50: 70, p90: 150, p95: 210, p99: 400, max: 900 },
            checks: { passed: 0, failed: 0 },
            statusCodes: {},
            errors: {},
            perRequest: [],
            thresholds: [],
            passed: false,
            timeline: [],
          },
        },
      }),
    ).toBe('[devkit] Load test "Peak" failed: 1200 requests, p95 210 ms, 2.50 % errors, 20 req/s.');

    const controller = new AbortController();
    const events: ApiRunnerEvent[] = [];
    const agent = new ApiTestRunnerAgent({
      api: { request: () => Promise.reject(new Error('ECONNREFUSED')) },
      identity,
      onEvent: (event) => events.push(event),
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    await agent.serve({ signal: controller.signal });
    expect(events).toEqual([{ type: 'offline', message: 'ECONNREFUSED', retryInMs: 2_000 }]);
  });
});

describe('devkit runner for API tests: serving and edge cases', () => {
  it('passes the abort signal and custom fetch to the run and keeps heartbeating while running', async () => {
    const { api, calls } = fakeApi(integration('{{base}}/slow'));
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, init),
    );
    const agent = new ApiTestRunnerAgent({ api, identity, heartbeatMs: 20, fetch: fetcher });
    await agent.poll({ waitSeconds: 0, signal: new AbortController().signal });
    expect(fetcher).toHaveBeenCalled();
    expect(calls.filter((call) => call.path.endsWith('/heartbeat')).length).toBeGreaterThan(1);
    expect(calls.at(-1)?.body).toMatchObject({ result: { total: 1 } });
  });

  it('serves runs, resets the backoff after success and stops on auth errors', async () => {
    let call = 0;
    const events: ApiRunnerEvent[] = [];
    const sleep = vi.fn(() => Promise.resolve());
    const agent = new ApiTestRunnerAgent({
      api: {
        request: () => {
          call += 1;
          if (call <= 2) return Promise.reject(notAnError('socket hang up'));
          if (call === 3) return Promise.resolve({ run: null });
          if (call === 4) return Promise.reject(new Error('reset'));
          return Promise.reject(Object.assign(new Error('Unauthorized'), { status: 401 }));
        },
      } as ApiTestRunnerAgentOptions['api'],
      identity,
      sleep,
      onEvent: (event) => events.push(event),
    });
    await expect(agent.serve()).rejects.toThrow('Unauthorized');
    expect(events).toEqual([
      { type: 'offline', message: 'socket hang up', retryInMs: 2_000 },
      { type: 'offline', message: 'socket hang up', retryInMs: 4_000 },
      { type: 'offline', message: 'reset', retryInMs: 2_000 },
    ]);
  });

  it('waits with the default sleep until the backoff ends or the signal aborts', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const events: ApiRunnerEvent[] = [];
      let calls = 0;
      const agent = new ApiTestRunnerAgent({
        api: {
          request: () => {
            calls += 1;
            return Promise.reject(new Error('offline'));
          },
        } as ApiTestRunnerAgentOptions['api'],
        identity,
        onEvent: (event) => events.push(event),
      });
      const serving = agent.serve({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toBe(2);
      controller.abort();
      await serving;
      expect(events.map((event) => event.type)).toEqual(['offline', 'offline']);

      // A signal aborted before the wait starts ends it at once.
      const fresh = new AbortController();
      const aborted = new ApiTestRunnerAgent({
        api: {
          request: () => {
            fresh.abort();
            return Promise.reject(new Error('offline'));
          },
        } as ApiTestRunnerAgentOptions['api'],
        identity,
      });
      await aborted.serve({ signal: fresh.signal });
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes claims, errors and outages', () => {
    const run = { id: 'r', kind: 'integration' as const, name: 'Smoke' };
    expect(formatApiRunnerEvent({ type: 'claimed', run })).toBe(
      '[devkit] API tests "Smoke" started on this computer.',
    );
    expect(
      formatApiRunnerEvent({
        type: 'finished',
        run,
        saved: true,
        outcome: { status: 'error', error: 'Bad URL', result: null },
      }),
    ).toBe('[devkit] API tests "Smoke" error: Bad URL.');
    expect(
      formatApiRunnerEvent({
        type: 'finished',
        run,
        saved: true,
        outcome: { status: 'failed', error: null, result: null },
      }),
    ).toBe('[devkit] API tests "Smoke" failed.');
    expect(formatApiRunnerEvent({ type: 'offline', message: 'down', retryInMs: 4_400 })).toBe(
      '[devkit] ADK is unreachable (down); retrying API test runs in 4 s.',
    );
  });
});
