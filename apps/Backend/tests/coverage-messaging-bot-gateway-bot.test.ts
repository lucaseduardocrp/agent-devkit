import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomAgent } from '../src/modules/agents/domain/agent-entity.js';
import type { CliBridge } from '../src/modules/messaging/application/cli-bridge.js';
import type { McpConnector } from '../src/modules/messaging/application/mcp-connector.js';
import { InMemoryMessagingChatStore } from '../src/modules/messaging/application/messaging-chat-store.js';
import type { TelegramUpdate } from '../src/modules/messaging/telegram/telegram-api.js';
import { TelegramBot } from '../src/modules/messaging/telegram/telegram-bot.js';
import { TelegramPairingCodes } from '../src/modules/messaging/telegram/telegram-pairing.js';
import { readTelegramSettings } from '../src/modules/messaging/telegram/telegram-settings.js';
import { ApplicationError } from '../src/shared/errors.js';
import { MemoryCacheStore } from '../src/shared/cache.js';

type From = NonNullable<NonNullable<TelegramUpdate['message']>['from']>;

function update(
  text: string | undefined,
  overrides: Record<string, unknown> = {},
  from: Partial<From> | null = {},
  id = 1,
): TelegramUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' },
      ...(from === null
        ? {}
        : { from: { id: 7, first_name: 'Ana', username: 'ana', language_code: 'en', ...from } }),
      ...(text === undefined ? {} : { text }),
      ...overrides,
    },
  } as TelegramUpdate;
}

const agentList = [
  { id: 'a1', slug: 'qa', name: 'QA', isDefault: false },
  { id: 'a2', slug: 'docs', name: 'Docs', isDefault: true },
] as unknown as CustomAgent[];

function setup(
  options: {
    agents?: CustomAgent[];
    bridge?: CliBridge;
    mcp?: McpConnector;
    settings?: Record<string, unknown>;
    typingIntervalMs?: number;
    executeAgent?: (...args: unknown[]) => Promise<{ result: string }>;
    deleteMessage?: () => Promise<unknown>;
  } = {},
) {
  const sent: string[] = [];
  const api = {
    sendMessage: vi.fn(async (_chat: number | string, text: string) => {
      sent.push(text);
    }),
    sendTyping: vi.fn(async () => undefined),
    deleteMessage: vi.fn(options.deleteMessage ?? (async () => true)),
  };
  const chats = new InMemoryMessagingChatStore();
  const executeAgent = vi.fn(options.executeAgent ?? (async () => ({ result: 'ok' })));
  const bot = new TelegramBot({
    workspaceId: 'ws-1',
    api: api as never,
    chats,
    agents: {
      listAgents: vi.fn(async () => options.agents ?? agentList),
      executeAgent,
    } as never,
    pairing: new TelegramPairingCodes(new MemoryCacheStore()),
    settings: readTelegramSettings(options.settings ?? {}),
    bridge: options.bridge,
    mcp: options.mcp,
    typingIntervalMs: options.typingIntervalMs,
  });
  return { bot, api, chats, sent, executeAgent };
}

async function pair(chats: InMemoryMessagingChatStore, agentId: string | null = null) {
  const chat = await chats.link({
    workspaceId: 'ws-1',
    provider: 'telegram',
    chatId: '42',
    userId: '7',
    displayName: 'Ana',
    linkedBy: 'user-1',
  });
  if (agentId) await chats.update('ws-1', chat.id, { agentId });
  return (await chats.find('ws-1', 'telegram', '42'))!;
}

