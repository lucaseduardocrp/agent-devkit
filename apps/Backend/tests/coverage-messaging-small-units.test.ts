import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryCacheStore } from '../src/shared/cache.js';
import { HttpCliBridge } from '../src/modules/messaging/application/cli-bridge.js';
import { InMemoryMessagingChatStore } from '../src/modules/messaging/application/messaging-chat-store.js';
import { TelegramRunNotifier } from '../src/modules/messaging/application/run-notifier.js';
import { TelegramApi, TelegramApiError } from '../src/modules/messaging/telegram/telegram-api.js';
import { telegramText } from '../src/modules/messaging/telegram/telegram-messages.js';
import { TelegramPairingCodes } from '../src/modules/messaging/telegram/telegram-pairing.js';
import { readTelegramSettings } from '../src/modules/messaging/telegram/telegram-settings.js';

const TOKEN = '123456:ABC-def';
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

afterEach(() => vi.restoreAllMocks());

describe('HttpCliBridge.listClis', () => {
  it('returns an empty list when the Bridge sends no clis array', async () => {
    const bridge = new HttpCliBridge({
      url: 'http://bridge/',
      token: 't',
      fetch: () => json({ clis: 'nope' }),
    });
    expect(await bridge.listClis()).toEqual([]);
  });
});

describe('TelegramApi errors', () => {
  it('throws TelegramApiError with Telegram description and retry_after', async () => {
    const api = new TelegramApi({
      token: TOKEN,
      fetch: () =>
        json({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } }, 429),
    });
    const error = (await api.getMe().catch((e: unknown) => e)) as TelegramApiError;
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(error).toMatchObject({ message: 'Too Many Requests', status: 429, retryAfterSec: 7 });
    expect(error.name).toBe('TelegramApiError');
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    const api = new TelegramApi({
      token: TOKEN,
      fetch: () => Promise.resolve(new Response('bad gateway', { status: 502 })),
    });
    await expect(api.getMe()).rejects.toMatchObject({
      message: 'Telegram returned 502.',
      status: 502,
    });
  });

  it('posts each helper method to its endpoint', async () => {
    const urls: string[] = [];
    const api = new TelegramApi({
      token: TOKEN,
      baseUrl: 'http://tg/',
      fetch: (url) => {
        urls.push(String(url));
        return json({ ok: true, result: true });
      },
    });
    await api.getUpdates(1, 5);
    await api.sendMessage(1, 'hi');
    await api.deleteMessage(1, 2);
    await api.sendTyping(1);
    await api.setWebhook('http://x', 's');
    await api.deleteWebhook();
    await api.setMyCommands([{ command: 'a', description: 'b' }]);
    expect(urls.map((u) => u.split('/').pop())).toEqual([
      'getUpdates',
      'sendMessage',
      'deleteMessage',
      'sendChatAction',
      'setWebhook',
      'deleteWebhook',
      'setMyCommands',
    ]);
  });
});

describe('telegramText', () => {
  it('leaves unknown placeholders untouched', () => {
    const text = telegramText('en-US', 'agentSet');
    expect(text).toContain('{agent}');
  });
});

describe('TelegramPairingCodes', () => {
  it('returns null when the stored grant is not valid JSON', async () => {
    const store = new MemoryCacheStore();
    await store.set('telegram:pairing:ABCDEFGH', '{not json', 60);
    expect(await new TelegramPairingCodes(store).consume('abcdefgh')).toBeNull();
  });
});

describe('readTelegramSettings', () => {
  it('reads explicit values and defaults', () => {
    expect(readTelegramSettings({})).toMatchObject({
      mode: 'auto',
      defaultAgentId: null,
      useKnowledge: true,
    });
    expect(
      readTelegramSettings({
        mode: 'webhook',
        defaultAgentId: '  a1 ',
        useKnowledge: false,
        notify: { e2e: false, onlyFailures: true },
      }),
    ).toMatchObject({
      mode: 'webhook',
      defaultAgentId: 'a1',
      useKnowledge: false,
      notify: { e2e: false, integration: true, load: true, onlyFailures: true },
    });
    expect(readTelegramSettings({ mode: 'polling', defaultAgentId: '  ' }).mode).toBe('polling');
    expect(readTelegramSettings({ defaultAgentId: '  ' }).defaultAgentId).toBeNull();
  });
});

