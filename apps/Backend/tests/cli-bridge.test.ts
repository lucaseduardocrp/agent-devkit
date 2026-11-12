import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import {
  bridgeChatId,
  HttpCliBridge,
  parseBridgeChatId,
  type CliBridge,
} from '../src/modules/messaging/application/cli-bridge.js';
import { InMemoryMessagingChatStore } from '../src/modules/messaging/application/messaging-chat-store.js';
import { TelegramApi } from '../src/modules/messaging/telegram/telegram-api.js';
import { TelegramBot } from '../src/modules/messaging/telegram/telegram-bot.js';
import { TelegramGateway } from '../src/modules/messaging/telegram/telegram-gateway.js';
import { TelegramPairingCodes } from '../src/modules/messaging/telegram/telegram-pairing.js';
import { readTelegramSettings } from '../src/modules/messaging/telegram/telegram-settings.js';
import { InMemoryAccessTokenRepository } from '../src/modules/identity/adapters/access-token-repositories.js';
import { AccessTokenService } from '../src/modules/identity/application/access-tokens.js';
import {
  AccessTokenMcpConnector,
  MCP_TOKEN_NAME,
  type McpConnector,
} from '../src/modules/messaging/application/mcp-connector.js';
import { MemoryCacheStore } from '../src/shared/cache.js';

const TOKEN = '123456:ABC-def_ghi';
const BRIDGE_TOKEN = 'bridge-secret-token';

function update(text: string, id = 1, language = 'en') {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 7, first_name: 'Ana', language_code: language },
      text,
    },
  };
}

