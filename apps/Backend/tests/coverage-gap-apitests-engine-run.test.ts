import { afterEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

import {
  isBlockedHostname,
  isPrivateAddress,
  remoteTargetGuard,
} from '../src/modules/apitests/application/target-guard.js';
import { runCollection, selectRequests } from '../src/modules/apitests/engine/collection-runner.js';
import { executeRun } from '../src/modules/apitests/engine/run-executor.js';
import type {
  ApiRequestSpec,
  CollectionRunResult,
  CollectionSpec,
  LoadSummary,
  RunPayload,
} from '../src/modules/apitests/engine/types.js';

const request = (id: string, overrides: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
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
  ...overrides,
});

const status = (code: string) => [
  { id: 's', source: 'status' as const, operator: 'eq' as const, expected: code },
];

const okFetch = (delayMs = 0): typeof fetch =>
  vi.fn(async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response('ok', { status: 200 });
  });

afterEach(() => {
  lookup.mockReset();
});

describe('collection runner edges', () => {
  const collection: CollectionSpec = {
    name: 'C',
    variables: [],
    auth: { type: 'inherit' },
    items: [
      {
        id: 'f1',
        type: 'folder',
        name: 'Inherits',
        auth: { type: 'inherit' },
        items: [
          request('r1'),
          request('r2', { auth: { type: 'basic', username: 'u', password: 'p' } }),
        ],
      },
      { id: 'f2', type: 'folder', name: 'No auth field', items: [request('r3')] },
    ],
  };

  it('resolves auth through folders and the collection', () => {
    expect(selectRequests(collection).map((entry) => [entry.request.id, entry.auth.type])).toEqual([
      ['r1', 'none'],
      ['r2', 'basic'],
      ['r3', 'none'],
    ]);
    expect(selectRequests(collection, ['r2', 'f2']).map((entry) => entry.request.id)).toEqual([
      'r2',
      'r3',
    ]);
  });

  it('pauses between requests and stops when cancelled', async () => {
    const started = performance.now();
    const paced = await runCollection(collection, { fetch: okFetch(), delayMs: 25 });
    expect(paced).toMatchObject({ total: 3, passed: 3 });
    // Two pauses: none after the last request.
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);

    const controller = new AbortController();
    const cancelled = await runCollection(collection, {
      fetch: okFetch(),
      signal: controller.signal,
      onResult: () => controller.abort(),
    });
    expect(cancelled).toMatchObject({ total: 3, passed: 1, failed: 0 });
  });
});

describe('executeRun', () => {
  const integration = (items: ApiRequestSpec[]): RunPayload => ({
    kind: 'integration',
    collection: { name: 'C', variables: [], auth: { type: 'none' }, items },
    environment: [],
    itemIds: [],
    bail: false,
  });

  it('runs a collection, reporting partial results and passing guard and fetch', async () => {
    const reports: (CollectionRunResult | LoadSummary | null)[] = [];
    const guard = vi.fn(async () => undefined);
    const outcome = await executeRun(
      integration([request('a', { assertions: status('200') }), request('b')]),
      {
        heartbeatMs: 5,
        fetch: okFetch(20),
        guard,
        report: async (partial) => {
          reports.push(partial);
          return 'running';
        },
      },
    );
    expect(outcome.status).toBe('passed');
    expect(outcome.error).toBeNull();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(reports.some((partial) => partial && 'results' in partial)).toBe(true);
  });

  it('marks a collection with failures as failed', async () => {
    const outcome = await executeRun(integration([request('a', { assertions: status('201') })]), {
      fetch: okFetch(),
      report: async () => 'running',
    });
    expect(outcome.status).toBe('failed');
    expect((outcome.result as CollectionRunResult).failed).toBe(1);
  });

  it('stops when the report says so, skipping beats while one is pending, and ignores report errors', async () => {
    let calls = 0;
    const outcome = await executeRun(
      integration(['a', 'b', 'c', 'd', 'e'].map((id) => request(id))),
      {
        heartbeatMs: 5,
        fetch: okFetch(15),
        signal: new AbortController().signal,
        report: async () => {
          calls += 1;
          if (calls === 1) throw new Error('network down');
          await new Promise((resolve) => setTimeout(resolve, 20));
          return 'stopped';
        },
      },
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    const result = outcome.result as CollectionRunResult;
    expect(result.results.length).toBeLessThan(5);
  });

  it('runs a load plan and reports the failing status', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 1_100);
    const payload: RunPayload = {
      kind: 'load',
      maxVus: 1,
      plan: {
        requests: [{ request: request('a'), auth: { type: 'none' }, weight: 1 }],
        variables: [],
        stages: [
          { durationSec: 0.001, targetVus: 5 },
          { durationSec: 60, targetVus: 5 },
        ],
        thinkTimeMs: 5,
        thresholds: [{ metric: 'rps', operator: 'gt', value: 1_000_000 }],
      },
    };
    const outcome = await executeRun(payload, {
      fetch: okFetch(),
      signal: controller.signal,
      report: async () => 'running',
    });
    expect(outcome.status).toBe('failed');
    expect((outcome.result as LoadSummary).maxVus).toBe(1);

    const passing = await executeRun(
      { ...payload, plan: { ...payload.plan, thresholds: [] } },
      { fetch: okFetch(), signal: AbortSignal.abort(), report: async () => 'running' },
    );
    expect(passing.status).toBe('passed');
  });

  it('turns thrown errors into an error outcome', async () => {
    const empty = await executeRun(
      {
        kind: 'load',
        maxVus: 1,
        plan: { requests: [], variables: [], stages: [], thinkTimeMs: 0, thresholds: [] },
      },
      { report: async () => 'running' },
    );
    expect(empty).toEqual({
      status: 'error',
      result: null,
      error: 'A load test needs at least one request.',
    });

    // A collection that throws something that is not an Error.
    const odd = await executeRun(
      {
        kind: 'integration',
        environment: [],
        itemIds: [],
        bail: false,
        collection: {
          name: 'C',
          variables: [],
          auth: { type: 'none' },
          get items(): never {
            throw 'broken collection';
          },
        },
      },
      { report: async () => 'running' },
    );
    expect(odd).toMatchObject({ status: 'error', error: 'broken collection' });
  });
});

