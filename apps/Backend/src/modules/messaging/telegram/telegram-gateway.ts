import { timingSafeEqual } from 'node:crypto';
import type { AgentService } from '../../agents/application/agent-service.js';
import type { IntegrationsService } from '../../integrations/application/integrations-service.js';
import type { CliBridge } from '../application/cli-bridge.js';
import type { McpConnector } from '../application/mcp-connector.js';
import type { MessagingChatStore } from '../application/messaging-chat-store.js';
import {
  splitMessage,
  TelegramApi,
  TelegramApiError,
  type TelegramUpdate,
} from './telegram-api.js';
import { TelegramBot } from './telegram-bot.js';
import { TELEGRAM_COMMANDS } from './telegram-messages.js';
import type { TelegramPairingCodes } from './telegram-pairing.js';
import {
  readTelegramSettings,
  TELEGRAM_PROVIDER_ID,
  usesWebhook,
  webhookSecret,
} from './telegram-settings.js';

export interface TelegramGatewayOptions {
  readonly integrations: Pick<
    IntegrationsService,
    'getIntegration' | 'getDecryptedSecret' | 'listByProvider' | 'onChange'
  >;
  readonly chats: MessagingChatStore;
  readonly agents: Pick<AgentService, 'listAgents' | 'executeAgent'>;
  readonly pairing: TelegramPairingCodes;
  /** The AI CLIs (apps/Bridge), when this install runs them. */
  readonly bridge?: CliBridge;
  /** The ADK MCP server the Bridge's CLIs can be connected to. */
  readonly mcp?: McpConnector;
  /** API_PUBLIC_URL: webhooks need it to be HTTPS. */
  readonly publicUrl?: string;
  readonly fetch?: typeof fetch;
  readonly encryptionKey?: Buffer;
  readonly pollTimeoutSec?: number;
}

/** What Connect shows about a workspace's bot. */
export interface TelegramBotStatus {
  readonly running: boolean;
  readonly mode: 'polling' | 'webhook' | null;
  readonly botUsername: string | null;
  readonly error: string | null;
}

interface RunningBot {
  readonly api: TelegramApi;
  readonly bot: TelegramBot;
  readonly mode: 'polling' | 'webhook';
  readonly controller: AbortController;
  readonly startedAt: number;
  /** Messages of one chat are answered in order, one at a time. */
  readonly queues: Map<string, Promise<void>>;
  botUsername: string | null;
  error: string | null;
}

/** Messages that waited longer than this while the bot was offline are dropped, not answered. */
const BACKLOG_MS = 5 * 60_000;

/**
 * Runs the Telegram bot of every workspace that enabled one. A local install long-polls
 * getUpdates (no public address needed); an API with a public HTTPS address registers a webhook.
 * Saving or deleting the integration restarts that workspace's bot.
 *
 * One API instance should poll a given bot: Telegram answers a second poller with 409.
 */
