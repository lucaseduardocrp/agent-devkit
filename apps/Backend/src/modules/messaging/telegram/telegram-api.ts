/** The parts of the Telegram Bot API the ADK bot uses (https://core.telegram.org/bots/api). */

export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: 'private' | 'group' | 'supergroup' | 'channel';
  readonly title?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly caption?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
}

export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
}

/** A failed Bot API call. `status` is the HTTP status: 401 for a revoked token, 409 for a conflict. */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

/** Longest text Telegram accepts in one message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramApiOptions {
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
}

export class TelegramApi {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: TelegramApiOptions) {
    // The token goes into the URL path: BotFather's format only (123456789:AAF...).
    if (!/^\d+:[\w-]+$/.test(options.token)) throw new Error('Invalid Telegram bot token.');
    this.fetcher = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call('getMe', {}, signal);
  }

  /** Long polling: waits up to `timeoutSec` for updates after `offset`. */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      signal,
    );
  }

  sendMessage(chatId: number | string, text: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(
      'sendMessage',
      { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
      signal,
    );
  }

  /** Removes a message from the chat (a bot can delete a user's message in a private chat). */
  deleteMessage(chatId: number | string, messageId: number): Promise<unknown> {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  sendTyping(chatId: number | string): Promise<unknown> {
    return this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  setWebhook(url: string, secretToken: string): Promise<unknown> {
    return this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
    });
  }

  /** Polling only works without a webhook; pending updates are kept. */
  deleteWebhook(): Promise<unknown> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  setMyCommands(commands: readonly TelegramBotCommand[]): Promise<unknown> {
    return this.call('setMyCommands', { commands });
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
      parameters?: { retry_after?: number };
    } | null;
    if (!response.ok || !payload?.ok) {
      // The token is part of the URL: never echo the request, only Telegram's description.
      throw new TelegramApiError(
        payload?.description ?? `Telegram returned ${response.status}.`,
        response.status,
        payload?.parameters?.retry_after,
      );
    }
    return payload.result as T;
  }
}

/**
 * Splits text into messages Telegram accepts, breaking at paragraph, line or word boundaries
 * when one is close enough to the limit.
 */
export function splitMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const minimum = Math.floor(limit / 2);
    let cut = window.lastIndexOf('\n\n');
    if (cut < minimum) cut = window.lastIndexOf('\n');
    if (cut < minimum) cut = window.lastIndexOf(' ');
    if (cut < minimum) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
