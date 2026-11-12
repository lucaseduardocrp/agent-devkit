import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import { exportK6 } from '../src/modules/apitests/formats/k6.js';
import type {
  ApiRequestSpec,
  Assertion,
  LoadMetric,
  RequestAuth,
} from '../src/modules/apitests/engine/types.js';

const request = (id: string, extra: Partial<ApiRequestSpec> = {}): ApiRequestSpec =>
  ({
    id,
    type: 'request',
    name: id,
    method: 'GET',
    url: 'https://api.test/x',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
    ...extra,
  }) as ApiRequestSpec;

const collectionOf = (
  items: ApiRequestSpec[],
  auth: RequestAuth = { type: 'none' },
): CollectionInput => ({ name: 'C', variables: [], auth, items }) as unknown as CollectionInput;

function script(
  items: ApiRequestSpec[],
  options: {
    auth?: RequestAuth;
    weights?: number[];
    thresholds?: {
      metric: LoadMetric;
      operator: 'lt' | 'lte' | 'gt' | 'gte';
      value: number;
      abortOnFail?: boolean;
    }[];
    timeoutMs?: number;
    environment?: { key: string; value: string; secret?: boolean; enabled?: boolean }[];
    variables?: { key: string; value: string; secret?: boolean; enabled?: boolean }[];
    extraRequests?: { requestId: string; weight: number }[];
  } = {},
): string {
  const collection = {
    ...collectionOf(items, options.auth),
    variables: options.variables ?? [],
  } as CollectionInput;
  return exportK6(
    collection,
    {
      name: 'Scenario',
      requests: [
        ...items.map((item, index) => ({
          requestId: item.id,
          weight: options.weights?.[index] ?? 1,
        })),
        ...(options.extraRequests ?? []),
      ],
      stages: [{ durationSec: 5, targetVus: 2 }],
      thinkTimeMs: 500,
      thresholds: options.thresholds ?? [],
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    },
    options.environment ?? [],
  );
}

describe('k6 thresholds', () => {
  it('maps every metric and operator and groups them by k6 metric', () => {
    const output = script([request('a')], {
      thresholds: [
        { metric: 'avg', operator: 'lt', value: 100 },
        { metric: 'p50', operator: 'lte', value: 90 },
        { metric: 'p90', operator: 'gt', value: 1 },
        { metric: 'p95', operator: 'gte', value: 2 },
        { metric: 'p99', operator: 'lt', value: 3, abortOnFail: true },
        { metric: 'max', operator: 'lt', value: 4 },
        { metric: 'errorRate', operator: 'lt', value: 0.1 },
        { metric: 'rps', operator: 'gt', value: 5 },
        { metric: 'checksRate', operator: 'gt', value: 0.9 },
      ],
    });
    expect(output).toContain('"avg<100"');
    expect(output).toContain('"med<=90"');
    expect(output).toContain('"p(90)>1"');
    expect(output).toContain('"p(95)>=2"');
    expect(output).toContain('"threshold": "p(99)<3"');
    expect(output).toContain('"abortOnFail": true');
    expect(output).toContain('"max<4"');
    expect(output).toContain('"http_req_failed"');
    expect(output).toContain('"rate<0.1"');
    expect(output).toContain('"http_reqs"');
    expect(output).toContain('"checks"');
  });
});

