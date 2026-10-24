import type { CollectionInput, LoadScenarioInput } from '../domain/api-test.js';
import { flattenRequests } from '../engine/collection-runner.js';
import { DYNAMIC_VALUE_NAMES, resolveDynamicValue } from '../engine/dynamic-values.js';
import { fillPathParams } from '../engine/http-request.js';
import type {
  Assertion,
  LoadThreshold,
  RequestAuth,
  RequestBody,
  Variable,
} from '../engine/types.js';

// A load scenario as a k6 script (https://k6.io): the same stages, thresholds and weighted
// requests, so a scenario designed in ADK can run in any k6 pipeline. Secret variables are read
// from the environment (`k6 run -e token=...`) and never written into the script.

const js = (value: unknown) => JSON.stringify(value);

/** Mock values the script computes on its own; every other `{{$helper}}` draws from a pool. */
const NATIVE_HELPERS = new Set([
  '$guid',
  '$randomUUID',
  '$timestamp',
  '$isoTimestamp',
  '$randomInt',
]);
/** Values per pool: enough variety for a load test, small enough to keep the script readable. */
const POOL_SIZE = 40;

/** The pools of the mock values the scenario uses, generated now (k6 has no copy of the catalog). */
function mockPools(source: string): Record<string, string[]> {
  const known = new Set(DYNAMIC_VALUE_NAMES);
  const pools: Record<string, string[]> = {};
  for (const match of source.matchAll(/\{\{\s*(\$[\w]+)\s*\}\}/g)) {
    const name = match[1]!;
    if (!known.has(name) || NATIVE_HELPERS.has(name) || pools[name]) continue;
    pools[name] = Array.from({ length: POOL_SIZE }, () => resolveDynamicValue(name)!);
  }
  return pools;
}

/** `data.items[0].id` → `data.items.0.id` (k6 `res.json()` uses gjson paths). */
const gjson = (path: string) =>
  path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1');

function thresholdExpression(threshold: LoadThreshold): [string, string] {
  const op = { lt: '<', lte: '<=', gt: '>', gte: '>=' }[threshold.operator];
  switch (threshold.metric) {
    case 'avg':
      return ['http_req_duration', `avg${op}${threshold.value}`];
    case 'p50':
      return ['http_req_duration', `med${op}${threshold.value}`];
    case 'max':
      return ['http_req_duration', `max${op}${threshold.value}`];
    case 'p90':
    case 'p95':
    case 'p99':
      return ['http_req_duration', `p(${threshold.metric.slice(1)})${op}${threshold.value}`];
    case 'errorRate':
      return ['http_req_failed', `rate${op}${threshold.value}`];
    case 'rps':
      return ['http_reqs', `rate${op}${threshold.value}`];
    case 'checksRate':
      return ['checks', `rate${op}${threshold.value}`];
  }
}

function checkLine(assertion: Assertion): string {
  const expected = assertion.expected ?? '';
  let actual: string;
  switch (assertion.source) {
    case 'status':
      actual = 'r.status';
      break;
    case 'duration':
      actual = 'r.timings.duration';
      break;
    case 'header':
      actual = `r.headers[${js(headerKey(assertion.path ?? ''))}]`;
      break;
    case 'body':
      actual = 'r.body';
      break;
    case 'json':
      actual = `json(r, ${js(gjson(assertion.path ?? ''))})`;
      break;
  }
  const expression: Record<Assertion['operator'], string> = {
    eq: `String(${actual}) === v(${js(expected)})`,
    neq: `String(${actual}) !== v(${js(expected)})`,
    contains: `String(${actual}).includes(v(${js(expected)}))`,
    notContains: `!String(${actual}).includes(v(${js(expected)}))`,
    exists: `${actual} !== undefined && ${actual} !== null`,
    notExists: `${actual} === undefined || ${actual} === null`,
    lt: `Number(${actual}) < ${Number(expected)}`,
    lte: `Number(${actual}) <= ${Number(expected)}`,
    gt: `Number(${actual}) > ${Number(expected)}`,
    gte: `Number(${actual}) >= ${Number(expected)}`,
    matches: `new RegExp(${js(expected)}).test(String(${actual}))`,
    isType: `typeOf(${actual}) === ${js(expected.toLowerCase())}`,
  };
  const label = [assertion.source, assertion.path, assertion.operator, assertion.expected]
    .filter(Boolean)
    .join(' ');
  return `${js(label)}: (r) => ${expression[assertion.operator]}`;
}

