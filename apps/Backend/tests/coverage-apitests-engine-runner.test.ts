import { beforeEach, describe, expect, it, vi } from 'vitest';

const grpc = vi.hoisted(() => ({ grpcListServices: vi.fn(), grpcCall: vi.fn() }));
vi.mock('../src/modules/apitests/engine/grpc-client.js', () => grpc);

const { flattenRequests, selectRequests, runCollectionWithState, describeGrpc } =
  await import('../src/modules/apitests/engine/collection-runner.js');
const { executeRun } = await import('../src/modules/apitests/engine/run-executor.js');
import type {
  ScriptHost,
  ScriptInput,
  ScriptOutput,
} from '../src/modules/apitests/engine/script-sandbox.js';
import type {
  ApiFolder,
  ApiRequestSpec,
  CollectionSpec,
  RunPayload,
} from '../src/modules/apitests/engine/types.js';

const request = (id: string, extra: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  id,
  type: 'request',
  name: id,
  method: 'GET',
  url: `https://api.example.test/${id}`,
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'inherit' },
  assertions: [],
  captures: [],
  ...extra,
});

const folder = (
  id: string,
  items: ApiFolder['items'],
  extra: Partial<ApiFolder> = {},
): ApiFolder => ({
  id,
  type: 'folder',
  name: id,
  items,
  ...extra,
});

const collection = (
  items: CollectionSpec['items'],
  extra: Partial<CollectionSpec> = {},
): CollectionSpec => ({ name: 'C', variables: [], auth: { type: 'none' }, items, ...extra });

const sent: { url: string; headers: Headers }[] = [];
const okFetch = (delayMs = 0): typeof fetch =>
  (async (input: Request) => {
    sent.push({ url: input.url, headers: input.headers });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response('ok', {
      status: 200,
      headers: [
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['x-one', '1'],
      ],
    });
  }) as unknown as typeof fetch;

const output = (input: ScriptInput, extra: Partial<ScriptOutput> = {}): ScriptOutput => ({
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
  ...extra,
});

type Handler = (
  input: ScriptInput,
  host: ScriptHost,
) => Promise<Partial<ScriptOutput> | void> | Partial<ScriptOutput> | void;
/** Scripts are plain handlers keyed by the code text. */
function scriptsOf(handlers: Record<string, Handler>, calls: ScriptInput[] = []) {
  const close = vi.fn(() => Promise.resolve());
  return {
    close,
    scripts: (host: ScriptHost) => ({
      close,
      run: async (input: ScriptInput) => {
        calls.push(input);
        return output(input, (await handlers[input.code.trim()]?.(input, host)) ?? {});
      },
    }),
  };
}

const withPre = (id: string, code: string, extra: Partial<ApiRequestSpec> = {}) =>
  request(id, { scripts: { preRequest: code }, ...extra });

beforeEach(() => {
  sent.length = 0;
  grpc.grpcListServices.mockReset();
  grpc.grpcCall.mockReset();
});

