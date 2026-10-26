import { describe, expect, it } from 'vitest';
import type { CollectionInput } from '../src/modules/apitests/domain/api-test.js';
import type { ApiRequestSpec, LoadThreshold } from '../src/modules/apitests/engine/types.js';
import { exportK6 } from '../src/modules/apitests/formats/k6.js';

const request = (overrides: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id: 'r',
  type: 'request',
  name: 'Req',
  method: 'GET',
  url: '{{baseUrl}}/x',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...overrides,
});

const collection: CollectionInput = {
  name: 'Load',
  variables: [
    { key: 'baseUrl', value: 'https://api.test' },
    { key: 'off', value: 'x', enabled: false },
    { key: '  ', value: 'blank' },
    { key: 'token', value: 'never-written', secret: true },
  ],
  auth: { type: 'basic', username: '{{user}}', password: 'p' },
  items: [
    request({
      id: 'checks',
      name: 'Checks',
      method: 'POST',
      headers: [
        { key: 'content-type', value: 'application/vnd+json' },
        { key: 'X-Off', value: '1', enabled: false },
        { key: ' ', value: 'blank' },
      ],
      query: [
        { key: 'q', value: '{{$randomFullName}}' },
        { key: 'skip', value: '1', enabled: false },
      ],
      body: {
        mode: 'json',
        content: '{"a":"{{$randomFullName}}","id":"{{$guid}}","x":"{{$nope}}"}',
      },
      assertions: [
        { id: '1', source: 'status', operator: 'eq', expected: '200' },
        { id: '2', source: 'duration', operator: 'lt', expected: '500' },
        { id: '3', source: 'header', path: 'content-type', operator: 'contains', expected: 'json' },
        { id: '4', source: 'header', operator: 'exists' },
        { id: '5', source: 'body', operator: 'notContains', expected: 'error' },
        { id: '6', source: 'json', path: '$.items[0]["id"]', operator: 'neq', expected: 'x' },
        { id: '7', source: 'json', operator: 'notExists' },
        { id: '8', source: 'json', path: 'n', operator: 'lte', expected: '3' },
        { id: '9', source: 'json', path: 'n', operator: 'gt', expected: '1' },
        { id: '10', source: 'json', path: 'n', operator: 'gte', expected: '2' },
        { id: '11', source: 'json', path: 's', operator: 'matches', expected: '^a' },
        { id: '12', source: 'json', path: 's', operator: 'isType', expected: 'String' },
      ],
      captures: [
        { variable: 's', source: 'status' },
        { variable: 'h', source: 'header', path: 'x-request-id' },
        { variable: 'hh', source: 'header' },
        { variable: 'b', source: 'body' },
        { variable: 'j', source: 'json', path: 'data[1]' },
        { variable: 'jj', source: 'json' },
      ],
    }),
    request({
      id: 'xml',
      name: 'Xml',
      body: { mode: 'xml', content: '<a/>' },
      auth: { type: 'none' },
    }),
    request({
      id: 'text',
      name: 'Text',
      body: { mode: 'text', content: 't' },
      auth: { type: 'apikey', key: 'k', value: 'v', in: 'query' },
    }),
    request({
      id: 'form',
      name: 'Form',
      body: {
        mode: 'form',
        fields: [
          { key: 'a', value: '1' },
          { key: 'b', value: '2', enabled: false },
        ],
      },
      auth: { type: 'apikey', key: 'X-Key', value: 'v', in: 'header' },
    }),
    request({
      id: 'enc',
      name: 'Encoded',
      body: { mode: 'urlencoded', fields: [{ key: 'c', value: 'd' }] },
      auth: { type: 'bearer', token: '{{token}}' },
    }),
  ],
};

const thresholds: LoadThreshold[] = [
  { metric: 'avg', operator: 'lt', value: 300 },
  { metric: 'p50', operator: 'lte', value: 200 },
  { metric: 'max', operator: 'gt', value: 1 },
  { metric: 'p90', operator: 'gte', value: 2 },
  { metric: 'p99', operator: 'lt', value: 900, abortOnFail: true },
  { metric: 'errorRate', operator: 'lt', value: 0.01 },
  { metric: 'rps', operator: 'gt', value: 10 },
  { metric: 'checksRate', operator: 'gte', value: 0.99 },
];

