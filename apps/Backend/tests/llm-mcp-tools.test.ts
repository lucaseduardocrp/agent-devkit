import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliLlmProvider } from '../src/modules/agents/adapters/cli-llm/cli-llm.js';
import { assertSafeArgument } from '../src/modules/agents/adapters/cli-llm/cli-process.js';
import type { CliRun, CliRunOptions } from '../src/modules/agents/adapters/cli-llm/cli-process.js';
import { llmMcpAccess, mcpAccessOf } from '../src/modules/agents/adapters/cli-llm/cli-config.js';
import { RemoteCliLlmProvider } from '../src/modules/agents/adapters/cli-llm/remote-cli-llm.js';
import {
  CLI_SPECS,
  isValidMcpServer,
  type CliMcpServer,
} from '../src/modules/agents/adapters/cli-llm/cli-specs.js';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import type { LlmPort, LlmRequest } from '../src/modules/agents/application/agent-ports.js';
import { AgentService } from '../src/modules/agents/application/agent-service.js';
import {
  McpToolAccess,
  MCP_AI_CLI_TOKEN_NAME,
  MCP_SERVER_NAME,
  type McpToolAccessPort,
} from '../src/modules/agents/application/mcp-tool-access.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { ApplicationError } from '../src/shared/errors.js';

const server: CliMcpServer = {
  name: MCP_SERVER_NAME,
  url: 'http://mcp:3333/mcp?workspace=ws-1',
  token: 'adk_pat_secret-token-0123456789',
};

describe('the MCP server in the CLI specs', () => {
  it('gives Claude exactly that server, with the token in a file and only its tools allowed', () => {
    const run = CLI_SPECS.claude.build({ prompt: 'p', mcp: server }, undefined);
    expect(run.args).toEqual(
      expect.arrayContaining([
        '--strict-mcp-config',
        '--mcp-config',
        'mcp.json',
        '--allowedTools',
        `mcp__${MCP_SERVER_NAME}`,
      ]),
    );
    // Built-in tools stay off; only the MCP ones are added.
    expect(run.args).toEqual(expect.arrayContaining(['--tools', '']));
    expect(JSON.parse(run.files['mcp.json'] as string)).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: 'http',
          url: server.url,
          headers: { Authorization: `Bearer ${server.token}` },
        },
      },
    });
    expect(run.args.join(' ')).not.toContain(server.token);
    for (const argument of run.args) expect(() => assertSafeArgument(argument)).not.toThrow();
  });

  it('gives Codex the server as config overrides and the token only as an environment variable', () => {
    const run = CLI_SPECS.codex.build({ prompt: 'p', mcp: server }, 'gpt-5');
    expect(run.args).toEqual(
      expect.arrayContaining([
        '-c',
        `mcp_servers.${MCP_SERVER_NAME}.url=${server.url}`,
        `mcp_servers.${MCP_SERVER_NAME}.bearer_token_env_var=ADK_MCP_TOKEN`,
      ]),
    );
    expect(run.args.at(-1)).toBe('-'); // the prompt still follows on stdin
    expect(run.env).toEqual({ ADK_MCP_TOKEN: server.token });
    expect(run.args.join(' ')).not.toContain(server.token);
    for (const argument of run.args) expect(() => assertSafeArgument(argument)).not.toThrow();
  });

  it('changes nothing when there is no server, and Gemini keeps its MCP config in its HOME', () => {
    expect(CLI_SPECS.claude.build({ prompt: 'p' }, undefined).args).not.toContain('--mcp-config');
    expect(CLI_SPECS.claude.build({ prompt: 'p' }, undefined).files).not.toHaveProperty('mcp.json');
    expect(CLI_SPECS.codex.build({ prompt: 'p' }, undefined).env).toBeUndefined();
    expect(CLI_SPECS.gemini.mcp).toBe('home');
    expect(CLI_SPECS.gemini.build({ prompt: 'p', mcp: server }, undefined)).toEqual(
      CLI_SPECS.gemini.build({ prompt: 'p' }, undefined),
    );
  });

  it('ignores a server that could break out of a config or a command line', () => {
    const bad: CliMcpServer[] = [
      { ...server, name: 'Adk Tools' },
      { ...server, name: 'x"; calc' },
      { ...server, url: 'file:///etc/passwd' },
      { ...server, url: 'http://mcp:3333/mcp" -c evil=1' },
      { ...server, url: `http://${'a'.repeat(400)}/` },
      { ...server, token: '' },
    ];
    for (const candidate of bad) {
      expect(isValidMcpServer(candidate)).toBe(false);
      expect(CLI_SPECS.claude.build({ prompt: 'p', mcp: candidate }, undefined).args).not.toContain(
        '--mcp-config',
      );
      expect(CLI_SPECS.codex.build({ prompt: 'p', mcp: candidate }, undefined).args).not.toContain(
        '-c',
      );
    }
    expect(isValidMcpServer(server)).toBe(true);
    expect(
      isValidMcpServer({ ...server, url: 'https://mcp.example.com/mcp?workspace=a-b_c' }),
    ).toBe(true);
    // The URL carries the workspace and the profile, so it has two parameters.
    const twoParameters = 'http://mcp:3333/mcp?workspace=ws-1&profile=standard';
    expect(isValidMcpServer({ ...server, url: twoParameters })).toBe(true);
    expect(() => assertSafeArgument(twoParameters)).not.toThrow();
    expect(
      CLI_SPECS.codex.build({ prompt: 'p', mcp: { ...server, url: twoParameters } }, undefined)
        .args,
    ).toContain(`mcp_servers.${MCP_SERVER_NAME}.url=${twoParameters}`);
  });
});

