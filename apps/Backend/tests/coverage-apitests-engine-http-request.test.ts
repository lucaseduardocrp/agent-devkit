import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const streams = vi.hoisted(() => ({
  websocketExchange: vi.fn(),
  sseExchange: vi.fn(),
  socketExchange: vi.fn(),
}));
const grpc = vi.hoisted(() => ({ grpcCall: vi.fn() }));
vi.mock('../src/modules/apitests/engine/stream-clients.js', () => streams);
vi.mock('../src/modules/apitests/engine/grpc-client.js', () => grpc);

const {
  executeRequest,
  networkOf,
  senderOf,
  readJsonPath,
  fillPathParams,
  mergeHeaders,
  assertionLabel,
  resolveAuth,
} = await import('../src/modules/apitests/engine/http-request.js');
const { sendHttp } = await import('../src/modules/apitests/engine/http-transport.js');
const { CookieJar } = await import('../src/modules/apitests/engine/cookie-jar.js');
const { LayeredScope } = await import('../src/modules/apitests/engine/variables.js');
import type {
  ExecuteOptions,
  RequestScripting,
  ScriptStep,
} from '../src/modules/apitests/engine/http-request.js';
import type {
  ApiRequestSpec,
  Assertion,
  Capture,
  RequestKind,
} from '../src/modules/apitests/engine/types.js';

