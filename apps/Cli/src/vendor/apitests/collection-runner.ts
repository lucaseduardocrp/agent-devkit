import { authorizeRequest } from './auth.js';
import { CookieJar } from './cookie-jar.js';
import { grpcListServices } from './grpc-client.js';
import {
  executeRequest,
  interpolate,
  mergeHeaders,
  networkOf,
  resolveAuth,
  senderOf,
  type ExecuteOptions,
  type RequestScripting,
  type ScriptStep,
} from './http-request.js';
import {
  ScriptSandbox,
  type ScriptHost,
  type ScriptInput,
  type ScriptOutput,
  type ScriptRequestView,
  type ScriptResponseView,
} from './script-sandbox.js';
import type {
  ApiFolder,
  ApiItem,
  ApiRequestSpec,
  AssertionResult,
  CollectionRunResult,
  CollectionSpec,
  GrpcServiceList,
  RequestAuth,
  RequestResult,
  RuntimeState,
  Scripts,
  Variable,
} from './types.js';
import { LayeredScope } from './variables.js';

export interface FlatRequest {
  readonly request: ApiRequestSpec;
  /** Folder names from the root. */
  readonly path: readonly string[];
  /** The auth that applies once `inherit` is resolved through folders and the collection. */
  readonly auth: RequestAuth;
  /** The folders from the root down to the request's parent. */
  readonly folders: readonly ApiFolder[];
}

/** Every request in run order, with its folder path and effective auth. */
export function flattenRequests(collection: Pick<CollectionSpec, 'auth' | 'items'>): FlatRequest[] {
  const out: FlatRequest[] = [];
  const walk = (
    items: readonly ApiItem[],
    folders: readonly ApiFolder[],
    inherited: RequestAuth,
  ) => {
    for (const item of items) {
      if (item.type === 'folder') {
        const auth = item.auth && item.auth.type !== 'inherit' ? item.auth : inherited;
        walk(item.items, [...folders, item], auth);
      } else {
        out.push({
          request: item,
          path: folders.map((folder) => folder.name),
          auth: item.auth.type === 'inherit' ? inherited : item.auth,
          folders,
        });
      }
    }
  };
  walk(
    collection.items,
    [],
    collection.auth.type === 'inherit' ? { type: 'none' } : collection.auth,
  );
  return out;
}

/** Ids of every request inside the given folders or requests (all of them when empty). */
export function selectRequests(
  collection: Pick<CollectionSpec, 'auth' | 'items'>,
  itemIds: readonly string[] = [],
): FlatRequest[] {
  if (!itemIds.length) return flattenRequests(collection);
  const wanted = new Set<string>();
  const mark = (items: readonly ApiItem[], inside: boolean) => {
    for (const item of items) {
      const selected = inside || itemIds.includes(item.id);
      if (item.type === 'folder') mark(item.items, selected);
      else if (selected) wanted.add(item.id);
    }
  };
  mark(collection.items, false);
  return flattenRequests(collection).filter((entry) => wanted.has(entry.request.id));
}

/** What runs the scripts: the isolated sandbox, or a fake in tests. */
export type ScriptRunner = Pick<ScriptSandbox, 'run' | 'close'>;

export interface CollectionRunOptions extends Omit<
  ExecuteOptions,
  | 'auth'
  | 'path'
  | 'keepResponse'
  | 'inheritedHeaders'
  | 'settings'
  | 'protoFiles'
  | 'cookies'
  | 'authCache'
  | 'scripting'
  | 'iteration'
