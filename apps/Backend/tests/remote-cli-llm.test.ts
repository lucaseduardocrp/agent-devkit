import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntegrationsRouter } from '../src/adapters/http/integrations-routes.js';
import {
  bridgeEndpoint,
  isLlmCliEnabled,
  llmCliTransport,
} from '../src/modules/agents/adapters/cli-llm/cli-config.js';
import { CliLlmError, CliLlmProvider } from '../src/modules/agents/adapters/cli-llm/cli-llm.js';
import {
  fetchBridgeClis,
  RemoteCliLlmProvider,
} from '../src/modules/agents/adapters/cli-llm/remote-cli-llm.js';
import { toLlmApplicationError } from '../src/modules/agents/application/agent-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { ApplicationError } from '../src/shared/errors.js';

const bridge = { url: 'http://bridge:3500', token: 'shared-token' };
const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function sse(chunks: string[], failAfter?: Error): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (failAfter) controller.error(failAfter);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function provider(
  fetcher: typeof fetch,
  extra: Partial<ConstructorParameters<typeof RemoteCliLlmProvider>[0]> = {},
) {
  return new RemoteCliLlmProvider({
    cli: 'claude',
    bridge,
    workspaceId: 'ws-1',
    fetcher,
    ...extra,
  });
}

async function drain(output: AsyncIterable<string>): Promise<string> {
  let all = '';
  for await (const chunk of output) all += chunk;
  return all;
}