const request = (
  overrides: Partial<ApiRequestSpec> = {},
  url = 'https://api.example.test/items',
): ApiRequestSpec => ({
  id: 'r1',
  type: 'request',
  name: 'Request',
  method: 'GET',
  url,
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  redirect: string | undefined;
}
const seen: Seen[] = [];

type Reply = { body?: string; status?: number; headers?: [string, string][] };
/** A fetch that records what was sent and answers `reply`. */
function fakeFetch(reply: Reply | ((seen: Seen) => Reply) = {}): typeof fetch {
  return (async (input: Request, init?: { redirect?: string }) => {
    const record: Seen = {
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: input.method === 'GET' || input.method === 'HEAD' ? '' : await input.text(),
      redirect: init?.redirect,
    };
    seen.push(record);
    const answer = typeof reply === 'function' ? reply(record) : reply;
    const headers = new Headers();
    for (const [name, value] of answer.headers ?? []) headers.append(name, value);
    return new Response(answer.body ?? '', { status: answer.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

const run = (
  spec: ApiRequestSpec,
  options: Partial<ExecuteOptions> = {},
  scope = new LayeredScope(),
) => executeRequest(spec, scope, { auth: { type: 'none' }, fetch: fakeFetch(), ...options });

const step = (extra: Partial<ScriptStep> = {}): ScriptStep => ({ tests: [], logs: [], ...extra });

beforeEach(() => {
  seen.length = 0;
  streams.websocketExchange.mockReset();
  streams.sseExchange.mockReset();
  streams.socketExchange.mockReset();
  grpc.grpcCall.mockReset();
});

describe('helpers', () => {
  it('reads json paths, fills path params and merges headers', () => {
    expect(readJsonPath({ a: { b: [{ c: 1 }] } }, '$.a.b[0].c')).toBe(1);
    expect(readJsonPath({ a: { 'x y': 2 } }, "a['x y']")).toBe(2);
    expect(readJsonPath({ a: null }, 'a.b')).toBeUndefined();
    expect(fillPathParams('/u/:id/:other', [{ key: 'id', value: '1' }])).toBe('/u/1/:other');
    expect(fillPathParams('/u/:id', [{ key: 'id', value: '1', enabled: false }])).toBe('/u/:id');
    expect(fillPathParams('/u/:id', undefined)).toBe('/u/:id');
    expect(
      mergeHeaders([{ key: 'A', value: '1' }], undefined, [
        { key: 'a', value: '2' },
        { key: 'off', value: 'x', enabled: false },
        { key: ' ', value: 'blank' },
      ]),
    ).toEqual([{ key: 'a', value: '2' }]);
    expect(assertionLabel({ id: '1', source: 'status', operator: 'eq', expected: '200' })).toBe(
      'status eq 200',
    );
    const scope = new LayeredScope({ collection: [{ key: 't', value: 'tok' }] });
    expect(resolveAuth({ type: 'bearer', token: '{{t}}' }, scope)).toEqual({
      type: 'bearer',
      token: 'tok',
    });
  });

  it('builds network options from the collection settings', () => {
    const scope = new LayeredScope({ collection: [{ key: 'host', value: 'proxy.test' }] });
    const signal = new AbortController().signal;
    expect(networkOf(undefined, scope, {}, signal)).toEqual({ signal });
    expect(networkOf({ proxy: { enabled: false } as never }, scope, {}, signal)).toEqual({
      signal,
    });
    const guard = () => Promise.resolve();
    const connectHost = (host: string) => host;
    const network = networkOf(
      {
        proxy: {
          enabled: true,
          protocol: 'http',
          hostname: '{{host}}',
          port: 8080,
        },
        tls: { verify: false },
        clientCertificates: [{ domain: '{{host}}', type: 'pem', cert: 'c' }],
      },
      scope,
      { guard, connectHost },
      signal,
    );
    expect(network).toMatchObject({
      proxy: { hostname: 'proxy.test', port: 8080 },
      tls: { verify: false },
      clientCertificates: [{ domain: 'proxy.test' }],
      connectHost,
      guard,
      signal,
    });
  });

  it('picks the node transport only when the settings need it', () => {
    const custom = vi.fn();
    expect(senderOf({ fetch: custom as never })).not.toBe(sendHttp);
    expect(senderOf({})).toBe(sendHttp);
    expect(senderOf({ preferFetch: true })).not.toBe(sendHttp);
    expect(senderOf({ preferFetch: true, settings: {} })).not.toBe(sendHttp);
    for (const settings of [
      { proxy: { enabled: true } },
      { tls: { verify: false } },
      { tls: { caCertificate: 'pem' } },
      { clientCertificates: [{ domain: 'a', type: 'pem' }] },
    ]) {
      expect(senderOf({ preferFetch: true, settings: settings as never })).toBe(sendHttp);
    }
    expect(senderOf({ preferFetch: true, connectHost: (host) => host })).toBe(sendHttp);
  });
});

describe('what scripts see before the request', () => {
  const draft = async (spec: ApiRequestSpec) => {
    let body: string | undefined = 'unset';
    const scripting: RequestScripting = {
      pre: (view) => {
        body = view.body;
        return Promise.resolve(step({ error: 'stop' }));
      },
      post: () => Promise.resolve(step()),
      tests: () => Promise.resolve(step()),
    };
    await run(spec, { scripting });
    return body;
  };

  it('describes the body of every request kind', async () => {
    expect(await draft(request({ kind: 'graphql', method: 'POST' }))).toBe(
      '{"query":"","variables":{}}',
    );
    expect(
      await draft(
        request({
          kind: 'graphql',
          method: 'POST',
          graphql: { query: 'q', variables: ' {"a":1} ', operationName: ' Op ' },
        }),
      ),
    ).toBe('{"query":"q","variables":{"a":1},"operationName":"Op"}');
    expect(
      await draft(
        request({
          kind: 'graphql',
          method: 'POST',
          graphql: { query: 'q', variables: '  ', operationName: '  ' },
        }),
      ),
    ).toBe('{"query":"q","variables":{}}');
    expect(await draft(request({ kind: 'grpc' }))).toBe('{}');
    expect(
      await draft(request({ kind: 'grpc', grpc: { method: 'a/b', message: '{"x":1}' } })),
    ).toBe('{"x":1}');
    expect(await draft(request({ kind: 'websocket' }))).toBeUndefined();
    expect(await draft(request({ kind: 'socket' }))).toBeUndefined();
    expect(await draft(request({ body: { mode: 'json', content: '{"a":1}' } }))).toBe('{"a":1}');
    expect(await draft(request({ body: { mode: 'xml', content: '<a/>' } }))).toBe('<a/>');
    expect(
      await draft(
        request({
          body: {
            mode: 'urlencoded',
            fields: [
              { key: 'a b', value: 'c&d' },
              { key: 'off', value: 'x', enabled: false },
            ],
          },
        }),
      ),
    ).toBe('a%20b=c%26d');
    expect(await draft(request({ body: { mode: 'form', fields: [] } }))).toBeUndefined();
    expect(await draft(request())).toBeUndefined();
  });
});

describe('request building over fetch', () => {
  it('sends json, text, urlencoded and binary bodies with their content types', async () => {
    const send = (body: ApiRequestSpec['body'], headers: ApiRequestSpec['headers'] = []) =>
      run(request({ method: 'POST', body, headers }));
    await send({ mode: 'json', content: '{"a":"{{x}}"}' });
    await send({ mode: 'text', content: 'hi' });
    await send({ mode: 'sparql', content: 'SELECT *' });
    await send(
      {
        mode: 'urlencoded',
        fields: [
          { key: 'a', value: '1 2' },
          { key: 'b', value: '3', enabled: false },
        ],
      },
      [],
    );
    await send({ mode: 'json', content: '{}' }, [{ key: 'Content-Type', value: 'text/custom' }]);
    await send({
      mode: 'binary',
      file: { fileName: 'a.bin', data: Buffer.from('bin').toString('base64') },
    });
    await send({
      mode: 'binary',
      file: {
        fileName: 'a.bin',
        contentType: 'image/png',
        data: Buffer.from('png').toString('base64'),
      },
    });
    await send({ mode: 'binary', file: null });
    await send({ mode: 'none' });
    expect(seen.map((item) => [item.headers.get('content-type'), item.body])).toEqual([
      ['application/json', '{"a":"{{x}}"}'],
      ['text/plain', 'hi'],
      ['application/sparql-query', 'SELECT *'],
      ['application/x-www-form-urlencoded', 'a=1+2'],
      ['text/custom', '{}'],
      ['application/octet-stream', 'bin'],
      ['image/png', 'png'],
      [null, ''],
      [null, ''],
    ]);
  });

  it('builds multipart bodies with text and file parts', async () => {
    await run(
      request({
        method: 'POST',
        body: {
          mode: 'form',
          fields: [
            { key: 'na"me', value: '{{v}}', contentType: 'application/json' },
            { key: 'plain', value: 'x' },
            { key: 'off', value: 'x', enabled: false },
            {
              key: 'file',
              value: '',
              type: 'file',
              file: {
                fileName: 'a"\nb.txt',
                contentType: 'text/csv',
                data: Buffer.from('1,2').toString('base64'),
              },
            },
            {
              key: 'file2',
              value: '',
              type: 'file',
              file: { fileName: 'b.bin', data: Buffer.from('zz').toString('base64') },
            },
            { key: 'file3', value: 'fallback', type: 'file' },
          ],
        },
      }),
      {},
      new LayeredScope({ collection: [{ key: 'v', value: '{"a":1}' }] }),
    );
    const [item] = seen;
    expect(item!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=----adk-/);
    expect(item!.body).toContain('name="na%22me"\r\nContent-Type: application/json\r\n\r\n{"a":1}');
    expect(item!.body).toContain('name="plain"\r\n\r\nx');
    expect(item!.body).not.toContain('name="off"');
    expect(item!.body).toContain('filename="a%22 b.txt"\r\nContent-Type: text/csv\r\n\r\n1,2');
    expect(item!.body).toContain('Content-Type: application/octet-stream\r\n\r\nzz');
    expect(item!.body).toContain('name="file3"\r\n\r\nfallback');
  });

  it('does not send a body on GET and HEAD', async () => {
    await run(request({ body: { mode: 'json', content: '{}' } }));
    await run(request({ method: 'HEAD', body: { mode: 'json', content: '{}' } }));
    expect(seen.map((item) => item.body)).toEqual(['', '']);
  });

  it('sends graphql as POST json or as query parameters on GET', async () => {
    await run(
      request({
        kind: 'graphql',
        method: 'POST',
        graphql: { query: '{ a(id: {{id}}) }', variables: '{"id":{{id}}}' },
      }),
      {},
      new LayeredScope({ collection: [{ key: 'id', value: '7' }] }),
    );
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(seen[0]!.body)).toEqual({ query: '{ a(id: 7) }', variables: { id: 7 } });

    await run(
      request({
        kind: 'graphql',
        method: 'GET',
        graphql: { query: '{ a }', variables: '{"a":1}', operationName: ' Op ' },
        query: [
          { key: 'k', value: 'v' },
          { key: 'off', value: 'x', enabled: false },
        ],
      }),
    );
    const url = new URL(seen[1]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      k: 'v',
      query: '{ a }',
      variables: '{"a":1}',
      operationName: 'Op',
    });

    await run(
      request({
        kind: 'graphql',
        method: 'GET',
        graphql: { query: '{ a }', variables: '{}', operationName: ' ' },
      }),
    );
    expect(Object.fromEntries(new URL(seen[2]!.url).searchParams)).toEqual({ query: '{ a }' });
    await run(request({ kind: 'graphql', method: 'GET', graphql: { query: '{ a }' } }));
    expect(Object.fromEntries(new URL(seen[3]!.url).searchParams)).toEqual({ query: '{ a }' });
    await run(request({ kind: 'graphql', method: 'GET' }));
    expect(Object.fromEntries(new URL(seen[4]!.url).searchParams)).toEqual({});
  });

  it('lets a pre-request script change the body, headers and url', async () => {
    const scripting: RequestScripting = {
      pre: (view) =>
        Promise.resolve(
          step({
            request: {
              ...view,
              body: '{"scripted":true}',
              url: 'https://api.example.test/changed',
              headers: { ...view.headers, ' ': 'blank', 'X-Id': '{{id}}' },
            },
          }),
        ),
      post: () => Promise.resolve(step()),
      tests: () => Promise.resolve(step()),
    };
    const scope = new LayeredScope({ collection: [{ key: 'id', value: '9' }] });
    await run(
      request({ method: 'POST', body: { mode: 'json', content: '{}' } }),
      { scripting },
      scope,
    );
    await run(request({ method: 'POST', body: { mode: 'none' } }), { scripting }, scope);
    await run(request({ method: 'POST', kind: 'graphql' }), { scripting }, scope);
    expect(
      seen.map((item) => [
        item.url,
        item.body,
        item.headers.get('content-type'),
        item.headers.get('x-id'),
      ]),
    ).toEqual([
      ['https://api.example.test/changed', '{"scripted":true}', 'application/json', '9'],
      ['https://api.example.test/changed', '{"scripted":true}', 'application/json', '9'],
      ['https://api.example.test/changed', '{"scripted":true}', 'application/json', '9'],
    ]);
  });

  it('keeps the draft body when a script removes it', async () => {
    const scripting: RequestScripting = {
      pre: (view) => Promise.resolve(step({ request: { ...view, body: undefined } })),
      post: () => Promise.resolve(step()),
      tests: () => Promise.resolve(step()),
    };
    await run(request({ method: 'POST', kind: 'graphql', graphql: { query: '{ a }' } }), {
      scripting,
    });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ query: '{ a }' });
  });

  it('fills path parameters, redirect and cookie settings', async () => {
    const cookies = new CookieJar();
    await run(
      request(
        {
          pathParams: [{ key: 'id', value: 'a b' }],
          settings: { followRedirects: false, maxRedirects: 2 },
        },
        'https://api.example.test/u/:id',
      ),
      { cookies, settings: { followRedirects: true, maxRedirects: 9 } },
    );
    expect(seen[0]!.url).toBe('https://api.example.test/u/a%20b');
    expect(seen[0]!.redirect).toBe('manual');
    await run(request(), { settings: { followRedirects: false } });
    expect(seen[1]!.redirect).toBe('manual');
    await run(request());
    expect(seen[2]!.redirect).toBe('follow');
    // Cookies from the jar are sent, unless the collection turns cookies off.
    cookies.set({ name: 's', value: '1', domain: 'api.example.test', path: '/' });
    await run(request(), { cookies });
    await run(request(), { cookies, settings: { cookies: false } });
    expect(seen[3]!.headers.get('cookie')).toBe('s=1');
    expect(seen[4]!.headers.get('cookie')).toBeNull();
  });

  it('reports an invalid url, even when the failure is not an Error', async () => {
    const result = await run(request({}, 'not a url'));
    expect(result).toMatchObject({ passed: false, status: null });
    expect(result.error).toMatch(/^Invalid request: /);
    let calls = 0;
    const scope = {
      // Fails once (building the url); the message of the failure reuses the scope again.
      get: () => {
        if (calls++ === 0) throw 'scope failure';
        return undefined;
      },
      set: () => undefined,
      values: () => [],
    };
    const failed = await executeRequest(request({}, 'https://x.test/{{a}}'), scope as never, {
      auth: { type: 'none' },
    });
    expect(failed.error).toBe('Invalid request: scope failure');
  });
});

describe('script steps', () => {
  it('stops on a pre-request error, skips on request and merges logs and tests', async () => {
    const failing: RequestScripting = {
      pre: () =>
        Promise.resolve(
          step({
            error: 'pre failed secret-value',
            tests: [{ id: 't', label: 'T', passed: false, actual: 'secret-value' }],
            logs: [{ level: 'log', message: 'log secret-value', source: 'pre-request' }],
          }),
        ),
      post: () => Promise.resolve(step()),
      tests: () => Promise.resolve(step()),
    };
    const scope = new LayeredScope({
      collection: [{ key: 's', value: 'secret-value', secret: true }],
    });
    const failed = await run(request({}, 'https://x.test/{{s}}'), { scripting: failing }, scope);
    expect(failed).toMatchObject({
      passed: false,
      error: 'pre failed ••••••',
      url: 'https://x.test/••••••',
      tests: [{ actual: '••••••' }],
      logs: [{ message: 'log ••••••' }],
    });

    const skipping: RequestScripting = {
      ...failing,
      pre: () => Promise.resolve(step({ skip: true })),
    };
    expect(await run(request(), { scripting: skipping })).toMatchObject({
      skipped: true,
      passed: true,
      status: null,
    });
  });

  it('runs post-response and test scripts and collects their errors', async () => {
    const scripting: RequestScripting = {
      pre: () => Promise.resolve(step()),
      post: () =>
        Promise.resolve(
          step({ error: 'post failed', tests: [{ id: 'p', label: 'P', passed: true }] }),
        ),
      tests: () =>
        Promise.resolve(
          step({ error: 'ignored', logs: [{ level: 'info', message: 'hello', source: 'tests' }] }),
        ),
    };
    const result = await run(request(), { scripting });
    expect(result).toMatchObject({
      passed: false,
      error: 'post failed',
      tests: [{ id: 'p' }],
      logs: [{ message: 'hello' }],
    });
    const testsOnly: RequestScripting = {
      ...scripting,
      post: () => Promise.resolve(step()),
    };
    expect(await run(request(), { scripting: testsOnly })).toMatchObject({ error: 'ignored' });
  });

  it('labels the iteration and lets a script drop the timeout', async () => {
    const scripting: RequestScripting = {
      pre: (view) => Promise.resolve(step({ request: { ...view, timeoutMs: undefined } })),
      post: () => Promise.resolve(step()),
      tests: () => Promise.resolve(step()),
    };
    expect(await run(request(), { iteration: 3, scripting })).toMatchObject({ iteration: 3 });
  });

  it('passes the run signal and a shared auth cache', async () => {
    const controller = new AbortController();
    const result = await run(request(), { signal: controller.signal, authCache: new Map() });
    expect(result.passed).toBe(true);
  });
});

describe('assertions and captures', () => {
  const body = JSON.stringify({ n: 5, s: 'hello', list: [1], nothing: null, nested: { a: 1 } });
  const assertion = (extra: Partial<Assertion>): Assertion => ({
    id: 'a',
    source: 'json',
    operator: 'eq',
    ...extra,
  });
  const check = async (assertions: Assertion[]) =>
    (
      await run(request({ assertions }), {
        fetch: fakeFetch({
          body,
          headers: [
            ['X-Mode', 'fast'],
            ['content-type', 'application/json'],
          ],
        }),
      })
    ).assertions.map((item) => item.passed);

  it('evaluates every source and operator', async () => {
    const cases: [Partial<Assertion>, boolean][] = [
      [{ source: 'status', operator: 'eq', expected: '200' }, true],
      [{ source: 'status', operator: 'neq', expected: '500' }, true],
      [{ source: 'status', operator: 'neq', expected: '200' }, false],
      [{ source: 'json', path: 's', operator: 'neq', expected: 'bye' }, true],
      [{ source: 'header', path: 'x-mode', operator: 'eq', expected: 'fast' }, true],
      [{ source: 'header', path: 'x-missing', operator: 'notExists' }, true],
      [{ source: 'header', path: 'x-missing', operator: 'exists' }, false],
      [{ source: 'header', operator: 'exists' }, false],
      [{ source: 'body', operator: 'contains', expected: 'hello' }, true],
      [{ source: 'body', operator: 'notContains', expected: 'nope' }, true],
      [{ source: 'json', path: 'n', operator: 'gt', expected: '4' }, true],
      [{ source: 'json', path: 'n', operator: 'gte', expected: '5' }, true],
      [{ source: 'json', path: 'n', operator: 'lt', expected: '6' }, true],
      [{ source: 'json', path: 'n', operator: 'lte', expected: '4' }, false],
      [{ source: 'json', path: 's', operator: 'gt', expected: '4' }, false],
      [{ source: 'json', path: 's', operator: 'matches', expected: '^he' }, true],
      [{ source: 'json', path: 's', operator: 'matches', expected: '(' }, false],
      [{ source: 'json', path: 'list', operator: 'isType', expected: 'ARRAY' }, true],
      [{ source: 'json', path: 'nothing', operator: 'isType', expected: 'null' }, true],
      [{ source: 'json', path: 'n', operator: 'isType', expected: 'number' }, true],
      [{ source: 'json', path: 'nested', operator: 'contains', expected: '"a":1' }, true],
      [{ source: 'json', path: 'missing', operator: 'exists' }, false],
      [{ source: 'json', path: 'missing', operator: 'notExists' }, true],
      [{ source: 'json', operator: 'exists' }, true],
      [{ source: 'duration', operator: 'lt', expected: '60000' }, true],
      [{ source: 'json', path: 'n', operator: 'eq', expected: '5.0' }, true],
      [{ source: 'json', path: 's', operator: 'eq', expected: 'hello' }, true],
    ];
    expect(await check(cases.map(([item]) => assertion(item)))).toEqual(
      cases.map(([, expected]) => expected),
    );
  });

  it('reads json assertions of a body that is not json as absent', async () => {
    const result = await run(
      request({ assertions: [assertion({ path: 'a', operator: 'notExists' })] }),
      { fetch: fakeFetch({ body: 'not json' }) },
    );
    expect(result.assertions[0]).toMatchObject({ passed: true, actual: '' });
  });

  it('captures status, header, body and json values', async () => {
    const captures: Capture[] = [
      { variable: 'status', source: 'status' },
      { variable: 'mode', source: 'header', path: 'x-mode' },
      { variable: 'nohdr', source: 'header', path: 'x-none' },
      { variable: 'nohdr2', source: 'header' },
      { variable: 'raw', source: 'body' },
      { variable: 'n', source: 'json', path: 'n' },
      { variable: 'obj', source: 'json', path: 'nested' },
      { variable: 'absent', source: 'json', path: 'absent' },
      { variable: 'whole', source: 'json' },
      { variable: '  ', source: 'status' },
      { variable: 'secretVar', source: 'json', path: 's' },
    ];
    const scope = new LayeredScope({
      collection: [{ key: 'secretVar', value: 'old', secret: true }],
    });
    await run(
      request({ captures }),
      {
        fetch: fakeFetch({ body, headers: [['x-mode', 'fast']] }),
      },
      scope,
    );
    expect(scope.get('status')?.value).toBe('200');
    expect(scope.get('mode')?.value).toBe('fast');
    expect(scope.get('nohdr')).toBeUndefined();
    expect(scope.get('nohdr2')).toBeUndefined();
    expect(scope.get('raw')?.value).toBe(body);
    expect(scope.get('n')?.value).toBe('5');
    expect(scope.get('obj')?.value).toBe('{"a":1}');
    expect(scope.get('absent')).toBeUndefined();
    expect(scope.get('whole')?.value).toBe(body);
    expect(scope.get('secretVar')).toEqual({ value: 'hello', secret: true });

    await run(
      request({ captures: [{ variable: 'x', source: 'json', path: 'a' }] }),
      {
        fetch: fakeFetch({ body: 'not json' }),
      },
      scope,
    );
    expect(scope.get('x')).toBeUndefined();
  });

  it('reads repeated response headers', async () => {
    const scope = new LayeredScope();
    const result = await run(
      request({
        captures: [{ variable: 'cookies', source: 'header', path: 'set-cookie' }],
        assertions: [
          assertion({ source: 'header', path: 'X-Dup', operator: 'eq', expected: 'a, b' }),
        ],
      }),
      {
        fetch: fakeFetch({
          headers: [
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
            ['x-dup', 'a'],
            ['x-dup', 'b'],
          ],
        }),
        keepResponse: true,
      },
      scope,
    );
    expect(scope.get('cookies')?.value).toBe('a=1\nb=2');
    expect(result.passed).toBe(true);
    expect(result.response?.headers['set-cookie']).toBe('a=1\nb=2');
  });
});

describe('the result', () => {
  it('keeps the response, masks credentials and hides sensitive headers', async () => {
    const result = await run(
      request({ method: 'POST', body: { mode: 'json', content: '{"token":"tok-12345"}' } }),
      {
        keepResponse: true,
        previewBytes: 5,
        auth: { type: 'apikey', key: 'X-Key', value: 'tok-12345', in: 'header' },
        settings: { proxy: { enabled: false, password: '{{pp}}' } as never },
        fetch: fakeFetch({ body: 'echo tok-12345 and more', headers: [['x-echo', 'tok-12345']] }),
      },
      new LayeredScope({ collection: [{ key: 'pp', value: 'proxy-pass' }] }),
    );
    expect(result.response).toMatchObject({ bodyPreview: 'echo ', truncated: true });
    expect(result.response?.headers['x-echo']).toBe('••••••');
    expect(result.timeline?.request.headers['X-Key']).toBe('••••••');
    expect(result.timeline?.request.bodyPreview).toBe('{"token":"••••••"}');
    expect(result.timeline?.httpVersion).toBe('1.1');
  });

  it('shows status text and the plain body of a successful call', async () => {
    const result = await run(request(), {
      keepResponse: true,
      fetch: fakeFetch({ body: 'ok' }),
    });
    expect(result.response).toMatchObject({ bodyPreview: 'ok' });
    expect(result.response?.truncated).toBeUndefined();
    expect(result.timeline?.request.bodyPreview).toBeUndefined();
  });

  it('reports a response as truncated when the transport cut it', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 10);
    const result = await run(request(), { keepResponse: true, fetch: fakeFetch({ body: big }) });
    expect(result.response?.truncated).toBe(true);
  });
});

