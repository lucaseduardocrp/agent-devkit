import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z, ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { signInForClient } from '../src/api/credentials.js';
import { AdkApiError, buildUrl, HttpAdkClient, segment } from '../src/api/http-client.js';
import { definePrompt } from '../src/core/prompt.js';
import { ToolRegistry } from '../src/core/registry.js';
import {
  limitText,
  MAX_RESULT_CHARACTERS,
  toCallToolResult,
  toErrorResult,
} from '../src/core/result.js';
import { FileSessionStore, MemorySessionStore, Session } from '../src/core/session.js';
import { defineTool, json, text } from '../src/core/tool.js';
import { loadConfig, normalizeUrl, parseToolsets } from '../src/bootstrap/config.js';

function response(status: number, body: unknown, type = 'application/json') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });
}

describe('HttpAdkClient', () => {
  it('builds URLs, skips empty query values and encodes segments', () => {
    expect(
      buildUrl('http://api/base', '/a', { x: 1, y: '', z: undefined, w: null, b: false }),
    ).toBe('http://api/base/a?x=1&b=false');
    expect(buildUrl('http://api/', 'a')).toBe('http://api/a');
    expect(segment('a/b?c')).toBe('a%2Fb%3Fc');
  });

  it('sends credentials, workspace and locale headers and parses JSON', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(200, { ok: true })));
    const client = new HttpAdkClient({
      baseUrl: 'http://api',
      timeoutMs: 1000,
      fetch: fetcher,
      credentials: () => ({ token: 't', workspaceId: 'ws', locale: 'en-US' }),
    });
    expect(await client.request({ method: 'POST', path: '/x', body: { a: 1 } })).toEqual({
      ok: true,
    });
    const [, init] = fetcher.mock.calls[0]!;
    expect(init.headers).toMatchObject({
      authorization: 'Bearer t',
      'x-workspace-id': 'ws',
      'x-locale': 'en-US',
      'content-type': 'application/json',
      'user-agent': 'devkit',
    });
    expect(init.body).toBe('{"a":1}');
    expect(init.redirect).toBe('manual');

    await client.request({ method: 'GET', path: '/auth/me', withoutWorkspace: true });
    expect(fetcher.mock.calls[1]![1].headers).not.toHaveProperty('x-workspace-id');
  });

  it('returns text bodies, undefined for 204, and omits absent credentials', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(200, '# Spec', 'text/markdown'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpAdkClient({
      baseUrl: 'http://api',
      timeoutMs: 1000,
      fetch: fetcher,
      userAgent: 'test',
      credentials: () => ({}),
    });
    expect(await client.request({ method: 'GET', path: '/md' })).toBe('# Spec');
    expect(await client.request({ method: 'DELETE', path: '/x' })).toBeUndefined();
    expect(fetcher.mock.calls[0]![1].headers).not.toHaveProperty('authorization');
  });

  it('uploads raw bodies, uses the global fetch by default and reads untyped bodies', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([104, 105])));
    vi.stubGlobal('fetch', fetcher);
    try {
      const client = new HttpAdkClient({
        baseUrl: 'http://api',
        timeoutMs: 1000,
        credentials: () => ({}),
      });
      const data = new Uint8Array([1, 2, 3]);
      expect(
        await client.request({
          method: 'PUT',
          path: '/file',
          rawBody: { data, contentType: 'image/png' },
        }),
      ).toBe('hi');
      const [, init] = fetcher.mock.calls[0]!;
      expect(init.headers['content-type']).toBe('image/png');
      expect(init.body).toEqual(data);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps API errors, plain-text errors, timeouts and network failures', async () => {
    const make = (fetcher: typeof fetch) =>
      new HttpAdkClient({
        baseUrl: 'http://api',
        timeoutMs: 5,
        fetch: fetcher,
        credentials: () => ({}),
      });

    const apiError = make(
      vi.fn().mockResolvedValue(
        response(404, {
          code: 'NOT_FOUND',
          message: 'Missing',
          details: [{ f: 1 }],
          correlationId: 'c1',
        }),
      ),
    );
    await expect(apiError.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Missing',
      details: [{ f: 1 }],
      correlationId: 'c1',
    });

    const textError = make(vi.fn().mockResolvedValue(response(502, 'Bad gateway', 'text/plain')));
    await expect(textError.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      code: 'HTTP_502',
      message: 'Bad gateway',
    });
    const emptyError = make(
      vi.fn().mockResolvedValue(new Response('', { status: 500, statusText: 'Boom' })),
    );
    await expect(emptyError.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({
      message: 'Boom',
    });

    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    await expect(
      make(vi.fn().mockRejectedValue(timeout)).request({ method: 'GET', path: '/x' }),
    ).rejects.toMatchObject({ code: 'ADK_API_TIMEOUT' });
    await expect(
      make(vi.fn().mockRejectedValue(new TypeError('fetch failed'))).request({
        method: 'GET',
        path: '/x',
      }),
    ).rejects.toMatchObject({ code: 'ADK_API_UNREACHABLE' });
  });
});