describe('providers and the ADK tools', () => {
  const started: Array<{ options: CliRunOptions; files: Record<string, string> }> = [];
  const start = (options: CliRunOptions): CliRun => {
    const files: Record<string, string> = {};
    started.push({ options, files });
    return {
      output: (async function* () {
        yield JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' });
      })(),
      exit: Promise.resolve({ exitCode: 0, stderr: '', timedOut: false, aborted: false }),
      stop: () => undefined,
    };
  };
  beforeEach(() => started.splice(0));

  it('a local CLI passes the server on only when it was allowed tools', async () => {
    await new CliLlmProvider({ cli: 'claude', mcpAccess: 'read', start }).complete({
      prompt: 'x',
      mcp: server,
    });
    expect(started[0]!.options.args).toContain('--mcp-config');

    await new CliLlmProvider({ cli: 'claude', start }).complete({ prompt: 'x', mcp: server });
    expect(started[1]!.options.args).not.toContain('--mcp-config');
  });

  it('a local Codex gets the token in its environment, never on the command line', async () => {
    const codexStart = (options: CliRunOptions): CliRun => ({
      ...start(options),
      output: (async function* () {
        yield JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'ok' },
        });
      })(),
    });
    await new CliLlmProvider({ cli: 'codex', mcpAccess: 'full', start: codexStart }).complete({
      prompt: 'x',
      mcp: server,
    });
    const { options } = started[0]!;
    expect(options.env['ADK_MCP_TOKEN']).toBe(server.token);
    expect(options.args.join(' ')).not.toContain(server.token);
  });

  it('a local Gemini never gets tools: its config would be written into the HOME of whoever runs the API', () => {
    expect(
      new CliLlmProvider({ cli: 'gemini', mcpAccess: 'full', start }).mcpAccess,
    ).toBeUndefined();
    expect(new CliLlmProvider({ cli: 'claude', mcpAccess: 'full', start }).mcpAccess).toBe('full');
    expect(new CliLlmProvider({ cli: 'codex', mcpAccess: 'read', start }).mcpAccess).toBe('read');
    expect(new CliLlmProvider({ cli: 'claude', start }).mcpAccess).toBeUndefined();
  });

  it('the Bridge provider sends the server only when it was allowed tools', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('event: done\ndata: {}\n\n', { status: 200 });
    });
    const base = {
      cli: 'gemini' as const,
      bridge: { url: 'http://bridge:3500', token: 't' },
      workspaceId: 'ws-1',
      fetcher: fetcher as never,
    };
    const withTools = new RemoteCliLlmProvider({ ...base, mcpAccess: 'full' });
    expect(withTools.mcpAccess).toBe('full'); // the Bridge can give Gemini its config in its own HOME
    await withTools.complete({ prompt: 'x', mcp: server });
    expect(bodies[0]!['mcp']).toEqual(server);

    const without = new RemoteCliLlmProvider(base);
    expect(without.mcpAccess).toBeUndefined();
    await without.complete({ prompt: 'x', mcp: server });
    expect(bodies[1]).not.toHaveProperty('mcp');
    await withTools.complete({ prompt: 'x' });
    expect(bodies[2]).not.toHaveProperty('mcp');
  });
});

