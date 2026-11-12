import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInForClient } from '../src/api/credentials.js';
import { AdkApiError, HttpAdkClient } from '../src/api/http-client.js';
import { loadConfig, storedApiUrl } from '../src/bootstrap/config.js';
import { createMcpServer } from '../src/bootstrap/create-server.js';
import { FileSessionStore, MemorySessionStore, Session } from '../src/core/session.js';
import { ToolRegistry } from '../src/core/registry.js';
import { defineTool } from '../src/core/tool.js';
import { getWorkflowBrief } from '../src/modules/agents/tools.js';
import { modules } from '../src/modules/index.js';
import { fakeContext, fixtures } from './support/fake-api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('HttpAdkClient edge cases', () => {
  it('uploads raw bytes with their own content type', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const client = new HttpAdkClient({
      baseUrl: 'http://api',
      timeoutMs: 1000,
      fetch: fetcher,
      credentials: () => ({}),
    });
    const data = new Uint8Array([1, 2, 3]);
    await client.request({
      method: 'POST',
      path: '/upload',
      rawBody: { data, contentType: 'video/mp4' },
    });
    const [, init] = fetcher.mock.calls[0]!;
    expect(init.headers['content-type']).toBe('video/mp4');
    expect(init.body).toEqual(data);
  });

  it('uses the global fetch when none is given', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const client = new HttpAdkClient({
      baseUrl: 'http://api',
      timeoutMs: 1000,
      credentials: () => ({}),
    });
    expect(await client.request({ method: 'GET', path: '/x' })).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reads a body that declares no content type as text', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([104, 105])));
    const client = new HttpAdkClient({
      baseUrl: 'http://api',
      timeoutMs: 1000,
      fetch: fetcher,
      credentials: () => ({}),
    });
    expect(await client.request({ method: 'GET', path: '/x' })).toBe('hi');
  });
});

describe('signInForClient', () => {
  const options = (tokenStatus: number) => ({
    apiUrl: 'http://adk.test',
    timeoutMs: 1000,
    fetch: vi.fn((url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path === '/auth/login')
        return Promise.resolve(
          Response.json({
            user: fixtures.user,
            token: 'session-token',
            expiresAt: '2026-10-01T00:00:00Z',
          }),
        );
      return Promise.resolve(Response.json({ code: 'NOPE' }, { status: tokenStatus }));
    }) as unknown as typeof fetch,
  });
  const credentials = { email: 'ana@example.com', password: 'x', tokenName: 'CLI' };

  it.each([404, 405, 501, 503])(
    'keeps the session when the API cannot issue access tokens (%i)',
    async (status) => {
      expect(await signInForClient(options(status), credentials)).toEqual({
        token: 'session-token',
        user: fixtures.user,
        expiresAt: '2026-10-01T00:00:00Z',
        kind: 'session',
      });
    },
  );

  it('rethrows any other failure while issuing the token', async () => {
    await expect(signInForClient(options(500), credentials)).rejects.toBeInstanceOf(AdkApiError);
  });
});

describe('stored sessions and configuration', () => {
  it('reads back the object it stored, and treats anything else as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-session-'));
    const file = join(dir, 'session.json');
    await new FileSessionStore(file).write({ token: 't' });
    expect(await new FileSessionStore(file).read()).toEqual({ token: 't' });
    await writeFile(file, 'null');
    expect(await new FileSessionStore(file).read()).toEqual({});
    await writeFile(file, '"text"');
    expect(await new FileSessionStore(file).read()).toEqual({});
  });

  it('looks for the stored API in the home directory by default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'adk-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    expect(await storedApiUrl({})).toBeUndefined();
  });

  it('names the environment when the whole configuration is invalid', () => {
    expect(() => loadConfig(undefined as unknown as NodeJS.ProcessEnv)).toThrow(
      /Invalid configuration:\n {2}- environment: /,
    );
  });

  it('parses tool input that was not sent at all as an empty object', () => {
    const noInput = defineTool({
      name: 'audit_none',
      title: 'None',
      description: 'No input',
      toolset: 'audit',
      access: 'read',
      routes: [],
      input: {},
      run: async () => ({ kind: 'json', data: {} }),
    });
    expect(noInput.parseInput(undefined)).toEqual({});
  });
});

