import type { AgentService } from '../../agents/application/agent-service.js';
import type { CustomAgent } from '../../agents/domain/agent-entity.js';
import type { SupportedLocale } from '../../../shared/i18n.js';
import { translateErrorMessage } from '../../../shared/i18n.js';
import { ApplicationError } from '../../../shared/errors.js';
import type { CliBridge } from '../application/cli-bridge.js';
import type { McpConnector } from '../application/mcp-connector.js';
import type { MessagingChat, MessagingChatStore } from '../application/messaging-chat-store.js';
import { splitMessage, type TelegramApi, type TelegramMessage } from './telegram-api.js';
import type { TelegramUpdate } from './telegram-api.js';
import { telegramLocale, telegramText, type TelegramMessageKey } from './telegram-messages.js';
import type { TelegramPairingCodes } from './telegram-pairing.js';
import { TELEGRAM_PROVIDER_ID, type TelegramSettings } from './telegram-settings.js';

export interface TelegramBotOptions {
  readonly workspaceId: string;
  readonly api: Pick<TelegramApi, 'sendMessage' | 'sendTyping' | 'deleteMessage'>;
  readonly chats: MessagingChatStore;
  readonly agents: Pick<AgentService, 'listAgents' | 'executeAgent'>;
  readonly pairing: TelegramPairingCodes;
  readonly settings: TelegramSettings;
  /** The AI CLIs (apps/Bridge); without it the /cli commands say so. */
  readonly bridge?: CliBridge;
  /** The ADK MCP server, for `/mcp adk`; without it that command says so. */
  readonly mcp?: McpConnector;
  /** How often "typing…" is refreshed while the agent works (Telegram shows it for ~5 s). */
  readonly typingIntervalMs?: number;
}

interface Turn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * A chat whose `agentId` is `cli:<id>` talks to that AI CLI through the Bridge instead of an ADK
 * agent; `/agent` switches back. The column is plain text, so this needs no migration.
 */
const CLI_PREFIX = 'cli:';
/** Commands the Bridge answers itself, in any chat. */
const BRIDGE_COMMANDS = new Set([
  'clis',
  'mode',
  'cancel',
  'status',
  'schedule',
  'tasks',
  'unschedule',
  'auth',
  'logout',
]);

/** Turns kept per chat for context; /new clears them. Kept in memory, like the Playground. */
const HISTORY_TURNS = 12;
const HISTORY_TURN_CHARS = 2_000;

/**
 * One workspace's bot: pairs chats with `/start CODE`, answers the commands and sends every
 * other text message to the chat's agent. Chats that are not paired only get pairing help.
 * The gateway hands it one message per chat at a time.
 */
export class TelegramBot {
  private readonly history = new Map<string, Turn[]>();