describe('McpToolAccess', () => {
  function setup(create?: (...args: unknown[]) => Promise<{ token: string }>) {
    let counter = 0;
    let clock = 1_000_000;
    const tokens = {
      create: vi.fn(create ?? (async () => ({ token: `adk_pat_token-${++counter}` }))),
      list: vi.fn(async () => [
        { id: 'a', name: MCP_AI_CLI_TOKEN_NAME },
        { id: 'b', name: 'My own token' },
        { id: 'c', name: MCP_AI_CLI_TOKEN_NAME },
      ]),
      revoke: vi.fn(async () => undefined),
    };
    const access = new McpToolAccess('http://mcp:3333/mcp', tokens as never, () => clock);
    return { access, tokens, advance: (ms: number) => (clock += ms) };
  }

  it('gives the server a name that does not clash with the one a user may have, pinned to the workspace', async () => {
    const { access } = setup();
    const connection = await access.connect('u1', 'ws-1', 'full');
    expect(connection).toEqual({
      name: 'adk-tools',
      url: 'http://mcp:3333/mcp?workspace=ws-1',
      token: 'adk_pat_token-1',
    });
    expect(MCP_SERVER_NAME).not.toBe('adk');
  });

  it('narrows the connection by profile in the URL, and gives no profile only to "full"', async () => {
    const { access } = setup();
    expect((await access.connect('u1', 'ws-1', 'standard')).url).toBe(
      'http://mcp:3333/mcp?workspace=ws-1&profile=standard',
    );
    expect((await access.connect('u1', 'ws-1', 'read')).url).toBe(
      'http://mcp:3333/mcp?workspace=ws-1&profile=read',
    );
    expect((await access.connect('u1', 'ws-1', 'full')).url).toBe(
      'http://mcp:3333/mcp?workspace=ws-1',
    );
  });

  it('gives a token that can only read just to "read", and one that can write to the rest', async () => {
    const { access, tokens } = setup();
    await access.connect('u1', 'ws-1', 'read');
    await access.connect('u2', 'ws-1', 'standard');
    await access.connect('u3', 'ws-1', 'full');
    expect(tokens.create.mock.calls.map(([, input]) => (input as { scope: string }).scope)).toEqual(
      ['read', 'full', 'full'],
    );
  });

  it('asks for a token of one day, with the scope of the access, in the name of this feature', async () => {
    const { access, tokens } = setup();
    await access.connect('u1', 'ws-1', 'read');
    expect(tokens.create).toHaveBeenCalledWith('u1', {
      name: 'ADK AI CLI',
      scope: 'read',
      expiresInDays: 1,
    });
  });

  it('reuses a token for half a day, per user and scope, then renews it', async () => {
    const { access, tokens, advance } = setup();
    const first = await access.connect('u1', 'ws-1', 'full');
    // Another workspace of the same user: same token, another URL.
    const other = await access.connect('u1', 'ws-2', 'full');
    expect(other.token).toBe(first.token);
    expect(other.url).toContain('workspace=ws-2');
    expect(tokens.create).toHaveBeenCalledOnce();

    expect((await access.connect('u1', 'ws-1', 'read')).token).not.toBe(first.token);
    expect((await access.connect('u2', 'ws-1', 'full')).token).not.toBe(first.token);
    expect(tokens.create).toHaveBeenCalledTimes(3);

    advance(11 * 60 * 60_000);
    expect((await access.connect('u1', 'ws-1', 'full')).token).toBe(first.token);
    advance(2 * 60 * 60_000);
    expect((await access.connect('u1', 'ws-1', 'full')).token).not.toBe(first.token);
  });

  it('makes one token for requests that arrive together', async () => {
    const { access, tokens } = setup();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => access.connect('u1', 'ws-1', 'full')),
    );
    expect(new Set(results.map((result) => result.token)).size).toBe(1);
    expect(tokens.create).toHaveBeenCalledOnce();
  });

  it('frees room when the limit of tokens is reached, touching only its own tokens', async () => {
    let attempts = 0;
    const { access, tokens } = setup(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApplicationError('ACCESS_TOKEN_LIMIT_REACHED', 'limit', 409);
      return { token: 'adk_pat_after-cleanup' };
    });
    expect((await access.connect('u1', 'ws-1', 'full')).token).toBe('adk_pat_after-cleanup');
    expect(tokens.revoke.mock.calls).toEqual([
      ['u1', 'a'],
      ['u1', 'c'],
    ]);
  });

  it('lets any other failure through, and tries again on the next request', async () => {
    let attempts = 0;
    const { access } = setup(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('database down');
      return { token: 'adk_pat_ok' };
    });
    await expect(access.connect('u1', 'ws-1', 'full')).rejects.toThrow('database down');
    expect((await access.connect('u1', 'ws-1', 'full')).token).toBe('adk_pat_ok');
  });
});

