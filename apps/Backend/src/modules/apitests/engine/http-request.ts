import { randomBytes } from 'node:crypto';
import { authorizeRequest, sendAuthorized, type AuthContext } from './auth.js';
import { grpcCall } from './grpc-client.js';
import {
  fetchSender,
  sendHttp,
  type CookieHooks,
  type HttpRequestInit,
  type HttpSender,
  type NetworkOptions,
} from './http-transport.js';
import type { ScriptRequestView, ScriptResponseView } from './script-sandbox.js';
import {
  socketExchange,
  sseExchange,
  websocketExchange,
  type ExchangeResult,
} from './stream-clients.js';
import {
  AUTH_SECRET_FIELDS,
  type ApiRequestSpec,
  type Assertion,
  type AssertionResult,
  type Capture,
  type CollectionSettings,
  type KeyValue,
  type ProtoFile,
  type RequestAuth,
  type RequestKind,
  type RequestResult,
  type RequestTimeline,
  type ScriptLog,
  type StreamMessage,
} from './types.js';
import { MASKED, interpolate, maskSecrets, type VariableScope } from './variables.js';

export { interpolate, maskSecrets, scopeOf, type VariableScope } from './variables.js';

/** Response bytes kept in a result by default; the rest is only counted. */
const PREVIEW_BYTES = 4 * 1024;
/** Bytes read to evaluate body and JSON assertions and captures. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
/** Stream messages kept in a result, and characters of each. */
const MAX_MESSAGES = 500;
const MAX_MESSAGE_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 30_000;

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

const enabled = <T extends KeyValue>(list: readonly T[] = []) =>
  list.filter((entry) => entry.enabled !== false && entry.key.trim());

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

/** Header rows of the collection and folders, then the request's: later names win. */
export function mergeHeaders(...lists: readonly (readonly KeyValue[] | undefined)[]): KeyValue[] {
  const merged = new Map<string, KeyValue>();
  for (const list of lists) {
    for (const row of enabled(list)) merged.set(row.key.trim().toLowerCase(), row);
  }
  return [...merged.values()];
}

// ---------- the request as scripts see it ----------

const TEXT_TYPES: Record<string, string> = {
  json: 'application/json',
  xml: 'application/xml',
  text: 'text/plain',
  sparql: 'application/sparql-query',
};

/** The body as text before variables are resolved, for scripts (`req.getBody()`). */
function draftBody(request: ApiRequestSpec, kind: RequestKind): string | undefined {
  if (kind === 'graphql') {
    const graphql = request.graphql ?? { query: '' };
    const variables = graphql.variables?.trim() || '{}';
    const operation = graphql.operationName?.trim()
      ? `,"operationName":${JSON.stringify(graphql.operationName.trim())}`
      : '';
    // The variables stay as typed, so `{{number}}` outside quotes still becomes a JSON number.
    return `{"query":${JSON.stringify(graphql.query)},"variables":${variables}${operation}}`;
  }
  if (kind === 'grpc') return request.grpc?.message ?? '{}';
  if (kind === 'websocket' || kind === 'socket') return undefined;
  const body = request.body;
  if (body.mode === 'json' || body.mode === 'text' || body.mode === 'xml' || body.mode === 'sparql')
    return body.content;
  if (body.mode === 'urlencoded') {
    return enabled(body.fields)
      .map((field) => `${encodeURIComponent(field.key)}=${encodeURIComponent(field.value)}`)
      .join('&');
  }
  return undefined;
}

function draftView(
  request: ApiRequestSpec,
  kind: RequestKind,
  auth: RequestAuth,
  inherited: readonly KeyValue[] | undefined,
  timeoutMs: number,
): ScriptRequestView {
  const body = draftBody(request, kind);
  return {
    id: request.id,
    name: request.name,
    kind,
    method: request.method,
    url: request.url.trim(),
    headers: Object.fromEntries(
      mergeHeaders(inherited, request.headers).map((row) => [row.key.trim(), row.value]),
    ),
    ...(body !== undefined ? { body } : {}),
    timeoutMs,
    authType: auth.type,
  };
}

