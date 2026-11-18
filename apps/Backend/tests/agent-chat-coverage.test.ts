import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { createIntegrationsRouter } from '../src/adapters/http/integrations-routes.js';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import { CliLlmError, type CliStatus } from '../src/modules/agents/adapters/cli-llm/cli-llm.js';
import {
  AgentService,
  toLlmApplicationError,
  type AgentStreamEvent,
} from '../src/modules/agents/application/agent-service.js';
import type { LlmPort, LlmRequest } from '../src/modules/agents/application/agent-ports.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import type { KnowledgeSearchPort } from '../src/modules/knowledge/application/knowledge-search.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { ApplicationError } from '../src/shared/errors.js';

/** An LLM whose stream is whatever the test says. */
class StubLlm implements LlmPort {
  public readonly provider = 'Stub';
  public lastRequest: LlmRequest | undefined;
  public lastSignal: AbortSignal | undefined;
  public constructor(private readonly source: (signal?: AbortSignal) => AsyncIterable<string>) {}
  public async complete(): Promise<never> {
    throw new Error('not used');
  }
  public stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.lastRequest = request;
    this.lastSignal = signal;
    return this.source(signal);
  }
}

const tokens = (...pieces: string[]) =>
  async function* () {
    for (const piece of pieces) yield piece;
  };

