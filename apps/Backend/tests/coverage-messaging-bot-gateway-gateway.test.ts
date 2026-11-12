import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomAgent } from '../src/modules/agents/domain/agent-entity.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import { InMemoryMessagingChatStore } from '../src/modules/messaging/application/messaging-chat-store.js';
import type { TelegramUpdate } from '../src/modules/messaging/telegram/telegram-api.js';
import { TelegramGateway } from '../src/modules/messaging/telegram/telegram-gateway.js';
import { TelegramPairingCodes } from '../src/modules/messaging/telegram/telegram-pairing.js';
import { webhookSecret } from '../src/modules/messaging/telegram/telegram-settings.js';
import { MemoryCacheStore } from '../src/shared/cache.js';

const TOKEN = '123456:ABC-def_ghi';
const KEY = Buffer.alloc(32, 9);

type Step =
  | 'hang'
  | 'hang-reject'
  | { status: number; description?: string; retryAfter?: number }
  | { throws: unknown }
  | TelegramUpdate[];

/** A Bot API double whose getUpdates answers follow a script. */
function scriptedTelegram(script: Step[] = [], username: string | null = 'bot') {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const queue = [...script];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === 'getMe')
      return Response.json({
        ok: true,
        result: username === null ? { id: 1 } : { id: 1, username },
      });
    if (method !== 'getUpdates') return Response.json({ ok: true, result: true });
    const step = queue.shift() ?? 'hang';
    if (step === 'hang' || step === 'hang-reject') {
      await new Promise<void>((resolve, reject) => {
        const finish = () => (step === 'hang' ? resolve() : reject(new Error('aborted')));
        if (init?.signal?.aborted) finish();
        init?.signal?.addEventListener('abort', finish);
      });
      return Response.json({ ok: true, result: [] });
    }
    if (Array.isArray(step)) return Response.json({ ok: true, result: step });
    if ('throws' in step) throw step.throws;
    return Response.json(
      {
        ok: false,
        description: step.description,
        parameters: step.retryAfter ? { retry_after: step.retryAfter } : undefined,
      },
      { status: step.status },
    );
  });
  const sent = () =>
    calls.filter((call) => call.method === 'sendMessage').map((call) => String(call.body['text']));
  return { fetcher: fetcher as unknown as typeof fetch, calls, sent };
}

function update(text: string, overrides: Record<string, unknown> = {}, id = 1): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' },
      from: { id: 7, first_name: 'Ana', language_code: 'en' },
      text,
      ...overrides,
    },
  } as TelegramUpdate;
}

const agents = [{ id: 'a1', slug: 'qa', name: 'QA', isDefault: true }] as unknown as CustomAgent[];

async function setup(
  script: Step[] = [],
  options: {
    publicUrl?: string;
    settings?: Record<string, unknown>;
    username?: string | null;
    secret?: string | null;
    enabled?: boolean;
    saved?: boolean;
    chats?: InMemoryMessagingChatStore;
  } = {},
) {
  const telegram = scriptedTelegram(
    script,
    options.username === undefined ? 'bot' : options.username,
  );
  const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
  if (options.saved !== false)
    await integrations.saveIntegration('ws-1', 'MESSAGING', 'telegram', {
      isEnabled: options.enabled ?? true,
      settings: options.settings ?? {},
      ...(options.secret === null ? {} : { secret: options.secret ?? TOKEN }),
    });
  const chats = options.chats ?? new InMemoryMessagingChatStore();
  const gateway = new TelegramGateway({
    integrations,
    chats,
    agents: {
      listAgents: vi.fn(async () => agents),
      executeAgent: vi.fn(async () => ({ result: 'hi' })),
    } as never,
    pairing: new TelegramPairingCodes(new MemoryCacheStore()),
    publicUrl: options.publicUrl,
    fetch: telegram.fetcher,
    encryptionKey: KEY,
    pollTimeoutSec: 1,
  });
  return { gateway, telegram, integrations, chats };
}