describe('over the node transport', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('records the remote address and the redirects in the timeline', async () => {
    const result = await executeRequest(request({}, `${base}/redirect`), new LayeredScope(), {
      auth: { type: 'none' },
      keepResponse: true,
    });
    expect(result.passed).toBe(true);
    expect(result.timeline?.remoteAddress).toContain('127.0.0.1');
    expect(result.timeline?.redirects?.length).toBe(1);
    expect(result.response?.bodyPreview).toBe('final');
  });
});

describe('failures', () => {
  it('reports the cause of a network error', async () => {
    const failing = (() =>
      Promise.reject(new Error('fetch failed', { cause: new Error('ECONNREFUSED') }))) as never;
    expect((await run(request(), { fetch: failing })).error).toBe('fetch failed: ECONNREFUSED');
    const ws = request({ kind: 'websocket' }, 'ws://x.test/');
    streams.websocketExchange.mockRejectedValueOnce(new Error('plain'));
    expect((await run(ws)).error).toBe('plain');
    streams.websocketExchange.mockRejectedValueOnce('odd');
    expect((await run(ws)).error).toBe('odd');
  });

  it('reports a timeout of the whole exchange', async () => {
    streams.websocketExchange.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 1_150)),
    );
    const spec = request({ kind: 'websocket', timeoutMs: 1 }, 'ws://x.test/');
    const [alone, withSignal] = await Promise.all([
      run(spec),
      run(spec, { signal: new AbortController().signal }),
    ]);
    expect(alone.error).toBe('Timed out after 1 ms');
    expect(withSignal.error).toBe('Timed out after 1 ms');
  });

  it('does not call a cancelled run a timeout', async () => {
    const controller = new AbortController();
    streams.websocketExchange.mockImplementation(async () => {
      controller.abort();
      throw new Error('cancelled');
    });
    const result = await run(request({ kind: 'websocket' }, 'ws://x.test/'), {
      signal: controller.signal,
    });
    expect(result.error).toBe('cancelled');
  });

  it('rejects an unsupported request kind', async () => {
    const result = await run(request({ kind: 'carrier-pigeon' as RequestKind }));
    expect(result.error).toBe('Unsupported request kind carrier-pigeon');
  });
});