describe('exportK6 edge cases', () => {
  it('writes thresholds, checks, auth lines, bodies, captures and mock pools', () => {
    const script = exportK6(
      collection,
      {
        name: 'Mixed',
        requests: [
          { requestId: 'checks', weight: 0 },
          { requestId: 'xml', weight: 2 },
          { requestId: 'text', weight: 1 },
          { requestId: 'form', weight: 1 },
          { requestId: 'enc', weight: 1 },
          { requestId: 'missing', weight: 5 },
        ],
        stages: [{ durationSec: 10, targetVus: 2 }],
        thinkTimeMs: 250,
        thresholds,
        timeoutMs: 5000,
      },
      [{ key: 'user', value: 'env-user' }],
    );
    const options = JSON.parse(
      /export const options = (\{[\s\S]*?\n\});/.exec(script)![1]!,
    ) as Record<string, any>;
    expect(options['thresholds']).toEqual({
      http_req_duration: [
        'avg<300',
        'med<=200',
        'max>1',
        'p(90)>=2',
        { threshold: 'p(99)<900', abortOnFail: true, delayAbortEval: '10s' },
      ],
      http_req_failed: ['rate<0.01'],
      http_reqs: ['rate>10'],
      checks: ['rate>=0.99'],
    });
    expect(script).toContain('// Run with: k6 run -e token=... script.js');
    expect(script).toContain(`"token": __ENV["token"] || '',`);
    expect(script).not.toContain('never-written');
    expect(script).not.toContain('"off"');
    expect(script).toContain(`"user": __ENV["user"] || "env-user",`);
    expect(script).toContain('weight: 1,');
    expect(script).toContain('weight: 2,');
    expect(script).not.toContain(`headers['Content-Type'] = "application/json"`);
    expect(script).not.toContain('X-Off');
    expect(script).not.toContain('skip');
    for (const line of [
      'String(r.status) === v("200")',
      'Number(r.timings.duration) < 500',
      'String(r.headers["Content-Type"]).includes(v("json"))',
      'r.headers[""] !== undefined',
      '!String(r.body).includes(v("error"))',
      'String(json(r, "items.0.id")) !== v("x")',
      'json(r, "") === undefined',
      'Number(json(r, "n")) <= 3',
      'Number(json(r, "n")) > 1',
      'Number(json(r, "n")) >= 2',
      'new RegExp("^a").test(String(json(r, "s")))',
      'typeOf(json(r, "s")) === "string"',
      `vars["s"] = String(String(r.status) ?? '');`,
      `vars["h"] = String(r.headers["X-Request-Id"] ?? '');`,
      `vars["hh"] = String(r.headers[""] ?? '');`,
      `vars["b"] = String(r.body ?? '');`,
      `vars["j"] = String(json(r, "data.1") ?? '');`,
      `vars["jj"] = String(json(r, "") ?? '');`,
      `headers['Authorization'] = 'Basic ' + encoding.b64encode(v("{{user}}") + ':' + v("p"));`,
      `headers['Content-Type'] = "application/xml";`,
      `headers['Content-Type'] = "text/plain";`,
      `query.push(encodeURIComponent(v("k")) + '=' + encodeURIComponent(v("v")));`,
      `headers[v("X-Key")] = v("v");`,
      `headers['Authorization'] = 'Bearer ' + v("{{token}}");`,
      '{ [v("a")]: v("1") }',
      '{ [v("c")]: v("d") }',
      `timeout: '5000ms'`,
      'sleep(0.25);',
    ]) {
      expect(script).toContain(line);
    }
    const pools = JSON.parse(/const pools = (\{[\s\S]*?\n\});/.exec(script)![1]!) as Record<
      string,
      string[]
    >;
    expect(Object.keys(pools)).toEqual(['$randomFullName']);
    expect(pools['$randomFullName']).toHaveLength(40);
  });

  it('omits timeouts, checks and the Content-Type header when they are not needed', () => {
    const script = exportK6(
      { name: 'Bare', variables: [], auth: { type: 'inherit' }, items: [request()] },
      {
        name: 'Bare',
        requests: [{ requestId: 'r', weight: 1 }],
        stages: [],
        thinkTimeMs: 0,
        thresholds: [],
      },
    );
    expect(script).toContain('// Run with: k6 run script.js');
    expect(script).not.toContain('timeout:');
    expect(script).not.toContain('check(r');
    expect(script).not.toContain(`headers['Content-Type']`);
    expect(script).not.toContain('Authorization');
    expect(script).toContain('http.request("GET", url, null,');
    expect(script).toContain('const pools = {};');
  });
});