  constructor(private readonly options: TelegramBotOptions) {}

  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from || message.from.is_bot) return;
    const locale = telegramLocale(message.from.language_code);
    const reply = (key: TelegramMessageKey, params?: Record<string, string>) =>
      this.send(message.chat.id, telegramText(locale, key, params));
    if (message.chat.type !== 'private') {
      await reply('groupsUnsupported');
      return;
    }
    const chatId = String(message.chat.id);
    const text = (message.text ?? '').trim();
    const command = parseCommand(text);
    const chat = await this.options.chats.find(
      this.options.workspaceId,
      TELEGRAM_PROVIDER_ID,
      chatId,
    );

    if (command?.name === 'start' && command.argument) {
      await this.pair(message, command.argument, locale);
      return;
    }
    // The allowlist: nothing past this point is available to chats that were not paired.
    if (!chat) {
      await reply('notPaired');
      return;
    }
    if (command) {
      // `/auth` carries a key: take it out of the chat history right away.
      // So does `/mcp add <name> <url> <token>`.
      if (
        (command.name === 'auth' && command.argument) ||
        (command.name === 'mcp' && /^add\s/i.test(command.argument))
      )
        await this.options.api
          .deleteMessage(message.chat.id, message.message_id)
          .catch(() => undefined);
      await this.command(chat, command, locale);
      return;
    }
    if (!text) {
      await reply('unsupportedMessage');
      return;
    }
    if (this.inCliMode(chat)) {
      await this.toBridge(chat, text, locale);
      return;
    }
    await this.converse(chat, text, locale, update.update_id);
  }

  private async pair(message: TelegramMessage, code: string, locale: SupportedLocale) {
    const grant = await this.options.pairing.consume(code);
    if (grant?.workspaceId !== this.options.workspaceId) {
      await this.send(message.chat.id, telegramText(locale, 'pairingInvalid'));
      return;
    }
    const from = message.from!;
    await this.options.chats.link({
      workspaceId: this.options.workspaceId,
      provider: TELEGRAM_PROVIDER_ID,
      chatId: String(message.chat.id),
      userId: String(from.id),
      displayName: displayName(from),
      linkedBy: grant.actorId,
    });
    this.history.delete(String(message.chat.id));
    await this.send(
      message.chat.id,
      telegramText(locale, 'paired', { workspace: grant.workspaceName }),
    );
  }

  private async command(chat: MessagingChat, command: Command, locale: SupportedLocale) {
    const reply = (key: TelegramMessageKey, params?: Record<string, string>) =>
      this.send(chat.chatId, telegramText(locale, key, params));
    const { chats, workspaceId } = this.options;
    switch (command.name) {
      case 'start':
      case 'help':
        await reply('help');
        return;
      case 'new':
        this.history.delete(chat.chatId);
        if (this.inCliMode(chat)) await this.toBridge(chat, '/new', locale);
        else await reply('newConversation');
        return;
      case 'cli':
        await this.cliCommand(chat, command.argument, locale);
        return;
      case 'mcp':
        await this.mcpCommand(chat, command.argument, locale);
        return;
      case 'agents': {
        const agents = await this.options.agents.listAgents(workspaceId);
        if (!agents.length) {
          await reply('noAgents');
          return;
        }
        const current = this.agentFor(chat, agents);
        const lines = agents.map(
          (agent) => `${agent.id === current?.id ? '•' : '◦'} ${agent.slug}: ${agent.name}`,
        );
        await this.send(chat.chatId, [telegramText(locale, 'agentsHeader'), ...lines].join('\n'));
        return;
      }
      case 'agent': {
        const agents = await this.options.agents.listAgents(workspaceId);
        const slug = command.argument.toLowerCase();
        if (!slug) {
          const current = this.agentFor(chat, agents);
          await reply(current ? 'currentAgent' : 'noAgents', {
            agent: current ? `${current.name} (${current.slug})` : '',
          });
          return;
        }
        if (slug === 'default' || slug === 'padrao' || slug === 'padrão') {
          await chats.update(workspaceId, chat.id, { agentId: null });
          await reply('agentDefault');
          return;
        }
        const agent = agents.find((item) => item.slug === slug);
        if (!agent) {
          await reply('agentUnknown', { slug: command.argument });
          return;
        }
        await chats.update(workspaceId, chat.id, { agentId: agent.id });
        this.history.delete(chat.chatId);
        await reply('agentSet', { agent: `${agent.name} (${agent.slug})` });
        return;
      }
      case 'notify': {
        const value = command.argument.toLowerCase();
        if (value !== 'on' && value !== 'off') {
          await reply('notifyUsage', {
            state: telegramText(locale, chat.notifications ? 'on' : 'off'),
          });
          return;
        }
        await chats.update(workspaceId, chat.id, { notifications: value === 'on' });
        await reply(value === 'on' ? 'notifyOn' : 'notifyOff');
        return;
      }
      case 'unlink':
        await chats.remove(workspaceId, chat.id);
        this.history.delete(chat.chatId);
        await reply('unlinked');
        return;
      default:
        if (BRIDGE_COMMANDS.has(command.name))
          await this.toBridge(chat, `/${command.name} ${command.argument}`.trim(), locale);
        else await reply('unknownCommand');
    }
  }

  /**
   * `/mcp adk` connects the ADK's own MCP server to the member's CLIs: the bot issues the token
   * and hands it to the Bridge, so it never shows up in the chat. Everything else (`/mcp`,
   * `/mcp add …`, `/mcp remove …`) is the Bridge's.
   */
  private async mcpCommand(chat: MessagingChat, argument: string, locale: SupportedLocale) {
    const { bridge, mcp } = this.options;
    const [sub = '', scope = ''] = argument.trim().split(/\s+/);
    if (!bridge) {
      await this.send(chat.chatId, telegramText(locale, 'bridgeOff'));
      return;
    }
    if (sub.toLowerCase() !== 'adk') {
      await this.toBridge(chat, `/mcp ${argument}`.trim(), locale);
      return;
    }
    if (!mcp) {
      await this.send(chat.chatId, telegramText(locale, 'mcpOff'));
      return;
    }
    try {
      const token = await mcp.issueToken(
        chat.linkedBy,
        scope.toLowerCase() === 'read' ? 'read' : 'full',
      );
      await this.toBridge(chat, `/mcp add adk ${mcp.url} ${token}`, locale);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.send(chat.chatId, telegramText(locale, 'mcpFailed', { reason }));
    }
  }

  private inCliMode(chat: MessagingChat): boolean {
    return Boolean(chat.agentId?.startsWith(CLI_PREFIX));
  }

  /** `/cli` lists the CLIs; `/cli claude` makes this chat talk to one. */
  private async cliCommand(chat: MessagingChat, argument: string, locale: SupportedLocale) {
    const { bridge, chats, workspaceId } = this.options;
    if (!bridge) {
      await this.send(chat.chatId, telegramText(locale, 'bridgeOff'));
      return;
    }
    const id = argument.toLowerCase();
    if (!id) {
      await this.toBridge(chat, '/cli', locale);
      return;
    }
    try {
      const available = await bridge.listClis();
      if (!available.includes(id)) {
        await this.send(
          chat.chatId,
          telegramText(locale, 'cliUnknown', { cli: argument, available: available.join(', ') }),
        );
        return;
      }
      await chats.update(workspaceId, chat.id, { agentId: `${CLI_PREFIX}${id}` });
      this.history.delete(chat.chatId);
      await bridge.forward({
        workspaceId,
        chatId: chat.chatId,
        userId: chat.userId,
        memberId: chat.linkedBy,
        text: `/cli ${id}`,
      });
      await this.send(chat.chatId, telegramText(locale, 'cliSet', { cli: id }));
    } catch (error) {
      await this.bridgeFailed(chat, error, locale);
    }
  }

  /** Hands text to the Bridge; its answer arrives later through the API's bridge routes. */
  private async toBridge(chat: MessagingChat, text: string, locale: SupportedLocale) {
    const { bridge, workspaceId } = this.options;
    if (!bridge) {
      await this.send(chat.chatId, telegramText(locale, 'bridgeOff'));
      return;
    }
    try {
      await bridge.forward({
        workspaceId,
        chatId: chat.chatId,
        userId: chat.userId,
        memberId: chat.linkedBy,
        text,
      });
    } catch (error) {
      await this.bridgeFailed(chat, error, locale);
    }
  }

  private async bridgeFailed(chat: MessagingChat, error: unknown, locale: SupportedLocale) {
    const reason = error instanceof Error ? error.message : String(error);
    await this.send(chat.chatId, telegramText(locale, 'bridgeFailed', { reason }));
  }

  private async converse(
    chat: MessagingChat,
    text: string,
    locale: SupportedLocale,
    updateId: number,
  ): Promise<void> {
    const typing = setInterval(
      () => void this.options.api.sendTyping(chat.chatId).catch(() => undefined),
      this.options.typingIntervalMs ?? 4_500,
    );
    void this.options.api.sendTyping(chat.chatId).catch(() => undefined);
    try {
      const { agents, workspaceId, settings } = this.options;
      const agent = this.agentFor(chat, await agents.listAgents(workspaceId));
      if (!agent) {
        await this.send(chat.chatId, telegramText(locale, 'noAgents'));
        return;
      }
      const turns = this.history.get(chat.chatId) ?? [];
      const conversation = turns
        .map((turn) => `${turn.role === 'user' ? 'Usuário' : 'Assistente'}: ${turn.text}`)
        .join('\n\n');
      const result = await agents.executeAgent(
        workspaceId,
        agent.id,
        {
          prompt: conversation
            ? `Conversa temporária:\n${conversation}\n\nPergunta atual:\n${text}`
            : text,
          knowledgeQuery: text,
          includeKnowledge: settings.useKnowledge,
        },
        {
          requestId: `telegram-${updateId}`,
          ownerId: workspaceId,
          workspaceId,
          actorId: chat.linkedBy,
          locale,
        },
      );
      const answer = result.result.trim() || telegramText(locale, 'emptyAnswer');
      this.remember(chat.chatId, { role: 'user', text }, { role: 'assistant', text: answer });
      await this.send(chat.chatId, answer);
    } catch (error) {
      const reason =
        error instanceof ApplicationError
          ? translateErrorMessage(error.code, locale, error.message, error.messageParams)
          : error instanceof Error
            ? error.message
            : String(error);
      console.warn(`[Telegram] Agent run failed for workspace ${this.options.workspaceId}:`, error);
      await this.send(chat.chatId, telegramText(locale, 'agentFailed', { reason }));
    } finally {
      clearInterval(typing);
    }
  }

  /** The chat's agent, else the integration's, else the workspace default, else the first. */
  private agentFor(chat: MessagingChat, agents: readonly CustomAgent[]): CustomAgent | undefined {
    const byId = (id: string | null) => (id ? agents.find((agent) => agent.id === id) : undefined);
    return (
      byId(chat.agentId) ??
      byId(this.options.settings.defaultAgentId) ??
      agents.find((agent) => agent.isDefault) ??
      agents[0]
    );
  }

  private remember(chatId: string, ...turns: Turn[]) {
    const kept = [
      ...(this.history.get(chatId) ?? []),
      ...turns.map((turn) => ({ ...turn, text: turn.text.slice(0, HISTORY_TURN_CHARS) })),
    ];
    this.history.set(chatId, kept.slice(-HISTORY_TURNS));
  }

  private async send(chatId: number | string, text: string): Promise<void> {
    for (const part of splitMessage(text)) await this.options.api.sendMessage(chatId, part);
  }
}

interface Command {
  readonly name: string;
  readonly argument: string;
}

/** `/agent qa`, `/agent@my_bot qa` → { name: 'agent', argument: 'qa' }. */
export function parseCommand(text: string): Command | null {
  const match = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), argument: (match[2] ?? '').trim() };
}

function displayName(user: NonNullable<TelegramMessage['from']>): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (name && user.username) return `${name} (@${user.username})`;
  return name || (user.username ? `@${user.username}` : String(user.id));
}