const exchange = (extra: Record<string, unknown> = {}) => ({
  status: 101,
  statusText: 'Switching Protocols',
  headers: [['x-h', '1']],
  messages: [
    { direction: 'sent', at: 0, data: '{"hi":1}' },
    { direction: 'received', at: 1, data: '{"n":1}' },
    { direction: 'received', at: 2, data: 'plain text' },
  ],
  sizeBytes: 20,
  durationMs: 12.4,
  ...extra,
});

describe('streams', () => {
  it('runs a websocket exchange', async () => {
    streams.websocketExchange.mockResolvedValue(
      exchange({
        timings: { total: 12 },
        remoteAddress: '1.2.3.4:80',
      }),
    );
    const cookies = new CookieJar();
    cookies.set({ name: 'ws', value: '1', domain: 'x.test', path: '/' });
    const result = await run(
      request(
        {
          kind: 'websocket',
          websocket: {
            messages: [{ content: 'hello {{name}}' }],
            subprotocols: ['chat'],
            listenMs: 50,
            maxMessages: 3,
          },
          assertions: [{ id: 'a', source: 'json', path: '0.n', operator: 'eq', expected: '1' }],
          captures: [{ variable: 'second', source: 'json', path: '1' }],
        },
        'ws://x.test/socket',
      ),
      {
        keepResponse: true,
        cookies,
        auth: { type: 'bearer', token: 'tok-12345' },
      },
      new LayeredScope({ collection: [{ key: 'name', value: 'bob' }] }),
    );
    const [input, network] = streams.websocketExchange.mock.calls[0]!;
    expect(input).toMatchObject({
      messages: [{ content: 'hello bob' }],
      subprotocols: ['chat'],
      listenMs: 50,
      maxMessages: 3,
    });
    expect(Object.fromEntries(input.headers)).toMatchObject({
      Authorization: 'Bearer tok-12345',
      cookie: 'ws=1',
    });
    expect(network.signal).toBeDefined();
    expect(result).toMatchObject({ passed: true, status: 101, kind: 'websocket' });
    expect(result.response?.messages).toHaveLength(3);
    expect(result.timeline).toMatchObject({ timings: { total: 12 }, remoteAddress: '1.2.3.4:80' });
  });

  it('uses websocket defaults, existing cookie headers and fails on exchange errors', async () => {
    streams.websocketExchange.mockResolvedValue(
      exchange({
        status: null,
        statusText: undefined,
        error: 'handshake rejected',
        timings: { total: 1 },
        durationMs: 0,
      }),
    );
    const cookies = new CookieJar();
    cookies.set({ name: 'ws', value: '1', domain: 'x.test', path: '/' });
    const result = await run(
      request({ kind: 'websocket', headers: [{ key: 'Cookie', value: 'own=1' }] }, 'ws://x.test/'),
      { cookies, keepResponse: true },
    );
    const [input] = streams.websocketExchange.mock.calls[0]!;
    expect(input).toMatchObject({ messages: [], listenMs: 2_000 });
    expect(input.subprotocols).toBeUndefined();
    expect(input.maxMessages).toBeUndefined();
    expect(Object.fromEntries(input.headers).Cookie).toBe('own=1');
    expect(result).toMatchObject({ passed: false, status: 0, error: 'handshake rejected' });
    expect(result.timeline?.remoteAddress).toBeUndefined();
    // Without cookies configured, or with cookies off, no cookie is added.
    await run(request({ kind: 'websocket' }, 'ws://x.test/'));
    await run(request({ kind: 'websocket' }, 'ws://x.test/'), {
      cookies,
      settings: { cookies: false },
    });
    for (const call of streams.websocketExchange.mock.calls.slice(1)) {
      expect(Object.fromEntries(call[0].headers).cookie).toBeUndefined();
    }
  });

  it('joins repeated response headers of a stream', async () => {
    streams.sseExchange.mockResolvedValue(
      exchange({
        status: 200,
        headers: [
          ['x-a', '1'],
          ['x-a', '2'],
          ['x-b', '3'],
        ],
      }),
    );
    const result = await run(request({ kind: 'sse' }, 'https://x.test/events'), {
      keepResponse: true,
    });
    expect(result.response?.headers).toEqual({ 'x-a': '1, 2', 'x-b': '3' });
  });

  it('runs sse exchanges with and without a body', async () => {
    streams.sseExchange.mockResolvedValue(exchange({ status: 200 }));
    await run(
      request(
        {
          kind: 'sse',
          method: 'POST',
          body: { mode: 'json', content: '{"q":"{{q}}"}' },
          sse: { listenMs: 10, maxEvents: 2 },
        },
        'https://x.test/events',
      ),
      {},
      new LayeredScope({ collection: [{ key: 'q', value: 'z' }] }),
    );
    expect(streams.sseExchange.mock.calls[0]![0]).toMatchObject({
      method: 'POST',
      body: '{"q":"z"}',
      listenMs: 10,
      maxEvents: 2,
    });
    await run(request({ kind: 'sse' }, 'https://x.test/events'));
    await run(
      request({ kind: 'sse', body: { mode: 'json', content: '{}' } }, 'https://x.test/events'),
    );
    for (const call of streams.sseExchange.mock.calls.slice(1)) {
      expect(call[0].body).toBeUndefined();
      expect(call[0].listenMs).toBe(5_000);
      expect(call[0].maxEvents).toBeUndefined();
    }
  });

  it('runs raw socket exchanges, without signing the request', async () => {
    streams.socketExchange.mockResolvedValue(exchange({ status: 0 }));
    await run(
      request(
        {
          kind: 'socket',
          socket: {
            messages: [{ content: 'ping {{n}}' }],
            listenMs: 5,
            readUntil: 'pong {{n}}',
            responseEncoding: 'hex',
          },
        },
        'tcp://x.test:9000',
      ),
      { auth: { type: 'bearer', token: 'tok-12345' } },
      new LayeredScope({ collection: [{ key: 'n', value: '1' }] }),
    );
    expect(streams.socketExchange.mock.calls[0]![0]).toMatchObject({
      messages: [{ content: 'ping 1' }],
      listenMs: 5,
      readUntil: 'pong 1',
      responseEncoding: 'hex',
    });
    await run(request({ kind: 'socket' }, 'tcp://x.test:9000'));
    expect(streams.socketExchange.mock.calls[1]![0]).toMatchObject({
      messages: [],
      listenMs: 2_000,
      responseEncoding: 'text',
    });
    expect(streams.socketExchange.mock.calls[1]![0].readUntil).toBeUndefined();
  });
});