describe('RemoteCliLlmProvider', () => {
  it('streams what the Bridge sends, even when an event is split across network chunks', async () => {
    const delta = event('delta', { text: 'Olá, ' });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        sse([
          delta.slice(0, 10),
          delta.slice(10),
          ': keep-alive\n\n',
          event('delta', { text: 'mundo' }),
          event('done', {}),
        ]),
      );
    expect(await drain(provider(fetcher).stream({ prompt: 'oi' }))).toBe('Olá, mundo');
  });

  it('sends the workspace, the CLI, the prompt and the token, with the shared token as bearer', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => sse([event('done', {})]));
    await drain(
      provider(fetcher as never, {
        credential: '  sk-ant-oat-abc  ',
        model: 'claude-sonnet-5-5',
      }).stream({
        prompt: 'Pergunta',
        instruction: 'Seja breve',
      }),
    );
    const [url, init] = fetcher.mock.calls[0]! as unknown as [
      string,
      { headers: object; body: string },
    ];
    expect(url).toBe('http://bridge:3500/llm/stream');
    expect(init.headers).toMatchObject({ authorization: 'Bearer shared-token' });
    expect(JSON.parse(init.body)).toEqual({
      workspaceId: 'ws-1',
      cli: 'claude',
      prompt: 'Pergunta',
      instruction: 'Seja breve',
      model: 'claude-sonnet-5-5',
      credential: 'sk-ant-oat-abc',
    });

    await drain(provider(fetcher as never).stream({ prompt: 'x' }));
    expect(
      JSON.parse((fetcher.mock.calls[1]! as unknown as [string, { body: string }])[1].body),
    ).toEqual({
      workspaceId: 'ws-1',
      cli: 'claude',
      prompt: 'x',
    });
  });

  it('answers complete() with the usage and model the Bridge reported', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        sse([
          event('delta', { text: 'Paris' }),
          event('usage', { inputTokens: 5, outputTokens: 2, model: 'claude-sonnet-5-5' }),
          event('done', {}),
        ]),
      );
    expect(await provider(fetcher).complete({ prompt: 'x' })).toEqual({
      provider: 'Claude CLI',
      text: 'Paris',
      model: 'claude-sonnet-5-5',
      usage: { inputTokens: 5, outputTokens: 2 },
    });
  });

  it('reads server-sent events however the Bridge spaces them', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      sse([
        'retry\n',
        'event:delta\ndata:{"text":"sem espaço"}\n\n',
        'event: delta\ndata: 5\n\n',
        'event: done\ndata: {}\n\n',
      ]),
    );
    expect(await drain(provider(fetcher as never).stream({ prompt: 'x' }))).toBe('sem espaço');
  });

  it('tolerates malformed and incomplete events', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        sse([
          'event: delta\ndata: {not json\n\n',
          event('delta', {}),
          event('usage', {}),
          event('mystery', {}),
          event('done', {}),
        ]),
      );
    const response = await provider(fetcher).complete({ prompt: 'x' });
    expect(response.text).toBe('');
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  describe('failures', () => {
    const fails = (fetcher: typeof fetch, extra: object = {}, signal?: AbortSignal) =>
      drain(provider(fetcher, extra).stream({ prompt: 'x' }, signal)).catch(
        (e: unknown) => e as CliLlmError,
      );

    it.each(['NOT_INSTALLED', 'NOT_AUTHENTICATED', 'TIMEOUT', 'UNSUPPORTED', 'FAILED'] as const)(
      'turns an %s error event into the same error',
      async (code) => {
        const error = await fails(
          vi.fn().mockResolvedValue(sse([event('error', { code, message: `m ${code}` })])),
        );
        expect(error).toMatchObject({ code, message: `m ${code}` });
      },
    );

    it('treats an unknown error code, or none, as a plain failure', async () => {
      expect(
        await fails(
          vi.fn().mockResolvedValue(sse([event('error', { code: 'WAT', message: 'x' })])),
        ),
      ).toMatchObject({ code: 'FAILED' });
      expect(await fails(vi.fn().mockResolvedValue(sse([event('error', {})])))).toMatchObject({
        code: 'FAILED',
        message: 'The CLI failed.',
      });
    });

    it('reports a Bridge that cannot be reached', async () => {
      expect(await fails(vi.fn().mockRejectedValue(new TypeError('fetch failed')))).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
      });
    });

    it('reports a request that outlived its time limit as a timeout', async () => {
      const hangs = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
      );
      expect(await fails(hangs as never, { timeoutMs: 30 })).toMatchObject({ code: 'TIMEOUT' });
    });

    it('reports an answer that stalls after it started as a timeout', async () => {
      const stalls = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event('delta', { text: 'a' })));
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        });
        return new Response(body, { status: 200 });
      });
      expect(await fails(stalls as never, { timeoutMs: 60 })).toMatchObject({ code: 'TIMEOUT' });
    });

    it('lets a cancellation by the caller through as it is', async () => {
      const controller = new AbortController();
      controller.abort();
      expect(await fails(vi.fn(), {}, controller.signal)).toMatchObject({ name: 'AbortError' });

      const cancelling = new AbortController();
      const hangs = vi.fn(
        (_url: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            ),
          ),
      );
      const pending = fails(hangs as never, {}, cancelling.signal);
      cancelling.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
    });

    it('lets a cancellation while reading through as it is', async () => {
      const cancelling = new AbortController();
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event('delta', { text: 'a' })));
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        });
        return new Response(body, { status: 200 });
      });
      const run = provider(fetcher as never)
        .stream({ prompt: 'x' }, cancelling.signal)
        [Symbol.asyncIterator]();
      await run.next();
      const next = run.next();
      cancelling.abort();
      await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('reports a connection lost in the middle of the answer', async () => {
      expect(
        await fails(
          vi.fn().mockResolvedValue(sse([event('delta', { text: 'a' })], new Error('reset'))),
        ),
      ).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
        message: 'The connection to the Bridge was lost.',
      });
    });

    it('reports an answer that ends without done', async () => {
      expect(
        await fails(vi.fn().mockResolvedValue(sse([event('delta', { text: 'a' })]))),
      ).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
        message: expect.stringContaining('before the answer ended'),
      });
    });

    it('explains a rejected shared token, a coded refusal and an unexpected status', async () => {
      expect(
        await fails(vi.fn().mockResolvedValue(json(401, { error: 'unauthorized' }))),
      ).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
        message: expect.stringContaining('BRIDGE_SHARED_TOKEN'),
      });
      expect(await fails(vi.fn().mockResolvedValue(json(403, {})))).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
      });
      expect(
        await fails(
          vi
            .fn()
            .mockResolvedValue(json(422, { code: 'NOT_AUTHENTICATED', message: 'No token yet.' })),
        ),
      ).toMatchObject({ code: 'NOT_AUTHENTICATED', message: 'No token yet.' });
      expect(
        await fails(vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))),
      ).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
        message: 'The Bridge answered 500.',
      });
    });

    it('reports an answer with no body', async () => {
      expect(
        await fails(
          vi.fn().mockResolvedValue({ ok: true, status: 200, body: null } as unknown as Response),
        ),
      ).toMatchObject({
        code: 'BRIDGE_UNAVAILABLE',
      });
    });

    it('refuses an image the CLI cannot read, and a model id that could break out', async () => {
      const fetcher = vi.fn();
      await expect(
        provider(fetcher).complete({
          prompt: 'x',
          images: [{ mimeType: 'image/bmp' as never, data: 'AA==' }],
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
      expect(fetcher).not.toHaveBeenCalled();
      expect(() => provider(vi.fn(), { model: 'x"; calc' })).toThrow(CliLlmError);
    });

    it('sends images and files to the Bridge', async () => {
      const fetcher = vi.fn().mockResolvedValue(sse([event('done', {})]));
      const image = { mimeType: 'image/png' as const, data: 'AA==' };
      const file = { name: 'a.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' };
      await provider(fetcher).complete({ prompt: 'x', images: [image], files: [file] });
      const body = JSON.parse(String((fetcher.mock.calls[0]![1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(body['images']).toEqual([image]);
      expect(body['files']).toEqual([file]);
    });
  });
});

describe('fetchBridgeClis', () => {
  const statuses = [
    { id: 'claude', label: 'Claude', command: 'claude', installed: true, signedIn: false },
  ];

  it('lists the CLIs of a workspace', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(200, { clis: statuses }));
    expect(await fetchBridgeClis(bridge, 'ws 1', fetcher)).toEqual(statuses);
    expect(fetcher.mock.calls[0]![0]).toBe('http://bridge:3500/llm/clis?workspaceId=ws%201');
    expect(fetcher.mock.calls[0]![1].headers).toMatchObject({
      authorization: 'Bearer shared-token',
    });
  });

  it('treats an answer with no list as empty', async () => {
    expect(await fetchBridgeClis(bridge, 'w', vi.fn().mockResolvedValue(json(200, {})))).toEqual(
      [],
    );
  });

  it('reports a Bridge that cannot be reached or that refuses', async () => {
    await expect(
      fetchBridgeClis(bridge, 'w', vi.fn().mockRejectedValue(new Error('down'))),
    ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
    await expect(
      fetchBridgeClis(bridge, 'w', vi.fn().mockResolvedValue(json(401, {}))),
    ).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
  });
});

describe('where the CLI runs', () => {
  it('reads the Bridge endpoint', () => {
    expect(
      bridgeEndpoint({ BRIDGE_URL: ' http://bridge:3500/ ', BRIDGE_SHARED_TOKEN: ' t ' }),
    ).toEqual({ url: 'http://bridge:3500', token: 't' });
    expect(bridgeEndpoint({ BRIDGE_URL: 'http://bridge:3500' })).toBeNull();
    expect(bridgeEndpoint({ BRIDGE_SHARED_TOKEN: 't' })).toBeNull();
    expect(bridgeEndpoint({})).toBeNull();
  });

  const withBridge = { BRIDGE_URL: 'http://bridge:3500', BRIDGE_SHARED_TOKEN: 't' };
  it.each([
    [{}, null],
    [withBridge, 'bridge'],
    [{ ...withBridge, ADK_LLM_CLI: 'bridge' }, 'bridge'],
    [{ ADK_LLM_CLI: 'bridge' }, null],
    [{ ADK_LLM_CLI: 'true' }, 'local'],
    [{ ADK_LLM_CLI: ' Local ' }, 'local'],
    [{ ...withBridge, ADK_LLM_CLI: 'true' }, 'local'],
    [{ ...withBridge, ADK_LLM_CLI: 'false' }, null],
    [{ ...withBridge, ADK_LLM_CLI: 'tru' }, null],
  ])('%j runs it %s', (env, transport) => {
    expect(llmCliTransport(env)).toBe(transport);
    expect(isLlmCliEnabled(env)).toBe(transport !== null);
  });
});

describe('the Bridge as the transport of an integration', () => {
  const keys = ['ADK_LLM_CLI', 'BRIDGE_URL', 'BRIDGE_SHARED_TOKEN'] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    delete process.env['ADK_LLM_CLI'];
    process.env['BRIDGE_URL'] = bridge.url;
    process.env['BRIDGE_SHARED_TOKEN'] = bridge.token;
  });
  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function factoryWith(
    fetcher: typeof fetch,
    settings: Record<string, unknown> = { authMode: 'cli' },
    secret?: string,
    providerId = 'claude',
  ) {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws-1', 'LLM', providerId, {
      isEnabled: true,
      settings,
      ...(secret ? { secret } : {}),
    });
    return new DynamicProviderFactory(integrations, fetcher);
  }

  it('resolves a remote CLI that sends the workspace token the integration stores', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(sse([event('delta', { text: 'Paris' }), event('done', {})]));
    const factory = await factoryWith(
      fetcher as never,
      { authMode: 'cli', cliModel: 'claude-sonnet-5-5' },
      'sk-ant-oat-stored-token',
    );
    const llm = await factory.resolveLlmProvider('ws-1');
    expect(llm).toBeInstanceOf(RemoteCliLlmProvider);
    expect(llm?.provider).toBe('Claude CLI');
    expect((await llm!.complete({ prompt: 'x' })).text).toBe('Paris');
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toMatchObject({
      workspaceId: 'ws-1',
      credential: 'sk-ant-oat-stored-token',
      model: 'claude-sonnet-5-5',
    });
  });

  it('asks the Bridge with no token when none was saved', async () => {
    const fetcher = vi.fn().mockResolvedValue(sse([event('done', {})]));
    const factory = await factoryWith(fetcher as never);
    await (await factory.resolveLlmProvider('ws-1'))!.complete({ prompt: 'x' });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body)).not.toHaveProperty('credential');
  });

  it('prefers the CLI on this machine when the operator turned it on', async () => {
    process.env['ADK_LLM_CLI'] = 'true';
    const factory = await factoryWith(vi.fn() as never, { authMode: 'cli' }, 'sk-ant-oat-ignored');
    expect(await factory.resolveLlmProvider('ws-1')).toBeInstanceOf(CliLlmProvider);
  });

  it('refuses a model id that could break out, for either transport', async () => {
    const factory = await factoryWith(vi.fn() as never, { authMode: 'cli', cliModel: 'x" & calc' });
    await expect(factory.resolveLlmProvider('ws-1')).rejects.toMatchObject({
      code: 'LLM_CLI_INVALID_MODEL',
    });
  });

  describe('Test Connection', () => {
    const status = (installed: boolean) =>
      json(200, {
        clis: [
          {
            id: 'claude',
            label: 'Claude',
            command: 'claude',
            installed,
            version: '2.1.318',
            signedIn: true,
          },
        ],
      });
    const probe = (fetcher: typeof fetch, secret = 'sk-ant-oat-typed') =>
      factoryWith(fetcher, { authMode: 'cli' }).then((factory) =>
        factory.testConnectivity(
          'claude',
          'LLM',
          { authMode: 'cli' },
          secret,
          undefined,
          undefined,
          'ws-1',
        ),
      );

    it('checks the Bridge has the CLI, then proves the token works with a real answer', async () => {
      const fetcher = vi.fn(async (url: string) =>
        url.includes('/llm/clis')
          ? status(true)
          : sse([event('delta', { text: 'OK' }), event('done', {})]),
      );
      expect(await probe(fetcher as never)).toEqual({
        ok: true,
        message: 'Claude CLI 2.1.318 answered.',
      });
      const streamCall = fetcher.mock.calls.find(([url]) => String(url).includes('/llm/stream'))!;
      expect(
        JSON.parse((streamCall as unknown as [string, { body: string }])[1].body),
      ).toMatchObject({ workspaceId: 'ws-1', credential: 'sk-ant-oat-typed' });
    });

    it('says the CLI is missing from the Bridge without calling the model', async () => {
      const fetcher = vi.fn(async () => status(false));
      const result = await probe(fetcher as never);
      expect(result).toMatchObject({
        ok: false,
        message: expect.stringContaining('in the Bridge container'),
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('says so when the Bridge does not list the CLI at all', async () => {
      const fetcher = vi.fn(async () => json(200, { clis: [] }));
      expect(await probe(fetcher as never)).toMatchObject({ ok: false });
    });

    it('reports a Bridge that cannot be reached, or a token the CLI rejects', async () => {
      expect(await probe(vi.fn().mockRejectedValue(new Error('down')) as never)).toMatchObject({
        ok: false,
        message: expect.stringContaining('could not be reached'),
      });
      const rejected = vi.fn(async (url: string) =>
        url.includes('/llm/clis')
          ? status(true)
          : json(422, {
              code: 'NOT_AUTHENTICATED',
              message: 'That is not a token Claude accepts.',
            }),
      );
      expect(await probe(rejected as never)).toEqual({
        ok: false,
        message: 'That is not a token Claude accepts.',
      });
    });
  });

  it('maps a Bridge that cannot be reached to its own error', () => {
    expect(toLlmApplicationError(new CliLlmError('BRIDGE_UNAVAILABLE', 'down'))).toMatchObject({
      code: 'LLM_CLI_BRIDGE_UNAVAILABLE',
      statusCode: 503,
    });
  });

  describe('GET /integrations/llm/clis', () => {
    async function get(listBridgeClis: typeof fetchBridgeClis) {
      const express = (await import('express')).default;
      const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
      const app = express().use(
        createIntegrationsRouter(
          integrations,
          async () => ({ requestId: 't', ownerId: 'ws-9', workspaceId: 'ws-9', actorId: 'u' }),
          undefined,
          undefined,
          listBridgeClis,
        ),
      );
      const server = app.listen(0);
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/integrations/llm/clis`;
        return (await (await fetch(url)).json()) as Record<string, unknown>;
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }

    it('lists the CLIs of this workspace in the Bridge, per provider', async () => {
      const list = vi.fn(async () => [
        {
          id: 'claude' as const,
          label: 'Claude',
          command: 'claude',
          installed: true,
          hint: 'Run claude setup-token',
        },
        { id: 'codex' as const, label: 'Codex', command: 'codex', installed: false },
      ]);
      const body = await get(list);
      expect(list).toHaveBeenCalledWith(bridge, 'ws-9');
      expect(body).toMatchObject({ enabled: true, transport: 'bridge' });
      expect(body).not.toHaveProperty('error');
      expect(body['providers']).toMatchObject({
        claude: { id: 'claude', installed: true, hint: 'Run claude setup-token' },
        openai: { id: 'codex', installed: false },
      });
    });

    it('says whether the ADK tools can be offered to the CLI, which depends on ADK_MCP_URL', async () => {
      const previous = process.env['ADK_MCP_URL'];
      try {
        process.env['ADK_MCP_URL'] = 'http://mcp:3333/mcp';
        expect(await get(async () => [])).toMatchObject({ mcp: true });
        process.env['ADK_MCP_URL'] = '  ';
        expect(await get(async () => [])).toMatchObject({ mcp: false });
        delete process.env['ADK_MCP_URL'];
        expect(await get(async () => [])).toMatchObject({ mcp: false });
      } finally {
        if (previous === undefined) delete process.env['ADK_MCP_URL'];
        else process.env['ADK_MCP_URL'] = previous;
      }
    });

    it('still answers when the Bridge cannot be reached, and says why', async () => {
      const body = await get(async () => {
        throw new CliLlmError('BRIDGE_UNAVAILABLE', 'The Bridge could not be reached.');
      });
      expect(body).toMatchObject({
        enabled: true,
        transport: 'bridge',
        providers: {},
        error: 'The Bridge could not be reached.',
      });
    });
  });
});

describe('errors shown to the user', () => {
  it('has a translated message for every code the CLI transports can produce', async () => {
    const { translateErrorMessage } = await import('../src/shared/i18n.js');
    for (const code of [
      'LLM_CLI_NOT_INSTALLED',
      'LLM_CLI_NOT_AUTHENTICATED',
      'LLM_CLI_BRIDGE_UNAVAILABLE',
      'LLM_CLI_UNSUPPORTED',
      'LLM_CLI_DISABLED',
      'LLM_CLI_INVALID_MODEL',
      'LLM_TIMEOUT',
    ]) {
      for (const locale of ['en-US', 'pt-BR'] as const) {
        expect(translateErrorMessage(code, locale)).not.toBe(
          translateErrorMessage('A_CODE_NOBODY_DEFINED', locale),
        );
      }
    }
    expect(new ApplicationError('X', 'y')).toBeTruthy();
  });
});