async function collect(events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> {
  const all: AgentStreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe('AgentService.streamAgent edge cases', () => {
  async function setup(llm: LlmPort, knowledgeSearch?: KnowledgeSearchPort) {
    const service = new AgentService({
      agentRepository: new InMemoryAgentRepository(),
      defaultLlm: llm,
      ...(knowledgeSearch ? { knowledgeSearch } : {}),
    });
    const agent = await service.createAgent('ws-1', {
      name: 'Helper',
      role: 'CUSTOM',
      instructions: 'Seja útil.',
    });
    return { service, agent };
  }

  it('answers from the Brain alone without calling the model when nothing was found', async () => {
    const llm = new StubLlm(tokens('never'));
    const { service, agent } = await setup(llm, { search: async () => [] });
    const events = await collect(
      service.streamAgent(
        'ws-1',
        agent.id,
        { prompt: 'E o prazo?', includeKnowledge: true, knowledgeOnly: true },
        { requestId: 'r', ownerId: 'ws-1' } as never,
      ),
    );
    expect(events.map((event) => event.type)).toEqual(['start', 'delta', 'done']);
    expect(events[0]).toMatchObject({ provider: 'brain' });
    expect(events[1]).toMatchObject({ text: 'Não encontrei essa informação no Brain.' });
    expect(llm.lastRequest).toBeUndefined();
  });

  it('finishes with an empty answer when the model says nothing', async () => {
    const { service, agent } = await setup(new StubLlm(tokens()));
    const events = await collect(service.streamAgent('ws-1', agent.id, { prompt: 'Oi' }));
    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(events[1]).toMatchObject({ response: { result: '' } });
  });

  it('keeps an application error as it is and turns anything else into an LLM error', async () => {
    const known = new ApplicationError('LLM_RATE_LIMITED', 'Slow down.', 429);
    const rateLimited = await setup(
      new StubLlm(async function* () {
        yield 'a';
        throw known;
      }),
    );
    await expect(
      collect(rateLimited.service.streamAgent('ws-1', rateLimited.agent.id, { prompt: 'Oi' })),
    ).rejects.toBe(known);

    const plain = await setup(
      new StubLlm(async function* () {
        yield 'a';
        throw new Error('socket hang up');
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      collect(plain.service.streamAgent('ws-1', plain.agent.id, { prompt: 'Oi' })),
    ).rejects.toMatchObject({ code: 'LLM_EXECUTION_FAILED', statusCode: 502 });
  });
});

describe('toLlmApplicationError for provider CLIs', () => {
  it.each([
    ['NOT_INSTALLED', 'LLM_CLI_NOT_INSTALLED', 503],
    ['NOT_AUTHENTICATED', 'LLM_CLI_NOT_AUTHENTICATED', 502],
    ['TIMEOUT', 'LLM_TIMEOUT', 504],
    ['UNSUPPORTED', 'LLM_CLI_UNSUPPORTED', 400],
    ['FAILED', 'LLM_EXECUTION_FAILED', 502],
  ] as const)('maps %s to %s', (code, mapped, status) => {
    expect(toLlmApplicationError(new CliLlmError(code, 'details'))).toMatchObject({
      code: mapped,
      statusCode: status,
      technicalMessage: 'details',
    });
  });
});

describe('POST /agents/:id/chat over a real connection', () => {
  async function serve(llm: LlmPort, tweak?: (service: AgentService) => void) {
    const authRepo = new InMemoryAuthRepository();
    const agentRepo = new InMemoryAgentRepository();
    const agentService = new AgentService({ agentRepository: agentRepo, defaultLlm: llm });
    tweak?.(agentService);
    const app = createApp({
      authService: new AuthService(authRepo),
      workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
      agentRepository: agentRepo,
      agentService,
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = { 'content-type': 'application/json' };
    const reg = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'c@example.com', password: 'StrongPassword123!', name: 'C' }),
    });
    const token = ((await reg.json()) as { token: string }).token;
    const auth = { ...json, authorization: `Bearer ${token}` };
    const ws = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'WS', slug: 'ws' }),
    });
    const workspaceId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const headers = { ...auth, 'x-workspace-id': workspaceId };
    const created = await fetch(`${base}/agents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Chatter', role: 'CUSTOM', instructions: 'Converse.' }),
    });
    const agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
    const chat = (body: unknown, signal?: AbortSignal) =>
      fetch(`${base}/agents/${agentId}/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    const close = () => new Promise((resolve) => server.close(resolve));
    return { chat, close };
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes the earlier turns of the conversation to the agent', async () => {
    const llm = new StubLlm(tokens('ok'));
    const { chat, close } = await serve(llm);
    try {
      const response = await chat({
        prompt: 'E agora?',
        history: [{ role: 'user', content: 'Meu nome é Ana.' }],
      });
      await response.text();
      expect(llm.lastRequest?.prompt).toContain('Usuário: Meu nome é Ana.');
    } finally {
      await close();
    }
  });

  it('reports a failure after the answer started as an error event, never with technical details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const known = await serve(
      new StubLlm(async function* () {
        yield 'a';
        throw new ApplicationError('LLM_CLI_NOT_INSTALLED', 'technical: spawn claude ENOENT', 503);
      }),
    );
    try {
      const body = await (await known.chat({ prompt: 'Oi' })).text();
      expect(body).toContain('event: start');
      expect(body).toContain('event: error');
      expect(body).toContain('"code":"LLM_CLI_NOT_INSTALLED"');
      expect(body).not.toContain('ENOENT');
      expect(body).not.toContain('event: done');
    } finally {
      await known.close();
    }

    const plain = await serve(
      new StubLlm(async function* () {
        yield 'a';
        throw new Error('secret internal detail');
      }),
    );
    try {
      const body = await (await plain.chat({ prompt: 'Oi' })).text();
      expect(body).toContain('"code":"LLM_EXECUTION_FAILED"');
      expect(body).not.toContain('secret internal detail');
    } finally {
      await plain.close();
    }

    // A bug that is not an LLM failure at all: still an error event, still no details.
    const bug = await serve(new StubLlm(tokens('a')), (service) => {
      service.streamAgent = async function* () {
        yield { type: 'start', agent: {} as never, provider: 'Stub' } as AgentStreamEvent;
        throw new TypeError('undefined is not a function (internal)');
      };
    });
    try {
      const body = await (await bug.chat({ prompt: 'Oi' })).text();
      expect(body).toContain('"code":"INTERNAL_ERROR"');
      expect(body).not.toContain('internal)');
    } finally {
      await bug.close();
    }
  });

  it('stops the model when the client disconnects', async () => {
    let seen: AbortSignal | undefined;
    const llm = new StubLlm(async function* (signal) {
      seen = signal;
      yield 'x'.repeat(200);
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    });
    const { chat, close } = await serve(llm);
    const controller = new AbortController();
    try {
      const response = await chat({ prompt: 'Oi' }, controller.signal);
      const reader = response.body!.getReader();
      await reader.read(); // the stream is open and flowing
      controller.abort();
      await vi.waitFor(() => expect(seen?.aborted).toBe(true));
    } finally {
      await close();
    }
  });

  it('sends a heartbeat so idle proxies keep the stream open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let finish!: () => void;
    const llm = new StubLlm(async function* () {
      yield 'a';
      await new Promise<void>((resolve) => (finish = resolve));
    });
    const { chat, close } = await serve(llm);
    const controller = new AbortController();
    try {
      const response = await chat({ prompt: 'Oi' }, controller.signal);
      const reader = response.body!.getReader();
      await reader.read(); // start
      vi.advanceTimersByTime(15_000);
      let received = '';
      while (!received.includes(': keep-alive')) {
        const { value } = await reader.read();
        received += new TextDecoder().decode(value);
      }
      expect(received).toContain(': keep-alive');
    } finally {
      finish?.();
      controller.abort();
      await close();
    }
  });
});