describe('workflow brief', () => {
  async function brief(workflow: Record<string, unknown>) {
    const { api } = fakeContext();
    api.on('GET /agents/workflow', () => ({ workflow: { ...fixtures.workflow, ...workflow } }));
    return getWorkflowBrief(api);
  }

  it('describes a workflow that only asks and reviews', async () => {
    const { rule } = await brief({
      enabled: true,
      autonomy: 'supervised',
      uncertaintyBehavior: 'ask',
      issueCreationBehavior: 'ask',
      finalReview: true,
      defaultAction: 'allow',
      steps: [
        { id: 's1', name: 'Draft', instructions: 'Write', reviewRequired: true },
        { id: 's2', name: 'Ship', instructions: 'Send' },
      ],
    });
    expect(rule).toContain('Ask the user to approve each completed workflow step');
    expect(rule).toContain('After these steps, show the result and wait for approval: Draft.');
    expect(rule).toContain('ask the user a specific question');
    expect(rule).toContain('requests explicit user approval before creating a new Issue');
    expect(rule).toContain('show the final result to the user and wait for approval');
    expect(rule).not.toContain('Block every write action');
  });

  it('describes a permissive workflow with every kind of rule', async () => {
    const { rule } = await brief({
      enabled: true,
      autonomy: 'autonomous',
      uncertaintyBehavior: 'assume',
      issueCreationBehavior: 'allow',
      finalReview: false,
      defaultAction: 'deny',
      rules: [
        { id: '1', name: 'No brain', toolset: 'brain', effect: 'deny' },
        { id: '2', name: 'Only one', toolset: 'e2e', toolName: 'e2e_run', effect: 'deny' },
        {
          id: '3',
          name: 'Providers',
          toolset: 'pbi',
          effect: 'allow',
          allowedProviders: ['azure_devops'],
          createIssueForAction: true,
          requireApproval: true,
        },
        { id: '4', name: 'Plain', toolset: 'spec', effect: 'allow' },
      ],
    });
    expect(rule).toContain('Continue through workflow steps without asking');
    expect(rule).toContain('Use conservative assumptions');
    expect(rule).toContain('only when it is part of the user');
    expect(rule).toContain('disabled final approval');
    expect(rule).toContain('Block every write action unless a matching module rule');
    expect(rule).toContain('Never call module brain.');
    expect(rule).toContain('Never call tool e2e_run.');
    expect(rule).toContain('use only these providers: azure_devops.');
    expect(rule).toContain('A tracking Issue is created automatically before write actions');
    expect(rule).toContain('requests user approval before each write action on module pbi.');
  });

  it('describes a balanced workflow and the case where none is active', async () => {
    const active = await brief({ enabled: true, autonomy: 'balanced' });
    expect(active.rule).toContain('Continue automatically except at steps marked for review');
    const inactive = await brief({ enabled: false });
    expect(inactive.rule).toContain('no active agent workflow');
  });
});

describe('human approval through the MCP client', () => {
  const API = 'http://adk.test';

  async function connect(
    decide: ((message: string) => { action: 'accept' | 'decline'; content?: object }) | null,
  ) {
    const requests: string[] = [];
    const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      requests.push(`${init?.method} ${path}`);
      if (path === '/agents/workflow')
        return Promise.resolve(
          Response.json({ workflow: { ...fixtures.workflow, autonomy: 'supervised' } }),
        );
      return Promise.resolve(Response.json({ ok: true }));
    }) as unknown as typeof fetch;
    const server = createMcpServer({
      apiUrl: API,
      timeoutMs: 1000,
      registry: new ToolRegistry(modules, { toolsets: ['brain'] }),
      session: new Session(new MemorySessionStore({ token: 't', workspaceId: 'ws-1' }), {
        apiUrl: API,
      }),
      skills: [],
      fetch: fetcher,
    });
    const client = new Client(
      { name: 'approval-test', version: '1.0.0' },
      { capabilities: decide ? { elicitation: {} } : {} },
    );
    const messages: string[] = [];
    if (decide) {
      client.setRequestHandler(ElicitRequestSchema, (request) => {
        messages.push(request.params.message);
        return decide(request.params.message);
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, requests, messages };
  }

  const text = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

  it('runs a supervised write once the user approves it', async () => {
    const { client, requests, messages } = await connect(() => ({
      action: 'accept',
      content: { approved: true },
    }));
    const result = await client.callTool({ name: 'brain_sync', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(messages[0]).toContain('Approve this write action');
    expect(requests).toContain('POST /knowledge/sync');
  });

  it.each([
    ['declines', () => ({ action: 'decline' as const })],
    [
      'accepts without approving',
      () => ({ action: 'accept' as const, content: { approved: false } }),
    ],
  ])('does nothing when the user %s', async (_, decide) => {
    const { client, requests } = await connect(decide);
    const result = await client.callTool({ name: 'brain_sync', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('declined');
    expect(requests).not.toContain('POST /knowledge/sync');
  });

  it('does nothing when the client cannot be asked', async () => {
    const { client, requests } = await connect(null);
    const result = await client.callTool({ name: 'brain_sync', arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('approval');
    expect(requests).not.toContain('POST /knowledge/sync');
  });
});