describe('signInForClient', () => {
  const login = { user: { id: 'u1', email: 'a@b.c', name: 'A' }, token: 's', expiresAt: 'x' };
  const signIn = (tokenStatus: number) =>
    signInForClient(
      {
        apiUrl: 'http://api',
        timeoutMs: 1000,
        fetch: vi.fn((url: string) =>
          Promise.resolve(
            String(url).endsWith('/auth/login')
              ? response(200, login)
              : response(tokenStatus, { code: 'NOPE', message: 'No tokens.' }),
          ),
        ) as unknown as typeof fetch,
      },
      { email: 'a@b.c', password: 'p', tokenName: 'cli' },
    );

  it('keeps the session when the API cannot issue access tokens', async () => {
    expect(await signIn(404)).toEqual({
      token: 's',
      user: login.user,
      expiresAt: 'x',
      kind: 'session',
    });
  });

  it('rethrows other token failures', async () => {
    await expect(signIn(500)).rejects.toMatchObject({ status: 500, code: 'NOPE' });
  });
});

describe('Session', () => {
  it('prefers stored credentials for the same API and falls back to defaults', async () => {
    const store = new MemorySessionStore();
    const session = new Session(store, { apiUrl: 'http://a', token: 'env', workspaceId: 'ws-env' });
    expect(await session.state()).toMatchObject({ token: 'env', workspaceId: 'ws-env' });
    await session.update({ token: 'stored', workspaceId: 'ws-1' });
    expect(await session.state()).toMatchObject({
      token: 'stored',
      workspaceId: 'ws-1',
      apiUrl: 'http://a',
    });
    await session.clear();
    expect((await session.state()).token).toBe('env');
  });

  it('never reuses a token stored for another API', async () => {
    const store = new MemorySessionStore({
      apiUrl: 'http://other',
      token: 'foreign',
      workspaceId: 'x',
    });
    const session = new Session(store, { apiUrl: 'http://a' });
    expect(await session.state()).toMatchObject({ token: undefined, workspaceId: undefined });
    await session.update({ workspaceId: 'ws' });
    expect(await store.read()).toEqual({ workspaceId: 'ws', apiUrl: 'http://a' });
  });

  it('persists to a user-only file and tolerates missing or invalid files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'devkit-'));
    const path = join(dir, 'nested', 'session.json');
    const store = new FileSessionStore(path);
    expect(await store.read()).toEqual({});
    await store.write({ token: 't' });
    expect(await store.read()).toEqual({ token: 't' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ token: 't' });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    await store.clear();
    expect(await store.read()).toEqual({});
    const invalid = new FileSessionStore(join(dir, 'x.json'));
    await new FileSessionStore(join(dir, 'x.json')).write({});
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'x.json'), '"string"');
    expect(await invalid.read()).toEqual({});
    await writeFile(join(dir, 'x.json'), 'null');
    expect(await invalid.read()).toEqual({});
  });
});

