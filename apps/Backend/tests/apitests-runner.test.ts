import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  runCollectionWithState,
  type ScriptRunner,
} from '../src/modules/apitests/engine/collection-runner.js';
import { executeRun } from '../src/modules/apitests/engine/run-executor.js';
import type { ScriptInput, ScriptOutput } from '../src/modules/apitests/engine/script-sandbox.js';
import type { ApiRequestSpec, CollectionSpec } from '../src/modules/apitests/engine/types.js';

// The runner's own logic (script flow, flow control, iterations, inheritance, bodies, cookies,
// runtime state) with a fake script runner: the sandbox has its own tests.

let base = '';
let server: http.Server;
const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/login') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'session=abc123; Path=/; HttpOnly',
        });
        res.end(JSON.stringify({ token: 'tok-1' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen.length = 0;
});

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

type Handler = (input: ScriptInput) => Partial<ScriptOutput> | void;

/** Scripts are names of handlers; each call is recorded as `<source>`. */
function fakeScripts(handlers: Record<string, Handler>, calls: string[]) {
  return (): ScriptRunner => ({
    run: (input) => {
      calls.push(input.source);
      const output = handlers[input.code.trim()]?.(input) ?? {};
      return Promise.resolve({
        request: input.request,
        variables: {
          environment: input.variables.environment,
          collection: input.variables.collection,
          runtime: input.variables.runtime,
          request: input.variables.request,
        },
        tests: [],
        logs: [],
        skipRequest: false,
        stopExecution: false,
        ...output,
      });
    },
    close: () => Promise.resolve(),
  });
}

const layered = (flow?: CollectionSpec['scriptFlow']): CollectionSpec => ({
  name: 'Flow',
  variables: [{ key: 'base', value: base }],
  auth: { type: 'none' },
  ...(flow ? { scriptFlow: flow } : {}),
  scripts: { preRequest: 'noop', postResponse: 'noop', tests: 'noop' },
  items: [
    {
      id: 'f',
      type: 'folder',
      name: 'Orders',
      scripts: { preRequest: 'noop', postResponse: 'noop' },
      items: [
        request({ id: 'r', url: '{{base}}/x', scripts: { preRequest: 'noop', tests: 'noop' } }),
      ],
    },
  ],
});

describe('script flow', () => {
  it('runs pre-request top-down and post-response bottom-up in sandwich mode', async () => {
    const calls: string[] = [];
    await runCollectionWithState(layered(), { scripts: fakeScripts({}, calls) });
    expect(calls).toEqual([
      'collection pre-request',
      'folder Orders pre-request',
      'request pre-request',
      'folder Orders post-response',
      'collection post-response',
      'request tests',
      'collection tests',
    ]);
  });

  it('runs everything top-down in sequential mode', async () => {
    const calls: string[] = [];
    await runCollectionWithState(layered('sequential'), { scripts: fakeScripts({}, calls) });
    expect(calls.slice(3)).toEqual([
      'collection post-response',
      'folder Orders post-response',
      'collection tests',
      'request tests',
    ]);
  });

  it('applies request changes and variables of pre-request scripts, and records tests', async () => {
    const calls: string[] = [];
    const collection: CollectionSpec = {
      name: 'Scripts',
      variables: [{ key: 'base', value: base }],
      auth: { type: 'none' },
      scripts: { preRequest: 'stamp', tests: 'check' },
      items: [request({ id: 'r', url: '{{base}}/x' })],
    };
    const { result, runtime } = await runCollectionWithState(collection, {
      scripts: fakeScripts(
        {
          stamp: (input) => ({
            request: {
              ...input.request,
              headers: { ...input.request.headers, 'x-run': '{{runId}}' },
            },
            variables: {
              environment: input.variables.environment,
              collection: input.variables.collection,
              runtime: { ...input.variables.runtime, runId: 'run-42' },
              request: input.variables.request,
            },
          }),
          check: (input) => ({
            tests: [
              { name: 'ok', passed: input.response?.status === 200 },
              { name: 'fails', passed: false, error: 'expected 1 to equal 2' },
            ],
            logs: [{ level: 'log', message: 'hello', source: input.source }],
          }),
        },
        calls,
      ),
    });
    expect(seen[0]!.headers['x-run']).toBe('run-42');
    const only = result.results[0]!;
    expect(only.tests?.map((test) => [test.label, test.passed])).toEqual([
      ['ok', true],
      ['fails', false],
    ]);
    expect(only.passed).toBe(false);
    expect(only.logs?.[0]).toMatchObject({ message: 'hello', source: 'collection tests' });
    expect(runtime.variables).toEqual([{ key: 'runId', value: 'run-42' }]);
  });

  it('follows setNextRequest, skips and stops', async () => {
    const collection: CollectionSpec = {
      name: 'Control',
      variables: [{ key: 'base', value: base }],
      auth: { type: 'none' },
      items: [
        request({ id: 'a', url: '{{base}}/a', scripts: { postResponse: 'jump' } }),
        request({ id: 'b', url: '{{base}}/b' }),
        request({ id: 'c', url: '{{base}}/c', scripts: { preRequest: 'skip' } }),
        request({ id: 'd', url: '{{base}}/d', scripts: { postResponse: 'stop' } }),
        request({ id: 'e', url: '{{base}}/e' }),
      ],
    };
    const { result } = await runCollectionWithState(collection, {
      scripts: fakeScripts(
        {
          jump: () => ({ nextRequest: 'c' }),
          skip: () => ({ skipRequest: true }),
          stop: () => ({ stopExecution: true }),
        },
        [],
      ),
    });
    expect(result.results.map((item) => [item.requestId, Boolean(item.skipped)])).toEqual([
      ['a', false],
      ['c', true],
      ['d', false],
    ]);
    expect(result).toMatchObject({ skipped: 1, passed: 2, failed: 0 });
  });
});

describe('collection runs', () => {
  it('iterates over data rows with the row as variables', async () => {
    const { result } = await runCollectionWithState(
      {
        name: 'Data',
        variables: [{ key: 'base', value: base }],
        auth: { type: 'none' },
        items: [request({ id: 'r', url: '{{base}}/users/{{user}}' })],
      },
      { data: [{ user: 'ana' }, { user: 'bia' }] },
    );
    expect(seen.map((entry) => entry.url)).toEqual(['/users/ana', '/users/bia']);
    expect(result.results.map((item) => item.iteration)).toEqual([1, 2]);
    expect(result.iterations).toBe(2);
  });

  it('inherits collection and folder headers and folder vars; the request wins', async () => {
    await runCollectionWithState({
      name: 'Headers',
      variables: [{ key: 'base', value: base }],
      auth: { type: 'none' },
      headers: [
        { key: 'X-Tenant', value: 'acme' },
        { key: 'X-Level', value: 'collection' },
      ],
      items: [
        {
          id: 'f',
          type: 'folder',
          name: 'F',
          headers: [{ key: 'x-level', value: 'folder' }],
          vars: [{ key: 'version', value: 'v2' }],
          items: [
            request({
              id: 'r',
              url: '{{base}}/{{version}}/x',
              headers: [{ key: 'X-Level', value: 'request' }],
            }),
          ],
        },
      ],
    });
    expect(seen[0]!.url).toBe('/v2/x');
    expect(seen[0]!.headers['x-tenant']).toBe('acme');
    expect(seen[0]!.headers['x-level']).toBe('request');
  });

  it('sends GraphQL, multipart and urlencoded bodies', async () => {
    await runCollectionWithState({
      name: 'Bodies',
      variables: [
        { key: 'base', value: base },
        { key: 'limit', value: '5' },
      ],
      auth: { type: 'none' },
      items: [
        request({
          id: 'gql',
          kind: 'graphql',
          method: 'POST',
          url: '{{base}}/graphql',
          graphql: { query: 'query($n: Int) { a(n: $n) }', variables: '{"n": {{limit}}}' },
        }),
        request({
          id: 'multi',
          method: 'POST',
          url: '{{base}}/upload',
          body: {
            mode: 'form',
            fields: [
              { key: 'note', value: 'hi {{limit}}' },
              {
                key: 'file',
                value: '',
                type: 'file',
                file: {
                  fileName: 'a.txt',
                  contentType: 'text/plain',
                  data: Buffer.from('file-body').toString('base64'),
                },
              },
            ],
          },
        }),
        request({
          id: 'form',
          method: 'POST',
          url: '{{base}}/form',
          body: { mode: 'urlencoded', fields: [{ key: 'a b', value: '1&2' }] },
        }),
      ],
    });
    const [gql, multi, form] = seen;
    expect(JSON.parse(gql!.body)).toEqual({
      query: 'query($n: Int) { a(n: $n) }',
      variables: { n: 5 },
    });
    expect(gql!.headers['content-type']).toBe('application/json');
    expect(multi!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(multi!.body).toContain('name="note"\r\n\r\nhi 5');
    expect(multi!.body).toContain('filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nfile-body');
    expect(form!.body).toBe('a+b=1%262');
  });

  it('keeps cookies between requests and returns them with the runtime state', async () => {
    const { runtime } = await runCollectionWithState({
      name: 'Cookies',
      variables: [{ key: 'base', value: base }],
      auth: { type: 'none' },
      items: [
        request({
          id: 'login',
          url: '{{base}}/login',
          captures: [{ variable: 'token', source: 'json', path: 'token' }],
        }),
        request({ id: 'me', url: '{{base}}/me' }),
      ],
    });
    expect(seen[1]!.headers.cookie).toBe('session=abc123');
    expect(runtime.cookies.map((cookie) => cookie.name)).toEqual(['session']);
    expect(runtime.variables).toEqual([{ key: 'token', value: 'tok-1' }]);
  });

  it('starts from the runtime state of previous sends', async () => {
    const outcome = await executeRun(
      {
        kind: 'integration',
        collection: {
          name: 'Runtime',
          variables: [{ key: 'base', value: base }],
          auth: { type: 'bearer', token: '{{token}}' },
          items: [request({ id: 'me', url: '{{base}}/me' })],
        },
        environment: [],
        itemIds: [],
        bail: false,
        runtime: {
          variables: [{ key: 'token', value: 'from-last-send' }],
          cookies: [
            { name: 'session', value: 's1', domain: '127.0.0.1', path: '/', hostOnly: true },
          ],
        },
      },
      { report: () => Promise.resolve('running') },
    );
    expect(seen[0]!.headers.authorization).toBe('Bearer from-last-send');
    expect(seen[0]!.headers.cookie).toBe('session=s1');
    expect(outcome.runtime?.variables).toEqual([{ key: 'token', value: 'from-last-send' }]);
    // The timeline never shows credentials.
    const result = outcome.result as unknown as {
      results: { timeline?: { request: { headers: Record<string, string> } } }[];
    };
    expect(JSON.stringify(result.results[0]!.timeline)).not.toContain('from-last-send');
  });
});
