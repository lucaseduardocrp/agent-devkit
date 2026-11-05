import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  executeRequest,
  networkOf,
  resolveAuth,
  senderOf,
} from '../src/modules/apitests/engine/http-request.js';
import type {
  ApiRequestSpec,
  CollectionSettings,
  RequestKind,
} from '../src/modules/apitests/engine/types.js';
import { scopeOf } from '../src/modules/apitests/engine/variables.js';
import {
  GREETER_PROTO,
  grpcServer,
  resettingWebsocketServer,
  socketServer,
  sseServer,
  websocketServer,
  type TestServer,
} from './apitests-stream-servers.js';

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

/** Runs one request of `kind` with no auth and the scope's variables. */
const run = (spec: ApiRequestSpec, variables: Record<string, string> = {}) =>
  executeRequest(spec, scopeOf(Object.entries(variables).map(([key, value]) => ({ key, value }))), {
    auth: { type: 'none' },
    timeoutMs: 5_000,
  });

describe('networkOf, senderOf and resolveAuth', () => {
  const scope = scopeOf([
    { key: 'host', value: 'proxy.test' },
    { key: 'pass', value: 'proxy-pass' },
    { key: 'cert', value: 'CERT-BODY' },
  ]);

  it('resolves the variables of the proxy and of every client certificate', () => {
    const settings: CollectionSettings = {
      proxy: {
        enabled: true,
        protocol: 'http',
        hostname: '{{host}}',
        port: 8080,
        password: '{{pass}}',
      },
      tls: { verify: false },
      clientCertificates: [{ domain: 'api.test', type: 'pem', cert: '{{cert}}', key: 'KEY' }],
    };
    const network = networkOf(settings, scope, {}, new AbortController().signal);
    expect(network.proxy).toMatchObject({ hostname: 'proxy.test', password: 'proxy-pass' });
    expect(network.tls).toEqual({ verify: false });
    expect(network.clientCertificates?.[0]).toMatchObject({ cert: 'CERT-BODY', key: 'KEY' });
    expect(network.connectHost).toBeUndefined();
    expect(network.guard).toBeUndefined();
  });

  it('keeps a disabled proxy and an empty certificate list out of the options', () => {
    const settings: CollectionSettings = {
      proxy: { enabled: false, protocol: 'http', hostname: '{{host}}', port: 8080 },
    };
    const connectHost = (hostname: string) => hostname;
    const guard = async () => {};
    const network = networkOf(
      { ...settings, clientCertificates: [] },
      scope,
      { connectHost, guard },
      new AbortController().signal,
    );
    expect(network.proxy).toBeUndefined();
    expect(network.clientCertificates).toBeUndefined();
    expect(network.tls).toBeUndefined();
    expect(network.connectHost).toBe(connectHost);
    expect(network.guard).toBe(guard);
  });

  it('picks the node transport whenever a network setting needs it', () => {
    const node = senderOf({});
    expect(senderOf({ preferFetch: true })).not.toBe(node);
    for (const settings of [
      { proxy: { enabled: true, protocol: 'http', hostname: 'proxy.test', port: 8080 } },
      { tls: { verify: false } },
      { tls: { caCertificate: 'CA' } },
      { clientCertificates: [{ domain: 'api.test', type: 'pem', cert: 'C', key: 'K' }] },
    ] satisfies CollectionSettings[]) {
      expect(senderOf({ preferFetch: true, settings })).toBe(node);
    }
    expect(senderOf({ preferFetch: true, connectHost: (host) => host })).toBe(node);
  });

  it('resolves only the string fields of an auth', () => {
    expect(
      resolveAuth({ type: 'apikey', key: 'x-{{host}}', value: '{{pass}}', in: 'header' }, scope),
    ).toEqual({ type: 'apikey', key: 'x-proxy.test', value: 'proxy-pass', in: 'header' });
  });
});

