import type { Channel, IncomingMessage, MessageHandler } from '../../core/types.js';

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly date: number;
    readonly chat: { readonly id: number; readonly type: string };
    readonly from?: { readonly id: number; readonly username?: string };
    readonly text?: string;
  };
}

export interface TelegramChannelOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly pollTimeoutSec?: number;
  /** Messages older than this when the bridge starts are dropped instead of answered late. */
  readonly backlogMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Telegram over long polling: needs no public address, port or webhook. */
export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  readonly maxMessageLength = 4096;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TelegramChannelOptions) {
    // The token goes into the URL path: BotFather's format only (123456789:AAF...).
    if (!/^\d+:[\w-]+$/.test(options.token)) throw new Error('Invalid Telegram bot token.');
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
  }

  async start(handler: MessageHandler, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const backlog = this.options.backlogMs ?? 5 * 60_000;
    const sleep = this.options.sleep ?? defaultSleep;
    // Polling only works without a webhook (e.g. after the bot was used on a server).
    await this.call('deleteWebhook', { drop_pending_updates: false }, signal).catch(
      () => undefined,
    );

    let offset = 0;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          { offset, timeout: this.options.pollTimeoutSec ?? 25, allowed_updates: ['message'] },
          signal,
        );
        failures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          const message = toIncoming(update);
          if (!message || update.message!.date * 1000 < startedAt - backlog) continue;
          // Not awaited: a long CLI run must not stop /cancel or other chats from being read.
          void handler(message).catch((error: unknown) =>
            console.warn('[Telegram] Handler failed:', error),
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        const status = error instanceof TelegramError ? error.status : 0;
        if (status === 401 || status === 404) {
          throw new Error('The Telegram bot token was rejected. Check TELEGRAM_BOT_TOKEN.');
        }
        if (status === 409 && failures === 0)
          console.warn('[Telegram] Another process is polling this bot; retrying.');
        console.warn('[Telegram] Polling failed:', error instanceof Error ? error.message : error);
        const delay = status === 409 ? 30_000 : Math.min(60_000, 1_000 * 2 ** failures);
        failures += 1;
        await sleep(delay, signal);
      }
    }
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
    });
  }

  async indicateBusy(chatId: string): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/bot${this.options.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: T;
      description?: string;
    } | null;
    if (!response.ok || !payload?.ok) {
      // The token is part of the URL: report Telegram's description, never the request.
      throw new TelegramError(
        payload?.description ?? `Telegram returned ${response.status}.`,
        response.status,
      );
    }
    return payload.result as T;
  }
}

class TelegramError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function toIncoming(update: TelegramUpdate): IncomingMessage | null {
  const message = update.message;
  if (!message?.text || !message.from) return null;
  return {
    channel: 'telegram',
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    username: message.from.username,
    text: message.text,
    isPrivate: message.chat.type === 'private',
  };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
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
