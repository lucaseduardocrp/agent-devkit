import type {
  ApiRequestSpec,
  Assertion,
  AssertionResult,
  Capture,
  KeyValue,
  RequestAuth,
  RequestResult,
  Variable,
} from './types.js';

/** Response bytes kept in a result; the rest is only counted. */
const PREVIEW_BYTES = 4 * 1024;
/** Bytes read to evaluate body and JSON assertions and captures. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MASK = '••••••';

/** Values of the run, by name. Captures add to it as requests run. */
export type VariableScope = Map<string, { value: string; secret: boolean }>;

export function scopeOf(...lists: readonly (readonly Variable[])[]): VariableScope {
  const scope: VariableScope = new Map();
  for (const list of lists) {
    for (const variable of list) {
      if (variable.enabled === false || !variable.key.trim()) continue;
      scope.set(variable.key.trim(), { value: variable.value, secret: Boolean(variable.secret) });
    }
  }
  return scope;
}

/**
 * Replaces `{{name}}` with the variable value. Dynamic helpers follow Postman's names:
 * `{{$guid}}`/`{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`.
 * Unknown names are left as they are, so a missing variable is visible in the result.
 */
export function interpolate(text: string, scope: VariableScope): string {
  return text.replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (match, name: string) => {
    if (name === '$guid' || name === '$randomUUID') return crypto.randomUUID();
    if (name === '$timestamp') return String(Math.floor(Date.now() / 1000));
    if (name === '$isoTimestamp') return new Date().toISOString();
    if (name === '$randomInt') return String(Math.floor(Math.random() * 1000));
    return scope.get(name)?.value ?? match;
  });
}

/** Hides every secret value of the scope inside `text`. */
export function maskSecrets(text: string, scope: VariableScope): string {
  let masked = text;
  for (const { value, secret } of scope.values()) {
    if (secret && value.length >= 4) masked = masked.split(value).join(MASK);
  }
  return masked;
}