function setup(bridge?: CliBridge, mcp?: McpConnector) {
  const sent: string[] = [];
  const deleted: number[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/deleteMessage'))
      deleted.push((JSON.parse(String(init?.body)) as { message_id: number }).message_id);
    if (String(url).endsWith('/sendMessage'))
      sent.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  const chats = new InMemoryMessagingChatStore();
  const agentsList = vi.fn(async () => []);
  const bot = new TelegramBot({
    workspaceId: 'ws-1',
    api: new TelegramApi({ token: TOKEN, fetch: fetcher }),
    chats,
    agents: {
      listAgents: agentsList,
      executeAgent: vi.fn(async () => ({ result: 'agent' })),
    } as never,
    pairing: new TelegramPairingCodes(new MemoryCacheStore()),
    settings: readTelegramSettings({}),
    bridge,
    mcp,
  });
  const link = () =>
    chats.link({
      workspaceId: 'ws-1',
      provider: 'telegram',
      chatId: '42',
      userId: '7',
      displayName: 'Ana',
      linkedBy: 'u1',
    });
  return { bot, chats, sent, link, deleted };
}

function fakeBridge(clis = ['claude', 'codex']) {
  return {
    listClis: vi.fn(async () => clis),
    forward: vi.fn(async () => undefined),
  } satisfies CliBridge;
}

describe('TelegramBot with the CLI Bridge', () => {
  it('says so when no Bridge is configured', async () => {
    const { bot, sent, link } = setup();
    await link();
    await bot.handle(update('/cli claude'));
    await bot.handle(update('/mode safe', 2));
    expect(sent).toHaveLength(2);
    expect(sent.every((text) => text.includes('not set up'))).toBe(true);
  });

  it('switches a chat to a CLI and forwards its messages and commands', async () => {
    const bridge = fakeBridge();
    const { bot, chats, sent, link } = setup(bridge);
    await link();

    await bot.handle(update('/cli', 1));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', chatId: '42', userId: '7', text: '/cli' }),
    );

    await bot.handle(update('/cli nope', 2));
    expect(sent.at(-1)).toContain('Available: claude, codex');

    await bot.handle(update('/cli CLAUDE', 3));
    expect((await chats.find('ws-1', 'telegram', '42'))?.agentId).toBe('cli:claude');
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/cli claude' }),
    );
    expect(sent.at(-1)).toContain('talks to the claude CLI');

    await bot.handle(update('fix the build', 4));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'fix the build' }),
    );
    await bot.handle(update('/schedule every 30m ping', 5));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/schedule every 30m ping' }),
    );
    await bot.handle(update('/cancel', 6));
    expect(bridge.forward).toHaveBeenLastCalledWith(expect.objectContaining({ text: '/cancel' }));
    const before = bridge.forward.mock.calls.length;
    await bot.handle(update('/new', 7));
    expect(bridge.forward).toHaveBeenCalledTimes(before + 1);
    expect(bridge.forward).toHaveBeenLastCalledWith(expect.objectContaining({ text: '/new' }));
  });

  it('goes back to ADK agents with /agent default, and /new answers itself there', async () => {
    const bridge = fakeBridge();
    const { bot, chats, sent, link } = setup(bridge);
    await link();
    await bot.handle(update('/cli claude', 1));
    await bot.handle(update('/agent default', 2));
    expect((await chats.find('ws-1', 'telegram', '42'))?.agentId).toBeNull();
    const calls = bridge.forward.mock.calls.length;
    await bot.handle(update('/new', 3));
    expect(bridge.forward).toHaveBeenCalledTimes(calls);
    expect(sent.at(-1)).toContain('New conversation');
  });

  it('reports a Bridge that is down, in Portuguese for Portuguese apps', async () => {
    const bridge = fakeBridge();
    bridge.forward.mockRejectedValue(new Error('The CLI Bridge answered 502.'));
    const { bot, sent, link } = setup(bridge);
    await link();
    await bot.handle(update('/cli', 1, 'pt'));
    expect(sent.at(-1)).toContain('Não consegui falar com o Bridge');
    bridge.listClis.mockRejectedValue('offline');
    await bot.handle(update('/cli claude', 2));
    expect(sent.at(-1)).toContain('offline');
  });

  it('forwards plain text and /status when the chat is in CLI mode without a Bridge', async () => {
    const { bot, sent, link, chats } = setup();
    const chat = await link();
    await chats.update('ws-1', chat.id, { agentId: 'cli:claude' });
    await bot.handle(update('hello', 1));
    await bot.handle(update('/status', 2));
    expect(sent).toHaveLength(2);
  });

  it('identifies the member who paired the chat and deletes /auth messages', async () => {
    const bridge = fakeBridge();
    const { bot, sent, link, deleted } = setup(bridge);
    await link();
    await bot.handle(update('/auth claude sk-ant-oat01-secret', 7));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({
        memberId: 'u1',
        text: '/auth claude sk-ant-oat01-secret',
      }),
    );
    expect(deleted).toEqual([7]);

    // Without a key there is nothing to hide; /logout is forwarded too.
    await bot.handle(update('/auth', 8));
    await bot.handle(update('/logout claude', 9));
    expect(deleted).toEqual([7]);
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ memberId: 'u1', text: '/logout claude' }),
    );
    expect(sent).toEqual([]);
  });

  it('keeps unknown commands unknown', async () => {
    const { bot, sent, link } = setup(fakeBridge());
    await link();
    await bot.handle(update('/bogus'));
    expect(sent.at(-1)).toContain('Unknown command');
  });
});

describe('HttpCliBridge', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

  it('lists CLIs and forwards messages with the shared token', async () => {
    const fetcher = respond(200, { clis: ['claude', 'codex'] });
    const bridge = new HttpCliBridge({ url: 'http://bridge:3500/', token: 't', fetch: fetcher });
    expect(await bridge.listClis()).toEqual(['claude', 'codex']);
    await bridge.forward({
      workspaceId: 'ws',
      chatId: '9',
      userId: '7',
      memberId: 'm-1',
      text: 'hi',
    });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://bridge:3500/messages');
    expect(init.headers).toMatchObject({ authorization: 'Bearer t' });
    expect(JSON.parse(String(init.body))).toEqual({
      chatId: 'ws:9',
      userId: '7',
      memberId: 'm-1',
      text: 'hi',
    });
  });

  it('tolerates odd payloads and fails on HTTP errors', async () => {
    const odd = new HttpCliBridge({ url: 'http://b', token: 't', fetch: respond(200, {}) });
    expect(await odd.listClis()).toEqual([]);
    const text = vi.fn(
      async () => new Response('nope', { status: 200 }),
    ) as unknown as typeof fetch;
    expect(
      await new HttpCliBridge({ url: 'http://b', token: 't', fetch: text }).listClis(),
    ).toEqual([]);
    const down = new HttpCliBridge({ url: 'http://b', token: 't', fetch: respond(502, {}) });
    await expect(down.listClis()).rejects.toThrow('502');
  });

  it('builds and parses chat ids', () => {
    expect(bridgeChatId('ws', '42')).toBe('ws:42');
    expect(parseBridgeChatId('ws:42')).toEqual({ workspaceId: 'ws', chatId: '42' });
    expect(parseBridgeChatId('a:b:42')).toEqual({ workspaceId: 'a:b', chatId: '42' });
    expect(parseBridgeChatId('nocolon')).toBeNull();
    expect(parseBridgeChatId(':42')).toBeNull();
    expect(parseBridgeChatId('ws:')).toBeNull();
  });
});