describe('grpc', () => {
  const reply = (extra: Record<string, unknown> = {}) => ({
    status: 0,
    statusMessage: 'OK',
    headers: { 'x-h': '1' },
    trailers: { 'grpc-status': '0', 'x-secret': 'tok-12345' },
    messages: [{ direction: 'received', at: 1, data: '{"ok":true}' }],
    responses: [{ ok: true }],
    sizeBytes: 11,
    durationMs: 3.2,
    ...extra,
  });

  it('calls a method with the proto file and a single message', async () => {
    grpc.grpcCall.mockResolvedValue(reply());
    const result = await run(
      request(
        {
          kind: 'grpc',
          grpc: { method: '{{svc}}/Get', protoFile: 'a.proto', message: '{"id":"{{id}}"}' },
          assertions: [{ id: 'a', source: 'json', path: 'ok', operator: 'eq', expected: 'true' }],
        },
        'grpc://x.test:50051',
      ),
      {
        keepResponse: true,
        protoFiles: [{ name: 'a.proto', content: 'syntax = "proto3";' }],
        auth: { type: 'bearer', token: 'tok-12345' },
      },
      new LayeredScope({
        collection: [
          { key: 'svc', value: 'pkg.Svc' },
          { key: 'id', value: '7' },
        ],
      }),
    );
    const [target, method, messages] = grpc.grpcCall.mock.calls[0]!;
    expect(target).toMatchObject({ protoFile: 'a.proto', reflection: false });
    expect(Object.fromEntries(target.metadata)).toMatchObject({
      Authorization: 'Bearer tok-12345',
    });
    expect(method).toBe('pkg.Svc/Get');
    expect(messages).toEqual([{ id: '7' }]);
    expect(result).toMatchObject({ passed: true, status: 0, kind: 'grpc' });
    expect(result.response?.trailers).toEqual({ 'grpc-status': '0', 'x-secret': '••••••' });
    expect(result.response?.statusText).toBe('OK');
  });

  it('streams several messages and uses reflection by default', async () => {
    grpc.grpcCall.mockResolvedValue(reply({ responses: [{ a: 1 }, { a: 2 }], trailers: {} }));
    const result = await run(
      request(
        { kind: 'grpc', grpc: { method: 'pkg.Svc/Stream', message: '[{"a":1},{"a":2}]' } },
        'grpc://x.test:50051',
      ),
      { keepResponse: true },
    );
    const [target, , messages] = grpc.grpcCall.mock.calls[0]!;
    expect(target).toMatchObject({ reflection: true, protoFiles: [] });
    expect(target.protoFile).toBeUndefined();
    expect(messages).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.response?.bodyPreview).toBe('[{"a":1},{"a":2}]');
  });

  it('falls back to the draft message when a script removes the body', async () => {
    grpc.grpcCall.mockResolvedValue(reply());
    const scripting: RequestScripting = {
      pre: (view) => Promise.resolve(step({ request: { ...view, body: undefined } })),
      post: () => Promise.resolve(step()),
      tests: () => Promise.resolve(step()),
    };
    await run(
      request({ kind: 'grpc', grpc: { method: 'a/B', message: '{"x":1}' } }, 'grpc://x.test:1'),
      { scripting },
    );
    expect(grpc.grpcCall.mock.calls[0]![2]).toEqual([{ x: 1 }]);
  });

  it('uses an empty message by default and rejects invalid json', async () => {
    grpc.grpcCall.mockResolvedValue(reply());
    await run(request({ kind: 'grpc' }, 'grpc://x.test:50051'));
    expect(grpc.grpcCall.mock.calls[0]![1]).toBe('');
    expect(grpc.grpcCall.mock.calls[0]![2]).toEqual([{}]);
    await run(
      request({ kind: 'grpc', grpc: { method: 'a/B', message: '   ' } }, 'grpc://x.test:50051'),
    );
    expect(grpc.grpcCall.mock.calls[1]![2]).toEqual([{}]);
    const invalid = await run(
      request({ kind: 'grpc', grpc: { method: 'a/B', message: '{oops' } }, 'grpc://x.test:50051'),
    );
    expect(invalid.error).toBe('The gRPC message is not valid JSON.');
  });
});
