import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { CustomAgent } from '../src/modules/agents/domain/agent-entity.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { InMemoryMessagingChatStore } from '../src/modules/messaging/application/messaging-chat-store.js';
import {
  formatDuration,
  formatRunFinished,
  TelegramRunNotifier,
} from '../src/modules/messaging/application/run-notifier.js';
import {
  splitMessage,
  TelegramApi,
  type TelegramUpdate,
} from '../src/modules/messaging/telegram/telegram-api.js';
import { parseCommand, TelegramBot } from '../src/modules/messaging/telegram/telegram-bot.js';
import { TelegramGateway } from '../src/modules/messaging/telegram/telegram-gateway.js';
import { TelegramPairingCodes } from '../src/modules/messaging/telegram/telegram-pairing.js';
import {
  readTelegramSettings,
  usesWebhook,
  webhookSecret,
} from '../src/modules/messaging/telegram/telegram-settings.js';
import { MemoryCacheStore } from '../src/shared/cache.js';

const TOKEN = '123456:ABC-def_ghi';
const KEY = Buffer.alloc(32, 7);

/** A Bot API double: records calls and serves queued getUpdates batches. */
function fakeTelegram(username = 'adk_test_bot') {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const batches: TelegramUpdate[][] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'getUpdates') {
      const batch = batches.shift();
      if (!batch)
        await new Promise<void>((resolve) => {
          if (init?.signal?.aborted) resolve();
          init?.signal?.addEventListener('abort', () => resolve());
        });
      return Response.json({ ok: true, result: batch ?? [] });
    }
    if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, username } });
    return Response.json({ ok: true, result: true });
  });
  const sent = () =>
    calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body['text']));
  return { fetcher: fetcher as unknown as typeof fetch, calls, batches, sent };
}

function message(text: string, overrides: Partial<TelegramUpdate['message']> = {}, id = 1) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' as const },
      from: { id: 7, first_name: 'Ana', username: 'ana', language_code: 'en' },
      text,
      ...overrides,
    },
  } satisfies TelegramUpdate;
}

const agents = [
  { id: 'a1', slug: 'qa', name: 'QA Agent', isDefault: true },
  { id: 'a2', slug: 'docs', name: 'Docs Agent', isDefault: false },
] as unknown as CustomAgent[];

function setupBot(workspaceId = 'ws-1') {
  const telegram = fakeTelegram();
  const chats = new InMemoryMessagingChatStore();
  const pairing = new TelegramPairingCodes(new MemoryCacheStore());
  const executeAgent = vi.fn(async (_ws: string, agentId: string) => ({
    result: `answer from ${agentId}`,
  }));
  const bot = new TelegramBot({
    workspaceId,
    api: new TelegramApi({ token: TOKEN, fetch: telegram.fetcher }),
    chats,
    agents: { listAgents: vi.fn(async () => agents), executeAgent } as never,
    pairing,
    settings: readTelegramSettings({}),
  });
  return { bot, telegram, chats, pairing, executeAgent };
}

async function pairedBot() {
  const setup = setupBot();
  const { code } = await setup.pairing.create({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    actorId: 'user-1',
  });
  await setup.bot.handle(message(`/start ${code}`));
  return setup;
}

