import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  describeGrpc,
  runCollectionWithState,
  type ScriptHost,
  type ScriptRunner,
} from '../src/modules/apitests/engine/collection-runner.js';
import type { ScriptInput, ScriptOutput } from '../src/modules/apitests/engine/script-sandbox.js';
import type { ApiRequestSpec, CollectionSpec } from '../src/modules/apitests/engine/types.js';
import {
  GREETER_PROTO,
  echoServer,
  grpcServer,
  tokenServer,
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

/** A script runner whose single handler is called for every phase. */
function scriptsReturning(
  handler: (input: ScriptInput) => Partial<ScriptOutput>,
): (host: ScriptHost) => ScriptRunner {
  return (host) => ({
    run: async (input) => ({
      request: input.request,
      variables: input.variables,
      tests: [],
      logs: [],
      skipRequest: false,
      stopExecution: false,
      ...handler({ ...input, host } as ScriptInput),
    }),
    close: () => Promise.resolve(),
  });
}

describe('describeGrpc', () => {
  const collection = (grpc: ApiRequestSpec['grpc'], extra: Partial<CollectionSpec> = {}) =>
    ({
      name: 'Grpc',
      variables: [{ key: 'tenant', value: 'acme' }],
      auth: { type: 'none' },
      protoFiles: [{ name: 'demo.proto', content: GREETER_PROTO }],
      items: [
        {
          id: 'f',
          type: 'folder',
          name: 'Folder',
          headers: [{ key: 'x-folder', value: 'yes' }],
          vars: [{ key: 'scoped', value: 'folder' }],
          items: [
            {
              ...request({ id: 'r', url: 'grpc://127.0.0.1:1' }),
              kind: 'grpc',
              headers: [{ key: 'x-tenant', value: '{{tenant}}' }],
              vars: [{ key: 'own', value: 'request' }],
              ...(grpc ? { grpc } : {}),
            },
          ],
        },
      ],
      ...extra,
    }) satisfies CollectionSpec;

  it('lists the services of the collection proto files without connecting', async () => {
    const services = await describeGrpc(
      collection({ method: 'demo.v1.Greeter/Say', message: '{}', protoFile: 'demo.proto' }),
      'r',
    );
    expect(services.services.map((service) => service.name)).toContain('demo.v1.Greeter');
    expect(services.services[0]?.methods.map((method) => method.name)).toContain('Say');
  });

  it('carries the request auth and the merged metadata into a reflection call', async () => {
    const server = await grpcServer();
    try {
      const target = collection({ method: 'demo.v1.Greeter/Say', message: '{}' });
      const spec: CollectionSpec = {
        ...target,
        items: [
          {
            ...target.items[0],
            items: [
              {
                ...(target.items[0] as { items: ApiRequestSpec[] }).items[0],
                url: server.url,
                auth: { type: 'bearer', token: 'tok-{{tenant}}' },
              },
            ],
          } as CollectionSpec['items'][number],
        ],
      };
      // The test server answers no reflection service, so the listing comes back empty.
      await expect(describeGrpc(spec, 'r', { timeoutMs: 2_000 })).resolves.toEqual({ services: [] });
      expect(server.metadata.at(-1)?.authorization).toBe('Bearer tok-acme');
      expect(server.metadata.at(-1)?.['x-tenant']).toBe('acme');
      expect(server.metadata.at(-1)?.['x-folder']).toBe('yes');
    } finally {
      await server.close();
    }
  });

  it('uses the collection timeout and settings when the request has none', async () => {
    const services = await describeGrpc(
      collection(
        { method: 'demo.v1.Greeter/Say', message: '{}', protoFile: 'demo.proto' },
        { settings: { timeoutMs: 4_000 } },
      ),
      'r',
    );
    expect(services.services.length).toBeGreaterThan(0);
  });

  it('refuses a request that is missing or is not gRPC', async () => {
    const http = {
      name: 'Http',
      variables: [],
      auth: { type: 'none' },
      items: [request({ id: 'plain', url: 'http://api.test/' })],
    } satisfies CollectionSpec;
    await expect(describeGrpc(http, 'plain')).rejects.toThrow('Choose a gRPC request.');
    await expect(describeGrpc(http, 'missing')).rejects.toThrow('Choose a gRPC request.');
  });
});

describe('what a script sends on its own', () => {
  let server: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    server = await echoServer([
      ['x-many', 'one'],
      ['x-many', 'two'],
    ]);
  });
  afterAll(() => server.close());

  const collection = (extra: Partial<CollectionSpec> = {}) =>
    ({
      name: 'Scripted',
      variables: [],
      auth: { type: 'none' },
      items: [request({ id: 'r', url: server.url, scripts: { preRequest: 'send' } })],
      ...extra,
    }) satisfies CollectionSpec;

  it('sends the request of a script with its body and joins repeated headers', async () => {
    let sent: Awaited<ReturnType<ScriptHost['sendRequest']>> | undefined;
    await runCollectionWithState(collection(), {
      scripts: scriptsReturning((input) => {
        const host = (input as ScriptInput & { host: ScriptHost }).host;
        void host
          .sendRequest({
            method: 'post',
            url: server.url,
            headers: { 'x-from': 'script' },
            body: '{"a":1}',
            timeoutMs: 3_000,
          })
          .then((response) => {
            sent = response;
          });
        return {};
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent?.status).toBe(200);
    expect(sent?.headers['x-many']).toBe('one, two');
    expect(server.seen.some((seen) => seen.body === '{"a":1}')).toBe(true);
  });

  it('falls back to the collection timeout when the script asks for none', async () => {
    let status: number | undefined;
    await runCollectionWithState(collection({ settings: { timeoutMs: 3_000 } }), {
      scripts: scriptsReturning((input) => {
        const host = (input as ScriptInput & { host: ScriptHost }).host;
        void host
          .sendRequest({ method: 'GET', url: server.url, headers: {} })
          .then((response) => {
            status = response.status;
          });
        return {};
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).toBe(200);
  });
});

describe('flow control that stops a run', () => {
  let server: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    server = await echoServer();
  });
  afterAll(() => server.close());

  const two = (): CollectionSpec => ({
    name: 'Two',
    variables: [],
    auth: { type: 'none' },
    items: [
      request({ id: 'a', url: server.url, scripts: { preRequest: 'jump' } }),
      request({ id: 'b', url: server.url }),
    ],
  });

  it('stops when a script names a request that the run does not hold', async () => {
    const { result } = await runCollectionWithState(
      two(),
      { scripts: scriptsReturning(() => ({ nextRequest: 'nowhere' })) },
    );
    expect(result.results.length).toBe(1);
  });

  it('reports a script error as the request error', async () => {
    const { result } = await runCollectionWithState(
      {
        name: 'Erroring',
        variables: [],
        auth: { type: 'none' },
        items: [request({ id: 'a', url: server.url, scripts: { preRequest: 'boom' } })],
      } satisfies CollectionSpec,
      { scripts: scriptsReturning(() => ({ error: 'script blew up' })) },
    );
    expect(result.results[0]?.error).toBe('script blew up');
    expect(result.results[0]?.passed).toBe(false);
  });

  it('passes the collection proto files to every request of the run', async () => {
    const { result } = await runCollectionWithState(
      {
        name: 'Protos',
        variables: [],
        auth: { type: 'none' },
        protoFiles: [{ name: 'demo.proto', content: GREETER_PROTO }],
        items: [request({ id: 'a', url: server.url })],
      } satisfies CollectionSpec,
      {},
    );
    expect(result.passed).toBe(1);
  });
});

describe('the defaults of a run and of a description', () => {
  let server: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    server = await echoServer();
  });
  afterAll(() => server.close());

  it('defaults the timeout of a script request and honours the run signal', async () => {
    let status: number | undefined;
    const controller = new AbortController();
    await runCollectionWithState(
      {
        name: 'Bare',
        variables: [],
        auth: { type: 'none' },
        items: [request({ id: 'r', url: server.url, scripts: { preRequest: 'send' } })],
      } satisfies CollectionSpec,
      {
        signal: controller.signal,
        scripts: scriptsReturning((input) => {
          const host = (input as ScriptInput & { host: ScriptHost }).host;
          void host
            .sendRequest({ method: 'GET', url: server.url, headers: {} })
            .then((response) => {
              status = response.status;
            });
          return {};
        }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status).toBe(200);
  });

  it('runs the real sandbox when the run brings no script runner', async () => {
    const { result } = await runCollectionWithState(
      {
        name: 'Sandboxed',
        variables: [],
        auth: { type: 'none' },
        items: [
          request({
            id: 'r',
            url: server.url,
            scripts: { tests: "test('ok', () => { if (res.getStatus() !== 200) throw new Error('no') });" },
          }),
        ],
      } satisfies CollectionSpec,
      {},
    );
    expect(result.results[0]?.tests?.[0]?.passed).toBe(true);
  }, 30_000);

  it('describes a top-level request with no folder vars, no request vars and no proto files', async () => {
    const services = await describeGrpc(
      {
        name: 'Bare grpc',
        variables: [],
        auth: { type: 'none' },
        items: [
          {
            ...request({ id: 'r', url: 'grpc://127.0.0.1:1' }),
            kind: 'grpc',
            grpc: { method: 'demo.v1.Greeter/Say', message: '{}', reflection: false },
          },
        ],
      } satisfies CollectionSpec,
      'r',
      { signal: new AbortController().signal },
    );
    expect(services).toEqual({ services: [] });
  });

  it('describes a request inside a folder that declares no variables', async () => {
    const services = await describeGrpc(
      {
        name: 'Folder grpc',
        variables: [],
        auth: { type: 'none' },
        items: [
          {
            id: 'f',
            type: 'folder',
            name: 'Folder',
            items: [
              {
                ...request({ id: 'r', url: 'grpc://127.0.0.1:1' }),
                kind: 'grpc',
                grpc: { method: 'demo.v1.Greeter/Say', message: '{}', reflection: false },
              },
            ],
          },
        ],
      } satisfies CollectionSpec,
      'r',
    );
    expect(services).toEqual({ services: [] });
  });

  it('fetches an oauth2 token for the reflection call', async () => {
    const tokens = await tokenServer();
    const grpc = await grpcServer();
    try {
      await describeGrpc(
        {
          name: 'Oauth grpc',
          variables: [],
          auth: {
            type: 'oauth2',
            grantType: 'client_credentials',
            accessTokenUrl: tokens.url,
            clientId: 'id',
            clientSecret: 'secret',
          },
          items: [
            {
              ...request({ id: 'r', url: grpc.url }),
              kind: 'grpc',
              grpc: { method: 'demo.v1.Greeter/Say', message: '{}' },
            },
          ],
        } satisfies CollectionSpec,
        'r',
        { timeoutMs: 2_000 },
      );
      expect(tokens.seen.length).toBe(1);
      expect(grpc.metadata.at(-1)?.authorization).toBe('Bearer issued-token');
    } finally {
      await grpc.close();
      await tokens.close();
    }
  });
});
