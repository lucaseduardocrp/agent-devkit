import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCollection, selectRequests } from '../src/modules/apitests/engine/collection-runner.js';
import {
  fillPathParams,
  interpolate,
  prepareRequest,
  readJsonPath,
  scopeOf,
} from '../src/modules/apitests/engine/http-request.js';
import {
  profileStages,
  totalDuration,
  vusAt,
} from '../src/modules/apitests/engine/load-profiles.js';
import { runLoad } from '../src/modules/apitests/engine/load-runner.js';
import type { ApiRequestSpec, CollectionSpec } from '../src/modules/apitests/engine/types.js';

let base = '';
let server: http.Server;
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'r-1' });
        res.end(JSON.stringify({ token: 'super-secret-token', user: { id: 7, roles: ['qa'] } }));
      } else if (url.pathname === '/me') {
        const ok = req.headers.authorization === 'Bearer super-secret-token';
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(ok ? { id: 7, echo: url.searchParams.get('q') } : { error: 'nope' }),
        );
      } else if (url.pathname === '/slow') {
        setTimeout(() => res.end('late'), 300);
      } else if (url.pathname === '/flaky') {
        const fail = Math.random() < 0.5;
        res.writeHead(fail ? 500 : 200);
        res.end(fail ? 'boom' : 'ok');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const request = (
  overrides: Partial<ApiRequestSpec> & Pick<ApiRequestSpec, 'id' | 'url'>,
): ApiRequestSpec => ({
  type: 'request',
  name: overrides.id,
  method: 'GET',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

describe('variables and paths', () => {
  it('interpolates variables and dynamic helpers, leaving unknown names visible', () => {
    const scope = scopeOf([
      { key: 'host', value: 'api.test' },
      { key: 'off', value: 'x', enabled: false },
    ]);
    expect(interpolate('https://{{host}}/{{ off }}/{{missing}}', scope)).toBe(
      'https://api.test/{{ off }}/{{missing}}',
    );
    expect(interpolate('{{$guid}}', scope)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('fills :name path segments, escaped when sending, and never touches a port', () => {
    expect(
      fillPathParams('http://localhost:8080/orders/:id/items/:item', [
        { key: 'id', value: '{{orderId}}' },
        { key: 'item', value: 'x', enabled: false },
      ]),
    ).toBe('http://localhost:8080/orders/{{orderId}}/items/:item');
    const prepared = prepareRequest(
      {
        id: 'r',
        type: 'request',
        name: 'Get order',
        method: 'GET',
        url: '{{baseUrl}}/orders/:id',
        pathParams: [{ key: 'id', value: '{{orderId}}' }],
        headers: [],
        query: [{ key: 'expand', value: 'items' }],
        body: { mode: 'none' },
        auth: { type: 'none' },
        assertions: [],
        captures: [],
      },
      { type: 'none' },
      scopeOf([
        { key: 'baseUrl', value: 'https://api.test:8443' },
        { key: 'orderId', value: 'a/b c' },
      ]),
    );
    expect(prepared.url.toString()).toBe('https://api.test:8443/orders/a%2Fb%20c?expand=items');
  });

  it('reads JSON paths in the common notations', () => {
    const doc = { data: { items: [{ id: 'a' }, { id: 'b' }] }, 'odd key': 1 };
    expect(readJsonPath(doc, 'data.items[1].id')).toBe('b');
    expect(readJsonPath(doc, '$.data.items.0.id')).toBe('a');
    expect(readJsonPath(doc, "$['odd key']")).toBe(1);
    expect(readJsonPath(doc, 'data.nothing.here')).toBeUndefined();
  });
});

describe('collection runs', () => {
  const collection: CollectionSpec = {
    name: 'Auth flow',
    variables: [{ key: 'base', value: '' }],
    auth: { type: 'none' },
    items: [
      request({
        id: 'login',
        method: 'POST',
        url: '{{base}}/login',
        body: { mode: 'json', content: '{"user":"{{user}}","password":"{{password}}"}' },
        assertions: [
          { id: 'a1', source: 'status', operator: 'eq', expected: '200' },
          { id: 'a2', source: 'json', path: 'user.roles', operator: 'isType', expected: 'array' },
          { id: 'a3', source: 'header', path: 'x-request-id', operator: 'exists' },
          { id: 'a4', source: 'duration', operator: 'lt', expected: '5000' },
        ],
        captures: [{ variable: 'token', source: 'json', path: 'token' }],
      }),
      {
        id: 'folder',
        type: 'folder',
        name: 'Account',
        auth: { type: 'bearer', token: '{{token}}' },
        items: [
          request({
            id: 'me',
            url: '{{base}}/me',
            query: [{ key: 'q', value: '{{user}}' }],
            assertions: [
              { id: 'b1', source: 'json', path: 'id', operator: 'eq', expected: '7' },
              { id: 'b2', source: 'json', path: 'echo', operator: 'eq', expected: 'ana' },
            ],
          }),
        ],
      },
    ],
  };

  it('chains captures, inherits folder auth and masks secrets', async () => {
    const result = await runCollection(
      { ...collection, variables: [{ key: 'base', value: base }] },
      {
        environment: [
          { key: 'user', value: 'ana' },
          { key: 'password', value: 'hunter2-pass', secret: true },
          { key: 'token', value: '', secret: true },
        ],
      },
    );
    expect(result).toMatchObject({ total: 2, passed: 2, failed: 0 });
    const [login, me] = result.results;
    expect(seen.find((entry) => entry.url === '/login')?.body).toBe(
      '{"user":"ana","password":"hunter2-pass"}',
    );
    expect(seen.find((entry) => entry.url.startsWith('/me'))?.headers.authorization).toBe(
      'Bearer super-secret-token',
    );
    // The captured token kept the secret flag of the environment variable.
    expect(login!.response!.bodyPreview).not.toContain('super-secret-token');
    expect(login!.response!.bodyPreview).toContain('••••••');
    expect(me!.path).toEqual(['Account']);
    expect(login!.assertions.every((assertion) => assertion.passed)).toBe(true);
  });

  it('reports failures, network errors and timeouts, and can stop at the first failure', async () => {
    const failing: CollectionSpec = {
      name: 'Failures',
      variables: [],
      auth: { type: 'none' },
      items: [
        request({
          id: 'unauth',
          url: `${base}/me`,
          assertions: [{ id: 'x', source: 'status', operator: 'eq', expected: '200' }],
        }),
        request({ id: 'slow', url: `${base}/slow`, timeoutMs: 50 }),
        request({ id: 'bad-url', url: 'not a url' }),
      ],
    };
    const all = await runCollection(failing);
    expect(all.results.map((result) => result.passed)).toEqual([false, false, false]);
    expect(all.results[0]!.status).toBe(401);
    expect(all.results[1]!.error).toMatch(/Timed out after 50 ms/);
    expect(all.results[2]!.error).toMatch(/Invalid request/);

    const bailed = await runCollection(failing, { bail: true });
    expect(bailed.results).toHaveLength(1);
  });

  it('runs only the chosen folders or requests', () => {
    expect(selectRequests(collection, ['folder']).map((entry) => entry.request.id)).toEqual(['me']);
    expect(selectRequests(collection).map((entry) => entry.auth.type)).toEqual(['none', 'bearer']);
  });
});

describe('load profiles', () => {
  it('builds the stages of every test type and interpolates VUs inside stages', () => {
    expect(profileStages('smoke', { vus: 50, durationSec: 300 })).toEqual([
      { durationSec: 60, targetVus: 2 },
    ]);
    const load = profileStages('load', { vus: 20, durationSec: 100 });
    expect(load).toEqual([
      { durationSec: 10, targetVus: 20 },
      { durationSec: 80, targetVus: 20 },
      { durationSec: 10, targetVus: 0 },
    ]);
    expect(vusAt(load, 5)).toBe(10);
    expect(vusAt(load, 50)).toBe(20);
    expect(vusAt(load, 200)).toBe(0);
    expect(
      Math.max(...profileStages('stress', { vus: 20, durationSec: 70 }).map((s) => s.targetVus)),
    ).toBe(30);
    expect(profileStages('spike', { vus: 100, durationSec: 100 }).map((s) => s.targetVus)).toEqual([
      10, 100, 100, 10, 10, 0,
    ]);
    expect(totalDuration(profileStages('soak', { vus: 5, durationSec: 3600 }))).toBe(3600);
  });
});

describe('load runs', () => {
  it('ramps virtual users, measures latency and evaluates thresholds', async () => {
    const ticks: number[] = [];
    const summary = await runLoad(
      {
        requests: [
          {
            request: request({ id: 'me', url: `${base}/me` }),
            auth: { type: 'bearer', token: '{{token}}' },
            weight: 3,
          },
          {
            request: request({
              id: 'flaky',
              url: `${base}/flaky`,
              assertions: [{ id: 'c', source: 'status', operator: 'eq', expected: '200' }],
            }),
            auth: { type: 'none' },
            weight: 1,
          },
        ],
        variables: [{ key: 'token', value: 'super-secret-token' }],
        stages: [{ durationSec: 1, targetVus: 4 }],
        thinkTimeMs: 5,
        thresholds: [
          { metric: 'p95', operator: 'lt', value: 2_000 },
          { metric: 'errorRate', operator: 'lt', value: 0.01 },
        ],
      },
      { tickMs: 250, controlMs: 20, onTick: (tick) => void ticks.push(tick.requests) },
    );
    expect(summary.totalRequests).toBeGreaterThan(10);
    expect(summary.maxVus).toBeGreaterThanOrEqual(2);
    expect(summary.maxVus).toBeLessThanOrEqual(4);
    expect(summary.statusCodes['200']).toBeGreaterThan(0);
    expect(summary.failedRequests).toBe(summary.statusCodes['500'] ?? 0);
    expect(summary.perRequest.map((entry) => entry.requestId)).toEqual(['me', 'flaky']);
    expect(summary.checks.passed + summary.checks.failed).toBe(summary.perRequest[1]!.count);
    expect(summary.thresholds[0]).toMatchObject({ metric: 'p95', passed: true });
    // The flaky endpoint fails about half of its requests, so the error-rate threshold fails.
    expect(summary.thresholds[1]!.passed).toBe(false);
    expect(summary.passed).toBe(false);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(summary.timeline.length).toBe(ticks.length);
  });

  it('caps the virtual users and stops on cancel', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const summary = await runLoad(
      {
        requests: [
          { request: request({ id: 'me', url: `${base}/me` }), auth: { type: 'none' }, weight: 1 },
        ],
        variables: [],
        stages: [{ durationSec: 60, targetVus: 50 }],
        thinkTimeMs: 10,
        thresholds: [],
      },
      { signal: controller.signal, maxVus: 3, controlMs: 10, tickMs: 100 },
    );
    expect(summary.maxVus).toBeLessThanOrEqual(3);
    expect(summary.durationSec).toBeLessThan(5);
    expect(summary.passed).toBe(true);
  });
});
