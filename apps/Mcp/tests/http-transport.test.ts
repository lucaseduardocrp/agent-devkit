import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/bootstrap/config.js';
import {
  AdkOAuthProvider,
  renderLoginPage,
  SealedClientsStore,
} from '../src/bootstrap/http/oauth.js';
import { effectiveAllowedHosts } from '../src/bootstrap/http/http-server.js';
import { Sealer } from '../src/bootstrap/http/sealed.js';
import { TokenVerifier } from '../src/bootstrap/http/token-verifier.js';
import { bearerToken, createHttpServer } from '../src/bootstrap/transports.js';
import { ToolRegistry } from '../src/core/registry.js';
import { modules } from '../src/modules/index.js';

const API = 'http://adk.test';
const SECRET = 'x'.repeat(40);
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const user = { id: 'u1', email: 'ana@example.com', name: 'Ana' };

/** Fake ADK API: valid tokens are `user-token`, `other-token` and any `adk_pat_*`. */
function backend(options: { down?: boolean } = {}) {
  const requests: { path: string; headers: Record<string, string> }[] = [];
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ path, headers });
    if (options.down) return Promise.reject(new TypeError('fetch failed'));
    const token = headers['authorization']?.replace('Bearer ', '') ?? '';
    const valid =
      ['user-token', 'other-token', 'session-1'].includes(token) || token.startsWith('adk_pat_');
    if (path === '/auth/login') {
      const body = JSON.parse(String(init?.body)) as { password: string };
      return Promise.resolve(
        body.password === 'right'
          ? Response.json({ user, token: 'session-1', expiresAt: '2026-10-01T00:00:00Z' })
          : Response.json({ code: 'INVALID_CREDENTIALS' }, { status: 401 }),
      );
    }
    if (path === '/auth/tokens') {
      return Promise.resolve(
        Response.json(
          {
            token: 'adk_pat_issued',
            accessToken: { expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
          },
          { status: 201 },
        ),
      );
    }
    if (!valid) return Promise.resolve(Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }));
    if (path === '/auth/me')
      return Promise.resolve(
        Response.json({ user: token === 'other-token' ? { ...user, id: 'u2' } : user }),
      );
    if (path === '/auth/logout') return Promise.resolve(Response.json({ success: true }));
    if (path === '/knowledge/stats') return Promise.resolve(Response.json({ documentsCount: 2 }));
    return Promise.resolve(Response.json({ code: 'FORBIDDEN' }, { status: 403 }));
  }) as unknown as typeof fetch;
  return { requests, fetcher };
}