describe('websocket requests', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await websocketServer();
  });
  afterAll(() => server.close());

  it('sends the resolved messages, asserts the received ones and keeps the subprotocol', async () => {
    const scope = scopeOf([
      { key: 'name', value: 'ana' },
      { key: 'token', value: 'tok' },
    ]);
    const result = await executeRequest(
      request({
        id: 'ws',
        kind: 'websocket',
        url: `${server.url}chat`,
        headers: [{ key: 'x-token', value: '{{token}}' }],
        websocket: {
          messages: [{ content: '{"hello":"{{name}}"}' }],
          subprotocols: ['adk'],
          listenMs: 100,
          maxMessages: 1,
        },
        assertions: [
          { id: 'a1', source: 'status', operator: 'eq', expected: '101' },
          { id: 'a2', source: 'body', operator: 'contains', expected: 'ana' },
          { id: 'a3', source: 'json', path: '0.hello', operator: 'eq', expected: 'ana' },
        ],
        captures: [
          { source: 'json', path: '0.hello', variable: 'greeted' },
          { source: 'status', variable: '' },
        ],
      }),
      scope,
      { auth: { type: 'none' }, timeoutMs: 5_000, keepResponse: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(101);
    expect(result.passed).toBe(true);
    expect(scope.get('greeted')?.value).toBe('ana');
    // The body assertions read the received messages as a JSON array of their data.
    expect(result.response?.messages?.some((message) => message.direction === 'received')).toBe(
      true,
    );
  });

  it('defaults the listening window and keeps no body for a websocket draft', async () => {
    const result = await run(
      request({
        id: 'ws-defaults',
        kind: 'websocket',
        url: server.url,
        body: { mode: 'json', content: '{"ignored":true}' },
        websocket: { messages: [{ content: 'ping' }], maxMessages: 1 },
      }),
    );
    expect(result.status).toBe(101);
    expect(result.kind).toBe('websocket');
  });

  it('reports a refused connection in the result instead of throwing', async () => {
    const result = await run(
      request({
        id: 'ws-refused',
        kind: 'websocket',
        url: 'ws://127.0.0.1:1/',
        websocket: { messages: [], listenMs: 50 },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('cleans up when the connection resets after a successful handshake', async () => {
    const resetting = await resettingWebsocketServer();
    try {
      const result = await run(
        request({
          id: 'ws-reset',
          kind: 'websocket',
          url: resetting.url,
          websocket: { messages: [], listenMs: 300 },
        }),
      );
      // The handshake completed (101) before the reset arrived; the session still settles.
      expect(result.status).toBe(101);
    } finally {
      await resetting.close();
    }
  });
});

describe('sse requests', () => {
  let server: Awaited<ReturnType<typeof sseServer>>;
  beforeAll(async () => {
    server = await sseServer();
  });
  afterAll(() => server.close());

  it('reads the events, exposes the response headers and caps them with maxEvents', async () => {
    const result = await run(
      request({
        id: 'sse',
        kind: 'sse',
        url: server.url,
        sse: { listenMs: 500, maxEvents: 2 },
        assertions: [
          { id: 'a1', source: 'status', operator: 'eq', expected: '200' },
          { id: 'a2', source: 'header', path: 'x-stream', operator: 'eq', expected: 'yes' },
          { id: 'a3', source: 'json', path: '0.n', operator: 'eq', expected: '1' },
        ],
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(result.status).toBe(200);
  });

  it('sends the body of a POST and leaves it out of a GET', async () => {
    const posted = await run(
      request({
        id: 'sse-post',
        kind: 'sse',
        method: 'POST',
        url: server.url,
        body: { mode: 'json', content: '{"q":"{{term}}"}' },
        sse: { listenMs: 200, maxEvents: 1 },
      }),
      { term: 'shoes' },
    );
    expect(posted.status).toBe(200);
    expect(server.bodies.at(-1)).toBe('{"q":"shoes"}');

    await run(
      request({
        id: 'sse-get',
        kind: 'sse',
        method: 'GET',
        url: server.url,
        body: { mode: 'json', content: '{"ignored":true}' },
        sse: { listenMs: 200, maxEvents: 1 },
      }),
    );
    expect(server.bodies.at(-1)).toBe('');
  });

  it('defaults the listening window when the spec has none', async () => {
    const result = await run(
      request({ id: 'sse-defaults', kind: 'sse', url: server.url, sse: { maxEvents: 1 } }),
    );
    expect(result.status).toBe(200);
  });
});

describe('socket requests', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await socketServer();
  });
  afterAll(() => server.close());

  it('sends the resolved messages and stops at readUntil', async () => {
    const result = await run(
      request({
        id: 'socket',
        kind: 'socket',
        url: server.url,
        query: [{ key: 'ignored', value: 'yes' }],
        socket: {
          messages: [{ content: 'hello {{name}}' }],
          listenMs: 500,
          readUntil: 'echo:{{marker}}',
          responseEncoding: 'text',
        },
        assertions: [{ id: 'a1', source: 'body', operator: 'contains', expected: 'hello ana' }],
      }),
      { name: 'ana', marker: 'hello' },
    );
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('defaults the listening window and the response encoding', async () => {
    const result = await run(
      request({
        id: 'socket-defaults',
        kind: 'socket',
        url: server.url,
        socket: { messages: [{ content: 'ping' }], listenMs: 100 },
      }),
    );
    expect(result.kind).toBe('socket');
  });
});

describe('request drafts of every kind', () => {
  it('drafts the body scripts read for each kind', async () => {
    const drafts: Record<string, string | undefined> = {};
    for (const [kind, spec] of [
      [
        'grpc',
        request({ id: 'g', url: 'grpc://127.0.0.1:1', grpc: { method: 'M', message: '{}' } }),
      ],
      ['websocket', request({ id: 'w', url: 'ws://127.0.0.1:1' })],
      ['socket', request({ id: 's', url: 'tcp://127.0.0.1:1' })],
    ] as const satisfies readonly (readonly [RequestKind, ApiRequestSpec])[]) {
      const result = await executeRequest({ ...spec, kind }, scopeOf([]), {
        auth: { type: 'none' },
        timeoutMs: 50,
        scripting: {
          pre: async (view) => {
            drafts[kind] = view.body;
            return { tests: [], logs: [], skip: true };
          },
          post: async () => ({ tests: [], logs: [] }),
          tests: async () => ({ tests: [], logs: [] }),
        },
      });
      expect(result.passed).toBe(true);
    }
    expect(drafts).toEqual({ grpc: '{}', websocket: undefined, socket: undefined });
  });

  it('fails an unsupported kind', async () => {
    const result = await executeRequest(
      { ...request({ id: 'x', url: 'http://api.test/' }), kind: 'quantum' as RequestKind },
      scopeOf([]),
      { auth: { type: 'none' } },
    );
    expect(result.error).toContain('Unsupported request kind quantum');
  });
});

describe('grpc requests', () => {
  let server: Awaited<ReturnType<typeof grpcServer>>;
  beforeAll(async () => {
    server = await grpcServer(['hi']);
  });
  afterAll(() => server.close());

  const protoFiles = [{ name: 'demo.proto', content: GREETER_PROTO }];

  it('calls the method from the proto files and keeps headers, trailers and messages', async () => {
    const result = await executeRequest(
      request({
        id: 'grpc',
        kind: 'grpc',
        url: server.url,
        headers: [{ key: 'x-tenant', value: '{{tenant}}' }],
        grpc: {
          method: 'demo.v1.{{service}}/Say',
          message: '{"id":"{{who}}"}',
          protoFile: 'demo.proto',
        },
        assertions: [
          { id: 'a1', source: 'status', operator: 'eq', expected: '0' },
          { id: 'a2', source: 'json', path: 'id', operator: 'eq', expected: 'hi' },
        ],
      }),
      scopeOf([
        { key: 'who', value: 'ana' },
        { key: 'service', value: 'Greeter' },
        { key: 'tenant', value: 'acme' },
      ]),
      { auth: { type: 'none' }, timeoutMs: 5_000, keepResponse: true, protoFiles },
    );
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(server.paths.at(-1)).toBe('/demo.v1.Greeter/Say');
    expect(server.metadata.at(-1)?.['x-tenant']).toBe('acme');
    expect(result.response?.trailers).toMatchObject({ 'x-trailer': 'done' });
    expect(result.response?.headers).toMatchObject({ 'x-served-by': 'adk-test' });
  });

  it('sends a JSON array as several request messages and keeps an array response', async () => {
    const twice = await grpcServer(['one', 'two']);
    try {
      const result = await executeRequest(
        request({
          id: 'grpc-stream',
          kind: 'grpc',
          url: twice.url,
          grpc: {
            method: '/demo.v1.Greeter/Say',
            message: '[{"id":"a"},{"id":"b"}]',
            protoFile: 'demo.proto',
          },
        }),
        scopeOf([]),
        { auth: { type: 'none' }, timeoutMs: 5_000, keepResponse: true, protoFiles },
      );
      expect(result.error).toBeUndefined();
      expect(result.response?.bodyPreview).toBe('[{"id":"one"},{"id":"two"}]');
    } finally {
      await twice.close();
    }
  });

  it('falls back to the draft message and to an empty one', async () => {
    const result = await executeRequest(
      request({
        id: 'grpc-empty',
        kind: 'grpc',
        url: server.url,
        grpc: { method: 'demo.v1.Greeter/Say', message: '   ', protoFile: 'demo.proto' },
      }),
      scopeOf([]),
      { auth: { type: 'none' }, timeoutMs: 5_000, protoFiles },
    );
    expect(result.error).toBeUndefined();
    expect(result.passed).toBe(true);
  });

  it('refuses a message that is not valid JSON', async () => {
    const result = await executeRequest(
      request({
        id: 'grpc-bad',
        kind: 'grpc',
        url: server.url,
        grpc: { method: 'demo.v1.Greeter/Say', message: '{not json', protoFile: 'demo.proto' },
      }),
      scopeOf([]),
      { auth: { type: 'none' }, timeoutMs: 5_000, protoFiles },
    );
    expect(result.error).toContain('not valid JSON');
  });

  it('asks the server through reflection when the request names no proto file', async () => {
    const result = await executeRequest(
      {
        ...request({ id: 'grpc-reflect', url: server.url }),
        kind: 'grpc',
        grpc: { method: 'demo.v1.Greeter/Say', message: '{}' },
      },
      scopeOf([]),
      { auth: { type: 'none' }, timeoutMs: 2_000 },
    );
    // The test server answers no reflection service, so the call fails instead of guessing.
    expect(result.passed).toBe(false);
  });
});