describe('what an integration says about the tools', () => {
  it('are "standard" by default, and "read", "full" and "off" are explicit choices', () => {
    expect(llmMcpAccess({})).toBe('standard');
    expect(llmMcpAccess({ mcpAccess: 'standard' })).toBe('standard');
    expect(llmMcpAccess({ mcpAccess: 'read' })).toBe('read');
    expect(llmMcpAccess({ mcpAccess: 'full' })).toBe('full');
    expect(llmMcpAccess({ mcpAccess: 'off' })).toBe('off');
    // A value nobody knows is not a way to get more than the default.
    expect(llmMcpAccess({ mcpAccess: 'everything' })).toBe('standard');
    expect(mcpAccessOf({})).toBe('standard');
    expect(mcpAccessOf({ mcpAccess: 'read' })).toBe('read');
    expect(mcpAccessOf({ mcpAccess: 'full' })).toBe('full');
    expect(mcpAccessOf({ mcpAccess: 'off' })).toBeUndefined();
  });

  describe('in the provider the factory builds', () => {
    const keys = ['ADK_LLM_CLI', 'BRIDGE_URL', 'BRIDGE_SHARED_TOKEN'] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    afterEach(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    async function scopeWith(settings: Record<string, unknown>, env: Record<string, string>) {
      for (const key of keys) delete process.env[key];
      Object.assign(process.env, env);
      const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
      await integrations.saveIntegration('ws-1', 'LLM', 'claude', {
        isEnabled: true,
        settings: { authMode: 'cli', ...settings },
      });
      const llm = await new DynamicProviderFactory(integrations).resolveLlmProvider('ws-1');
      return llm?.mcpAccess;
    }

    it.each([
      [{}, 'standard'],
      [{ mcpAccess: 'read' }, 'read'],
      [{ mcpAccess: 'full' }, 'full'],
      [{ mcpAccess: 'off' }, undefined],
    ])('%j gives the local CLI the scope %s', async (settings, scope) => {
      expect(await scopeWith(settings, { ADK_LLM_CLI: 'true' })).toBe(scope);
    });

    it.each([
      [{}, 'standard'],
      [{ mcpAccess: 'read' }, 'read'],
      [{ mcpAccess: 'full' }, 'full'],
      [{ mcpAccess: 'off' }, undefined],
    ])('%j gives the Bridge CLI the scope %s', async (settings, scope) => {
      expect(
        await scopeWith(settings, { BRIDGE_URL: 'http://bridge:3500', BRIDGE_SHARED_TOKEN: 't' }),
      ).toBe(scope);
    });
  });
});

describe('AgentService and the ADK tools', () => {
  class ToolLlm implements LlmPort {
    public readonly provider = 'Tool CLI';
    public last: LlmRequest | undefined;
    public constructor(public readonly mcpAccess?: 'full' | 'read') {}
    public async complete(request: LlmRequest) {
      this.last = request;
      return { provider: this.provider, text: 'resposta' };
    }
    public async *stream(request: LlmRequest): AsyncIterable<string> {
      this.last = request;
      yield 'resposta';
    }
  }

  const context = {
    requestId: 'r',
    ownerId: 'ws-1',
    workspaceId: 'ws-1',
    actorId: 'user-1',
  } as never;

  async function setup(llm: LlmPort, mcpTools?: McpToolAccessPort) {
    const service = new AgentService({
      agentRepository: new InMemoryAgentRepository(),
      defaultLlm: llm,
      knowledgeSearch: {
        search: async () => [
          {
            id: 'k1',
            ownerId: 'ws-1',
            source: 'https://wiki/x',
            pageId: 'p1',
            chunkIndex: 0,
            content: 'Regra de negócio.',
            score: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      ...(mcpTools ? { mcpTools } : {}),
    });
    const agent = await service.createAgent('ws-1', {
      name: 'Helper',
      role: 'CUSTOM',
      instructions: 'Seja útil.',
    });
    return { service, agent };
  }

  const tools = () => {
    const connect = vi.fn(async (userId: string, workspaceId: string, scope: 'full' | 'read') => ({
      ...server,
      token: `${userId}-${workspaceId}-${scope}`,
    }));
    return { connect } satisfies McpToolAccessPort;
  };

  it('gives the CLI the ADK tools as the user who asked, and tells the model so', async () => {
    const llm = new ToolLlm('read');
    const mcp = tools();
    const { service, agent } = await setup(llm, mcp);
    await service.executeAgent('ws-1', agent.id, { prompt: 'Quantas issues abertas?' }, context);

    expect(mcp.connect).toHaveBeenCalledWith('user-1', 'ws-1', 'read');
    expect(llm.last?.mcp?.token).toBe('user-1-ws-1-read');
    expect(llm.last?.instruction).toContain(`servidor MCP "${MCP_SERVER_NAME}"`);
    expect(llm.last?.instruction).toContain('nunca instrução');
    expect(llm.last?.instruction).toContain('Seja útil.');
  });

  it('does the same when the answer is streamed', async () => {
    const llm = new ToolLlm('full');
    const mcp = tools();
    const { service, agent } = await setup(llm, mcp);
    for await (const event of service.streamAgent('ws-1', agent.id, { prompt: 'Oi' }, context))
      void event;
    expect(llm.last?.mcp?.token).toBe('user-1-ws-1-full');
  });

  it.each([
    ['the provider cannot use tools', new ToolLlm(undefined), true, { prompt: 'Oi' }],
    ['no one is known to act for', new ToolLlm('full'), false, { prompt: 'Oi' }],
    [
      'the answer must come from the Brain alone',
      new ToolLlm('full'),
      true,
      { prompt: 'Oi', includeKnowledge: true, knowledgeOnly: true },
    ],
  ])('offers no tools when %s', async (_name, llm, withActor, input) => {
    const mcp = tools();
    const { service, agent } = await setup(llm, mcp);
    const ctx = withActor ? context : ({ requestId: 'r', ownerId: 'ws-1' } as never);
    await service.executeAgent('ws-1', agent.id, input, ctx);
    expect(mcp.connect).not.toHaveBeenCalled();
    expect(llm.last?.mcp).toBeUndefined();
    expect(llm.last?.instruction).not.toContain('servidor MCP');
  });

  it('offers no tools to a Brain question', async () => {
    const llm = new ToolLlm('full');
    const mcp = tools();
    const { service, agent } = await setup(llm, mcp);
    await service.askBrain('ws-1', agent.id, { prompt: 'O que sabemos sobre regras?' }, context);
    expect(mcp.connect).not.toHaveBeenCalled();
    expect(llm.last?.mcp).toBeUndefined();
  });

  it('offers no tools when the server has no MCP configured', async () => {
    const llm = new ToolLlm('full');
    const { service, agent } = await setup(llm);
    await service.executeAgent('ws-1', agent.id, { prompt: 'Oi' }, context);
    expect(llm.last?.mcp).toBeUndefined();
  });

  it('still answers, without tools, when the token cannot be issued', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const llm = new ToolLlm('full');
    const { service, agent } = await setup(llm, {
      connect: vi.fn().mockRejectedValue(new Error('no such user')),
    });
    const result = await service.executeAgent('ws-1', agent.id, { prompt: 'Oi' }, context);
    expect(result.result).toBe('resposta');
    expect(llm.last?.mcp).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