describe('k6 assertions and captures', () => {
  const assertion = (
    source: Assertion['source'],
    operator: Assertion['operator'],
    extra: Partial<Assertion> = {},
  ): Assertion => ({ id: `${source}-${operator}`, source, operator, ...extra }) as Assertion;

  it('writes a check for every assertion source and operator', () => {
    const assertions: Assertion[] = [
      assertion('status', 'eq', { expected: '200' }),
      assertion('duration', 'lt', { expected: '300' }),
      assertion('header', 'contains', { path: 'content-type', expected: 'json' }),
      assertion('header', 'exists'),
      assertion('body', 'notContains', { expected: 'error' }),
      assertion('json', 'neq', { path: '$.data[0].id', expected: '1' }),
      assertion('json', 'exists', { path: "data['a b'].x" }),
      assertion('json', 'notExists'),
      assertion('json', 'lte', { path: 'n', expected: '5' }),
      assertion('json', 'gt', { path: 'n', expected: '1' }),
      assertion('json', 'gte', { path: 'n', expected: '2' }),
      assertion('json', 'matches', { path: 's', expected: '^a' }),
      assertion('json', 'isType', { path: 's', expected: 'String' }),
    ];
    const output = script([request('a', { assertions })]);
    expect(output).toContain('r.status');
    expect(output).toContain('r.timings.duration');
    expect(output).toContain('r.headers["Content-Type"]');
    expect(output).toContain('r.headers[""]');
    expect(output).toContain('r.body');
    expect(output).toContain('json(r, "data.0.id")');
    expect(output).toContain('json(r, "data.a b.x")');
    expect(output).toContain('json(r, "")');
    expect(output).toContain('Number(json(r, "n")) <= 5');
    expect(output).toContain('new RegExp("^a")');
    expect(output).toContain('typeOf(json(r, "s")) === "string"');
  });

  it('assigns captures from every source', () => {
    const output = script([
      request('a', {
        captures: [
          { variable: 'status', source: 'status' },
          { variable: 'header', source: 'header', path: 'x-token' },
          { variable: 'nopath', source: 'header' },
          { variable: 'body', source: 'body' },
          { variable: 'id', source: 'json', path: 'data.id' },
          { variable: 'whole', source: 'json' },
        ] as ApiRequestSpec['captures'],
      }),
    ]);
    expect(output).toContain('vars["status"] = String(String(r.status) ?? \'\');');
    expect(output).toContain('r.headers["X-Token"]');
    expect(output).toContain('vars["body"] = String(r.body ?? \'\');');
    expect(output).toContain('json(r, "data.id")');
  });
});

describe('k6 auth', () => {
  const auths = (list: RequestAuth[]) =>
    script(list.map((auth, index) => request(`r${index}`, { auth })));

  it('translates the supported schemes and flags the rest', () => {
    const output = auths([
      { type: 'bearer', token: '{{t}}' },
      { type: 'basic', username: 'u', password: 'p' },
      { type: 'apikey', key: 'k', value: 'v', in: 'query' },
      { type: 'apikey', key: 'k', value: 'v', in: 'header' },
      { type: 'none' },
      { type: 'digest', username: 'u', password: 'p' },
    ]);
    expect(output).toContain("headers['Authorization'] = 'Bearer ' + v(\"{{t}}\");");
    expect(output).toContain('encoding.b64encode');
    expect(output).toContain('query.push(encodeURIComponent(v("k"))');
    expect(output).toContain('headers[v("k")] = v("v");');
    expect(output).toContain('// TODO: digest auth is not exported to k6');
  });

  it('uses the collection auth for requests that inherit it', () => {
    const output = script([request('a')], { auth: { type: 'bearer', token: 'abc' } });
    expect(output).toContain('Bearer');
  });
});