/** k6 canonicalises header names (`Content-Type`). */
const headerKey = (name: string) =>
  name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');

function authLines(auth: RequestAuth): string[] {
  switch (auth.type) {
    case 'bearer':
      return [`headers['Authorization'] = 'Bearer ' + v(${js(auth.token)});`];
    case 'basic':
      return [
        `headers['Authorization'] = 'Basic ' + encoding.b64encode(v(${js(auth.username)}) + ':' + v(${js(auth.password)}));`,
      ];
    case 'apikey':
      return auth.in === 'query'
        ? [
            `query.push(encodeURIComponent(v(${js(auth.key)})) + '=' + encodeURIComponent(v(${js(auth.value)})));`,
          ]
        : [`headers[v(${js(auth.key)})] = v(${js(auth.value)});`];
    default:
      return [];
  }
}

function bodyExpression(body: RequestBody): string {
  switch (body.mode) {
    case 'none':
      return 'null';
    case 'json':
    case 'text':
    case 'xml':
      return `v(${js(body.content)})`;
    case 'urlencoded':
    case 'form':
      return `{ ${body.fields
        .filter((f) => f.enabled !== false)
        .map((f) => `[v(${js(f.key)})]: v(${js(f.value)})`)
        .join(', ')} }`;
  }
}

export function exportK6(
  collection: CollectionInput,
  scenario: Pick<
    LoadScenarioInput,
    'name' | 'requests' | 'stages' | 'thinkTimeMs' | 'thresholds' | 'timeoutMs'
  >,
  environment: readonly Variable[] = [],
): string {
  const variables = new Map<string, Variable>();
  for (const variable of [...collection.variables, ...environment]) {
    if (variable.enabled !== false && variable.key.trim())
      variables.set(variable.key.trim(), variable);
  }
  const all = flattenRequests(collection);
  const chosen = scenario.requests
    .map((entry) => ({ ...entry, flat: all.find((item) => item.request.id === entry.requestId) }))
    .filter((entry) => entry.flat);

  const thresholds = new Map<string, unknown[]>();
  for (const threshold of scenario.thresholds) {
    const [metric, expression] = thresholdExpression(threshold);
    thresholds.set(metric, [
      ...(thresholds.get(metric) ?? []),
      threshold.abortOnFail
        ? { threshold: expression, abortOnFail: true, delayAbortEval: '10s' }
        : expression,
    ]);
  }
  const options = {
    stages: scenario.stages.map((stage) => ({
      duration: `${stage.durationSec}s`,
      target: stage.targetVus,
    })),
    thresholds: Object.fromEntries(thresholds),
  };

  const requestBlocks = chosen.map(({ flat, weight }) => {
    const request = flat!.request;
    const enabled = (list: readonly { key: string; value: string; enabled?: boolean }[]) =>
      list.filter((entry) => entry.enabled !== false && entry.key.trim());
    const body = request.body;
    const contentType =
      body.mode === 'json'
        ? 'application/json'
        : body.mode === 'xml'
          ? 'application/xml'
          : body.mode === 'text'
            ? 'text/plain'
            : null;
    const lines = [
      `  {`,
      `    name: ${js(request.name)},`,
      `    weight: ${weight > 0 ? weight : 1},`,
      `    run() {`,
      `      const headers = { ${enabled(request.headers)
        .map((h) => `[v(${js(h.key)})]: v(${js(h.value)})`)
        .join(', ')} };`,
      ...(contentType &&
      !enabled(request.headers).some((h) => h.key.toLowerCase() === 'content-type')
        ? [`      headers['Content-Type'] = ${js(contentType)};`]
        : []),
      `      const query = [${enabled(request.query)
        .map(
          (q) =>
            `encodeURIComponent(v(${js(q.key)})) + '=' + encodeURIComponent(v(${js(q.value)}))`,
        )
        .join(', ')}];`,
      ...authLines(flat!.auth).map((line) => `      ${line}`),
      `      const url = v(${js(fillPathParams(request.url, request.pathParams))}) + (query.length ? '?' + query.join('&') : '');`,
      `      const r = http.request(${js(request.method)}, url, ${bodyExpression(body)}, { headers, tags: { name: ${js(request.name)} }${scenario.timeoutMs ? `, timeout: '${scenario.timeoutMs}ms'` : ''} });`,
      ...(request.assertions.length
        ? [
            `      check(r, {`,
            ...request.assertions.map((assertion) => `        ${checkLine(assertion)},`),
            `      });`,
          ]
        : []),
      ...request.captures.map((capture) => {
        const value =
          capture.source === 'status'
            ? 'String(r.status)'
            : capture.source === 'header'
              ? `r.headers[${js(headerKey(capture.path ?? ''))}]`
              : capture.source === 'body'
                ? 'r.body'
                : `json(r, ${js(gjson(capture.path ?? ''))})`;
        return `      vars[${js(capture.variable)}] = String(${value} ?? '');`;
      }),
      `    },`,
      `  },`,
    ];
    return lines.join('\n');
  });

  const pools = mockPools(
    JSON.stringify([
      chosen.map(({ flat }) => [flat!.request, flat!.auth]),
      [...variables.values()],
    ]),
  );
  const varLines = [...variables.values()].map((variable) =>
    variable.secret
      ? `  ${js(variable.key)}: __ENV[${js(variable.key)}] || '',`
      : `  ${js(variable.key)}: __ENV[${js(variable.key)}] || ${js(variable.value)},`,
  );

  return `// ${scenario.name} — exported from ADK (Overload Tests).
// Run with: k6 run${[...variables.values()]
    .filter((variable) => variable.secret)
    .map((variable) => ` -e ${variable.key}=...`)
    .join('')} script.js
import http from 'k6/http';
import encoding from 'k6/encoding';
import { check, sleep } from 'k6';

export const options = ${JSON.stringify(options, null, 2)};

// Each VU has its own copy, so captured values (tokens, ids) stay per virtual user.
const vars = {
${varLines.join('\n')}
};

// Mock values ({{$randomFullName}}, {{$randomEmail}}...): drawn from pools generated when the
// script was exported, so every request sends a different one.
const pools = ${JSON.stringify(pools, null, 2)};

function dynamic(name) {
  if (name === '$guid' || name === '$randomUUID') {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r % 4) + 8).toString(16);
    });
  }
  if (name === '$timestamp') return String(Math.floor(Date.now() / 1000));
  if (name === '$isoTimestamp') return new Date().toISOString();
  if (name === '$randomInt') return String(Math.floor(Math.random() * 1000));
  const pool = pools[name];
  return pool ? pool[Math.floor(Math.random() * pool.length)] : undefined;
}

function v(text) {
  return String(text).replace(/\\{\\{\\s*([$\\w.-]+)\\s*\\}\\}/g, (match, name) => {
    if (name in vars) return vars[name];
    const value = dynamic(name);
    return value === undefined ? match : value;
  });
}

function json(r, path) {
  try {
    return r.json(path);
  } catch (error) {
    return undefined;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const requests = [
${requestBlocks.join('\n')}
];
const totalWeight = requests.reduce((sum, request) => sum + request.weight, 0);

export default function () {
  let roll = Math.random() * totalWeight;
  const request = requests.find((candidate) => (roll -= candidate.weight) < 0) || requests[requests.length - 1];
  request.run();
  sleep(${scenario.thinkTimeMs / 1000});
}
`;
}
