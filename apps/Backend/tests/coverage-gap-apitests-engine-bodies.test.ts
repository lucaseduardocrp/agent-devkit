import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRequest } from '../src/modules/apitests/engine/http-request.js';
import type { ApiRequestSpec, RequestAuth } from '../src/modules/apitests/engine/types.js';
import { scopeOf } from '../src/modules/apitests/engine/variables.js';
import {
  GREETER_PROTO,
  echoServer,
  grpcServer,
  redirectServer,
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

const vars = (values: Record<string, string>) =>
  scopeOf(Object.entries(values).map(([key, value]) => ({ key, value })));

describe('bodies sent for each editor mode', () => {
  let server: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    server = await echoServer();
  });
  afterAll(() => server.close());

  const send = (spec: Partial<ApiRequestSpec>, values: Record<string, string> = {}) =>
    executeRequest(
      request({ id: 'body', url: server.url, method: 'POST', ...spec }),
      vars(values),
      { auth: { type: 'none' }, timeoutMs: 5_000, keepResponse: true },
    );

  it('encodes text modes with their own content type', async () => {
    for (const [mode, type] of [
      ['json', 'application/json'],
      ['text', 'text/plain'],
      ['xml', 'application/xml'],
      ['sparql', 'application/sparql-query'],
    ] as const) {
      const result = await send({ body: { mode, content: 'value-{{n}}' } }, { n: '1' });
      expect(result.error).toBeUndefined();
      expect(server.seen.at(-1)?.body).toBe('value-1');
      expect(server.seen.at(-1)?.headers['content-type']).toBe(type);
    }
  });

  it('encodes urlencoded fields and skips the disabled ones', async () => {
    await send(
      {
        body: {
          mode: 'urlencoded',
          fields: [
            { key: 'a', value: '{{v}}' },
            { key: 'skipped', value: 'no', enabled: false },
            { key: 'b b', value: 'c&d' },
          ],
        },
      },
      { v: 'one' },
    );
    expect(server.seen.at(-1)?.body).toBe('a=one&b+b=c%26d');
    expect(server.seen.at(-1)?.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('encodes a multipart body with text fields, their content types and a file', async () => {
    await send(
      {
        body: {
          mode: 'form',
          fields: [
            { key: 'plain {{q}}"x"', value: '{{v}}' },
            { key: 'typed', value: '{"a":1}', contentType: 'application/json' },
            {
              key: 'upload',
              value: '',
              type: 'file',
              file: { fileName: 'a"b\nc.txt', contentType: 'text/plain', data: 'aGk=' },
            },
            {
              key: 'untyped',
              value: '',
              type: 'file',
              file: { fileName: 'raw.bin', contentType: '', data: 'aGk=' },
            },
            { key: 'off', value: 'no', enabled: false },
          ],
        },
      },
      { q: 'name', v: 'one' },
    );
    const seen = server.seen.at(-1);
    expect(seen?.headers['content-type']).toContain('multipart/form-data; boundary=----adk-');
    expect(seen?.body).toContain('name="plain name%22x%22"');
    expect(seen?.body).toContain('Content-Type: application/json');
    expect(seen?.body).toContain('filename="a%22b c.txt"');
    expect(seen?.body).toContain('Content-Type: application/octet-stream');
    expect(seen?.body).not.toContain('name="off"');
  });

  it('sends a binary body with its type, and nothing when no file is attached', async () => {
    await send({
      body: { mode: 'binary', file: { fileName: 'a.bin', contentType: '', data: 'aGk=' } },
    });
    expect(server.seen.at(-1)?.headers['content-type']).toBe('application/octet-stream');
    expect(server.seen.at(-1)?.body).toBe('hi');

    await send({
      body: { mode: 'binary', file: { fileName: 'b.png', contentType: 'image/png', data: 'aGk=' } },
    });
    expect(server.seen.at(-1)?.headers['content-type']).toBe('image/png');

    await send({ body: { mode: 'binary', file: null } });
    expect(server.seen.at(-1)?.body).toBe('');
  });

  it('keeps the request content type a header already set', async () => {
    await send({
      body: { mode: 'json', content: '{}' },
      headers: [{ key: 'content-type', value: 'application/vnd.adk+json' }],
    });
    expect(server.seen.at(-1)?.headers['content-type']).toBe('application/vnd.adk+json');
  });

  it('leaves a body out of GET and HEAD', async () => {
    await send({ method: 'GET', body: { mode: 'json', content: '{"a":1}' } });
    expect(server.seen.at(-1)?.body).toBe('');
  });

  it('lets a pre-request script replace the body, typed after the editor mode', async () => {
    for (const [mode, type] of [
      ['xml', 'application/xml'],
      ['none', 'application/json'],
    ] as const) {
      const result = await executeRequest(
        request({
          id: 'scripted',
          url: server.url,
          method: 'POST',
          body: mode === 'none' ? { mode: 'none' } : { mode, content: '<a/>' },
        }),
        vars({ who: 'ana' }),
        {
          auth: { type: 'none' },
          timeoutMs: 5_000,
          scripting: {
            pre: async (view) => ({
              request: { ...view, body: 'replaced-{{who}}' },
              tests: [],
              logs: [],
            }),
            post: async () => ({ tests: [], logs: [] }),
            tests: async () => ({ tests: [], logs: [] }),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(server.seen.at(-1)?.body).toBe('replaced-ana');
      expect(server.seen.at(-1)?.headers['content-type']).toBe(type);
    }
  });

  it('drops headers whose name is blank and resolves the rest', async () => {
    await send(
      {
        headers: [
          { key: '   ', value: 'ignored' },
          { key: 'x-{{k}}', value: '{{v}}' },
        ],
      },
      { k: 'name', v: 'value' },
    );
    expect(server.seen.at(-1)?.headers['x-name']).toBe('value');
  });
});

describe('graphql requests', () => {
  let server: Awaited<ReturnType<typeof echoServer>>;
  beforeAll(async () => {
    server = await echoServer();
  });
  afterAll(() => server.close());

  const graphql = (spec: NonNullable<ApiRequestSpec['graphql']>, method: 'GET' | 'POST') =>
    executeRequest(
      { ...request({ id: 'gql', url: server.url, method }), kind: 'graphql', graphql: spec },
      vars({ id: '7' }),
      { auth: { type: 'none' }, timeoutMs: 5_000 },
    );

  it('posts the query, the variables as typed and the operation name', async () => {
    await graphql(
      { query: 'query Q($id:Int){ a(id:$id) }', variables: '{"id":{{id}}}', operationName: ' Q ' },
      'POST',
    );
    expect(server.seen.at(-1)?.body).toBe(
      '{"query":"query Q($id:Int){ a(id:$id) }","variables":{"id":7},"operationName":"Q"}',
    );
    expect(server.seen.at(-1)?.headers['content-type']).toBe('application/json');
  });

  it('defaults the variables to an empty object and leaves the operation name out', async () => {
    await graphql({ query: '{ a }', variables: '   ', operationName: '  ' }, 'POST');
    expect(server.seen.at(-1)?.body).toBe('{"query":"{ a }","variables":{}}');
  });

  it('puts the query in the search params of a GET, skipping empty variables', async () => {
    await graphql({ query: '{ a }', variables: '{}', operationName: 'Q' }, 'GET');
    const url = new URL(server.seen.at(-1)!.url, server.url);
    expect(url.searchParams.get('query')).toBe('{ a }');
    expect(url.searchParams.get('variables')).toBeNull();
    expect(url.searchParams.get('operationName')).toBe('Q');
    expect(server.seen.at(-1)?.body).toBe('');

    await graphql({ query: '{ a(id:$id) }', variables: '{"id":{{id}}}' }, 'GET');
    const withVariables = new URL(server.seen.at(-1)!.url, server.url);
    expect(withVariables.searchParams.get('variables')).toBe('{"id":7}');
    expect(withVariables.searchParams.get('operationName')).toBeNull();
  });

  it('still drafts an empty graphql body when the request has no graphql spec', async () => {
    await executeRequest(
      { ...request({ id: 'gql-none', url: server.url, method: 'POST' }), kind: 'graphql' },
      vars({}),
      { auth: { type: 'none' }, timeoutMs: 5_000 },
    );
    expect(server.seen.at(-1)?.body).toBe('{"query":"","variables":{}}');
  });
});

describe('repeated response headers and masked timelines', () => {
  it('joins set-cookie with newlines and other repeats with commas', async () => {
    const server = await echoServer([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
      ['x-many', 'one'],
      ['x-many', 'two'],
    ]);
    try {
      const result = await executeRequest(
        request({
          id: 'headers',
          url: server.url,
          assertions: [
            {
              id: 'a1',
              source: 'header',
              path: 'set-cookie',
              operator: 'eq',
              expected: 'a=1\nb=2',
            },
            { id: 'a2', source: 'header', path: 'x-many', operator: 'eq', expected: 'one, two' },
            { id: 'a3', source: 'header', path: '', operator: 'notExists' },
          ],
          captures: [{ source: 'header', path: 'set-cookie', variable: 'cookies' }],
        }),
        vars({}),
        { auth: { type: 'none' }, timeoutMs: 5_000, keepResponse: true },
      );
      expect(result.passed).toBe(true);
      expect(result.response?.headers['set-cookie']).toBe('a=1\nb=2');
      expect(result.response?.headers['x-many']).toBe('one, two');
    } finally {
      await server.close();
    }
  });

  it('masks the api key header of the auth in the timeline', async () => {
    const server = await echoServer();
    try {
      const auth: RequestAuth = {
        type: 'apikey',
        key: 'X-Api-Key',
        value: 'super-secret',
        in: 'header',
      };
      const result = await executeRequest(request({ id: 'apikey', url: server.url }), vars({}), {
        auth,
        timeoutMs: 5_000,
        keepResponse: true,
      });
      expect(result.timeline?.request.headers['X-Api-Key']).not.toContain('super-secret');
      expect(server.seen.at(-1)?.headers['x-api-key']).toBe('super-secret');
    } finally {
      await server.close();
    }
  });
});

describe('failures reported in the result', () => {
  it('reports a pre-request script error without sending anything', async () => {
    const result = await executeRequest(
      request({ id: 'pre-error', url: 'http://127.0.0.1:1/' }),
      vars({}),
      {
        auth: { type: 'none' },
        scripting: {
          pre: async () => ({ tests: [], logs: [], error: 'pre blew up' }),
          post: async () => ({ tests: [], logs: [] }),
          tests: async () => ({ tests: [], logs: [] }),
        },
      },
    );
    expect(result.error).toBe('pre blew up');
    expect(result.status).toBeNull();
  });

  it('reports an unparseable URL as an invalid request', async () => {
    const result = await executeRequest(request({ id: 'bad-url', url: 'not-a-url' }), vars({}), {
      auth: { type: 'none' },
    });
    expect(result.error).toContain('Invalid request:');
  });

  it('adds the cause of a transport error to the message', async () => {
    const result = await executeRequest(
      request({ id: 'cause', url: 'http://127.0.0.1:1/' }),
      vars({}),
      {
        auth: { type: 'none' },
        timeoutMs: 2_000,
        fetch: async () => {
          throw new Error('fetch failed', { cause: new Error('ECONNREFUSED') });
        },
      },
    );
    expect(result.error).toBe('fetch failed: ECONNREFUSED');
  });

  it('reports a thrown non-error as its text', async () => {
    const result = await executeRequest(
      request({ id: 'thrown', url: 'http://api.test/' }),
      vars({}),
      {
        auth: { type: 'none' },
        timeoutMs: 2_000,
        fetch: () => {
          throw 'plain string';
        },
      },
    );
    expect(result.error).toBe('plain string');
  });
});

describe('cookies of a stream exchange', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await websocketServer();
  });
  afterAll(() => server.close());

  it('sends the jar cookie once and leaves an explicit one alone', async () => {
    const jar = { cookieHeader: () => 'from=jar', store: () => {} };
    const spec = request({
      id: 'ws-cookies',
      kind: 'websocket',
      url: server.url,
      websocket: { messages: [{ content: 'hi' }], listenMs: 100, maxMessages: 1 },
    });
    const withJar = await executeRequest(spec, vars({}), {
      auth: { type: 'none' },
      timeoutMs: 5_000,
      cookies: jar,
    });
    expect(withJar.status).toBe(101);

    const explicit = await executeRequest(
      { ...spec, headers: [{ key: 'cookie', value: 'mine=1' }] },
      vars({}),
      { auth: { type: 'none' }, timeoutMs: 5_000, cookies: jar },
    );
    expect(explicit.status).toBe(101);

    const disabled = await executeRequest(spec, vars({}), {
      auth: { type: 'none' },
      timeoutMs: 5_000,
      cookies: jar,
      settings: { cookies: false },
    });
    expect(disabled.status).toBe(101);
  });
});

describe('the last branches of a request run', () => {
  it('keeps the redirect chain in the timeline', async () => {
    const server = await redirectServer();
    try {
      const result = await executeRequest(request({ id: 'redirects', url: server.url }), vars({}), {
        auth: { type: 'none' },
        timeoutMs: 5_000,
        keepResponse: true,
      });
      expect(result.status).toBe(200);
      expect(result.timeline?.redirects?.length).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('masks the proxy password of the settings wherever it shows up', async () => {
    const server = await echoServer();
    try {
      const result = await executeRequest(
        request({
          id: 'proxy-mask',
          url: server.url,
          method: 'POST',
          body: { mode: 'text', content: 'leaking {{secret}}' },
        }),
        vars({ secret: 'proxy-password' }),
        {
          auth: { type: 'none' },
          timeoutMs: 5_000,
          keepResponse: true,
          settings: {
            proxy: {
              enabled: false,
              protocol: 'http',
              hostname: 'proxy.test',
              port: 8080,
              password: '{{secret}}',
            },
          },
        },
      );
      expect(result.timeline?.request.bodyPreview).not.toContain('proxy-password');
    } finally {
      await server.close();
    }
  });

  it('keeps the draft view when a pre-request script returns none', async () => {
    const server = await echoServer();
    try {
      const result = await executeRequest(request({ id: 'no-view', url: server.url }), vars({}), {
        auth: { type: 'none' },
        timeoutMs: 5_000,
        scripting: {
          pre: async () => ({ tests: [], logs: [] }),
          post: async () => ({ tests: [], logs: [] }),
          tests: async () => ({ tests: [], logs: [] }),
        },
      });
      expect(result.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('falls back to the run timeout when the view carries none', async () => {
    const server = await echoServer();
    try {
      const result = await executeRequest(
        request({ id: 'no-timeout', url: server.url }),
        vars({}),
        {
          auth: { type: 'none' },
          timeoutMs: 5_000,
          scripting: {
            pre: async (view) => {
              const { timeoutMs: _dropped, ...rest } = view;
              return { request: rest as typeof view, tests: [], logs: [] };
            },
            post: async () => ({ tests: [], logs: [] }),
            tests: async () => ({ tests: [], logs: [] }),
          },
        },
      );
      expect(result.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('reports a transport error that carries no cause', async () => {
    const result = await executeRequest(
      request({ id: 'no-cause', url: 'http://api.test/' }),
      vars({}),
      {
        auth: { type: 'none' },
        timeoutMs: 2_000,
        fetch: async () => {
          throw new Error('plain failure');
        },
      },
    );
    expect(result.error).toBe('plain failure');
  });

  it('types a script body as JSON for a kind that is not http', async () => {
    const server = await echoServer();
    try {
      await executeRequest(
        {
          ...request({ id: 'gql-script', url: server.url, method: 'POST' }),
          kind: 'graphql',
          graphql: { query: '{ a }' },
        },
        vars({}),
        {
          auth: { type: 'none' },
          timeoutMs: 5_000,
          scripting: {
            pre: async (view) => ({
              request: { ...view, body: '{"replaced":1}' },
              tests: [],
              logs: [],
            }),
            post: async () => ({ tests: [], logs: [] }),
            tests: async () => ({ tests: [], logs: [] }),
          },
        },
      );
      expect(server.seen.at(-1)?.body).toBe('{"replaced":1}');
      expect(server.seen.at(-1)?.headers['content-type']).toBe('application/json');
    } finally {
      await server.close();
    }
  });
});

describe('stream and grpc specs left out of the request', () => {
  it('defaults every stream spec that the request does not carry', async () => {
    const sse = await sseServer(['data: 1\n\n']);
    try {
      // No `sse` spec at all: the default window and no event cap.
      const result = await executeRequest(
        { ...request({ id: 'sse-bare', url: sse.url }), kind: 'sse' },
        vars({}),
        { auth: { type: 'none' }, timeoutMs: 300 },
      );
      expect(result.kind).toBe('sse');
    } finally {
      await sse.close();
    }

    const tcp = await socketServer();
    try {
      const result = await executeRequest(
        { ...request({ id: 'socket-bare', url: tcp.url }), kind: 'socket' },
        vars({}),
        { auth: { type: 'none' }, timeoutMs: 300 },
      );
      expect(result.kind).toBe('socket');
    } finally {
      await tcp.close();
    }
  });

  it('defaults the grpc spec and its message when the request carries none', async () => {
    const result = await executeRequest(
      { ...request({ id: 'grpc-bare', url: 'grpc://127.0.0.1:1' }), kind: 'grpc' },
      vars({}),
      { auth: { type: 'none' }, timeoutMs: 500 },
    );
    // An empty method cannot be resolved, so the call fails instead of connecting.
    expect(result.passed).toBe(false);
  });
});

describe('values thrown outside the transport', () => {
  it('reports a thrown non-error as its text', async () => {
    const server = await websocketServer();
    try {
      const result = await executeRequest(
        {
          ...request({ id: 'thrown-string', url: server.url }),
          kind: 'websocket',
          websocket: { messages: [], listenMs: 50 },
        },
        vars({}),
        {
          auth: { type: 'none' },
          timeoutMs: 2_000,
          cookies: {
            cookieHeader: () => {
              throw 'jar is broken';
            },
            store: () => {},
          },
        },
      );
      expect(result.error).toBe('jar is broken');
    } finally {
      await server.close();
    }
  });

  it('falls back to the draft message when a script drops the grpc body', async () => {
    const server = await grpcServer(['hi']);
    try {
      const result = await executeRequest(
        {
          ...request({ id: 'grpc-dropped', url: server.url }),
          kind: 'grpc',
          grpc: { method: 'demo.v1.Greeter/Say', message: '{"id":"ana"}', protoFile: 'demo.proto' },
        },
        vars({}),
        {
          auth: { type: 'none' },
          timeoutMs: 5_000,
          protoFiles: [{ name: 'demo.proto', content: GREETER_PROTO }],
          scripting: {
            pre: async (view) => {
              const { body: _dropped, ...rest } = view;
              return { request: rest as typeof view, tests: [], logs: [] };
            },
            post: async () => ({ tests: [], logs: [] }),
            tests: async () => ({ tests: [], logs: [] }),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.passed).toBe(true);
    } finally {
      await server.close();
    }
  });
});