describe('k6 bodies', () => {
  it('sets content types and body expressions per mode', () => {
    const output = script([
      request('json', { body: { mode: 'json', content: '{}' } }),
      request('xml', { body: { mode: 'xml', content: '<a/>' } }),
      request('sparql', { body: { mode: 'sparql', content: 'ASK {}' } }),
      request('text', { body: { mode: 'text', content: 'hi' } }),
      request('own', {
        body: { mode: 'json', content: '{}' },
        headers: [{ key: 'content-type', value: 'application/vnd.x+json' }],
      }),
      request('disabled', {
        body: { mode: 'json', content: '{}' },
        headers: [{ key: 'Content-Type', value: 'x', enabled: false }],
      }),
      request('urlencoded', {
        body: {
          mode: 'urlencoded',
          fields: [
            { key: 'a', value: '1' },
            { key: 'b', value: '2', enabled: false },
          ],
        },
      }),
      request('form', {
        body: { mode: 'form', fields: [{ key: 'f', value: 'v', type: 'text' }] } as never,
      }),
      request('binary', { body: { mode: 'binary', file: null } }),
    ]);
    expect(output).toContain('application/json');
    expect(output).toContain('application/xml');
    expect(output).toContain('application/sparql-query');
    expect(output).toContain('text/plain');
    expect(output).toContain('{ [v("a")]: v("1") }');
    expect(output).toContain('{ [v("f")]: v("v") }');
    expect(output).toContain('url, null,');
    expect(output).toContain('v("{}")');
  });
});

describe('k6 graphql and unsupported kinds', () => {
  it('posts GraphQL as JSON, dropping invalid variables', () => {
    const output = script([
      request('full', {
        kind: 'graphql',
        graphql: { query: '{ a }', variables: '{"x":1}', operationName: 'Op' },
      }),
      request('badvars', { kind: 'graphql', graphql: { query: '{ b }', variables: '{oops' } }),
      request('blank', { kind: 'graphql', graphql: { query: '{ c }', variables: '  ' } }),
      request('missing', { kind: 'graphql' }),
    ]);
    expect(output).toContain('"POST"');
    expect(output).toContain('\\"variables\\":{\\"x\\":1}');
    expect(output).toContain('\\"operationName\\":\\"Op\\"');
    expect(output).toContain('{ b }');
    expect(output).not.toContain('oops');
  });

  it('comments out request kinds k6 cannot run', () => {
    const output = script([request('stream', { kind: 'websocket' as never, name: 'Live feed' })]);
    expect(output).toContain('// Live feed: websocket requests are not exported to k6');
  });
});

describe('k6 scenario details', () => {
  it('writes weights, timeouts and variables with secrets read from the environment', () => {
    const output = script([request('a'), request('b')], {
      weights: [0, 3],
      timeoutMs: 2500,
      variables: [
        { key: 'host', value: 'h' },
        { key: 'token', value: 'secret-value', secret: true },
        { key: 'off', value: 'x', enabled: false },
        { key: '  ', value: 'blank' },
      ],
      environment: [{ key: 'host', value: 'override' }],
      extraRequests: [{ requestId: 'missing', weight: 1 }],
    });
    expect(output).toContain('weight: 1,');
    expect(output).toContain('weight: 3,');
    expect(output).toContain("timeout: '2500ms'");
    expect(output).toContain('"token": __ENV["token"] || \'\',');
    expect(output).toContain('"host": __ENV["host"] || "override",');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('"off"');
    expect(output).toContain('k6 run -e token=... script.js');
  });

  it('generates pools only for the mock values it cannot compute itself', () => {
    const output = script([
      request('a', {
        url: 'https://api.test/{{$randomFullName}}/{{$guid}}/{{$notAHelper}}/{{$randomFullName}}',
      }),
    ]);
    expect(output).toMatch(/"\$randomFullName": \[/);
    expect(output).not.toMatch(/"\$guid": \[/);
    expect(output).not.toMatch(/"\$notAHelper": \[/);
  });

  it('omits the check block when there are no assertions', () => {
    expect(script([request('a')])).not.toContain('check(r, {');
  });
});

describe('k6 query strings', () => {
  it('encodes the enabled query parameters', () => {
    const output = script([
      request('a', {
        query: [
          { key: 'q', value: 'a b' },
          { key: 'off', value: 'x', enabled: false },
          { key: ' ', value: 'blank' },
        ],
      }),
    ]);
    expect(output).toContain(
      'const query = [encodeURIComponent(v("q")) + \'=\' + encodeURIComponent(v("a b"))];',
    );
  });
});