describe('TelegramRunNotifier delivery failures', () => {
  it('warns when some notifications are not delivered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const chats = new InMemoryMessagingChatStore();
    await chats.link({
      workspaceId: 'w',
      provider: 'telegram',
      chatId: '1',
      userId: 'u',
      displayName: 'A',
      linkedBy: 'm',
    });
    const notifier = new TelegramRunNotifier({
      chats,
      integrations: {
        getIntegration: () => Promise.resolve({ isEnabled: true, settings: {} }),
        getDecryptedSecret: () => Promise.resolve(TOKEN),
      } as never,
      fetch: () => json({ ok: false, description: 'blocked' }, 403),
    });
    await notifier.runFinished({
      workspaceId: 'w',
      kind: 'e2e',
      name: 'n',
      status: 'failed',
      summary: 's',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('1 of 1 notification(s) were not delivered'),
      expect.any(TelegramApiError),
    );
  });
});

describe('default fetch and notifier catch', () => {
  it('uses the global fetch when none is injected', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => json({ ok: true, result: { id: 1 }, clis: ['a'] }));
    expect(await new HttpCliBridge({ url: 'http://b', token: 't' }).listClis()).toEqual(['a']);
    expect(await new TelegramApi({ token: TOKEN }).getMe()).toEqual({ id: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never throws when the integration lookup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notifier = new TelegramRunNotifier({
      chats: new InMemoryMessagingChatStore(),
      integrations: {
        getIntegration: () => Promise.reject(new Error('db down')),
        getDecryptedSecret: () => Promise.resolve(null),
      } as never,
    });
    await expect(
      notifier.runFinished({
        workspaceId: 'w',
        kind: 'load',
        name: 'n',
        status: 'error',
        summary: '',
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[Telegram] Could not send the run notification:',
      expect.any(Error),
    );
  });
});

describe('TelegramRunNotifier early returns', () => {
  const event = {
    workspaceId: 'w',
    kind: 'e2e' as const,
    name: 'n',
    status: 'passed' as const,
    summary: 's',
  };

  async function run(integration: unknown, secret: string | null, withChat = true) {
    const chats = new InMemoryMessagingChatStore();
    if (withChat)
      await chats.link({
        workspaceId: 'w',
        provider: 'telegram',
        chatId: '1',
        userId: 'u',
        displayName: 'A',
        linkedBy: 'm',
      });
    const fetcher = vi.fn(() => json({ ok: true, result: true }));
    await new TelegramRunNotifier({
      chats,
      fetch: fetcher as never,
      integrations: {
        getIntegration: () => Promise.resolve(integration),
        getDecryptedSecret: () => Promise.resolve(secret),
      } as never,
    }).runFinished(event);
    return fetcher;
  }

  it('sends nothing when disabled, filtered, without chats or without a token', async () => {
    expect(await run(null, TOKEN)).not.toHaveBeenCalled();
    expect(await run({ isEnabled: false, settings: {} }, TOKEN)).not.toHaveBeenCalled();
    expect(
      await run({ isEnabled: true, settings: { notify: { onlyFailures: true } } }, TOKEN),
    ).not.toHaveBeenCalled();
    expect(await run({ isEnabled: true, settings: {} }, TOKEN, false)).not.toHaveBeenCalled();
    expect(await run({ isEnabled: true, settings: {} }, null)).not.toHaveBeenCalled();
    expect(await run({ isEnabled: true, settings: {} }, TOKEN)).toHaveBeenCalledTimes(1);
  });
});