// ---------- building what is sent ----------

/** Every string field of the auth with its variables resolved. */
export function resolveAuth(auth: RequestAuth, scope: VariableScope): RequestAuth {
  return Object.fromEntries(
    Object.entries(auth).map(([key, value]) => [
      key,
      key !== 'type' && typeof value === 'string' ? interpolate(value, scope) : value,
    ]),
  ) as RequestAuth;
}

/** Credential values of the resolved auth: masked wherever they could show up in a result. */
function credentialsOf(auth: RequestAuth): string[] {
  const record = auth as unknown as Record<string, unknown>;
  return AUTH_SECRET_FIELDS[auth.type]
    .map((field) => record[field])
    .filter((value): value is string => typeof value === 'string' && value.length >= 4);
}

function resolveStrings<T extends object>(value: T, scope: VariableScope): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === 'string' ? interpolate(entry, scope) : entry,
    ]),
  ) as T;
}

/** Proxy, TLS and client certificates with variables resolved, plus the run's hooks. */
export function networkOf(
  settings: CollectionSettings | undefined,
  scope: VariableScope,
  options: Pick<ExecuteOptions, 'connectHost' | 'guard'>,
  signal: AbortSignal,
): NetworkOptions {
  return {
    ...(settings?.proxy?.enabled ? { proxy: resolveStrings(settings.proxy, scope) } : {}),
    ...(settings?.tls ? { tls: settings.tls } : {}),
    ...(settings?.clientCertificates?.length
      ? {
          clientCertificates: settings.clientCertificates.map((certificate) =>
            resolveStrings(certificate, scope),
          ),
        }
      : {}),
    ...(options.connectHost ? { connectHost: options.connectHost } : {}),
    ...(options.guard ? { guard: options.guard } : {}),
    signal,
  };
}

/** The node transport measures phases and honors proxies and certificates; fetch keeps connections alive. */
export function senderOf(
  options: Pick<ExecuteOptions, 'fetch' | 'settings' | 'connectHost' | 'preferFetch'>,
): HttpSender {
  if (options.fetch) return fetchSender(options.fetch);
  const settings = options.settings;
  const needsNode =
    Boolean(settings?.proxy?.enabled) ||
    settings?.tls?.verify === false ||
    Boolean(settings?.tls?.caCertificate) ||
    Boolean(settings?.clientCertificates?.length) ||
    Boolean(options.connectHost);
  return options.preferFetch && !needsNode ? fetchSender(fetch) : sendHttp;
}