describe('tools, prompts and registry', () => {
  const tool = (
    name: string,
    toolset: 'brain' | 'spec' = 'brain',
    access: 'read' | 'write' = 'read',
  ) =>
    defineTool({
      name,
      title: name,
      description: 'Does things.',
      toolset,
      access,
      routes: [],
      input: { value: z.string().default('x') },
      run: (input) => Promise.resolve(json(input)),
    });

  it('validates names, parses input and annotates execution modes', async () => {
    expect(() => tool('Bad-Name')).toThrow('Invalid MCP tool name');
    expect(tool('brain_a').parseInput(undefined)).toEqual({ value: 'x' });
    expect(await tool('brain_a').execute(undefined, {} as never)).toEqual({
      kind: 'json',
      data: { value: 'x' },
    });
    await expect(tool('brain_a').execute({ value: 1 }, {} as never)).rejects.toBeInstanceOf(
      ZodError,
    );
    const host = defineTool({
      name: 'brain_host',
      title: 'h',
      description: 'D.',
      toolset: 'brain',
      access: 'read',
      execution: 'host',
      routes: [],
      input: {},
      run: () => Promise.resolve(text('ok')),
    });
    expect(host.description).toContain('no API key needed');
    const server = {
      ...host,
      ...defineTool({
        ...host,
        name: 'brain_srv',
        execution: 'server',
        run: () => Promise.resolve(text('')),
      }),
    };
    expect(server.description).toContain('needs an API key');
  });

  it('renders prompts with validated arguments', () => {
    const prompt = definePrompt({
      name: 'p',
      title: 'P',
      description: 'D',
      args: { topic: z.string() },
      render: ({ topic }) => `About ${topic}`,
    });
    expect(prompt.render({ topic: 'x' })).toBe('About x');
    expect(() => prompt.render({})).toThrow();
  });

  it('filters by toolset and read-only mode and rejects inconsistent modules', () => {
    const modules = [
      { toolset: 'brain' as const, tools: [tool('brain_a'), tool('brain_b', 'brain', 'write')] },
      {
        toolset: 'spec' as const,
        tools: [tool('spec_a', 'spec')],
        prompts: [
          definePrompt({ name: 'sp', title: 'S', description: 'D', args: {}, render: () => '' }),
        ],
      },
    ];
    expect(new ToolRegistry(modules).tools).toHaveLength(3);
    expect(new ToolRegistry(modules, { readOnly: true }).tools.map((t) => t.name)).toEqual([
      'brain_a',
      'spec_a',
    ]);
    const onlyBrain = new ToolRegistry(modules, { toolsets: ['brain'] });
    expect(onlyBrain.tools.map((t) => t.name)).toEqual(['brain_a', 'brain_b']);
    expect(onlyBrain.prompts).toEqual([]);
    expect(onlyBrain.find('brain_b')?.name).toBe('brain_b');
    expect(onlyBrain.find('spec_a')).toBeUndefined();

    expect(
      () => new ToolRegistry([{ toolset: 'brain', tools: [tool('brain_a'), tool('brain_a')] }]),
    ).toThrow('Duplicate MCP tool name');
    expect(() => new ToolRegistry([{ toolset: 'spec', tools: [tool('brain_a')] }])).toThrow(
      'declared in the spec module',
    );
  });
});

describe('tool results', () => {
  it('truncates oversized results and error bodies', async () => {
    const big = toCallToolResult(text('x'.repeat(MAX_RESULT_CHARACTERS + 10)));
    const value = (big.content[0] as { text: string }).text;
    expect(value).toContain('[Truncated: 10 more characters.');
    expect(limitText('short')).toBe('short');
    const client = new HttpAdkClient({
      baseUrl: 'http://api',
      timeoutMs: 1000,
      credentials: () => ({}),
      fetch: vi.fn().mockResolvedValue(new Response('<html>'.repeat(1000), { status: 502 })),
    });
    await expect(client.request({ method: 'GET', path: '/x' })).rejects.toSatisfy(
      (error: Error) => error.message.length === 500,
    );
  });

  it('serializes JSON and text results', () => {
    expect(toCallToolResult(text('hi'))).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(toCallToolResult(json(undefined)).content[0]).toEqual({
      type: 'text',
      text: '{\n  "success": true\n}',
    });
  });

  it('explains API, validation and unexpected errors with recovery hints', () => {
    const api = toErrorResult(new AdkApiError(401, 'UNAUTHORIZED', 'Login', [{ f: 1 }], 'c1'));
    expect(api.isError).toBe(true);
    const message = (api.content[0] as { text: string }).text;
    expect(message).toContain('ADK API error 401 UNAUTHORIZED: Login');
    expect(message).toContain('Correlation id: c1');
    expect(message).toContain('devkit login');
    const bare = (
      toErrorResult(new AdkApiError(0, 'ADK_API_UNREACHABLE', 'down')).content[0] as {
        text: string;
      }
    ).text;
    expect(bare).toBe('ADK API error ADK_API_UNREACHABLE: down');

    const zod = z.object({ a: z.string() }).safeParse({});
    expect((toErrorResult(zod.error).content[0] as { text: string }).text).toContain(
      'Invalid tool input: a',
    );
    const root = z.string().safeParse(1);
    expect((toErrorResult(root.error).content[0] as { text: string }).text).toContain('(root)');
    expect((toErrorResult(new Error('boom')).content[0] as { text: string }).text).toBe('boom');
    expect((toErrorResult('x').content[0] as { text: string }).text).toBe('Unexpected error.');
  });
});