describe('target guard', () => {
  it('blocks names and addresses of the machine itself', () => {
    expect(isBlockedHostname('LOCALHOST')).toBe(true);
    expect(isBlockedHostname('app.localhost')).toBe(true);
    expect(isBlockedHostname('[::1]')).toBe(true);
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('0.0.0.0')).toBe(true);
    expect(isBlockedHostname('169.254.169.254')).toBe(true);
    expect(isBlockedHostname('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHostname('fe80::1')).toBe(true);
    expect(isBlockedHostname('::')).toBe(true);
    expect(isBlockedHostname('169.1.0.1')).toBe(false);
    expect(isBlockedHostname('2001:db8::1')).toBe(false);
    expect(isBlockedHostname('example.com')).toBe(false);
  });

  it('recognizes private ranges', () => {
    for (const address of ['10.0.0.1', '172.16.0.1', '172.31.9.9', '192.168.1.1', '100.64.0.1']) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of [
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '100.63.0.1',
      '100.128.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('FC00::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
    // Not four valid octets: read as IPv6.
    expect(isPrivateAddress('1.2.3.999')).toBe(false);
  });

  it('checks resolved addresses once per host', async () => {
    const guard = remoteTargetGuard();
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(guard(new URL('https://example.com/a'))).resolves.toBeUndefined();
    await guard(new URL('https://example.com/b'));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true });

    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ]);
    await expect(guard(new URL('https://intranet.test/'))).rejects.toMatchObject({
      code: 'API_TEST_TARGET_LOCAL',
      statusCode: 400,
    });
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(guard(new URL('https://sneaky.test/'))).rejects.toThrow(/devkit runner/);
    await expect(guard(new URL('http://localhost:3000/'))).rejects.toThrow(/localhost/);
    // Literal addresses are not resolved.
    await expect(guard(new URL('http://[2001:db8::1]/'))).resolves.toBeUndefined();
    await expect(guard(new URL('http://192.168.0.2/'))).rejects.toThrow(/192\.168\.0\.2/);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('lets private networks through when allowed, and localhost through the host alias', async () => {
    const allowed = remoteTargetGuard({ allowPrivateNetwork: true });
    await expect(allowed(new URL('http://10.0.0.5/'))).resolves.toBeUndefined();
    await expect(allowed(new URL('http://127.0.0.1/'))).rejects.toThrow(/127\.0\.0\.1/);

    const aliased = remoteTargetGuard({ hostAlias: 'host.docker.internal' });
    await expect(aliased(new URL('http://localhost:5173/'))).resolves.toBeUndefined();
    await expect(aliased(new URL('http://192.168.0.9/'))).resolves.toBeUndefined();
    await expect(aliased(new URL('http://169.254.169.254/'))).rejects.toThrow(/169\.254/);
  });
});