describe('Bridge routes', () => {
  function gatewayWith(sendMessage = vi.fn(async () => true), typing = vi.fn(async () => true)) {
    return { sendToChat: sendMessage, typingInChat: typing } as unknown as TelegramGateway;
  }
  function appWith(options: { token?: string; gateway?: TelegramGateway }) {
    return createApp({
      authService: new AuthService(new InMemoryAuthRepository()),
      integrationsService: new IntegrationsService(new InMemoryUserIntegrationStore()),
      messagingChats: new InMemoryMessagingChatStore(),
      telegramGateway: options.gateway ?? gatewayWith(),
      bridgeToken: options.token,
    });
  }
  const auth = { Authorization: `Bearer ${BRIDGE_TOKEN}` };

  it('does not exist without a token', async () => {
    const response = await request(appWith({})).post('/messaging/bridge/send').send({});
    expect(response.status).toBe(404);
  });

  it('rejects calls without the shared token', async () => {
    const app = appWith({ token: BRIDGE_TOKEN });
    const body = { chatId: 'ws:42', text: 'hi' };
    expect((await request(app).post('/messaging/bridge/send').send(body)).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/messaging/bridge/send')
          .set({ Authorization: 'Bearer wrong-secret-token' })
          .send(body)
      ).status,
    ).toBe(401);
  });

  it('delivers replies and typing to the workspace bot', async () => {
    const send = vi.fn(async () => true);
    const typing = vi.fn(async () => true);
    const app = appWith({ token: BRIDGE_TOKEN, gateway: gatewayWith(send, typing) });
    const sent = await request(app)
      .post('/messaging/bridge/send')
      .set(auth)
      .send({ chatId: 'ws-1:42', text: 'done' });
    expect(sent.status).toBe(200);
    expect(send).toHaveBeenCalledWith('ws-1', '42', 'done');
    const typed = await request(app)
      .post('/messaging/bridge/typing')
      .set(auth)
      .send({ chatId: 'ws-1:42' });
    expect(typed.status).toBe(200);
    expect(typing).toHaveBeenCalledWith('ws-1', '42');
  });

  it('reports an offline bot and a malformed chat id', async () => {
    const app = appWith({
      token: BRIDGE_TOKEN,
      gateway: gatewayWith(vi.fn(async () => false)),
    });
    const offline = await request(app)
      .post('/messaging/bridge/send')
      .set(auth)
      .send({ chatId: 'ws-1:42', text: 'x' });
    expect(offline.status).toBe(409);
    for (const path of ['send', 'typing']) {
      const bad = await request(app)
        .post(`/messaging/bridge/${path}`)
        .set(auth)
        .send({ chatId: 'nocolon', text: 'x' });
      expect(bad.status).toBe(400);
    }
  });
});

describe('TelegramGateway bridge delivery', () => {
  it('returns false for a workspace without a running bot', async () => {
    const gateway = new TelegramGateway({
      integrations: new IntegrationsService(new InMemoryUserIntegrationStore()),
      chats: new InMemoryMessagingChatStore(),
      agents: { listAgents: vi.fn(), executeAgent: vi.fn() } as never,
      pairing: new TelegramPairingCodes(new MemoryCacheStore()),
    });
    expect(await gateway.sendToChat('ws', '42', 'x')).toBe(false);
    expect(await gateway.typingInChat('ws', '42')).toBe(false);
  });
});