function fakeBridge(clis: string[] = ['claude']) {
  return {
    listClis: vi.fn(async () => clis),
    forward: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('TelegramBot edge cases', () => {
  it('ignores updates without a human sender', async () => {
    const { bot, sent } = setup();
    await bot.handle({ update_id: 1 });
    await bot.handle(update('hi', {}, null));
    await bot.handle(update('hi', {}, { is_bot: true }));
    expect(sent).toEqual([]);
  });

  it('rejects an unknown pairing code and a /start without a code is the help', async () => {
    const { bot, chats, sent } = setup();
    await bot.handle(update('/start nope'));
    expect(sent).toHaveLength(1);
    await pair(chats);
    await bot.handle(update('/start'));
    await bot.handle(update('/help'));
    expect(sent).toHaveLength(3);
    expect(sent[1]).toBe(sent[2]);
  });

  it('names the linked user from whatever the profile has', async () => {
    const names: string[] = [];
    for (const from of [
      { first_name: 'Ana', last_name: 'Lima', username: 'ana' },
      { first_name: 'Ana', last_name: undefined, username: undefined },
      { first_name: '', last_name: undefined, username: 'only' },
      { first_name: '', last_name: undefined, username: undefined },
    ]) {
      const { bot, chats } = setup();
      const pairing = (bot as unknown as { options: { pairing: TelegramPairingCodes } }).options
        .pairing;
      const { code } = await pairing.create({
        workspaceId: 'ws-1',
        workspaceName: 'Acme',
        actorId: 'u',
      });
      await bot.handle(update(`/start ${code}`, {}, from as Partial<From>));
      names.push((await chats.find('ws-1', 'telegram', '42'))!.displayName);
    }
    expect(names).toEqual(['Ana Lima (@ana)', 'Ana', '@only', '7']);
  });

  it('deletes /auth with a key and /mcp add, even when deleting fails', async () => {
    const bridge = fakeBridge();
    const { bot, chats, api } = setup({
      bridge,
      deleteMessage: async () => {
        throw new Error('cannot delete');
      },
    });
    await pair(chats);
    await bot.handle(update('/auth sk-secret'));
    await bot.handle(update('/mcp add x https://x tok'));
    await bot.handle(update('/auth'));
    await bot.handle(update('/mcp list'));
    expect(api.deleteMessage).toHaveBeenCalledTimes(2);
    expect(
      (bridge.forward.mock.calls as unknown as [{ text: string }][]).map((call) => call[0].text),
    ).toEqual(['/auth sk-secret', '/mcp add x https://x tok', '/auth', '/mcp list']);
  });

  it('answers messages without text, and sends cli-mode text to the bridge', async () => {
    const bridge = fakeBridge();
    const { bot, chats, sent } = setup({ bridge });
    await pair(chats, 'cli:claude');
    await bot.handle(update(undefined));
    expect(sent).toHaveLength(1);
    await bot.handle(update('hello cli'));
    expect(bridge.forward).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello cli', chatId: '42', memberId: 'user-1' }),
    );
  });

  it('/new clears history and forwards to the bridge in cli mode', async () => {
    const bridge = fakeBridge();
    const { bot, chats, sent } = setup({ bridge });
    const chat = await pair(chats);
    await bot.handle(update('/new'));
    expect(sent).toHaveLength(1);
    await chats.update('ws-1', chat.id, { agentId: 'cli:claude' });
    await bot.handle(update('/new'));
    expect(bridge.forward).toHaveBeenCalledWith(expect.objectContaining({ text: '/new' }));
  });

  it('/agents lists agents marking the current one, or says there are none', async () => {
    const { bot, chats, sent } = setup();
    await pair(chats);
    await bot.handle(update('/agents'));
    expect(sent[0]).toContain('◦ qa: QA');
    expect(sent[0]).toContain('• docs: Docs');
    const empty = setup({ agents: [] });
    await pair(empty.chats);
    await empty.bot.handle(update('/agents'));
    expect(empty.sent).toHaveLength(1);
    expect(empty.sent[0]).not.toContain(':');
  });

  it('/agent shows the current agent, resets, rejects unknown slugs and switches', async () => {
    const { bot, chats, sent } = setup();
    const chat = await pair(chats);
    await bot.handle(update('/agent'));
    expect(sent[0]).toContain('Docs (docs)');
    await bot.handle(update('/agent qa'));
    expect((await chats.find('ws-1', 'telegram', '42'))!.agentId).toBe('a1');
    await bot.handle(update('/agent padrão'));
    expect((await chats.find('ws-1', 'telegram', '42'))!.agentId).toBeNull();
    await bot.handle(update('/agent nope'));
    expect(sent.at(-1)).toContain('nope');
    expect(chat.id).toBeTruthy();
    const empty = setup({ agents: [] });
    await pair(empty.chats);
    await empty.bot.handle(update('/agent'));
    expect(empty.sent).toHaveLength(1);
  });

  it('/notify explains usage with the current state and toggles', async () => {
    const { bot, chats, sent } = setup();
    const chat = await pair(chats);
    await bot.handle(update('/notify maybe'));
    await chats.update('ws-1', chat.id, { notifications: false });
    await bot.handle(update('/notify'));
    expect(sent[0]).not.toBe(sent[1]);
    await bot.handle(update('/notify on'));
    await bot.handle(update('/notify off'));
    expect(sent[2]).not.toBe(sent[3]);
    expect((await chats.find('ws-1', 'telegram', '42'))!.notifications).toBe(false);
  });

  it('/unlink removes the chat; bridge commands are forwarded, others unknown', async () => {
    const bridge = fakeBridge();
    const { bot, chats, sent } = setup({ bridge });
    await pair(chats);
    await bot.handle(update('/status'));
    await bot.handle(update('/tasks now'));
    await bot.handle(update('/bogus'));
    expect(
      (bridge.forward.mock.calls as unknown as [{ text: string }][]).map((call) => call[0].text),
    ).toEqual(['/status', '/tasks now']);
    expect(sent).toHaveLength(1);
    await bot.handle(update('/unlink'));
    expect(await chats.find('ws-1', 'telegram', '42')).toBeNull();
    expect(sent).toHaveLength(2);
  });

  it('bridge commands say so when there is no bridge, and report bridge failures', async () => {
    const off = setup();
    await pair(off.chats);
    await off.bot.handle(update('/status'));
    await off.bot.handle(update('/cli'));
    await off.bot.handle(update('/mcp'));
    expect(off.sent).toHaveLength(3);
    expect(new Set(off.sent).size).toBe(1);

    const bridge = {
      listClis: vi.fn(async () => ['claude']),
      forward: vi.fn(async () => {
        throw new Error('bridge down');
      }),
    };
    const failing = setup({ bridge });
    await pair(failing.chats);
    await failing.bot.handle(update('/status'));
    expect(failing.sent[0]).toContain('bridge down');
    const stringy = setup({
      bridge: {
        listClis: async () => ['claude'],
        forward: async () => Promise.reject('plain failure'),
      },
    });
    await pair(stringy.chats);
    await stringy.bot.handle(update('/status'));
    expect(stringy.sent[0]).toContain('plain failure');
  });

  it('/cli lists, rejects unknown CLIs, switches and reports failures', async () => {
    const bridge = fakeBridge(['claude', 'codex']);
    const { bot, chats, sent } = setup({ bridge });
    await pair(chats);
    await bot.handle(update('/cli'));
    expect(bridge.forward).toHaveBeenLastCalledWith(expect.objectContaining({ text: '/cli' }));
    await bot.handle(update('/cli gemini'));
    expect(sent[0]).toContain('claude, codex');
    await bot.handle(update('/cli CODEX'));
    expect((await chats.find('ws-1', 'telegram', '42'))!.agentId).toBe('cli:codex');
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/cli codex' }),
    );
    expect(sent).toHaveLength(2);

    const broken = setup({
      bridge: {
        listClis: async () => {
          throw new Error('no list');
        },
        forward: async () => undefined,
      },
    });
    await pair(broken.chats);
    await broken.bot.handle(update('/cli claude'));
    expect(broken.sent[0]).toContain('no list');
  });

  it('/mcp adk issues a token for the member, scoped, and keeps other subcommands for the bridge', async () => {
    const bridge = fakeBridge();
    const mcp = { url: 'https://api/mcp', issueToken: vi.fn(async () => 'tok-1') };
    const { bot, chats, sent } = setup({ bridge, mcp });
    await pair(chats);
    await bot.handle(update('/mcp adk'));
    await bot.handle(update('/mcp ADK read'));
    expect(mcp.issueToken.mock.calls).toEqual([
      ['user-1', 'full'],
      ['user-1', 'read'],
    ]);
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/mcp add adk https://api/mcp tok-1' }),
    );
    await bot.handle(update('/mcp remove adk'));
    expect(bridge.forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: '/mcp remove adk' }),
    );
    expect(sent).toEqual([]);
  });

  it('/mcp adk reports a missing connector and token failures', async () => {
    const noMcp = setup({ bridge: fakeBridge() });
    await pair(noMcp.chats);
    await noMcp.bot.handle(update('/mcp adk'));
    expect(noMcp.sent).toHaveLength(1);

    for (const failure of [new Error('token boom'), 'plain boom']) {
      const mcp = {
        url: 'u',
        issueToken: async () => {
          throw failure;
        },
      };
      const { bot, chats, sent } = setup({ bridge: fakeBridge(), mcp });
      await pair(chats);
      await bot.handle(update('/mcp adk'));
      expect(sent[0]).toContain(failure instanceof Error ? failure.message : failure);
    }
  });

  it('talks to the integration default agent and keeps the history bounded', async () => {
    const { bot, chats, sent, executeAgent } = setup({
      settings: { defaultAgentId: 'a1', useKnowledge: false },
      executeAgent: async () => ({ result: 'x'.repeat(3000) }),
    });
    await pair(chats);
    await bot.handle(update('first'));
    for (let i = 2; i <= 8; i++) await bot.handle(update(`question ${i}`, {}, {}, i));
    expect(executeAgent.mock.calls[0]![1]).toBe('a1');
    expect(executeAgent.mock.calls[0]![2]).toMatchObject({
      prompt: 'first',
      knowledgeQuery: 'first',
      includeKnowledge: false,
    });
    const lastPrompt = (executeAgent.mock.calls.at(-1)![2] as { prompt: string }).prompt;
    expect(lastPrompt).toContain('Conversa temporária:');
    expect(lastPrompt).not.toContain('Usuário: first');
    expect(lastPrompt).toContain('Assistente: ' + 'x'.repeat(2000));
    expect(lastPrompt).not.toContain('x'.repeat(2001));
    expect(sent.length).toBeGreaterThan(7);
  });

  it('falls back to the first agent when none is the default', async () => {
    const agents = [
      { id: 'a9', slug: 'z', name: 'Z', isDefault: false },
      { id: 'a8', slug: 'y', name: 'Y', isDefault: false },
    ] as unknown as CustomAgent[];
    const { bot, chats, executeAgent } = setup({ agents });
    await pair(chats, 'ghost');
    await bot.handle(update('hi'));
    expect(executeAgent.mock.calls[0]![1]).toBe('a9');
  });

  it('says so when there is no agent, and when the agent answers nothing', async () => {
    const none = setup({ agents: [] });
    await pair(none.chats);
    await none.bot.handle(update('hi'));
    expect(none.sent).toHaveLength(1);
    expect(none.executeAgent).not.toHaveBeenCalled();

    const blank = setup({ executeAgent: async () => ({ result: '   ' }) });
    await pair(blank.chats);
    await blank.bot.handle(update('hi'));
    expect(blank.sent).toHaveLength(1);
    expect(blank.sent[0]!.trim()).not.toBe('');
  });

  it('translates application errors and reports other failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cases: [unknown, string][] = [
      [new ApplicationError('SOME_CODE', 'technical text'), 'technical text'],
      [new Error('plain error'), 'plain error'],
      ['string failure', 'string failure'],
    ];
    for (const [failure, expected] of cases) {
      const { bot, chats, sent } = setup({
        executeAgent: async () => {
          throw failure;
        },
      });
      await pair(chats);
      await bot.handle(update('hi'));
      expect(sent[0]).toContain(expected);
    }
  });

  it('keeps "typing" alive while the agent works', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const { bot, chats, api } = setup({
      typingIntervalMs: 10,
      executeAgent: () =>
        new Promise((resolve) => {
          release = () => resolve({ result: 'done' });
        }),
    });
    await pair(chats);
    api.sendTyping.mockRejectedValue(new Error('typing failed'));
    const handled = bot.handle(update('hi'));
    await vi.advanceTimersByTimeAsync(35);
    expect(api.sendTyping.mock.calls.length).toBeGreaterThanOrEqual(3);
    release();
    await handled;
    const calls = api.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50);
    expect(api.sendTyping.mock.calls.length).toBe(calls);
  });

  it('uses the default typing interval when none is given', async () => {
    const { bot, chats, api } = setup();
    await pair(chats);
    await bot.handle(update('hi'));
    expect(api.sendTyping).toHaveBeenCalledTimes(1);
  });
});