describe('configuration', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      apiUrl: 'http://localhost:3000',
      toolsets: [],
      readOnly: false,
      timeoutMs: 180000,
      http: { host: '127.0.0.1', port: 3333, allowedHosts: [], requireAuth: false },
    });
    expect(config.sessionFile).toMatch(/\.adk[\\/]mcp-session\.json$/);
  });

  it('reads every setting and requires auth off loopback by default', () => {
    const config = loadConfig({
      ADK_API_URL: 'https://adk.example.com/',
      ADK_TOKEN: 't',
      ADK_WORKSPACE_ID: 'ws',
      ADK_LOCALE: 'en-US',
      ADK_MCP_TOOLSETS: 'brain, spec',
      ADK_MCP_READ_ONLY: 'yes',
      ADK_MCP_SESSION_FILE: '/tmp/s.json',
      ADK_MCP_TIMEOUT_MS: '5000',
      ADK_MCP_HTTP_HOST: '0.0.0.0',
      ADK_MCP_HTTP_PORT: '8080',
      ADK_MCP_ALLOWED_HOSTS: 'mcp.example.com, localhost',
    });
    expect(config).toMatchObject({
      apiUrl: 'https://adk.example.com',
      token: 't',
      workspaceId: 'ws',
      locale: 'en-US',
      toolsets: ['brain', 'spec'],
      readOnly: true,
      sessionFile: '/tmp/s.json',
      timeoutMs: 5000,
      http: {
        host: '0.0.0.0',
        port: 8080,
        allowedHosts: ['mcp.example.com', 'localhost'],
        requireAuth: true,
      },
    });
    expect(
      loadConfig({ ADK_MCP_HTTP_HOST: '0.0.0.0', ADK_MCP_REQUIRE_AUTH: 'false' }).http.requireAuth,
    ).toBe(false);
    expect(loadConfig({ ADK_MCP_REQUIRE_AUTH: '1' }).http.requireAuth).toBe(true);
  });

  it('reads the remote connector settings', () => {
    expect(
      loadConfig({
        ADK_MCP_PUBLIC_URL: 'https://mcp.example.com/',
        ADK_MCP_OAUTH_SECRET: 's'.repeat(32),
        ADK_MCP_TRUST_PROXY: 'true',
        ADK_MCP_RATE_LIMIT: '50',
      }).http,
    ).toMatchObject({
      publicUrl: 'https://mcp.example.com',
      trustProxy: true,
      rateLimitPerMinute: 50,
    });
    expect(loadConfig({}).http).toMatchObject({ trustProxy: false, rateLimitPerMinute: 600 });
    expect(loadConfig({ PORT: '8080' }).http.port).toBe(8080);
    expect(loadConfig({ PORT: '8080', ADK_MCP_HTTP_PORT: '9090' }).http.port).toBe(9090);
    expect(() => loadConfig({ ADK_MCP_OAUTH_SECRET: 's'.repeat(32) })).toThrow(
      'requires ADK_MCP_PUBLIC_URL',
    );
    expect(() => loadConfig({ ADK_MCP_OAUTH_SECRET: 'short' })).toThrow();
  });

  it('normalizes URLs pasted into hosting dashboards', () => {
    expect(normalizeUrl(' "mcp.up.railway.app/" ')).toBe('https://mcp.up.railway.app');
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeUrl('http://api.test///')).toBe('http://api.test');
    expect(normalizeUrl('  ')).toBeUndefined();
    expect(normalizeUrl(3)).toBe(3);
    expect(loadConfig({ ADK_MCP_PUBLIC_URL: 'mcp.example.com' }).http.publicUrl).toBe(
      'https://mcp.example.com',
    );
    expect(() => loadConfig({ ADK_MCP_PUBLIC_URL: 'https://exa mple' })).toThrow(
      'Invalid configuration:\n  - ADK_MCP_PUBLIC_URL: Must be a URL',
    );
  });

  it('rejects unknown toolsets and invalid values', () => {
    expect(() => parseToolsets('brain,unknown')).toThrow('Unknown toolset(s): unknown');
    expect(parseToolsets(undefined)).toEqual([]);
    expect(() => loadConfig({ ADK_API_URL: 'not a url' })).toThrow(/ADK_API_URL: /);
  });
});
