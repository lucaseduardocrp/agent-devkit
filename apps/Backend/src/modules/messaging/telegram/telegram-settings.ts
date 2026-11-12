import { createHmac } from 'node:crypto';
import { resolveEncryptionKey } from '../../../shared/encryption.js';

export const TELEGRAM_PROVIDER_ID = 'telegram';

/**
 * How the bot receives messages. `auto` uses a webhook when the API has a public HTTPS address
 * (Railway, a server behind a proxy) and long polling otherwise (a local install).
 */
export type TelegramMode = 'auto' | 'polling' | 'webhook';

export type RunKind = 'e2e' | 'integration' | 'load';

/** What a workspace manager sets in Connect. Paired chats live in their own table. */
export interface TelegramSettings {
  readonly mode: TelegramMode;
  /** Agent that answers chats that did not pick one with /agent; null uses the default agent. */
  readonly defaultAgentId: string | null;
  /** Grounds answers on the workspace's Brain. */
  readonly useKnowledge: boolean;
  readonly notify: Readonly<Record<RunKind, boolean>> & { readonly onlyFailures: boolean };
}

export function readTelegramSettings(raw: Record<string, unknown>): TelegramSettings {
  const notify = (raw['notify'] ?? {}) as Record<string, unknown>;
  const mode = raw['mode'];
  const agent = raw['defaultAgentId'];
  return {
    mode: mode === 'polling' || mode === 'webhook' ? mode : 'auto',
    defaultAgentId: typeof agent === 'string' && agent.trim() ? agent.trim() : null,
    useKnowledge: raw['useKnowledge'] !== false,
    notify: {
      e2e: notify['e2e'] !== false,
      integration: notify['integration'] !== false,
      load: notify['load'] !== false,
      onlyFailures: notify['onlyFailures'] === true,
    },
  };
}

/** Webhook mode when chosen, or for `auto` when Telegram can reach the API over HTTPS. */
export function usesWebhook(settings: TelegramSettings, publicUrl: string | undefined): boolean {
  if (settings.mode === 'polling') return false;
  const https = Boolean(publicUrl?.startsWith('https://'));
  return settings.mode === 'webhook' ? true : https;
}

/**
 * The `X-Telegram-Bot-Api-Secret-Token` of a workspace's webhook, derived from the encryption
 * key so nothing has to be stored and every API instance agrees on it.
 */
export function webhookSecret(workspaceId: string, key = resolveEncryptionKey()): string {
  return createHmac('sha256', key).update(`telegram-webhook:${workspaceId}`).digest('hex');
}