> {
  /** Environment variables; they override the collection's own. */
  readonly environment?: readonly Variable[];
  readonly environmentName?: string;
  /** Folders or requests to run; empty runs the whole collection. */
  readonly itemIds?: readonly string[];
  /** Stop at the first request that fails. */
  readonly bail?: boolean;
  /** Pause between requests. */
  readonly delayMs?: number;
  /** The user's runtime variables and cookies from previous sends. */
  readonly runtime?: RuntimeState;
  /** Runs the selection this many times; one iteration per row when `data` is given. */
  readonly iterations?: number;
  readonly data?: readonly Readonly<Record<string, string>>[];
  /** Creates the script runner (the isolated sandbox by default). */
  readonly scripts?: (host: ScriptHost) => ScriptRunner;
  readonly onResult?: (result: RequestResult, index: number, total: number) => void | Promise<void>;
}

/** A run's result and the runtime state it leaves for the user's next sends. */
export interface CollectionRunOutput {
  readonly result: CollectionRunResult;
  readonly runtime: RuntimeState;
}

/** Requests executed in one run at most, so `setNextRequest` loops end. */
const MAX_EXECUTIONS = 10_000;
const PHASE_LABEL = {
  'pre-request': 'pre-request',
  'post-response': 'post-response',
  tests: 'tests',
} as const;
const SCRIPT_FIELD = {
  'pre-request': 'preRequest',
  'post-response': 'postResponse',
  tests: 'tests',
} as const satisfies Record<ScriptInput['phase'], keyof Scripts>;

interface ScriptLevel {
  readonly label: string;
  readonly scripts?: Scripts;
}

/** What scripts asked of the runner while a request ran. */
interface FlowControl {
  next?: string | null;
  stop: boolean;
}

/**
 * The scripts of one request: the collection's, its folders' and its own, in the run's flow.
 * Sandwich (Bruno's default): pre-request top-down, post-response and tests bottom-up;
 * sequential: everything top-down.
 */
function requestScripting(
  levels: readonly ScriptLevel[],
  flow: CollectionSpec['scriptFlow'],
  scope: LayeredScope,
  runner: () => ScriptRunner,
  context: Pick<ScriptInput, 'collectionName' | 'environmentName' | 'iteration'>,
  control: FlowControl,
): RequestScripting | undefined {
  const has = (phase: ScriptInput['phase']) =>
    levels.some((level) => level.scripts?.[SCRIPT_FIELD[phase]]?.trim());
  if (!has('pre-request') && !has('post-response') && !has('tests')) return undefined;
  let testCount = 0;

  const runPhase = async (
    phase: ScriptInput['phase'],
    request: ScriptRequestView,
    response?: ScriptResponseView,
  ): Promise<ScriptStep> => {
    const ordered =
      phase === 'pre-request' || flow === 'sequential' ? levels : [...levels].reverse();
    const tests: AssertionResult[] = [];
    const logs: ScriptStep['logs'][number][] = [];
    let current = request;
    let skip = false;
    for (const level of ordered) {
      const code = level.scripts?.[SCRIPT_FIELD[phase]];
      if (!code?.trim()) continue;
      const output: ScriptOutput = await runner().run({
        phase,
        source: `${level.label} ${PHASE_LABEL[phase]}`,
        code,
        request: current,
        ...(response ? { response } : {}),
        variables: {
          environment: scope.record('environment'),
          collection: scope.record('collection'),
          runtime: scope.record('runtime'),
          folder: scope.record('folder'),
          request: scope.record('request'),
          data: scope.record('data'),
        },
        ...context,
      });
      scope.replace('environment', output.variables.environment);
      scope.replace('collection', output.variables.collection);
      scope.replace('runtime', output.variables.runtime);
      scope.replace('request', output.variables.request);
      if (phase === 'pre-request') current = output.request;
      logs.push(...output.logs);
      for (const test of output.tests) {
        testCount += 1;
        tests.push({
          id: `test-${testCount}`,
          label: test.name,
          passed: test.passed,
          ...(test.error ? { actual: test.error } : {}),
        });
      }
      if (output.nextRequest !== undefined) control.next = output.nextRequest;
      if (output.stopExecution) control.stop = true;
      skip ||= output.skipRequest;
      if (output.error) return { request: current, tests, logs, error: output.error };
    }
    return { request: current, tests, logs, ...(skip ? { skip } : {}) };
  };

  return {
    pre: (request) => runPhase('pre-request', request),
    post: (request, response) => runPhase('post-response', request, response),
    tests: (request, response) => runPhase('tests', request, response),
  };
}