export class TelegramGateway {
  private readonly bots = new Map<string, RunningBot>();
  private readonly failures = new Map<string, string>();
  private readonly syncs = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: TelegramGatewayOptions) {}

  async start(): Promise<void> {
    this.unsubscribe = this.options.integrations.onChange((workspaceId, category, providerId) => {
      if (category === 'MESSAGING' && providerId === TELEGRAM_PROVIDER_ID)
        void this.sync(workspaceId);
    });
    const records = await this.options.integrations.listByProvider(
      'MESSAGING',
      TELEGRAM_PROVIDER_ID,
    );
    await Promise.all(
      records.filter((record) => record.isEnabled).map((record) => this.sync(record.ownerId)),
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    for (const workspaceId of [...this.bots.keys()]) this.halt(workspaceId);
    await Promise.allSettled(this.syncs.values());
  }

  status(workspaceId: string): TelegramBotStatus {
    const running = this.bots.get(workspaceId);
    return {
      running: Boolean(running && !running.error),
      mode: running?.mode ?? null,
      botUsername: running?.botUsername ?? null,
      error: running?.error ?? this.failures.get(workspaceId) ?? null,
    };
  }

  /** Sends text to a chat through the workspace's bot (the Bridge's answers). False when offline. */
  async sendToChat(workspaceId: string, chatId: string, text: string): Promise<boolean> {
    const running = this.bots.get(workspaceId);
    if (!running) return false;
    for (const part of splitMessage(text)) await running.api.sendMessage(chatId, part);
    return true;
  }

  async typingInChat(workspaceId: string, chatId: string): Promise<boolean> {
    const running = this.bots.get(workspaceId);
    if (!running) return false;
    await running.api.sendTyping(chatId);
    return true;
  }

  /** (Re)starts or stops a workspace's bot from its saved integration. Calls are serialized. */
  sync(workspaceId: string): Promise<void> {
    const previous = this.syncs.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .then(() => this.restart(workspaceId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.failures.set(workspaceId, message);
        console.warn(`[Telegram] Could not start the bot of workspace ${workspaceId}:`, message);
      })
      .finally(() => {
        if (this.syncs.get(workspaceId) === next) this.syncs.delete(workspaceId);
      });
    this.syncs.set(workspaceId, next);
    return next;
  }

  /**
   * An update Telegram posted to the webhook. False when the secret does not match, so the
   * route answers 401; the update itself is processed in the background.
   */
  async receive(
    workspaceId: string,
    secret: string | undefined,
    update: unknown,
  ): Promise<boolean> {
    if (!secret || !sameSecret(secret, webhookSecret(workspaceId, this.options.encryptionKey)))
      return false;
    // Saved on another instance: start the bot here on its first delivery.
    if (!this.bots.has(workspaceId)) await this.sync(workspaceId);
    const running = this.bots.get(workspaceId);
    if (running?.mode === 'webhook' && isUpdate(update)) this.dispatch(running, update);
    return true;
  }

  private async restart(workspaceId: string): Promise<void> {
    this.halt(workspaceId);
    this.failures.delete(workspaceId);
    if (this.stopped) return;
    const { integrations } = this.options;
    const integration = await integrations.getIntegration(
      workspaceId,
      'MESSAGING',
      TELEGRAM_PROVIDER_ID,
    );
    const token = integration?.isEnabled
      ? await integrations.getDecryptedSecret(workspaceId, 'MESSAGING', TELEGRAM_PROVIDER_ID)
      : null;
    if (!integration || !token) return;

    const settings = readTelegramSettings(integration.settings);
    const api = new TelegramApi({ token, fetch: this.options.fetch });
    const me = await api.getMe();
    const publicUrl = this.options.publicUrl?.replace(/\/$/, '');
    const webhook = usesWebhook(settings, publicUrl);
    if (webhook && !publicUrl?.startsWith('https://'))
      throw new Error('Webhook mode needs API_PUBLIC_URL to be an https:// address.');
    const running: RunningBot = {
      api,
      bot: new TelegramBot({
        workspaceId,
        api,
        chats: this.options.chats,
        agents: this.options.agents,
        pairing: this.options.pairing,
        bridge: this.options.bridge,
        mcp: this.options.mcp,
        settings,
      }),
      mode: webhook ? 'webhook' : 'polling',
      controller: new AbortController(),
      startedAt: Date.now(),
      queues: new Map(),
      botUsername: me.username ?? null,
      error: null,
    };
    if (webhook) {
      await api.setWebhook(
        `${publicUrl}/messaging/telegram/webhook/${encodeURIComponent(workspaceId)}`,
        webhookSecret(workspaceId, this.options.encryptionKey),
      );
    } else {
      // getUpdates is refused while a webhook is set, e.g. after moving from Railway to local.
      await api.deleteWebhook();
    }
    await api.setMyCommands(TELEGRAM_COMMANDS).catch(() => undefined);
    this.bots.set(workspaceId, running);
    console.log(
      `[Telegram] @${running.botUsername ?? '?'} is online for workspace ${workspaceId} (${running.mode}).`,
    );
    if (!webhook) void this.poll(workspaceId, running);
  }

  private halt(workspaceId: string): void {
    const running = this.bots.get(workspaceId);
    if (!running) return;
    running.controller.abort();
    this.bots.delete(workspaceId);
  }

  private async poll(workspaceId: string, running: RunningBot): Promise<void> {
    const { signal } = running.controller;
    let offset = 0;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await running.api.getUpdates(
          offset,
          this.options.pollTimeoutSec ?? 25,
          signal,
        );
        failures = 0;
        running.error = null;
        for (const update of updates) {
          offset = update.update_id + 1;
          this.dispatch(running, update);
        }
      } catch (error) {
        if (signal.aborted) return;
        const status = error instanceof TelegramApiError ? error.status : 0;
        running.error = error instanceof Error ? error.message : String(error);
        if (status === 401 || status === 404) {
          console.warn(`[Telegram] The bot token of workspace ${workspaceId} was revoked.`);
          return;
        }
        if (status === 409 && failures === 0)
          console.warn(
            `[Telegram] Another process is polling the bot of workspace ${workspaceId}; retrying.`,
          );
        const retryAfter = error instanceof TelegramApiError ? error.retryAfterSec : undefined;
        const delay = retryAfter
          ? retryAfter * 1000
          : status === 409
            ? 30_000
            : Math.min(60_000, 1_000 * 2 ** failures);
        failures += 1;
        await sleep(delay, signal);
      }
    }
  }

  private dispatch(running: RunningBot, update: TelegramUpdate): void {
    const message = update.message;
    if (!message) return;
    if (message.date * 1000 < running.startedAt - BACKLOG_MS) return;
    const key = String(message.chat.id);
    const previous = running.queues.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => running.bot.handle(update))
      .catch((error: unknown) => console.warn('[Telegram] Could not handle a message:', error))
      .finally(() => {
        if (running.queues.get(key) === next) running.queues.delete(key);
      });
    running.queues.set(key, next);
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isUpdate(value: unknown): value is TelegramUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { update_id?: unknown }).update_id === 'number'
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