describe('GET /integrations/llm/clis', () => {
  const previous = process.env['ADK_LLM_CLI'];
  afterEach(() => {
    if (previous === undefined) delete process.env['ADK_LLM_CLI'];
    else process.env['ADK_LLM_CLI'] = previous;
  });

  async function request(detect: (id: 'claude' | 'codex' | 'gemini') => Promise<CliStatus>) {
    const express = (await import('express')).default;
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = express().use(
      createIntegrationsRouter(
        integrations,
        async () => ({ requestId: 't', ownerId: 'ws-1', workspaceId: 'ws-1', actorId: 'u' }),
        undefined,
        detect,
      ),
    );
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/integrations/llm/clis`;
      return await (await fetch(url)).json();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  const status = (id: 'claude' | 'codex' | 'gemini'): Promise<CliStatus> =>
    Promise.resolve({ id, label: id, command: id, installed: id !== 'gemini' });

  it('reports nothing, and probes nothing, while CLIs are disabled', async () => {
    delete process.env['ADK_LLM_CLI'];
    const detect = vi.fn(status);
    expect(await request(detect)).toEqual({ enabled: false, providers: {} });
    expect(detect).not.toHaveBeenCalled();
  });

  it('reports each provider with the CLI that replaces its API key', async () => {
    process.env['ADK_LLM_CLI'] = 'true';
    const body = (await request(status)) as {
      enabled: boolean;
      providers: Record<string, CliStatus>;
    };
    expect(body.enabled).toBe(true);
    expect(body.providers['claude']).toMatchObject({ id: 'claude', installed: true });
    expect(body.providers['openai']).toMatchObject({ id: 'codex', installed: true });
    expect(body.providers['gemini']).toMatchObject({ id: 'gemini', installed: false });
  });

  it('answers an error through the normal error path', async () => {
    process.env['ADK_LLM_CLI'] = 'true';
    const express = (await import('express')).default;
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    const app = express()
      .use(
        createIntegrationsRouter(integrations, async () => {
          throw new ApplicationError('UNAUTHORIZED', 'No session.', 401);
        }),
      )
      .use(((
        error: ApplicationError,
        _req: unknown,
        res: { status(code: number): { json(body: unknown): void } },
      ) => {
        res.status(error.statusCode).json({ code: error.code });
      }) as never);
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/integrations/llm/clis`;
      const response = await fetch(url);
      expect(response.status).toBe(401);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