/**
 * Runs the requests one after the other, sharing variables: a capture or a script of one request
 * (a token, a created id) is available to the next ones, as in a Postman or Bruno collection run.
 */
export async function runCollectionWithState(
  collection: CollectionSpec,
  options: CollectionRunOptions = {},
): Promise<CollectionRunOutput> {
  const started = performance.now();
  const scope = new LayeredScope({
    collection: collection.variables,
    environment: options.environment ?? [],
    runtime: options.runtime?.variables ?? [],
  });
  const jar = new CookieJar(options.runtime?.cookies ?? []);
  const authCache = new Map<string, unknown>();
  const requests = selectRequests(collection, options.itemIds);
  const rows = options.data?.length ? options.data : null;
  const iterations = rows ? rows.length : Math.max(1, options.iterations ?? 1);
  const total = requests.length * iterations;
  const settings = collection.settings;

  let sandbox: ScriptRunner | null = null;
  const host: ScriptHost = {
    sendRequest: async (input) => {
      const signal = AbortSignal.timeout(input.timeoutMs ?? settings?.timeoutMs ?? 30_000);
      const response = await senderOf({ ...options, ...(settings ? { settings } : {}) })(
        {
          method: input.method.toUpperCase(),
          url: new URL(input.url),
          headers: Object.entries(input.headers),
          ...(input.body !== undefined ? { body: input.body } : {}),
          timeoutMs: input.timeoutMs ?? settings?.timeoutMs ?? 30_000,
          cookies: jar,
        },
        networkOf(
          settings,
          scope,
          options,
          options.signal ? AbortSignal.any([options.signal, signal]) : signal,
        ),
      );
      const headers: Record<string, string> = {};
      for (const [key, value] of response.headers) {
        headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`;
      }
      return {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: response.body.toString('utf8'),
        durationMs: Math.round(response.timings.total),
      };
    },
  };
  const runner = () =>
    (sandbox ??= options.scripts ? options.scripts(host) : new ScriptSandbox({ host }));

  const results: RequestResult[] = [];
  let executions = 0;
  let stopped = false;
  try {
    for (let iteration = 0; iteration < iterations && !stopped; iteration += 1) {
      scope.replace('data', rows?.[iteration] ?? {});
      let index = 0;
      while (index < requests.length) {
        if (options.signal?.aborted || executions >= MAX_EXECUTIONS) {
          stopped = true;
          break;
        }
        executions += 1;
        const entry = requests[index]!;
        scope.assign(
          'folder',
          entry.folders.flatMap((folder) => folder.vars ?? []),
        );
        scope.assign('request', entry.request.vars ?? []);
        const control: FlowControl = { stop: false };
        const scripting = requestScripting(
          [
            { label: 'collection', ...(collection.scripts ? { scripts: collection.scripts } : {}) },
            ...entry.folders.map((folder) => ({
              label: `folder ${folder.name}`,
              ...(folder.scripts ? { scripts: folder.scripts } : {}),
            })),
            {
              label: 'request',
              ...(entry.request.scripts ? { scripts: entry.request.scripts } : {}),
            },
          ],
          collection.scriptFlow,
          scope,
          runner,
          {
            collectionName: collection.name,
            ...(options.environmentName ? { environmentName: options.environmentName } : {}),
            ...(iterations > 1 ? { iteration: { index: iteration, total: iterations } } : {}),
          },
          control,
        );
        const result = await executeRequest(entry.request, scope, {
          ...options,
          auth: entry.auth,
          path: entry.path,
          keepResponse: true,
          inheritedHeaders: mergeHeaders(
            collection.headers,
            ...entry.folders.map((folder) => folder.headers),
          ),
          ...(settings ? { settings } : {}),
          ...(collection.protoFiles ? { protoFiles: collection.protoFiles } : {}),
          cookies: jar,
          authCache,
          ...(scripting ? { scripting } : {}),
          ...(iterations > 1 ? { iteration: iteration + 1 } : {}),
        });
        results.push(result);
        await options.onResult?.(result, results.length - 1, Math.max(total, results.length));
        if ((options.bail && !result.passed) || control.stop || control.next === null) {
          stopped = true;
          break;
        }
        if (typeof control.next === 'string') {
          const target = requests.findIndex((item) => item.request.name === control.next);
          if (target < 0) {
            stopped = true;
            break;
          }
          index = target;
        } else {
          index += 1;
        }
        if (options.delayMs && index < requests.length) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
      }
    }
  } finally {
    await (sandbox as ScriptRunner | null)?.close();
  }
  const skipped = results.filter((result) => result.skipped).length;
  const passed = results.filter((result) => result.passed && !result.skipped).length;
  return {
    result: {
      durationMs: Math.round(performance.now() - started),
      total: Math.max(total, results.length),
      passed,
      failed: results.length - passed - skipped,
      ...(skipped ? { skipped } : {}),
      ...(iterations > 1 ? { iterations } : {}),
      results,
    },
    runtime: { variables: scope.variables('runtime'), cookies: jar.all() },
  };
}

export async function runCollection(
  collection: CollectionSpec,
  options: CollectionRunOptions = {},
): Promise<CollectionRunResult> {
  return (await runCollectionWithState(collection, options)).result;
}

/**
 * The services a gRPC request can call: from its server (reflection) or from the collection's
 * proto files, with the request's URL, metadata and auth resolved like a run would.
 */
export async function describeGrpc(
  collection: CollectionSpec,
  requestId: string,
  options: Pick<
    CollectionRunOptions,
    'environment' | 'runtime' | 'signal' | 'guard' | 'connectHost' | 'timeoutMs' | 'fetch'
  > = {},
): Promise<GrpcServiceList> {
  const entry = flattenRequests(collection).find((item) => item.request.id === requestId);
  if (!entry || entry.request.kind !== 'grpc') throw new Error('Choose a gRPC request.');
  const scope = new LayeredScope({
    collection: collection.variables,
    environment: options.environment ?? [],
    runtime: options.runtime?.variables ?? [],
  });
  scope.assign(
    'folder',
    entry.folders.flatMap((folder) => folder.vars ?? []),
  );
  scope.assign('request', entry.request.vars ?? []);
  const timeoutMs =
    entry.request.timeoutMs ?? collection.settings?.timeoutMs ?? options.timeoutMs ?? 30_000;
  const timeout = AbortSignal.timeout(timeoutMs + 1_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const metadata = mergeHeaders(
    collection.headers,
    ...entry.folders.map((folder) => folder.headers),
    entry.request.headers,
  ).map((row) => [interpolate(row.key, scope), interpolate(row.value, scope)] as const);
  const grpc = entry.request.grpc;
  const url = new URL(interpolate(entry.request.url.trim(), scope));
  const network = networkOf(collection.settings, scope, options, signal);
  const send = senderOf({
    ...options,
    ...(collection.settings ? { settings: collection.settings } : {}),
  });
  // Reflection calls carry the request's auth, as servers often protect them too.
  const authorized = await authorizeRequest(
    { method: 'POST', url, headers: metadata },
    resolveAuth(entry.auth, scope),
    { send: (init) => send(init, network), cache: new Map<string, unknown>() },
  );
  return grpcListServices(
    {
      url,
      protoFiles: collection.protoFiles ?? [],
      ...(grpc?.protoFile ? { protoFile: grpc.protoFile } : {}),
      reflection: grpc?.reflection ?? !grpc?.protoFile,
      metadata: authorized.headers,
      timeoutMs,
    },
    network,
  );
}