describe('selecting requests', () => {
  it('resolves auth through folders and the collection', () => {
    const tree = collection(
      [
        folder('f1', [request('a'), request('b', { auth: { type: 'bearer', token: 'own' } })], {
          auth: { type: 'basic', username: 'u', password: 'p' },
        }),
        folder('f2', [folder('f3', [request('c')], { auth: { type: 'inherit' } })]),
        request('d'),
      ],
      { auth: { type: 'inherit' } },
    );
    expect(
      flattenRequests(tree).map((entry) => [entry.request.id, entry.auth.type, entry.path]),
    ).toEqual([
      ['a', 'basic', ['f1']],
      ['b', 'bearer', ['f1']],
      ['c', 'none', ['f2', 'f3']],
      ['d', 'none', []],
    ]);
    expect(selectRequests(tree, ['f2', 'b']).map((entry) => entry.request.id)).toEqual(['b', 'c']);
    expect(selectRequests(tree).map((entry) => entry.request.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('script host', () => {
  const sendThrough = async (
    input: Parameters<ScriptHost['sendRequest']>[0],
    options: Partial<Parameters<typeof runCollectionWithState>[1]> = {},
    settings?: CollectionSpec['settings'],
  ) => {
    let response: Awaited<ReturnType<ScriptHost['sendRequest']>> | undefined;
    const { scripts } = scriptsOf({
      go: async (_input, host) => {
        response = await host.sendRequest(input);
      },
    });
    const run = await runCollectionWithState(
      collection([withPre('a', 'go')], settings ? { settings } : {}),
      { fetch: okFetch(), scripts, ...options },
    );
    return { response: response!, run };
  };

  it('sends requests with the run cookies, network and timeouts', async () => {
    const { response, run } = await sendThrough({
      method: 'post',
      url: 'https://hook.test/x',
      headers: { a: '1' },
      body: 'payload',
      timeoutMs: 500,
    });
    expect(response).toMatchObject({
      status: 200,
      body: 'ok',
      headers: { 'set-cookie': 'a=1, b=2', 'x-one': '1' },
    });
    expect(sent[0]!.url).toBe('https://hook.test/x');
    expect(sent[0]!.headers.get('a')).toBe('1');
    // The hook's cookies join the run's jar.
    expect(run.runtime.cookies.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
  });

  it('defaults to the collection timeout, then 30 seconds, and honours the run signal', async () => {
    const withSettings = await sendThrough(
      { method: 'get', url: 'https://hook.test/y', headers: {} },
      { signal: new AbortController().signal },
      { timeoutMs: 2_000 },
    );
    expect(withSettings.response.status).toBe(200);
    const bare = await sendThrough({ method: 'get', url: 'https://hook.test/z', headers: {} });
    expect(bare.response.status).toBe(200);
  });
});

describe('collection flow', () => {
  it('stops a request on a script error, before running the next script level', async () => {
    const calls: ScriptInput[] = [];
    const { scripts, close } = scriptsOf(
      {
        first: () => ({
          error: 'script blew up',
          tests: [
            { name: 'T', passed: false, error: 'bad' },
            { name: 'U', passed: true },
          ],
          logs: [{ level: 'log', message: 'hello', source: 'go' }],
        }),
        second: () => undefined,
      },
      calls,
    );
    const { result } = await runCollectionWithState(
      collection([request('a', { scripts: { preRequest: 'first' } })], {
        scripts: { preRequest: 'second' },
      }),
      { fetch: okFetch(), scripts },
    );
    // The collection level runs first and its script does not fail; the request level fails.
    expect(calls.map((call) => call.source)).toEqual([
      'collection pre-request',
      'request pre-request',
    ]);
    expect(result.results[0]).toMatchObject({
      passed: false,
      error: 'script blew up',
      tests: [
        { id: 'test-1', label: 'T', passed: false, actual: 'bad' },
        { id: 'test-2', label: 'U', passed: true },
      ],
      logs: [{ message: 'hello' }],
    });
    expect(close).toHaveBeenCalled();
  });

  it('follows setNextRequest, and stops on an unknown name, null or stopExecution', async () => {
    const items = [withPre('a', 'a'), withPre('b', 'b'), withPre('c', 'c')];
    const ran = async (handlers: Record<string, Handler>) =>
      (
        await runCollectionWithState(collection(items), {
          fetch: okFetch(),
          scripts: scriptsOf(handlers).scripts,
        })
      ).result;

    let looped = false;
    const jumped = await ran({
      b: () => {
        if (looped) return undefined;
        looped = true;
        return { nextRequest: 'a' };
      },
    });
    expect(jumped.results.map((item) => item.name)).toEqual(['a', 'b', 'a', 'b', 'c']);
    // More requests ran than the selection holds, and the total follows.
    expect(jumped.total).toBe(5);

    expect((await ran({ a: () => ({ nextRequest: 'missing' }) })).results).toHaveLength(1);
    expect((await ran({ a: () => ({ nextRequest: null }) })).results).toHaveLength(1);
    expect((await ran({ b: () => ({ stopExecution: true }) })).results).toHaveLength(2);
    const skipped = await ran({ b: () => ({ skipRequest: true }) });
    expect(skipped).toMatchObject({ skipped: 1, passed: 2, failed: 0 });
  });

  it('ends a script loop after the execution limit', async () => {
    const { scripts } = scriptsOf({ loop: () => ({ nextRequest: 'a' }) });
    const { result } = await runCollectionWithState(collection([withPre('a', 'loop')]), {
      fetch: okFetch(),
      scripts,
    });
    expect(result.results).toHaveLength(10_000);
  }, 120_000);

  it('bails at the first failure and tells the listener about every result', async () => {
    const failing = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    const onResult = vi.fn();
    const { result } = await runCollectionWithState(collection([request('a'), request('b')]), {
      fetch: failing,
      bail: true,
      onResult,
    });
    expect(result).toMatchObject({ total: 2, failed: 1, passed: 0 });
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ name: 'a' }), 0, 2);
  });

  it('runs folders that have no variables, headers or scripts', async () => {
    const { result } = await runCollectionWithState(collection([folder('plain', [request('a')])]), {
      fetch: okFetch(),
    });
    expect(result.passed).toBe(1);
  });

  it('runs iterations over data rows, with the environment name and sequential scripts', async () => {
    const calls: ScriptInput[] = [];
    const { scripts } = scriptsOf(
      { 'tests-code': () => ({ tests: [{ name: 'ok', passed: true }] }) },
      calls,
    );
    const tree = collection(
      [
        folder('f', [request('a', { scripts: { tests: 'tests-code' } })], {
          scripts: { tests: 'tests-code' },
          vars: [{ key: 'v', value: '1' }],
          headers: [{ key: 'X-F', value: 'f' }],
        }),
      ],
      {
        scripts: { tests: 'tests-code' },
        scriptFlow: 'sequential',
        headers: [{ key: 'X-C', value: 'c' }],
        protoFiles: [{ name: 'a.proto', content: '' }],
        settings: { followRedirects: false },
      },
    );
    const { result } = await runCollectionWithState(tree, {
      fetch: okFetch(),
      scripts,
      environmentName: 'staging',
      data: [{ n: '1' }, { n: '2' }],
      iterations: 9,
    });
    expect(result).toMatchObject({ total: 2, iterations: 2, passed: 2 });
    expect(result.results.map((item) => item.iteration)).toEqual([1, 2]);
    expect(calls.map((call) => call.source).slice(0, 3)).toEqual([
      'collection tests',
      'folder f tests',
      'request tests',
    ]);
    expect(calls[0]).toMatchObject({
      environmentName: 'staging',
      iteration: { index: 0, total: 2 },
      variables: { data: { n: '1' } },
    });
    expect(sent[0]!.headers.get('x-c')).toBe('c');
    expect(sent[0]!.headers.get('x-f')).toBe('f');

    // Without data, `iterations` repeats the selection; without a name, the context has none.
    calls.length = 0;
    const repeated = await runCollectionWithState(collection([withPre('a', 'tests-code')]), {
      fetch: okFetch(),
      scripts,
      iterations: 2,
    });
    expect(repeated.result.iterations).toBe(2);
    expect(calls[0]).not.toHaveProperty('environmentName');
  });

  it('pauses between requests and stops on a cancelled run', async () => {
    const started = Date.now();
    await runCollectionWithState(collection([request('a'), request('b')]), {
      fetch: okFetch(),
      delayMs: 40,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runCollectionWithState(collection([request('a')]), {
      fetch: okFetch(),
      signal: controller.signal,
    });
    expect(cancelled.result).toMatchObject({ total: 1, passed: 0, failed: 0, results: [] });
  });

  it('starts from the runtime state and returns it', async () => {
    const { runtime } = await runCollectionWithState(
      collection([request('a', { captures: [{ variable: 'seen', source: 'status' }] })]),
      {
        fetch: okFetch(),
        runtime: {
          variables: [{ key: 'kept', value: 'yes' }],
          cookies: [{ name: 'old', value: '1', domain: 'api.example.test', path: '/' }],
        },
      },
    );
    expect(runtime.variables).toEqual(
      expect.arrayContaining([
        { key: 'kept', value: 'yes' },
        { key: 'seen', value: '200' },
      ]),
    );
    expect(sent[0]!.headers.get('cookie')).toBe('old=1');
  });

  it('runs scripts in the real sandbox by default', async () => {
    const { result } = await runCollectionWithState(
      collection([request('a', { scripts: { preRequest: 'adk.runner.skipRequest()' } })]),
      { fetch: okFetch() },
    );
    expect(result).toMatchObject({ skipped: 1, passed: 0, failed: 0 });
  }, 30_000);
});

describe('describeGrpc', () => {
  const grpcRequest = (extra: Partial<ApiRequestSpec> = {}) =>
    request('g', {
      kind: 'grpc',
      url: 'grpc://{{host}}:50051',
      headers: [{ key: 'x-req', value: '{{host}}' }],
      grpc: { method: 'a.B/C', message: '{}' },
      ...extra,
    });

  it('refuses requests that are not gRPC', async () => {
    const tree = collection([request('plain')]);
    await expect(describeGrpc(tree, 'plain')).rejects.toThrow('Choose a gRPC request.');
    await expect(describeGrpc(tree, 'missing')).rejects.toThrow('Choose a gRPC request.');
  });

  it('lists services with the request url, metadata, auth and proto files', async () => {
    grpc.grpcListServices.mockResolvedValue({ services: [] });
    const tree = collection(
      [
        folder(
          'f',
          [
            grpcRequest({
              timeoutMs: 1_500,
              grpc: { method: 'a.B/C', message: '{}', protoFile: 'a.proto' },
            }),
          ],
          {
            vars: [{ key: 'host', value: 'svc.test' }],
            headers: [{ key: 'x-folder', value: 'f' }],
          },
        ),
      ],
      {
        auth: { type: 'bearer', token: 'tok-{{host}}' },
        headers: [{ key: 'x-col', value: 'c' }],
        protoFiles: [{ name: 'a.proto', content: 'syntax = "proto3";' }],
        settings: { timeoutMs: 9_000 },
      },
    );
    const list = await describeGrpc(tree, 'g', {
      signal: new AbortController().signal,
      environment: [{ key: 'env', value: 'x' }],
      runtime: { variables: [{ key: 'rt', value: 'y' }], cookies: [] },
      fetch: okFetch(),
    });
    expect(list).toEqual({ services: [] });
    const [target] = grpc.grpcListServices.mock.calls[0]!;
    expect(target.url.href).toBe('grpc://svc.test:50051');
    expect(target).toMatchObject({ protoFile: 'a.proto', reflection: false, timeoutMs: 1_500 });
    expect(target.protoFiles).toHaveLength(1);
    expect(Object.fromEntries(target.metadata)).toEqual({
      'x-col': 'c',
      'x-folder': 'f',
      'x-req': 'svc.test',
      Authorization: 'Bearer tok-svc.test',
    });
  });

  it('fetches an OAuth2 token for the reflection call and handles folders without settings', async () => {
    grpc.grpcListServices.mockResolvedValue({ services: [] });
    const tokenFetch = (async (input: Request) => {
      sent.push({ url: input.url, headers: input.headers });
      return new Response(JSON.stringify({ access_token: 'oauth-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const tree = collection(
      [folder('plain', [grpcRequest({ url: 'grpc://x.test:1', headers: [] })])],
      {
        auth: {
          type: 'oauth2',
          grantType: 'client_credentials',
          accessTokenUrl: 'https://auth.test/token',
          clientId: 'id',
          clientSecret: 'secret',
        },
      },
    );
    await describeGrpc(tree, 'g', { fetch: tokenFetch });
    expect(sent[0]!.url).toBe('https://auth.test/token');
    const [target] = grpc.grpcListServices.mock.calls[0]!;
    expect(Object.fromEntries(target.metadata)).toEqual({ Authorization: 'Bearer oauth-token' });
  });

  it('uses reflection when there is no proto file, and the collection timeout otherwise', async () => {
    grpc.grpcListServices.mockResolvedValue({ services: [] });
    await describeGrpc(
      collection([grpcRequest({ grpc: undefined, url: 'grpc://x.test:1', headers: [] })], {
        settings: { timeoutMs: 9_000 },
      }),
      'g',
    );
    expect(grpc.grpcListServices.mock.calls[0]![0]).toMatchObject({
      reflection: true,
      protoFiles: [],
      timeoutMs: 9_000,
    });
    await describeGrpc(collection([grpcRequest({ url: 'grpc://x.test:1', headers: [] })]), 'g', {
      timeoutMs: 4_000,
    });
    expect(grpc.grpcListServices.mock.calls[1]![0]).toMatchObject({ timeoutMs: 4_000 });
    await describeGrpc(collection([grpcRequest({ url: 'grpc://x.test:1', headers: [] })]), 'g');
    expect(grpc.grpcListServices.mock.calls[2]![0]).toMatchObject({ timeoutMs: 30_000 });
    // An explicit reflection flag wins over the proto file.
    await describeGrpc(
      collection([
        grpcRequest({
          url: 'grpc://x.test:1',
          headers: [],
          grpc: { method: 'a/B', message: '{}', protoFile: 'a.proto', reflection: true },
        }),
      ]),
      'g',
    );
    expect(grpc.grpcListServices.mock.calls[3]![0]).toMatchObject({ reflection: true });
  });
});

describe('executeRun', () => {
  const report = () => Promise.resolve('running' as const);
  const integration = (
    items: CollectionSpec['items'],
    extra: Partial<Extract<RunPayload, { kind: 'integration' }>> = {},
  ): RunPayload => ({
    kind: 'integration',
    collection: collection(items),
    environment: [],
    itemIds: [],
    bail: false,
    ...extra,
  });

  it('runs a collection with every option and reports the runtime state', async () => {
    const guard = vi.fn(() => Promise.resolve());
    const outcome = await executeRun(
      integration([request('a'), request('b')], {
        environment: [{ key: 'env', value: 'x' }],
        environmentName: 'qa',
        runtime: { variables: [{ key: 'rt', value: '1' }], cookies: [] },
        iterations: 2,
        data: [{ n: '1' }],
        delayMs: 1,
        previewBytes: 1,
        itemIds: ['a', 'b'],
      }),
      { report, fetch: okFetch(), guard, connectHost: (host) => host },
    );
    expect(outcome).toMatchObject({ status: 'passed', error: null });
    expect(outcome.runtime?.variables).toEqual([{ key: 'rt', value: '1' }]);
    expect(guard).toHaveBeenCalled();
    const result = outcome.result as unknown as {
      results: { response?: { bodyPreview: string } }[];
    };
    expect(result.results[0]!.response?.bodyPreview).toBe('o');
  });

  it('marks a run with failed requests as failed', async () => {
    const outcome = await executeRun(integration([request('a')]), {
      report,
      fetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe('passed');
    const failing = await executeRun(
      integration([
        request('a', {
          assertions: [{ id: '1', source: 'status', operator: 'eq', expected: '500' }],
        }),
      ]),
      { report, fetch: okFetch() },
    );
    expect(failing.status).toBe('failed');
  });

  it('reports progress while it runs, including skipped requests', async () => {
    const partials: unknown[] = [];
    const outcome = await executeRun(
      integration([
        request('skip', { scripts: { preRequest: 'adk.runner.skipRequest()' } }),
        request('slow-1'),
        request('slow-2'),
      ]),
      {
        heartbeatMs: 20,
        fetch: okFetch(80),
        report: (partial) => {
          partials.push(partial);
          // A slow listener: beats that arrive while it works are skipped.
          return new Promise((resolve) => setTimeout(() => resolve('running'), 50));
        },
      },
    );
    expect(outcome.status).toBe('passed');
    const last = partials.at(-1) as { total: number; passed: number; skipped?: number } | null;
    expect(partials[0]).toBeNull();
    expect(last).toMatchObject({ total: 3, skipped: 1 });
  }, 30_000);

  it('stops when the listener says so, or when the caller aborts', async () => {
    const stopped = await executeRun(integration([request('a'), request('b'), request('c')]), {
      heartbeatMs: 10,
      fetch: okFetch(60),
      report: () => Promise.resolve('stopped'),
    });
    expect((stopped.result as unknown as { results: unknown[] }).results.length).toBeLessThan(3);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const aborted = await executeRun(integration([request('a'), request('b'), request('c')]), {
      report,
      signal: controller.signal,
      fetch: okFetch(60),
    });
    expect((aborted.result as unknown as { results: unknown[] }).results.length).toBeLessThan(3);
  });

  it('survives a failing progress listener', async () => {
    const outcome = await executeRun(integration([request('a')]), {
      heartbeatMs: 5,
      fetch: okFetch(40),
      report: () => Promise.reject(new Error('listener down')),
    });
    expect(outcome.status).toBe('passed');
  });

  it('reports errors of the run itself, whatever was thrown', async () => {
    const asError = await executeRun({ ...integration([]), collection: null } as never, { report });
    expect(asError).toMatchObject({ status: 'error', result: null });
    expect(asError.error).toMatch(/null/);
    const odd = integration([request('a')]);
    Object.defineProperty(odd, 'itemIds', {
      get() {
        throw 'weird failure';
      },
    });
    expect(await executeRun(odd, { report })).toMatchObject({
      status: 'error',
      error: 'weird failure',
    });
  });

  it('runs load tests with the same hooks', async () => {
    const partials: unknown[] = [];
    const outcome = await executeRun(
      {
        kind: 'load',
        plan: {
          requests: [{ request: request('a'), auth: { type: 'none' }, weight: 1 }],
          variables: [],
          stages: [
            { durationSec: 1, targetVus: 1 },
            { durationSec: 1, targetVus: 1 },
          ],
          thinkTimeMs: 100,
          thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.5 }],
        },
        maxVus: 1,
      },
      {
        heartbeatMs: 100,
        fetch: okFetch(),
        report: (partial) => {
          partials.push(partial);
          return Promise.resolve('running');
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'passed', error: null });
    expect(partials.some((partial) => partial !== null)).toBe(true);
    const failing = await executeRun(
      {
        kind: 'load',
        plan: {
          requests: [],
          variables: [],
          stages: [],
          thinkTimeMs: 0,
          thresholds: [],
        },
        maxVus: 1,
      },
      { report },
    );
    expect(failing).toMatchObject({
      status: 'error',
      error: 'A load test needs at least one request.',
    });
    const unmet = await executeRun(
      {
        kind: 'load',
        plan: {
          requests: [{ request: request('a'), auth: { type: 'none' }, weight: 1 }],
          variables: [],
          stages: [
            { durationSec: 1, targetVus: 1 },
            { durationSec: 1, targetVus: 1 },
          ],
          thinkTimeMs: 100,
          thresholds: [{ metric: 'errorRate', operator: 'gt', value: 0.5 }],
        },
        maxVus: 1,
      },
      { report, fetch: okFetch() },
    );
    expect(unmet.status).toBe('failed');
  }, 30_000);

  describe('gRPC reflection', () => {
    const grpcPayload = (items: CollectionSpec['items'] = [grpcRequest()]): RunPayload =>
      integration(items, {
        mode: 'grpc-reflect',
        runtime: { variables: [{ key: 'rt', value: '1' }], cookies: [] },
      });
    const grpcRequest = () =>
      request('g', {
        kind: 'grpc',
        url: 'grpc://x.test:1',
        grpc: { method: 'a/B', message: '{}' },
      });

    it('lists the services as the body of the result', async () => {
      grpc.grpcListServices.mockResolvedValue({ services: [{ name: 'a.B', methods: [] }] });
      const outcome = await executeRun(grpcPayload(), { report, fetch: okFetch() });
      expect(outcome.status).toBe('passed');
      const result = outcome.result as unknown as {
        results: { response: { bodyPreview: string }; kind: string; status: number }[];
        passed: number;
      };
      expect(result.passed).toBe(1);
      expect(result.results[0]).toMatchObject({ kind: 'grpc', status: 0 });
      expect(JSON.parse(result.results[0]!.response.bodyPreview)).toEqual({
        services: [{ name: 'a.B', methods: [] }],
      });
      const withoutRuntime = await executeRun(
        { ...grpcPayload(), runtime: undefined } as RunPayload,
        { report },
      );
      expect(withoutRuntime.status).toBe('passed');
    });

    it('fails the run when the listing fails, whatever was thrown', async () => {
      grpc.grpcListServices.mockRejectedValueOnce(new Error('unreachable'));
      const outcome = await executeRun(grpcPayload(), { report });
      expect(outcome.status).toBe('failed');
      expect(outcome.result).toMatchObject({
        failed: 1,
        results: [{ error: 'unreachable', status: null }],
      });
      grpc.grpcListServices.mockRejectedValueOnce('odd');
      const odd = await executeRun(grpcPayload(), { report });
      expect(odd.result).toMatchObject({ results: [{ error: 'odd' }] });
    });

    it('reports a run without a gRPC request as an error', async () => {
      const outcome = await executeRun(grpcPayload([]), { report });
      expect(outcome).toMatchObject({
        status: 'error',
        error: 'There is no gRPC request to describe.',
      });
    });
  });
});