const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function listen(
  env: NodeJS.ProcessEnv = {},
  options: Record<string, unknown> = {},
  down = false,
) {
  const api = backend({ down });
  const config = loadConfig({ ADK_API_URL: API, ...env });
  const server = createHttpServer(config, new ToolRegistry(modules), [], {
    fetch: api.fetcher,
    ...options,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://localhost:${port}`, port, ...api };
}

/** Raw request so tests can forge Host and Origin headers. */
function raw(port: number, path: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'x', version: '1' },
  },
};
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function connectClient(url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'http-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('HTTP transport', () => {
  it('parses bearer tokens and derives allowed hosts', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect([...effectiveAllowedHosts(loadConfig({}))]).toEqual(['localhost', '127.0.0.1', '[::1]']);
    expect([...effectiveAllowedHosts(loadConfig({ ADK_MCP_HTTP_HOST: '0.0.0.0' }))]).toEqual([]);
    expect([
      ...effectiveAllowedHosts(
        loadConfig({
          ADK_MCP_HTTP_HOST: '0.0.0.0',
          ADK_MCP_ALLOWED_HOSTS: 'a.com',
          ADK_MCP_PUBLIC_URL: 'https://mcp.example.com',
        }),
      ),
    ]).toEqual(['a.com', 'mcp.example.com']);
  });

  it('serves MCP sessions with each user token and verifies it once per minute', async () => {
    const { url, requests } = await listen();
    const { client, transport } = await connectClient(url, 'user-token');
    const result = await client.callTool({ name: 'brain_stats', arguments: {} });
    expect(result.isError).toBeFalsy();
    const stats = requests.find((item) => item.path === '/knowledge/stats')!;
    expect(stats.headers['authorization']).toBe('Bearer user-token');
    expect(requests.filter((item) => item.path === '/auth/me')).toHaveLength(1);
    await transport.terminateSession();
    await client.close();
  });

  it('blocks DNS rebinding: foreign Host or Origin headers are rejected on loopback', async () => {
    const { port } = await listen();
    expect(await raw(port, '/healthz', { host: `localhost:${port}` })).toBe(200);
    expect(await raw(port, '/healthz', { host: 'healthcheck.railway.app' })).toBe(200);
    expect(await raw(port, '/mcp', { host: 'evil.example' })).toBe(403);
    expect(
      await raw(port, '/mcp', { host: `localhost:${port}`, origin: 'http://evil.example' }),
    ).toBe(403);
    expect(await raw(port, '/mcp', { host: `localhost:${port}`, origin: 'not a url' })).toBe(403);
    expect(
      await raw(port, '/mcp', {
        host: `127.0.0.1:${port}`,
        origin: `http://localhost:${port}`,
      }),
    ).toBe(400);
  });

  it('rejects invalid tokens, unknown paths, sessions and bodies', async () => {
    const { url } = await listen({}, { maxBodyBytes: 64 });
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${url}/mcp`, { method: 'POST', headers: { ...mcpHeaders, ...headers }, body });
    const invalid = await post(JSON.stringify(initialize), { authorization: 'Bearer nope' });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get('www-authenticate')).toContain('invalid_token');
    expect((await fetch(`${url}/nope`)).status).toBe(404);
    expect((await post('{bad')).status).toBe(400);
    expect((await post(JSON.stringify({ padding: 'x'.repeat(100) }))).status).toBe(413);
    expect((await post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).status).toBe(400);
    expect((await fetch(`${url}/mcp`)).status).toBe(400);
  });

  it('binds a session to the authenticated user and accepts a renewed token', async () => {
    const { url } = await listen();
    const created = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: 'Bearer user-token' },
      body: JSON.stringify(initialize),
    });
    const sessionId = created.headers.get('mcp-session-id')!;
    await created.text();
    const renewed = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sessionId, authorization: 'Bearer session-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(renewed.status).toBe(200);
    await renewed.text();
    const hijack = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sessionId, authorization: 'Bearer other-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(hijack.status).toBe(403);
    const anonymous = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    expect(anonymous.status).toBe(403);
  });

  it('serves tool calls from a stale session without requiring a new connection', async () => {
    const { url, requests } = await listen();
    const headers = {
      ...mcpHeaders,
      authorization: 'Bearer user-token',
      'mcp-session-id': 'expired-session',
      'mcp-protocol-version': '2025-06-18',
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'brain_stats', arguments: {} },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: attempt ? { ...headers, authorization: 'Bearer session-1' } : headers,
        body,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      expect(await response.text()).toContain('documentsCount');
    }
    expect(requests.filter((item) => item.path === '/knowledge/stats')).toHaveLength(2);
    const otherUser = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer other-token' },
      body,
    });
    expect(otherUser.status).toBe(403);
    const anonymous = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, 'mcp-session-id': 'expired-session' },
      body,
    });
    expect(anonymous.status).toBe(404);
  });

  it('requires tokens when configured, caps sessions and never lends the operator token remotely', async () => {
    const secured = await listen({ ADK_MCP_REQUIRE_AUTH: 'true' });
    const denied = await fetch(`${secured.url}/mcp`, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer realm="adk"');

    const full = await listen({}, { maxSessions: 0 });
    const busy = await fetch(`${full.url}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify(initialize),
    });
    expect(busy.status).toBe(503);

    const remote = await listen({
      ADK_MCP_HTTP_HOST: '0.0.0.0',
      ADK_MCP_REQUIRE_AUTH: 'false',
      ADK_TOKEN: 'user-token',
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${remote.url}/mcp`));
    const client = new Client({ name: 'anon', version: '1' });
    await client.connect(transport);
    await client.callTool({ name: 'brain_stats', arguments: {} });
    const stats = remote.requests.find((item) => item.path === '/knowledge/stats')!;
    expect(stats.headers['authorization']).toBeUndefined();
    await client.close();
  });

  it('answers 502 when ADK cannot verify a token', async () => {
    const { url } = await listen({}, {}, true);
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, authorization: 'Bearer user-token' },
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(502);
  });
});

describe('OAuth for remote connectors', () => {
  const verifier = 'v'.repeat(64);
  const challengeFor = (value: string) => createHash('sha256').update(value).digest('base64url');

  async function oauthServer(down = false) {
    return listen(
      { ADK_MCP_PUBLIC_URL: 'http://localhost', ADK_MCP_OAUTH_SECRET: SECRET },
      {},
      down,
    );
  }

  async function register(url: string) {
    const response = await fetch(`${url}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: 'none',
        client_name: 'Claude',
      }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
  }

  async function authorizePage(url: string, clientId: string) {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challengeFor(verifier),
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const response = await fetch(`${url}/authorize?${query}`);
    const html = await response.text();
    return { response, html, request: /name="request" value="([^"]+)"/.exec(html)![1]! };
  }

  const login = (url: string, fields: Record<string, string>) =>
    fetch(`${url}/oauth/login`, {
      method: 'POST',
      redirect: 'manual',
      // Browsers post the login form with `Origin: null` because the page uses no-referrer.
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' },
      body: new URLSearchParams(fields),
    });

  const exchange = (url: string, clientId: string, code: string, codeVerifier = verifier) =>
    fetch(`${url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: CALLBACK,
      }),
    });

  it('publishes discovery metadata and points unauthenticated clients to it', async () => {
    const { url } = await oauthServer();
    const resource = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
    expect(await resource.json()).toMatchObject({
      resource: 'http://localhost/mcp',
      authorization_servers: ['http://localhost/'],
    });
    const metadata = (await (
      await fetch(`${url}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      registration_endpoint: 'http://localhost/register',
      code_challenge_methods_supported: ['S256'],
    });
    const unauthenticated = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify(initialize),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain(
      'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"',
    );
    expect(await (await fetch(`${url}/healthz`)).json()).toMatchObject({ oauth: true });
  });

  it('runs the full authorization-code flow with PKCE and issues an ADK access token', async () => {
    const { url, requests } = await oauthServer();
    const clientId = await register(url);
    const page = await authorizePage(url, clientId);
    expect(page.response.headers.get('content-security-policy')).toContain(
      "form-action 'self' https://claude.ai",
    );
    expect(page.response.headers.get('x-frame-options')).toBe('DENY');
    expect(page.html).toContain('<strong>Claude</strong>');

    const wrong = await login(url, {
      request: page.request,
      email: 'ana@example.com',
      password: 'bad',
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Invalid credentials');

    const ok = await login(url, {
      request: page.request,
      email: 'ana@example.com',
      password: 'right',
    });
    expect(ok.status).toBe(302);
    const location = new URL(ok.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get('state')).toBe('xyz');
    const tokenRequest = requests.find((item) => item.path === '/auth/tokens')!;
    expect(tokenRequest.headers['authorization']).toBe('Bearer session-1');

    const code = location.searchParams.get('code')!;
    expect((await exchange(url, clientId, code, 'w'.repeat(64))).status).toBe(400);
    const tokens = await exchange(url, clientId, code);
    expect(tokens.status).toBe(200);
    const body = (await tokens.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };
    expect(body).toMatchObject({ access_token: 'adk_pat_issued', token_type: 'bearer' });
    expect(body.expires_in).toBeGreaterThan(0);
    expect((await exchange(url, clientId, code)).status).toBe(400);

    const { client } = await connectClient(url, body.access_token);
    expect((await client.callTool({ name: 'brain_stats', arguments: {} })).isError).toBeFalsy();
    await client.close();
  });

  it('accepts a pasted access token and rejects incomplete or forged logins', async () => {
    const { url } = await oauthServer();
    const clientId = await register(url);
    const page = await authorizePage(url, clientId);
    const pasted = await login(url, { request: page.request, token: 'adk_pat_manual' });
    expect(pasted.status).toBe(302);
    const code = new URL(pasted.headers.get('location')!).searchParams.get('code')!;
    const tokens = (await (await exchange(url, clientId, code)).json()) as Record<string, unknown>;
    expect(tokens).toMatchObject({ access_token: 'adk_pat_manual' });
    expect(tokens).not.toHaveProperty('expires_in');

    expect((await login(url, { request: page.request })).status).toBe(400);
    expect((await login(url, { request: page.request, token: 'forged' })).status).toBe(401);
    expect(
      (await login(url, { request: 'tampered', email: 'a@b.c', password: 'right' })).status,
    ).toBe(400);
    const refresh = await fetch(`${url}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: 'r',
        client_id: clientId,
      }),
    });
    expect(refresh.status).toBe(400);
  });

  it('shows a retry page when ADK is unreachable during login', async () => {
    const { url } = await oauthServer(true);
    const clientId = await register(url);
    const page = await authorizePage(url, clientId);
    const response = await login(url, {
      request: page.request,
      email: 'ana@example.com',
      password: 'right',
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('ADK is unavailable');
  });
});

describe('OAuth building blocks', () => {
  it('seals payloads, rejects tampering, expiry and short secrets', async () => {
    const sealer = new Sealer(SECRET, 'test');
    const value = sealer.seal({ a: 1 });
    expect(sealer.unseal(value)).toEqual({ a: 1 });
    expect(new Sealer(SECRET, 'other').unseal(value)).toBeUndefined();
    expect(sealer.unseal(`${value.slice(0, -2)}AA`)).toBeUndefined();
    expect(sealer.unseal('short')).toBeUndefined();
    const expiring = sealer.seal({ a: 1 }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sealer.unseal(expiring)).toBeUndefined();
    expect(() => new Sealer('short', 'x')).toThrow('at least 32 characters');
  });

  it('stores clients inside their ids and escapes the login page', () => {
    const store = new SealedClientsStore(new Sealer(SECRET, 'client'));
    const client = store.registerClient({ redirect_uris: [CALLBACK] });
    expect(store.getClient(client.client_id)).toMatchObject({ redirect_uris: [CALLBACK] });
    expect(store.getClient('nope')).toBeUndefined();
    const html = renderLoginPage({ request: '"><script>', clientName: '<b>x</b>', error: '<i>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;b&#62;x&#60;/b&#62;');
    expect(html).toContain('role="alert"');
  });

  it('verifies tokens, rejects bad codes and redirect mismatches', async () => {
    const api = backend();
    const provider = new AdkOAuthProvider(SECRET, {
      apiUrl: API,
      timeoutMs: 1000,
      fetch: api.fetcher,
    });
    expect(await provider.verifyAccessToken('user-token')).toMatchObject({ clientId: 'u1' });
    await expect(provider.verifyAccessToken('nope')).rejects.toThrow('Invalid or expired');
    const client = provider.clientsStore.registerClient({ redirect_uris: [CALLBACK] });
    await expect(provider.challengeForAuthorizationCode(client, 'bad')).rejects.toThrow(
      'Invalid or expired',
    );
    const sealed = new Sealer(SECRET, 'oauth-code').seal({
      token: 't',
      client: createHash('sha256').update(client.client_id).digest('hex'),
      challenge: 'c',
      redirectUri: CALLBACK,
      expiresAt: null,
      nonce: 'n1',
    });
    expect(await provider.challengeForAuthorizationCode(client, sealed)).toBe('c');
    await expect(
      provider.exchangeAuthorizationCode(client, sealed, undefined, 'https://evil'),
    ).rejects.toThrow('redirect_uri does not match');
    await expect(provider.exchangeRefreshToken()).rejects.toThrow('Refresh tokens are not issued');
  });

  it('caches token verification and rethrows transient failures', async () => {
    const api = backend();
    const verifier = new TokenVerifier(
      { apiUrl: API, timeoutMs: 1000, fetch: api.fetcher },
      60_000,
      1,
    );
    expect(await verifier.verify('user-token')).toMatchObject({ id: 'u1' });
    expect(await verifier.verify('user-token')).toMatchObject({ id: 'u1' });
    expect(await verifier.verify('nope')).toBeNull();
    expect(api.requests).toHaveLength(2);
    const down = new TokenVerifier({
      apiUrl: API,
      timeoutMs: 1000,
      fetch: backend({ down: true }).fetcher,
    });
    await expect(down.verify('user-token')).rejects.toMatchObject({ code: 'ADK_API_UNREACHABLE' });
  });
});