describe('Telegram helpers', () => {
  it('splits long text at paragraph or line boundaries within the limit', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n${'c'.repeat(30)}`;
    const parts = splitMessage(text, 100);
    expect(parts).toEqual(['a'.repeat(60), `${'b'.repeat(60)}\n${'c'.repeat(30)}`]);
    expect(splitMessage('x'.repeat(250), 100)).toEqual([
      'x'.repeat(100),
      'x'.repeat(100),
      'x'.repeat(50),
    ]);
    expect(splitMessage('  ')).toEqual([]);
  });

  it('parses commands, with or without the bot mention', () => {
    expect(parseCommand('/agent@adk_bot  docs ')).toEqual({ name: 'agent', argument: 'docs' });
    expect(parseCommand('/NEW')).toEqual({ name: 'new', argument: '' });
    expect(parseCommand('hello /new')).toBeNull();
  });

  it('reads settings with safe defaults and picks the transport', () => {
    const defaults = readTelegramSettings({});
    expect(defaults).toMatchObject({ mode: 'auto', defaultAgentId: null, useKnowledge: true });
    expect(defaults.notify).toEqual({
      e2e: true,
      integration: true,
      load: true,
      onlyFailures: false,
    });
    expect(usesWebhook(defaults, 'https://api.example.com')).toBe(true);
    expect(usesWebhook(defaults, 'http://localhost:3000')).toBe(false);
    expect(usesWebhook(readTelegramSettings({ mode: 'polling' }), 'https://x')).toBe(false);
  });

  it('derives a stable webhook secret per workspace', () => {
    expect(webhookSecret('ws-1', KEY)).toBe(webhookSecret('ws-1', KEY));
    expect(webhookSecret('ws-1', KEY)).not.toBe(webhookSecret('ws-2', KEY));
    expect(webhookSecret('ws-1', KEY)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses tokens that are not in the BotFather format', () => {
    expect(() => new TelegramApi({ token: '../evil' })).toThrow('Invalid Telegram bot token.');
  });

  it('formats durations and run notifications', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(
      formatRunFinished(
        {
          workspaceId: 'w',
          kind: 'e2e',
          name: 'Checkout',
          status: 'failed',
          summary: '1/2 passed',
        },
        'https://adk.example.com/',
      ),
    ).toBe('❌ E2E · Checkout\n1/2 passed\nhttps://adk.example.com');
  });

  it('pairing codes work once', async () => {
    const pairing = new TelegramPairingCodes(new MemoryCacheStore());
    const { code } = await pairing.create({ workspaceId: 'w', workspaceName: 'W', actorId: 'u' });
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(await pairing.consume(code.toLowerCase())).toEqual({
      workspaceId: 'w',
      workspaceName: 'W',
      actorId: 'u',
    });
    expect(await pairing.consume(code)).toBeNull();
    expect(await pairing.consume('bad')).toBeNull();
  });
});

describe('TelegramBot', () => {
  it('only gives pairing help to chats that are not paired', async () => {
    const { bot, telegram, executeAgent } = setupBot();
    await bot.handle(message('hello'));
    await bot.handle(message('/agents'));
    expect(executeAgent).not.toHaveBeenCalled();
    expect(telegram.sent()).toHaveLength(2);
    expect(telegram.sent()[0]).toContain('/start CODE');
  });

  it('answers in Portuguese for Portuguese Telegram apps and refuses groups', async () => {
    const { bot, telegram } = setupBot();
    await bot.handle(message('oi', { from: { id: 7, first_name: 'Ana', language_code: 'pt-br' } }));
    await bot.handle(message('hi', { chat: { id: -5, type: 'group' } }));
    expect(telegram.sent()[0]).toContain('ainda não está conectado');
    expect(telegram.sent()[1]).toContain('private chats');
  });

  it('pairs a chat with a code of its workspace', async () => {
    const { chats, telegram } = await pairedBot();
    const [chat] = await chats.list('ws-1', 'telegram');
    expect(chat).toMatchObject({
      chatId: '42',
      userId: '7',
      displayName: 'Ana (@ana)',
      linkedBy: 'user-1',
      notifications: true,
    });
    expect(telegram.sent().at(-1)).toContain('Acme');
  });

  it('rejects codes of another workspace', async () => {
    const { bot, pairing, chats, telegram } = setupBot('ws-1');
    const { code } = await pairing.create({
      workspaceId: 'ws-2',
      workspaceName: 'B',
      actorId: 'u',
    });
    await bot.handle(message(`/start ${code}`));
    expect(await chats.list('ws-1', 'telegram')).toEqual([]);
    expect(telegram.sent()[0]).toContain('Invalid or expired code');
  });

  it('talks to the default agent with the conversation so far', async () => {
    const { bot, executeAgent, telegram } = await pairedBot();
    await bot.handle(message('first question', {}, 2));
    await bot.handle(message('second question', {}, 3));
    expect(executeAgent).toHaveBeenCalledTimes(2);
    const [workspaceId, agentId, input, context] = executeAgent.mock.calls[1] as unknown as [
      string,
      string,
      { prompt: string; includeKnowledge: boolean; knowledgeQuery: string },
      { ownerId: string; actorId: string },
    ];
    expect({ workspaceId, agentId }).toEqual({ workspaceId: 'ws-1', agentId: 'a1' });
    expect(input.prompt).toContain('first question');
    expect(input.prompt).toContain('answer from a1');
    expect(input.knowledgeQuery).toBe('second question');
    expect(input.includeKnowledge).toBe(true);
    expect(context).toMatchObject({ ownerId: 'ws-1', actorId: 'user-1' });
    expect(telegram.sent().at(-1)).toBe('answer from a1');
    expect(telegram.calls.some((call) => call.method === 'sendChatAction')).toBe(true);
  });

  it('switches agents, clears the history and toggles notifications', async () => {
    const { bot, executeAgent, chats, telegram } = await pairedBot();
    await bot.handle(message('/agents'));
    expect(telegram.sent().at(-1)).toContain('• qa: QA Agent');
    await bot.handle(message('/agent docs'));
    await bot.handle(message('question'));
    expect(executeAgent.mock.calls.at(-1)?.[1]).toBe('a2');
    await bot.handle(message('/agent nope'));
    expect(telegram.sent().at(-1)).toContain('There is no agent "nope"');
    await bot.handle(message('/agent default'));
    await bot.handle(message('/new'));
    await bot.handle(message('again'));
    const last = executeAgent.mock.calls.at(-1) as unknown as [string, string, { prompt: string }];
    expect(last[1]).toBe('a1');
    expect(last[2].prompt).toBe('again');
    await bot.handle(message('/notify off'));
    expect((await chats.list('ws-1', 'telegram'))[0]?.notifications).toBe(false);
    await bot.handle(message('/notify'));
    expect(telegram.sent().at(-1)).toContain('Now: off');
    await bot.handle(message('/whatever'));
    expect(telegram.sent().at(-1)).toContain('Unknown command');
    await bot.handle(message('/unlink'));
    expect(await chats.list('ws-1', 'telegram')).toEqual([]);
  });

  it('splits long answers and reports agent failures', async () => {
    const { bot, executeAgent, telegram } = await pairedBot();
    executeAgent.mockResolvedValueOnce({ result: 'y'.repeat(5000) });
    await bot.handle(message('long'));
    expect(
      telegram
        .sent()
        .slice(-2)
        .map((text) => text.length),
    ).toEqual([4096, 904]);
    executeAgent.mockRejectedValueOnce(new Error('no LLM configured'));
    await bot.handle(message('fail'));
    expect(telegram.sent().at(-1)).toBe('I could not answer: no LLM configured');
  });
});

describe('TelegramRunNotifier', () => {
  async function setup(settings: Record<string, unknown> = {}, isEnabled = true) {
    const telegram = fakeTelegram();
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws-1', 'MESSAGING', 'telegram', {
      isEnabled,
      settings,
      secret: TOKEN,
    });
    const chats = new InMemoryMessagingChatStore();
    const base = { workspaceId: 'ws-1', provider: 'telegram' as const, linkedBy: 'u' };
    await chats.link({ ...base, chatId: '1', userId: '1', displayName: 'A' });
    const muted = await chats.link({ ...base, chatId: '2', userId: '2', displayName: 'B' });
    await chats.update('ws-1', muted.id, { notifications: false });
    const notifier = new TelegramRunNotifier({ integrations, chats, fetch: telegram.fetcher });
    return { notifier, telegram };
  }
  const event = {
    workspaceId: 'ws-1',
    kind: 'integration' as const,
    name: 'Orders API',
    status: 'passed' as const,
    summary: '3/3 passed · 2s',
  };

  it('tells the chats that keep notifications on', async () => {
    const { notifier, telegram } = await setup();
    await notifier.runFinished(event);
    const sends = telegram.calls.filter((call) => call.method === 'sendMessage');
    expect(sends.map((call) => call.body['chat_id'])).toEqual(['1']);
    expect(String(sends[0]?.body['text'])).toContain('Integration Tests · Orders API');
  });

  it('follows the event switches and the integration state', async () => {
    const onlyFailures = await setup({ notify: { onlyFailures: true } });
    await onlyFailures.notifier.runFinished(event);
    await onlyFailures.notifier.runFinished({ ...event, status: 'failed' });
    expect(onlyFailures.telegram.sent()).toHaveLength(1);

    const noLoad = await setup({ notify: { load: false } });
    await noLoad.notifier.runFinished({ ...event, kind: 'load' });
    const disabled = await setup({}, false);
    await disabled.notifier.runFinished(event);
    expect([...noLoad.telegram.sent(), ...disabled.telegram.sent()]).toEqual([]);
  });

  it('never throws when Telegram fails', async () => {
    const { notifier } = await setup();
    const failing = new TelegramRunNotifier({
      integrations: (notifier as unknown as { options: TelegramRunNotifier['options'] }).options
        .integrations,
      chats: new InMemoryMessagingChatStore(),
      fetch: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    await expect(failing.runFinished(event)).resolves.toBeUndefined();
  });
});

describe('TelegramGateway', () => {
  async function setup(publicUrl?: string, settings: Record<string, unknown> = {}) {
    const telegram = fakeTelegram();
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws-1', 'MESSAGING', 'telegram', {
      isEnabled: true,
      settings,
      secret: TOKEN,
    });
    const chats = new InMemoryMessagingChatStore();
    const pairing = new TelegramPairingCodes(new MemoryCacheStore());
    const gateway = new TelegramGateway({
      integrations,
      chats,
      agents: {
        listAgents: vi.fn(async () => agents),
        executeAgent: vi.fn(async () => ({ result: 'hi' })),
      } as never,
      pairing,
      publicUrl,
      fetch: telegram.fetcher,
      encryptionKey: KEY,
      pollTimeoutSec: 1,
    });
    return { gateway, telegram, integrations, chats, pairing };
  }

  it('goes online even when Telegram refuses the command list', async () => {
    const { gateway, telegram } = await setup('http://localhost:3000');
    const fetcher = telegram.fetcher as unknown as ReturnType<typeof vi.fn>;
    const original = fetcher.getMockImplementation() as typeof fetch;
    fetcher.mockImplementation(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith('/setMyCommands')
        ? Response.json({ ok: false, description: 'denied' }, { status: 400 })
        : original(url, init),
    );
    await gateway.start();
    expect(gateway.status('ws-1')).toMatchObject({ running: true });
    await gateway.stop();
  });

  it('long-polls on a local install and answers the updates', async () => {
    const { gateway, telegram } = await setup('http://localhost:3000');
    telegram.batches.push([message('hello', {}, 10)]);
    await gateway.start();
    expect(gateway.status('ws-1')).toMatchObject({
      running: true,
      mode: 'polling',
      botUsername: 'adk_test_bot',
    });
    await vi.waitFor(() => expect(telegram.sent()).toHaveLength(1));
    expect(telegram.calls.map((call) => call.method)).toContain('deleteWebhook');
    expect(telegram.calls.find((call) => call.method === 'setMyCommands')).toBeDefined();
    await vi.waitFor(() =>
      expect(
        telegram.calls.filter((call) => call.method === 'getUpdates').at(-1)?.body['offset'],
      ).toBe(11),
    );
    await gateway.stop();
    expect(gateway.status('ws-1').running).toBe(false);
  });

  it('drops messages that waited too long while the bot was offline', async () => {
    const { gateway, telegram } = await setup();
    telegram.batches.push([message('old', { date: Math.floor(Date.now() / 1000) - 3600 })]);
    await gateway.start();
    await vi.waitFor(() =>
      expect(telegram.calls.filter((call) => call.method === 'getUpdates').length).toBe(2),
    );
    expect(telegram.sent()).toEqual([]);
    await gateway.stop();
  });

  it('registers a webhook behind HTTPS and checks its secret', async () => {
    const { gateway, telegram } = await setup('https://api.example.com/');
    await gateway.start();
    const setWebhook = telegram.calls.find((call) => call.method === 'setWebhook');
    expect(setWebhook?.body).toMatchObject({
      url: 'https://api.example.com/messaging/telegram/webhook/ws-1',
      secret_token: webhookSecret('ws-1', KEY),
    });
    expect(await gateway.receive('ws-1', 'wrong', message('hi'))).toBe(false);
    expect(await gateway.receive('ws-1', undefined, message('hi'))).toBe(false);
    expect(await gateway.receive('ws-1', webhookSecret('ws-1', KEY), message('hi'))).toBe(true);
    await vi.waitFor(() => expect(telegram.sent()).toHaveLength(1));
    await gateway.stop();
  });

  it('restarts or stops a bot when its integration changes', async () => {
    const { gateway, integrations, telegram } = await setup();
    await gateway.start();
    expect(gateway.status('ws-1').running).toBe(true);
    await integrations.saveIntegration('ws-1', 'MESSAGING', 'telegram', {
      isEnabled: false,
      settings: {},
    });
    await vi.waitFor(() => expect(gateway.status('ws-1').running).toBe(false));
    await integrations.deleteIntegration('ws-1', 'MESSAGING', 'telegram');
    expect(gateway.status('ws-1')).toEqual({
      running: false,
      mode: null,
      botUsername: null,
      error: null,
    });
    expect(telegram.calls.filter((call) => call.method === 'getMe')).toHaveLength(1);
    await gateway.stop();
  });

  it('reports a bot that cannot start', async () => {
    const { gateway } = await setup('http://localhost:3000', { mode: 'webhook' });
    await gateway.start();
    expect(gateway.status('ws-1')).toMatchObject({
      running: false,
      error: 'Webhook mode needs API_PUBLIC_URL to be an https:// address.',
    });
  });
});

describe('Messaging routes', () => {
  async function setup() {
    const telegram = fakeTelegram();
    const authService = new AuthService(new InMemoryAuthRepository());
    const integrationsService = new IntegrationsService(new InMemoryUserIntegrationStore());
    const messagingChats = new InMemoryMessagingChatStore();
    const telegramPairing = new TelegramPairingCodes(new MemoryCacheStore());
    const telegramGateway = new TelegramGateway({
      integrations: integrationsService,
      chats: messagingChats,
      agents: { listAgents: vi.fn(async () => []), executeAgent: vi.fn() },
      pairing: telegramPairing,
      fetch: telegram.fetcher,
      encryptionKey: KEY,
    });
    const app = createApp({
      authService,
      integrationsService,
      messagingChats,
      telegramGateway,
      telegramPairing,
    });
    const registered = await request(app).post('/auth/register').send({
      email: 'bot-owner@example.com',
      password: 'StrongPassword123!',
      name: 'Bot Owner',
    });
    const auth = { Authorization: `Bearer ${registered.body.token as string}` };
    const workspaces = await request(app).get('/workspaces').set(auth);
    const workspaceId = (workspaces.body as { workspace: { id: string } }[])[0]?.workspace.id ?? '';
    return { app, auth, workspaceId, telegramGateway, messagingChats, telegram };
  }

  it('pairs, lists, updates and removes chats', async () => {
    const { app, auth, workspaceId, telegramGateway, messagingChats } = await setup();
    await telegramGateway.start();

    const offline = await request(app)
      .post('/integrations/MESSAGING/telegram/pairing-code')
      .set(auth);
    expect(offline.status).toBe(409);
    expect(offline.body.code).toBe('TELEGRAM_BOT_OFFLINE');

    const saved = await request(app)
      .put('/integrations/MESSAGING/telegram')
      .set(auth)
      .send({ settings: { mode: 'polling' }, secret: TOKEN });
    expect(saved.status).toBe(200);
    await vi.waitFor(() => expect(telegramGateway.status(workspaceId).running).toBe(true));

    const pairing = await request(app)
      .post('/integrations/MESSAGING/telegram/pairing-code')
      .set(auth);
    expect(pairing.status).toBe(201);
    expect(pairing.body.deepLink).toBe(`https://t.me/adk_test_bot?start=${pairing.body.code}`);

    const chat = await messagingChats.link({
      workspaceId,
      provider: 'telegram',
      chatId: '42',
      userId: '7',
      displayName: 'Ana',
      linkedBy: 'u',
    });
    const listed = await request(app).get('/integrations/MESSAGING/telegram/chats').set(auth);
    expect(listed.body.status).toMatchObject({ running: true, mode: 'polling' });
    expect(listed.body.chats).toHaveLength(1);

    const patched = await request(app)
      .patch(`/integrations/MESSAGING/telegram/chats/${chat.id}`)
      .set(auth)
      .send({ notifications: false });
    expect(patched.body.chat.notifications).toBe(false);
    const invalid = await request(app)
      .patch(`/integrations/MESSAGING/telegram/chats/${chat.id}`)
      .set(auth)
      .send({ chatId: 'x' });
    expect(invalid.status).toBe(400);

    const removed = await request(app)
      .delete(`/integrations/MESSAGING/telegram/chats/${chat.id}`)
      .set(auth);
    expect(removed.body).toEqual({ deleted: true });
    const missing = await request(app)
      .delete(`/integrations/MESSAGING/telegram/chats/${chat.id}`)
      .set(auth);
    expect(missing.status).toBe(404);
    await telegramGateway.stop();
  });

  it('accepts webhook posts only with the secret', async () => {
    const { app, workspaceId } = await setup();
    const forbidden = await request(app)
      .post(`/messaging/telegram/webhook/${workspaceId}`)
      .send({ update_id: 1 });
    expect(forbidden.status).toBe(401);
    const accepted = await request(app)
      .post(`/messaging/telegram/webhook/${workspaceId}`)
      .set('X-Telegram-Bot-Api-Secret-Token', webhookSecret(workspaceId, KEY))
      .send({ update_id: 1 });
    expect(accepted.status).toBe(200);
  });

  it('checks a bot token through the integration test route', async () => {
    const { app, auth } = await setup();
    const result = await request(app)
      .post('/integrations/MESSAGING/telegram/test')
      .set(auth)
      .send({ secret: 'not a token' });
    expect(result.body).toMatchObject({ ok: false });
  });
});