describe('/mcp adk', () => {
  const connector = () =>
    ({
      url: 'https://mcp.example.com/mcp',
      issueToken: vi.fn(async () => 'adk_pat_ISSUED'),
    }) satisfies McpConnector;

  it('issues a token for the member who paired the chat and hands it to the Bridge', async () => {
    const bridge = fakeBridge();
    const mcp = connector();
    const { bot, sent, link, deleted } = setup(bridge, mcp);
    await link();
    await bot.handle(update('/mcp adk', 1));
    expect(mcp.issueToken).toHaveBeenLastCalledWith('u1', 'full');
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({
        memberId: 'u1',
        text: '/mcp add adk https://mcp.example.com/mcp adk_pat_ISSUED',
      }),
    );
    await bot.handle(update('/mcp ADK read', 2));
    expect(mcp.issueToken).toHaveBeenLastCalledWith('u1', 'read');
    // The member never typed a key, so nothing is deleted and nothing is echoed back.
    expect(deleted).toEqual([]);
    expect(sent.join(' ')).not.toContain('ISSUED');
  });

  it('forwards the other /mcp commands and deletes the message that carries a token', async () => {
    const bridge = fakeBridge();
    const { bot, link, deleted } = setup(bridge, connector());
    await link();
    await bot.handle(update('/mcp', 1));
    expect(bridge.forward).toHaveBeenLastCalledWith(expect.objectContaining({ text: '/mcp' }));
    await bot.handle(update('/mcp remove adk', 2));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/mcp remove adk' }),
    );
    expect(deleted).toEqual([]);
    await bot.handle(update('/mcp add tool https://t.example.com/mcp SECRET', 3));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/mcp add tool https://t.example.com/mcp SECRET' }),
    );
    expect(deleted).toEqual([3]);
  });

  it('explains when the Bridge or the ADK MCP server is not set up, and when issuing fails', async () => {
    const none = setup();
    await none.link();
    await none.bot.handle(update('/mcp adk', 1));
    expect(none.sent.at(-1)).toContain('not set up');

    const noMcp = setup(fakeBridge());
    await noMcp.link();
    await noMcp.bot.handle(update('/mcp adk', 1));
    expect(noMcp.sent.at(-1)).toContain('ADK_MCP_URL');

    const failing = { ...connector(), issueToken: vi.fn().mockRejectedValue(new Error('limit')) };
    const broken = setup(fakeBridge(), failing);
    await broken.link();
    await broken.bot.handle(update('/mcp adk', 1));
    expect(broken.sent.at(-1)).toContain('limit');
    failing.issueToken.mockRejectedValue('weird');
    await broken.bot.handle(update('/mcp adk', 2));
    expect(broken.sent.at(-1)).toContain('weird');
  });
});

describe('AccessTokenMcpConnector', () => {
  it('replaces the previous token of the member instead of piling them up', async () => {
    const tokens = new AccessTokenService(new InMemoryAccessTokenRepository(), {
      findById: async () => null,
    });
    const connector = new AccessTokenMcpConnector('https://mcp.example.com/mcp', tokens);
    const other = await tokens.create('u1', {
      name: 'my laptop',
      scope: 'full',
      expiresInDays: 30,
    });

    const first = await connector.issueToken('u1', 'full');
    const second = await connector.issueToken('u1', 'read');
    expect(first).not.toBe(second);
    expect(second.startsWith('adk_')).toBe(true);

    const active = await tokens.list('u1');
    expect(active.filter((token) => token.name === MCP_TOKEN_NAME)).toHaveLength(1);
    expect(active.find((token) => token.name === MCP_TOKEN_NAME)?.scope).toBe('read');
    // The member's other tokens are left alone.
    expect(active.some((token) => token.id === other.accessToken.id)).toBe(true);
    expect(await tokens.list('u2')).toEqual([]);
  });
});