function multipart(
  fields: Extract<ApiRequestSpec['body'], { mode: 'form' }>['fields'],
  scope: VariableScope,
): { body: Buffer; contentType: string } {
  const boundary = `----adk-${randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  const quote = (value: string) => value.replace(/"/g, '%22').replace(/\r|\n/g, ' ');
  for (const field of enabled(fields)) {
    const name = quote(interpolate(field.key, scope));
    if (field.type === 'file' && field.file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${quote(field.file.fileName)}"\r\n` +
            `Content-Type: ${field.file.contentType || 'application/octet-stream'}\r\n\r\n`,
        ),
        Buffer.from(field.file.data, 'base64'),
        Buffer.from('\r\n'),
      );
    } else {
      const type = field.contentType ? `Content-Type: ${field.contentType}\r\n` : '';
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n${type}\r\n` +
            `${interpolate(field.value, scope)}\r\n`,
        ),
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The body to send. A pre-request script that changed the body wins over the editor's mode;
 * otherwise each mode is encoded as its content type says.
 */
function bodyOf(
  request: ApiRequestSpec,
  kind: RequestKind,
  view: ScriptRequestView,
  original: string | undefined,
  scope: VariableScope,
): { body?: Buffer | string; contentType?: string } {
  if (view.body !== original && view.body !== undefined) {
    const mode = request.body.mode;
    return {
      body: interpolate(view.body, scope),
      contentType: (kind === 'http' && TEXT_TYPES[mode]) || 'application/json',
    };
  }
  // A GraphQL request always has a draft body, so `original` is set unless a script removed it.
  if (kind === 'graphql' && original !== undefined) {
    return { body: interpolate(original, scope), contentType: 'application/json' };
  }
  const body = request.body;
  switch (body.mode) {
    case 'json':
    case 'text':
    case 'xml':
    case 'sparql':
      return { body: interpolate(body.content, scope), contentType: TEXT_TYPES[body.mode] };
    case 'urlencoded': {
      const params = new URLSearchParams();
      for (const field of enabled(body.fields)) {
        params.append(interpolate(field.key, scope), interpolate(field.value, scope));
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'form':
      return multipart(body.fields, scope);
    case 'binary':
      return body.file
        ? {
            body: Buffer.from(body.file.data, 'base64'),
            contentType: body.file.contentType || 'application/octet-stream',
          }
        : {};
    default:
      return {};
  }
}

function resolveUrl(
  request: ApiRequestSpec,
  kind: RequestKind,
  view: ScriptRequestView,
  scope: VariableScope,
): URL {
  const url = new URL(
    interpolate(
      fillPathParams(view.url, request.pathParams, (value) =>
        encodeURIComponent(interpolate(value, scope)),
      ),
      scope,
    ),
  );
  if (kind === 'grpc' || kind === 'socket') return url;
  for (const entry of enabled(request.query)) {
    url.searchParams.append(interpolate(entry.key, scope), interpolate(entry.value, scope));
  }
  if (kind === 'graphql' && view.method === 'GET' && request.graphql) {
    url.searchParams.set('query', interpolate(request.graphql.query, scope));
    const variables = request.graphql.variables?.trim();
    if (variables && variables !== '{}') {
      url.searchParams.set('variables', interpolate(variables, scope));
    }
    if (request.graphql.operationName?.trim()) {
      url.searchParams.set('operationName', request.graphql.operationName.trim());
    }
  }
  return url;
}

// ---------- reading the response ----------

interface HeaderReader {
  get(name: string): string | null;
}

function headerReader(pairs: readonly (readonly [string, string])[]): HeaderReader {
  return {
    get: (name) => {
      const lower = name.toLowerCase();
      const values = pairs.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
      return values.length ? values.join(lower === 'set-cookie' ? '\n' : ', ') : null;
    },
  };
}

function headerRecord(pairs: readonly (readonly [string, string])[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of pairs) {
    const name = key.toLowerCase();
    record[name] =
      record[name] === undefined
        ? value
        : `${record[name]}${name === 'set-cookie' ? '\n' : ', '}${value}`;
  }
  return record;
}

interface ResponseView {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeaderReader;
  readonly headerPairs: readonly (readonly [string, string])[];
  readonly text: string;
  readonly durationMs: number;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly messages?: readonly StreamMessage[];
  readonly trailers?: Readonly<Record<string, string>>;
  readonly timeline?: Omit<RequestTimeline, 'request'>;
  /** The exchange failed after it started (streams): shown, and the request fails. */
  readonly error?: string;
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

/** Received messages as the body assertions and captures read: a JSON array of their data. */
function messagesBody(messages: readonly StreamMessage[]): string {
  return JSON.stringify(
    messages
      .filter((message) => message.direction === 'received')
      .map((message) => {
        const parsed = parseJson(message.data);
        return parsed.ok ? parsed.value : message.data;
      }),
  );
}

function fromExchange(exchange: ExchangeResult): ResponseView {
  return {
    status: exchange.status ?? 0,
    statusText: exchange.statusText ?? '',
    headers: headerReader(exchange.headers),
    headerPairs: exchange.headers,
    text: messagesBody(exchange.messages),
    durationMs: Math.round(exchange.durationMs),
    sizeBytes: exchange.sizeBytes,
    truncated: false,
    messages: exchange.messages,
    ...(exchange.timings
      ? {
          timeline: {
            timings: exchange.timings,
            ...(exchange.remoteAddress ? { remoteAddress: exchange.remoteAddress } : {}),
          },
        }
      : {}),
    ...(exchange.error ? { error: exchange.error } : {}),
  };
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
  masks: readonly string[],
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
    actual: maskSecrets(text.slice(0, 200), scope, masks),
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

// ---------- executing ----------

/** One step of scripts: what it changed and reported. */
export interface ScriptStep {
  /** The request after pre-request scripts. */
  readonly request?: ScriptRequestView;
  readonly tests: readonly AssertionResult[];
  readonly logs: readonly ScriptLog[];
  /** `adk.runner.skipRequest()`. */
  readonly skip?: boolean;
  readonly error?: string;
}

/** The scripts of a request (collection, folders and its own), run by the collection runner. */
export interface RequestScripting {
  pre(request: ScriptRequestView): Promise<ScriptStep>;
  post(request: ScriptRequestView, response: ScriptResponseView): Promise<ScriptStep>;
  tests(request: ScriptRequestView, response: ScriptResponseView): Promise<ScriptStep>;
}

export interface ExecuteOptions {
  /** The effective auth, with `inherit` resolved through folders and the collection. */
  readonly auth: RequestAuth;
  readonly path?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Sends HTTP through this fetch instead of the node transport (tests, custom fetches). */
  readonly fetch?: typeof fetch;
  /** Keep headers and a body preview in the result (off in load tests). */
  readonly keepResponse?: boolean;
  /** Called before connecting, to refuse targets (e.g. private addresses on ADK workers). */
  readonly guard?: (url: URL) => Promise<void>;
  /** Maps the host connected to (host access of a local install). */
  readonly connectHost?: (hostname: string) => string;
  /** Collection settings: proxy, TLS, certificates, redirects, default timeout. */
  readonly settings?: CollectionSettings;
  /** Headers of the collection and the folders, weakest first; the request's own win. */
  readonly inheritedHeaders?: readonly KeyValue[];
  readonly protoFiles?: readonly ProtoFile[];
  /** The run's cookie jar. */
  readonly cookies?: CookieHooks;
  /** OAuth2 tokens of the run. */
  readonly authCache?: Map<string, unknown>;
  /** Body bytes kept in the result. */
  readonly previewBytes?: number;
  readonly scripting?: RequestScripting;
  /** Iteration of a data-driven run, from 1. */
  readonly iteration?: number;
  /** Load tests: keep-alive fetch when no network setting needs the node transport. */
  readonly preferFetch?: boolean;
}

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-wsse',
  'x-amz-security-token',
]);

function timelineHeaders(
  pairs: readonly (readonly [string, string])[],
  auth: RequestAuth,
  mask: (text: string) => string,
): Record<string, string> {
  const hidden = new Set(SENSITIVE_HEADERS);
  if (auth.type === 'apikey' && auth.in === 'header') hidden.add(auth.key.toLowerCase());
  return Object.fromEntries(
    pairs.map(([key, value]) => [key, hidden.has(key.toLowerCase()) ? MASKED : mask(value)]),
  );
}

function bodyPreview(
  body: Buffer | string | Uint8Array | undefined,
  bytes: number,
): string | undefined {
  if (body === undefined) return undefined;
  const buffer = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  return buffer.subarray(0, bytes).toString('utf8');
}

/**
 * Runs one request of any kind: pre-request scripts, variables, auth, the exchange, then
 * captures, post-response scripts, assertions and tests. Never throws for a failed request:
 * the error is in the result.
 */
export async function executeRequest(
  request: ApiRequestSpec,
  scope: VariableScope,
  options: ExecuteOptions,
): Promise<RequestResult> {
  const started = performance.now();
  const kind: RequestKind = request.kind ?? 'http';
  const settings = options.settings;
  const base = {
    requestId: request.id,
    name: request.name,
    ...(kind !== 'http' ? { kind } : {}),
    path: options.path ?? [],
    ...(options.iteration ? { iteration: options.iteration } : {}),
    method: request.method,
  };
  const tests: AssertionResult[] = [];
  const logs: ScriptLog[] = [];
  const masks: string[] = [];
  const mask = (text: string) => maskSecrets(text, scope, masks);
  const scriptExtras = () => ({
    ...(tests.length
      ? {
          tests: tests.map((test) => ({
            ...test,
            ...(test.actual ? { actual: mask(test.actual) } : {}),
          })),
        }
      : {}),
    ...(logs.length ? { logs: logs.map((log) => ({ ...log, message: mask(log.message) })) } : {}),
  });
  const failed = (url: string, error: string): RequestResult => ({
    ...base,
    url: mask(url),
    status: null,
    durationMs: Math.round(performance.now() - started),
    sizeBytes: 0,
    passed: false,
    error: mask(error),
    assertions: [],
    ...scriptExtras(),
  });

  const timeoutMs =
    request.timeoutMs ?? settings?.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const original = draftView(request, kind, options.auth, options.inheritedHeaders, timeoutMs);
  let view = original;
  if (options.scripting) {
    const step = await options.scripting.pre(view);
    tests.push(...step.tests);
    logs.push(...step.logs);
    if (step.error) return failed(interpolate(view.url, scope), step.error);
    if (step.skip) {
      return {
        ...base,
        url: mask(interpolate(view.url, scope)),
        status: null,
        durationMs: 0,
        sizeBytes: 0,
        passed: true,
        skipped: true,
        assertions: [],
        ...scriptExtras(),
      };
    }
    view = step.request ?? view;
  }

  const auth = resolveAuth(options.auth, scope);
  masks.push(...credentialsOf(auth));
  if (settings?.proxy?.password) masks.push(interpolate(settings.proxy.password, scope));
  let url: URL;
  try {
    url = resolveUrl(request, kind, view, scope);
  } catch (error) {
    return failed(
      interpolate(view.url, scope),
      `Invalid request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requestTimeout = view.timeoutMs ?? timeoutMs;
  const timeout = AbortSignal.timeout(requestTimeout + 1_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const network = networkOf(settings, scope, options, signal);
  const sender = senderOf(options);
  const authContext: AuthContext = {
    send: (init) => sender(init, network),
    cache: options.authCache ?? new Map<string, unknown>(),
  };
  const headers: [string, string][] = Object.entries(view.headers)
    .filter(([key]) => key.trim())
    .map(([key, value]) => [interpolate(key, scope), interpolate(value, scope)]);
  const hasHeader = (name: string) => headers.some(([key]) => key.toLowerCase() === name);

  let response: ResponseView;
  let sent: HttpRequestInit = { method: view.method, url, headers };
  try {
    if (kind === 'http' || kind === 'graphql') {
      const { body, contentType } = bodyOf(request, kind, view, original.body, scope);
      const sendsBody = body !== undefined && view.method !== 'GET' && view.method !== 'HEAD';
      if (sendsBody && contentType && !hasHeader('content-type')) {
        headers.push(['content-type', contentType]);
      }
      const init: HttpRequestInit = {
        method: view.method,
        url,
        headers,
        ...(sendsBody ? { body } : {}),
        followRedirects: request.settings?.followRedirects ?? settings?.followRedirects ?? true,
        maxRedirects: request.settings?.maxRedirects ?? settings?.maxRedirects ?? 5,
        maxBodyBytes: MAX_READ_BYTES,
        timeoutMs: requestTimeout,
        ...(options.cookies && settings?.cookies !== false ? { cookies: options.cookies } : {}),
      };
      const exchange = await sendAuthorized(init, auth, authContext);
      sent = exchange.sent;
      const data = exchange.response;
      response = {
        status: data.status,
        statusText: data.statusText,
        headers: headerReader(data.headers),
        headerPairs: data.headers,
        text: data.body.toString('utf8'),
        durationMs: Math.round(data.timings.total),
        sizeBytes: data.sizeBytes,
        truncated: data.truncated,
        timeline: {
          httpVersion: data.httpVersion,
          ...(data.remoteAddress ? { remoteAddress: data.remoteAddress } : {}),
          ...(data.redirects.length ? { redirects: data.redirects } : {}),
          timings: data.timings,
        },
      };
    } else {
      // Streams and gRPC take the auth as headers (metadata), without a body to sign.
      const cookieUrl = new URL(url.href.replace(/^ws/, 'http'));
      const cookie =
        kind === 'websocket' || kind === 'sse'
          ? options.cookies && settings?.cookies !== false
            ? options.cookies.cookieHeader(cookieUrl)
            : undefined
          : undefined;
      if (cookie && !hasHeader('cookie')) headers.push(['cookie', cookie]);
      sent =
        kind === 'socket'
          ? sent
          : await authorizeRequest({ method: view.method, url, headers }, auth, authContext);
      response = await exchangeOf(
        request,
        kind,
        view,
        original.body ?? '',
        sent,
        scope,
        network,
        requestTimeout,
        options,
      );
    }
  } catch (error) {
    const reason =
      timeout.aborted && !options.signal?.aborted
        ? `Timed out after ${requestTimeout} ms`
        : error instanceof Error
          ? error.cause instanceof Error
            ? `${error.message}: ${error.cause.message}`
            : error.message
          : String(error);
    return failed(url.toString(), reason);
  }

  const scriptResponse: ScriptResponseView = {
    status: response.status,
    statusText: response.statusText,
    headers: headerRecord(response.headerPairs),
    body: response.text,
    durationMs: response.durationMs,
    sizeBytes: response.sizeBytes,
  };
  for (const rule of request.captures) {
    const value = capture(rule, response);
    const name = rule.variable.trim();
    if (value !== undefined && name) {
      scope.set(name, { value, secret: scope.get(name)?.secret ?? false });
    }
  }
  let error = response.error;
  if (options.scripting) {
    const post = await options.scripting.post(view, scriptResponse);
    tests.push(...post.tests);
    logs.push(...post.logs);
    error ??= post.error;
  }
  const assertions = request.assertions.map((assertion) =>
    evaluate(assertion, response, scope, masks),
  );
  if (options.scripting) {
    const step = await options.scripting.tests(view, scriptResponse);
    tests.push(...step.tests);
    logs.push(...step.logs);
    error ??= step.error;
  }

  const previewBytes = options.previewBytes ?? PREVIEW_BYTES;
  const preview = Buffer.from(response.text).subarray(0, previewBytes).toString('utf8');
  const sentUrl = sent.url.toString();
  const sentPreview = bodyPreview(sent.body, 2_048);
  return {
    ...base,
    url: mask(sentUrl),
    status: response.status,
    durationMs: response.durationMs || Math.round(performance.now() - started),
    sizeBytes: response.sizeBytes,
    passed:
      !error &&
      assertions.every((assertion) => assertion.passed) &&
      tests.every((test) => test.passed),
    ...(error ? { error: mask(error) } : {}),
    assertions,
    ...scriptExtras(),
    ...(options.keepResponse
      ? {
          response: {
            headers: Object.fromEntries(
              Object.entries(headerRecord(response.headerPairs)).map(([key, value]) => [
                key,
                mask(value),
              ]),
            ),
            bodyPreview: mask(preview),
            ...(response.truncated || response.text.length > preview.length
              ? { truncated: true }
              : {}),
            ...(response.statusText ? { statusText: response.statusText } : {}),
            ...(response.trailers
              ? {
                  trailers: Object.fromEntries(
                    Object.entries(response.trailers).map(([key, value]) => [key, mask(value)]),
                  ),
                }
              : {}),
            ...(response.messages
              ? {
                  messages: response.messages.slice(0, MAX_MESSAGES).map((message) => ({
                    ...message,
                    data: mask(message.data.slice(0, MAX_MESSAGE_CHARS)),
                  })),
                }
              : {}),
          },
          timeline: {
            request: {
              method: sent.method,
              url: mask(sentUrl),
              headers: timelineHeaders(sent.headers, auth, mask),
              ...(sentPreview !== undefined ? { bodyPreview: mask(sentPreview) } : {}),
            },
            ...response.timeline,
          },
        }
      : {}),
  };
}

async function exchangeOf(
  request: ApiRequestSpec,
  kind: RequestKind,
  view: ScriptRequestView,
  originalBody: string,
  sent: HttpRequestInit,
  scope: VariableScope,
  network: NetworkOptions,
  timeoutMs: number,
  options: ExecuteOptions,
): Promise<ResponseView> {
  const resolveMessages = (messages: readonly { content: string }[] = []) =>
    messages.map((message) => ({ ...message, content: interpolate(message.content, scope) }));
  switch (kind) {
    case 'websocket':
      return fromExchange(
        await websocketExchange(
          {
            url: sent.url,
            headers: sent.headers,
            messages: resolveMessages(request.websocket?.messages),
            ...(request.websocket?.subprotocols?.length
              ? { subprotocols: request.websocket.subprotocols }
              : {}),
            listenMs: request.websocket?.listenMs ?? 2_000,
            ...(request.websocket?.maxMessages
              ? { maxMessages: request.websocket.maxMessages }
              : {}),
            timeoutMs,
          },
          network,
        ),
      );
    case 'sse': {
      const body = view.body !== undefined ? interpolate(view.body, scope) : undefined;
      const sendsBody = body !== undefined && view.method !== 'GET' && view.method !== 'HEAD';
      return fromExchange(
        await sseExchange(
          {
            url: sent.url,
            method: view.method,
            headers: sent.headers,
            ...(sendsBody ? { body } : {}),
            listenMs: request.sse?.listenMs ?? 5_000,
            ...(request.sse?.maxEvents ? { maxEvents: request.sse.maxEvents } : {}),
            timeoutMs,
          },
          network,
        ),
      );
    }
    case 'socket':
      return fromExchange(
        await socketExchange(
          {
            url: sent.url,
            messages: resolveMessages(request.socket?.messages),
            listenMs: request.socket?.listenMs ?? 2_000,
            ...(request.socket?.readUntil
              ? { readUntil: interpolate(request.socket.readUntil, scope) }
              : {}),
            responseEncoding: request.socket?.responseEncoding ?? 'text',
            timeoutMs,
          },
          network,
        ),
      );
    case 'grpc': {
      const grpc = request.grpc ?? { method: '', message: '{}' };
      const text = interpolate(view.body ?? originalBody, scope).trim() || '{}';
      const parsed = parseJson(text);
      if (!parsed.ok) throw new Error('The gRPC message is not valid JSON.');
      const requests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
      const result = await grpcCall(
        {
          url: sent.url,
          protoFiles: options.protoFiles ?? [],
          ...(grpc.protoFile ? { protoFile: grpc.protoFile } : {}),
          reflection: grpc.reflection ?? !grpc.protoFile,
          metadata: sent.headers,
          timeoutMs,
        },
        interpolate(grpc.method, scope),
        requests,
        network,
      );
      return {
        status: result.status,
        statusText: result.statusMessage,
        headers: headerReader(Object.entries(result.headers)),
        headerPairs: Object.entries(result.headers),
        text: JSON.stringify(
          result.responses.length === 1 ? result.responses[0] : result.responses,
        ),
        durationMs: Math.round(result.durationMs),
        sizeBytes: result.sizeBytes,
        truncated: false,
        messages: result.messages,
        trailers: result.trailers,
      };
    }
    default:
      throw new Error(`Unsupported request kind ${kind}`);
  }
}