async function pairChat(chats: InMemoryMessagingChatStore) {
  await chats.link({
    workspaceId: 'ws-1',
    provider: 'telegram',
    chatId: '42',
    userId: '7',
    displayName: 'Ana',
    linkedBy: 'u',
  });
}

const polls = (telegram: { calls: { method: string }[] }) =>
  telegram.calls.filter((call) => call.method === 'getUpdates').length;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TelegramGateway edge cases', () => {
  it('sends and shows typing only through a running bot', async () => {
    const { gateway, telegram } = await setup([], { publicUrl: 'https://api.example.com' });
    expect(await gateway.sendToChat('ws-1', '42', 'x')).toBe(false);
    expect(await gateway.typingInChat('ws-1', '42')).toBe(false);
    await gateway.start();
    expect(await gateway.sendToChat('ws-1', '42', 'hello')).toBe(true);
    expect(await gateway.typingInChat('ws-1', '42')).toBe(true);
    expect(telegram.sent()).toEqual(['hello']);
    expect(telegram.calls.some((call) => call.method === 'sendChatAction')).toBe(true);
    await gateway.stop();
  });

  it('skips disabled integrations, missing ones and tokenless ones', async () => {
    const disabled = await setup([], { enabled: false });
    await disabled.gateway.start();
    expect(disabled.telegram.calls).toEqual([]);
    expect(disabled.gateway.status('ws-1').running).toBe(false);

    const none = await setup([], { saved: false });
    await none.gateway.sync('ws-1');
    expect(none.gateway.status('ws-1').error).toBeNull();

    const tokenless = await setup([], { secret: null });
    await tokenless.gateway.sync('ws-1');
    expect(tokenless.telegram.calls).toEqual([]);
  });

  it('ignores integration changes of other providers and does not restart after stop', async () => {
    const { gateway, integrations, telegram } = await setup();
    await gateway.start();
    await integrations.saveIntegration('ws-1', 'MESSAGING', 'other', {
      isEnabled: true,
      settings: {},
      secret: TOKEN,
    });
    expect(telegram.calls.filter((call) => call.method === 'getMe')).toHaveLength(1);
    await gateway.stop();
    await gateway.sync('ws-1');
    expect(gateway.status('ws-1').running).toBe(false);
    expect(telegram.calls.filter((call) => call.method === 'getMe')).toHaveLength(1);
  });

  it('serializes syncs and reports failures that are not Errors', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { gateway, telegram } = await setup([], { username: null });
    const first = gateway.sync('ws-1');
    const second = gateway.sync('ws-1');
    await Promise.all([first, second]);
    expect(gateway.status('ws-1')).toMatchObject({ running: true, botUsername: null });
    expect(telegram.calls.filter((call) => call.method === 'getMe')).toHaveLength(2);
    await gateway.stop();

    const broken = await setup();
    const original = broken.telegram.fetcher;
    (broken.gateway as unknown as { options: { fetch: typeof fetch } }).options = {
      ...(broken.gateway as unknown as { options: object }).options,
      fetch: (async () => {
        throw 'network down';
      }) as unknown as typeof fetch,
    };
    expect(original).toBeDefined();
    await broken.gateway.sync('ws-1');
    expect(broken.gateway.status('ws-1').error).toBe('network down');
  });

  it('handles webhook deliveries: other instance start, bad bodies, polling bots, old messages', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const secret = webhookSecret('ws-1', KEY);
    const { gateway, telegram, chats } = await setup([], { publicUrl: 'https://api.example.com' });
    await pairChat(chats);
    // Not started here yet: the first delivery starts it.
    expect(await gateway.receive('ws-1', secret, 'not an update')).toBe(true);
    expect(gateway.status('ws-1').mode).toBe('webhook');
    expect(await gateway.receive('ws-1', secret, null)).toBe(true);
    expect(await gateway.receive('ws-1', secret, { update_id: 'x' })).toBe(true);
    expect(await gateway.receive('ws-1', secret, { update_id: 2 })).toBe(true);
    const old = update('old', { date: Math.floor(Date.now() / 1000) - 3600 }, 3);
    expect(await gateway.receive('ws-1', secret, old)).toBe(true);
    expect(telegram.sent()).toEqual([]);
    // A wrong-length secret is rejected without comparing bytes.
    expect(await gateway.receive('ws-1', 'short', update('hi'))).toBe(false);
    // Two messages of one chat are answered in order.
    expect(await gateway.receive('ws-1', secret, update('one', {}, 4))).toBe(true);
    expect(await gateway.receive('ws-1', secret, update('two', {}, 5))).toBe(true);
    await vi.waitFor(() => expect(telegram.sent()).toHaveLength(2));
    await gateway.stop();

    const polling = await setup([], { publicUrl: 'http://localhost:3000' });
    expect(await polling.gateway.receive('ws-1', secret, update('ignored in polling mode'))).toBe(
      true,
    );
    expect(polling.telegram.sent()).toEqual([]);
    await polling.gateway.stop();
  });

  it('logs a message that cannot be handled and keeps going', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const chats = new InMemoryMessagingChatStore();
    vi.spyOn(chats, 'find').mockRejectedValue(new Error('db down'));
    const { gateway } = await setup([], { publicUrl: 'https://api.example.com', chats });
    await gateway.start();
    await gateway.receive('ws-1', webhookSecret('ws-1', KEY), update('hi'));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[Telegram] Could not handle a message:',
        expect.any(Error),
      ),
    );
    await gateway.stop();
  });

  it('ignores polled updates without a message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { gateway, telegram } = await setup([[{ update_id: 5 } as TelegramUpdate]]);
    await gateway.start();
    await vi.waitFor(() => expect(polls(telegram)).toBe(2));
    expect(
      telegram.calls.filter((call) => call.method === 'getUpdates').at(-1)?.body['offset'],
    ).toBe(6);
    await gateway.stop();
  });

  it('stops polling for good when the token was revoked', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const status of [401, 404]) {
      const { gateway, telegram } = await setup([{ status, description: 'Unauthorized' }]);
      await gateway.start();
      await vi.waitFor(() => expect(gateway.status('ws-1').error).toBe('Unauthorized'));
      expect(polls(telegram)).toBe(1);
      expect(gateway.status('ws-1').running).toBe(false);
      await gateway.stop();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('was revoked'));
  });

  it('does not report an error for a poll aborted by stop', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { gateway, telegram } = await setup(['hang-reject']);
    await gateway.start();
    await vi.waitFor(() => expect(polls(telegram)).toBe(1));
    await gateway.stop();
    expect(gateway.status('ws-1').error).toBeNull();
  });

  it('backs off between failures, honoring 409 and retry_after', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { gateway, telegram } = await setup([
      { status: 409, description: 'conflict' },
      { status: 409, description: 'conflict' },
      { status: 429, description: 'slow down', retryAfter: 2 },
      { status: 500, description: 'boom' },
      { throws: 'socket closed' },
      [],
    ]);
    await gateway.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls(telegram)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // 409 -> 30 s.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(polls(telegram)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls(telegram)).toBe(2);
    // second 409 does not warn again; still 30 s.
    expect(warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls(telegram)).toBe(3);
    // retry_after 2 s.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(polls(telegram)).toBe(4);
    // exponential: failures=3 -> 8 s.
    await vi.advanceTimersByTimeAsync(7_999);
    expect(polls(telegram)).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls(telegram)).toBe(5);
    expect(gateway.status('ws-1').error).toBe('socket closed');
    // failures=4 -> 16 s, then success clears the error.
    await vi.advanceTimersByTimeAsync(16_000);
    expect(polls(telegram)).toBe(7);
    expect(gateway.status('ws-1')).toMatchObject({ running: true, error: null });
    await gateway.stop();
  });

  it('wakes a sleeping poller when the bot is stopped', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { gateway, telegram } = await setup([{ status: 500, description: 'boom' }]);
    await gateway.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(polls(telegram)).toBe(1);
    await gateway.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(polls(telegram)).toBe(1);
  });
});