/** Reads `data.items[0].id`, `$.token` or `items.0.id` from parsed JSON; undefined when absent. */
export function readJsonPath(document: unknown, path: string): unknown {
  const segments = path
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[['"]([^'"]+)['"]\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = document;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const enabled = (list: readonly KeyValue[]) =>
  list.filter((entry) => entry.enabled !== false && entry.key.trim());

function applyAuth(auth: RequestAuth, headers: Headers, url: URL, scope: VariableScope): void {
  switch (auth.type) {
    case 'bearer':
      headers.set('authorization', `Bearer ${interpolate(auth.token, scope)}`);
      return;
    case 'basic': {
      const credentials = `${interpolate(auth.username, scope)}:${interpolate(auth.password, scope)}`;
      headers.set('authorization', `Basic ${Buffer.from(credentials).toString('base64')}`);
      return;
    }
    case 'apikey': {
      const key = interpolate(auth.key, scope);
      const value = interpolate(auth.value, scope);
      if (auth.in === 'query') url.searchParams.set(key, value);
      else headers.set(key, value);
      return;
    }
    default:
      return;
  }
}

export interface PreparedRequest {
  readonly url: URL;
  readonly init: RequestInit & { method: string; headers: Headers };
}

/** Path segments written as `:name`; a port (`host:8080`) never matches, it starts with a digit. */
const PATH_PARAM = /\/:([A-Za-z_][\w-]*)/g;

/**
 * Replaces the `:name` segments of the URL with their values. `encode` turns each value into
 * what goes in the URL (resolved and escaped when sending, kept as written for exports).
 */
export function fillPathParams(
  url: string,
  params: readonly KeyValue[] | undefined,
  encode: (value: string) => string = (value) => value,
): string {
  const values = new Map(
    (params ?? [])
      .filter((param) => param.enabled !== false)
      .map((param) => [param.key, param.value]),
  );
  return url.replace(PATH_PARAM, (segment, name: string) =>
    values.has(name) ? `/${encode(values.get(name)!)}` : segment,
  );
}

/** Resolves variables, auth and body into what `fetch` sends. `auth` is the effective auth. */
export function prepareRequest(
  request: ApiRequestSpec,
  auth: RequestAuth,
  scope: VariableScope,
): PreparedRequest {
  const url = new URL(
    interpolate(
      fillPathParams(request.url.trim(), request.pathParams, (value) =>
        encodeURIComponent(interpolate(value, scope)),
      ),
      scope,
    ),
  );
  for (const entry of enabled(request.query)) {
    url.searchParams.append(interpolate(entry.key, scope), interpolate(entry.value, scope));
  }
  const headers = new Headers();
  for (const entry of enabled(request.headers)) {
    headers.set(interpolate(entry.key, scope), interpolate(entry.value, scope));
  }
  applyAuth(auth, headers, url, scope);
  let body: string | undefined;
  const body_ = request.body;
  if (body_.mode === 'json' || body_.mode === 'text' || body_.mode === 'xml') {
    body = interpolate(body_.content, scope);
    if (!headers.has('content-type')) {
      headers.set(
        'content-type',
        body_.mode === 'json'
          ? 'application/json'
          : body_.mode === 'xml'
            ? 'application/xml'
            : 'text/plain',
      );
    }
  } else if (body_.mode === 'urlencoded' || body_.mode === 'form') {
    const params = new URLSearchParams();
    for (const field of enabled(body_.fields)) {
      params.append(interpolate(field.key, scope), interpolate(field.value, scope));
    }
    body = params.toString();
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
  }
  const sendsBody = body !== undefined && request.method !== 'GET' && request.method !== 'HEAD';
  return {
    url,
    init: { method: request.method, headers, ...(sendsBody ? { body } : {}), redirect: 'follow' },
  };
}

async function readBody(response: Response): Promise<{ text: string; size: number }> {
  if (!response.body) return { text: '', size: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let kept = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (kept < MAX_READ_BYTES) {
      chunks.push(value);
      kept += value.byteLength;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), size };
}

interface ResponseView {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly durationMs: number;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function asText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Human label of an assertion, e.g. `status eq 200` or `json data.id exists`. */
export function assertionLabel(assertion: Assertion): string {
  return [assertion.source, assertion.path, assertion.operator, assertion.expected]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

function evaluate(
  assertion: Assertion,
  response: ResponseView,
  scope: VariableScope,
): AssertionResult {
  let actual: unknown;
  let present = true;
  switch (assertion.source) {
    case 'status':
      actual = response.status;
      break;
    case 'duration':
      actual = response.durationMs;
      break;
    case 'header': {
      const value = response.headers.get(assertion.path ?? '');
      present = value !== null;
      actual = value ?? undefined;
      break;
    }
    case 'body':
      actual = response.text;
      break;
    case 'json': {
      const parsed = parseJson(response.text);
      actual = parsed.ok ? readJsonPath(parsed.value, assertion.path ?? '') : undefined;
      present = actual !== undefined;
      break;
    }
  }
  const expected = interpolate(assertion.expected ?? '', scope);
  const text = asText(actual);
  const number = Number(text);
  const target = Number(expected);
  const numeric = text !== '' && expected !== '' && !Number.isNaN(number) && !Number.isNaN(target);
  let passed: boolean;
  switch (assertion.operator) {
    case 'eq':
      passed = numeric ? number === target : text === expected;
      break;
    case 'neq':
      passed = numeric ? number !== target : text !== expected;
      break;
    case 'contains':
      passed = text.includes(expected);
      break;
    case 'notContains':
      passed = !text.includes(expected);
      break;
    case 'exists':
      passed = present;
      break;
    case 'notExists':
      passed = !present;
      break;
    case 'lt':
      passed = numeric && number < target;
      break;
    case 'lte':
      passed = numeric && number <= target;
      break;
    case 'gt':
      passed = numeric && number > target;
      break;
    case 'gte':
      passed = numeric && number >= target;
      break;
    case 'matches':
      try {
        passed = new RegExp(expected).test(text);
      } catch {
        passed = false;
      }
      break;
    case 'isType':
      passed = typeOf(actual) === expected.toLowerCase();
      break;
  }
  return {
    id: assertion.id,
    label: assertionLabel(assertion),
    passed,
    actual: maskSecrets(text.slice(0, 200), scope),
  };
}

function capture(rule: Capture, response: ResponseView): string | undefined {
  switch (rule.source) {
    case 'status':
      return String(response.status);
    case 'header':
      return response.headers.get(rule.path ?? '') ?? undefined;
    case 'body':
      return response.text;
    case 'json': {
      const parsed = parseJson(response.text);
      if (!parsed.ok) return undefined;
      const value = readJsonPath(parsed.value, rule.path ?? '');
      return value === undefined ? undefined : asText(value);
    }
  }
}

export interface ExecuteOptions {
  readonly auth: RequestAuth;
  readonly path?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Keep headers and a body preview in the result (off in load tests). */
  readonly keepResponse?: boolean;
  /** Called before sending, to refuse targets (e.g. private addresses on ADK workers). */
  readonly guard?: (url: URL) => Promise<void>;
}

/** Sends one request, then evaluates its assertions and stores its captures in `scope`. */
export async function executeRequest(
  request: ApiRequestSpec,
  scope: VariableScope,
  options: ExecuteOptions,
): Promise<RequestResult> {
  const started = performance.now();
  const base = {
    requestId: request.id,
    name: request.name,
    path: options.path ?? [],
    method: request.method,
  };
  let prepared: PreparedRequest;
  try {
    prepared = prepareRequest(request, options.auth, scope);
  } catch (error) {
    return {
      ...base,
      url: maskSecrets(interpolate(request.url, scope), scope),
      status: null,
      durationMs: 0,
      sizeBytes: 0,
      passed: false,
      error: `Invalid request: ${error instanceof Error ? error.message : String(error)}`,
      assertions: [],
    };
  }
  const url = maskSecrets(prepared.url.toString(), scope);
  const timeout = AbortSignal.timeout(request.timeoutMs ?? options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    await options.guard?.(prepared.url);
    const response = await (options.fetch ?? fetch)(prepared.url, { ...prepared.init, signal });
    const { text, size } = await readBody(response);
    const durationMs = Math.round(performance.now() - started);
    const view: ResponseView = {
      status: response.status,
      headers: response.headers,
      text,
      durationMs,
    };
    const assertions = request.assertions.map((assertion) => evaluate(assertion, view, scope));
    for (const rule of request.captures) {
      const value = capture(rule, view);
      const name = rule.variable.trim();
      if (value !== undefined && name) {
        scope.set(name, { value, secret: scope.get(name)?.secret ?? false });
      }
    }
    return {
      ...base,
      url,
      status: response.status,
      durationMs,
      sizeBytes: size,
      passed: assertions.every((assertion) => assertion.passed),
      assertions,
      ...(options.keepResponse
        ? {
            response: {
              headers: Object.fromEntries(
                [...response.headers.entries()].map(([key, value]) => [
                  key,
                  maskSecrets(value, scope),
                ]),
              ),
              bodyPreview: maskSecrets(text.slice(0, PREVIEW_BYTES), scope),
            },
          }
        : {}),
    };
  } catch (error) {
    const reason =
      timeout.aborted && !options.signal?.aborted
        ? `Timed out after ${request.timeoutMs ?? options.timeoutMs ?? 30_000} ms`
        : error instanceof Error
          ? error.cause instanceof Error
            ? `${error.message}: ${error.cause.message}`
            : error.message
          : String(error);
    return {
      ...base,
      url,
      status: null,
      durationMs: Math.round(performance.now() - started),
      sizeBytes: 0,
      passed: false,
      error: maskSecrets(reason, scope),
      assertions: [],
    };
  }
}
