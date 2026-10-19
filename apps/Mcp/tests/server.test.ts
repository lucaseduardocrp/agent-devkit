import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpServer,
  createToolContext,
  estimateTokens,
  recordToolUsage,
  SERVER_INSTRUCTIONS,
} from '../src/bootstrap/create-server.js';
import { loadSkills } from '../src/bootstrap/skills.js';
import { ToolRegistry } from '../src/core/registry.js';
import { MemorySessionStore, Session, type SessionState } from '../src/core/session.js';
import { modules } from '../src/modules/index.js';
import { fakeContext } from './support/fake-api.js';

const API = 'http://adk.test';

/** Fake ADK backend: records the requests it receives. */
function backend() {
  const requests: {
    url: string;
    method?: string;
    body?: string;
    headers: Record<string, string>;
  }[] = [];
  const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (String(url).endsWith('/stats')) {
      return Promise.resolve(Response.json({ documentsCount: 2, chunksCount: 5 }));
    }
    return Promise.resolve(
      Response.json({ code: 'FORBIDDEN', message: 'No access.' }, { status: 403 }),
    );
  }) as unknown as typeof fetch;
  return { requests, fetcher };
}

async function connect(
  registry = new ToolRegistry(modules),
  state: SessionState = { token: 'stored', workspaceId: 'ws-1' },
) {
  const { requests, fetcher } = backend();
  const session = new Session(new MemorySessionStore(state), {
    apiUrl: API,
  });
  const server = createMcpServer({
    apiUrl: API,
    timeoutMs: 1000,
    locale: 'pt-BR',
    registry,
    session,
    skills: await loadSkills(),
    fetch: fetcher,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, requests };
}

describe('MCP server', () => {
  it('advertises every tool with annotations and the usage instructions', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(new ToolRegistry(modules).tools.length);
    const remove = tools.find((tool) => tool.name === 'brain_delete_document')!;
    expect(remove.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    const prepare = tools.find((tool) => tool.name === 'testplans_prepare')!;
    expect(prepare.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(prepare.inputSchema.properties).toHaveProperty('prompt');
  });

  it('calls the backend with the session credentials and reports errors as tool errors', async () => {
    const { client, requests } = await connect();
    const ok = await client.callTool({ name: 'brain_stats', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect((ok.content as { text: string }[])[0]!.text).toContain('"documentsCount": 2');
    expect(requests[0]!.headers).toMatchObject({
      authorization: 'Bearer stored',
      'x-workspace-id': 'ws-1',
      'x-locale': 'pt-BR',
    });

    const denied = await client.callTool({ name: 'brain_sync', arguments: {} });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0]!.text).toContain('403 FORBIDDEN');
  });

  it('serves workflow prompts, skills and the guide as resources', async () => {
    const { client } = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual(
      ['ask_brain', 'create_prototype', 'draft_spec', 'generate_test_plan'].sort(),
    );
    const prompt = await client.getPrompt({
      name: 'generate_test_plan',
      arguments: { requirement: 'Checkout' },
    });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain('testplans_prepare');

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual(
      expect.arrayContaining(['adk://guide', 'adk://skills/adk-test-plans']),
    );
    const skill = await client.readResource({ uri: 'adk://skills/adk-brain' });
    expect((skill.contents[0] as { text: string }).text).toContain('# ADK Brain');
    const guide = await client.readResource({ uri: 'adk://guide' });
    const guideText = (guide.contents[0] as { text: string }).text;
    expect(guideText).toContain('`testplans_prepare` (testplans, read, host model)');
    expect(guideText).toContain('`brain_stats` (brain, read)');
  });

  it('respects read-only registries', async () => {
    const { client } = await connect(new ToolRegistry(modules, { readOnly: true }));
    const { tools } = await client.listTools();
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
  });

  it('reports the estimated host-model tokens of each tool call to the cost ledger', async () => {
    const { client, requests } = await connect();
    const result = await client.callTool({ name: 'brain_stats', arguments: {} });
    const resultText = (result.content as { text: string }[])[0]!.text;
    await vi.waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/costs/usage'))).toBe(true),
    );
    const usage = requests.find((request) => request.url.endsWith('/costs/usage'))!;
    expect(usage.method).toBe('POST');
    expect(usage.headers).toMatchObject({
      authorization: 'Bearer stored',
      'x-workspace-id': 'ws-1',
    });
    expect(JSON.parse(usage.body!)).toEqual({
      tool: 'brain_stats',
      provider: 'mcp',
      model: 'test',
      inputTokens: estimateTokens(resultText),
      outputTokens: 1,
      estimated: true,
    });

    // The fake backend rejects every usage call (403); tool results are unaffected.
    const denied = await client.callTool({ name: 'brain_sync', arguments: {} });
    expect(denied.isError).toBe(true);
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.url.endsWith('/costs/usage'))).toHaveLength(2),
    );
  });

  it('does not meter session tools, exact host runs or calls without a workspace', async () => {
    const { client, requests } = await connect();
    await client.callTool({ name: 'auth_whoami', arguments: {} });
    await client.callTool({ name: 'workspaces_list', arguments: {} });
    await client.callTool({
      name: 'issues_complete_run',
      arguments: { runId: 'r1', output: 'Done' },
    });
    const anonymous = await connect(new ToolRegistry(modules), { token: 'stored' });
    await anonymous.client.callTool({ name: 'brain_stats', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      [...requests, ...anonymous.requests].filter((request) =>
        request.url.endsWith('/costs/usage'),
      ),
    ).toEqual([]);
  });

  it('estimates tokens from any text content and swallows ledger failures', async () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
    const tool = new ToolRegistry(modules).tools.find((item) => item.name === 'brain_stats')!;
    const { api, context } = fakeContext();
    await recordToolUsage(
      tool,
      undefined,
      {
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: '12345678' },
        ],
      },
      context,
      undefined,
    );
    expect(api.calls).toEqual([
      {
        method: 'POST',
        path: '/costs/usage',
        body: {
          tool: 'brain_stats',
          provider: 'mcp',
          model: 'unknown',
          inputTokens: 2,
          outputTokens: 1,
          estimated: true,
        },
      },
    ]);
    api.on('POST /costs/usage', () => {
      throw new Error('ledger down');
    });
    await expect(
      recordToolUsage(tool, {}, { content: [] }, context, 'codex'),
    ).resolves.toBeUndefined();
  });

  it('lets a per-request token override the stored session', async () => {
    const { fetcher, requests } = backend();
    const context = createToolContext(
      {
        apiUrl: API,
        timeoutMs: 1000,
        registry: new ToolRegistry([]),
        session: new Session(new MemorySessionStore({ token: 'stored' }), { apiUrl: API }),
        skills: [],
        fetch: fetcher,
      },
      'request-token',
    );
    await context.api.request({ method: 'GET', path: '/knowledge/stats' });
    expect(requests[0]!.headers['authorization']).toBe('Bearer request-token');
  });
});
