import type { IntegrationsService } from '../../integrations/application/integrations-service.js';
import type { MessagingChatStore } from './messaging-chat-store.js';
import { TelegramApi } from '../telegram/telegram-api.js';
import {
  readTelegramSettings,
  TELEGRAM_PROVIDER_ID,
  type RunKind,
} from '../telegram/telegram-settings.js';

/** A finished test run, told to the chats paired with the workspace's bot. */
export interface RunFinishedEvent {
  readonly workspaceId: string;
  readonly kind: RunKind;
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'error';
  /** One line, e.g. "11/12 passed · 3m 20s". */
  readonly summary: string;
}

/** Never throws: a notification that cannot be sent must not fail the run. */
export interface RunNotifier {
  runFinished(event: RunFinishedEvent): Promise<void>;
}

export interface TelegramRunNotifierOptions {
  readonly integrations: Pick<IntegrationsService, 'getIntegration' | 'getDecryptedSecret'>;
  readonly chats: MessagingChatStore;
  /** Linked at the end of each notification. */
  readonly frontendUrl?: string;
  readonly fetch?: typeof fetch;
}

const KIND_LABEL: Record<RunKind, string> = {
  e2e: 'E2E',
  integration: 'Integration Tests',
  load: 'Overload Tests',
};
const STATUS_ICON: Record<RunFinishedEvent['status'], string> = {
  passed: '✅',
  failed: '❌',
  error: '⚠️',
};

export class TelegramRunNotifier implements RunNotifier {
  constructor(private readonly options: TelegramRunNotifierOptions) {}

  async runFinished(event: RunFinishedEvent): Promise<void> {
    try {
      const { integrations, chats } = this.options;
      const integration = await integrations.getIntegration(
        event.workspaceId,
        'MESSAGING',
        TELEGRAM_PROVIDER_ID,
      );
      if (!integration?.isEnabled) return;
      const { notify } = readTelegramSettings(integration.settings);
      if (!notify[event.kind] || (notify.onlyFailures && event.status === 'passed')) return;
      const recipients = (await chats.list(event.workspaceId, TELEGRAM_PROVIDER_ID)).filter(
        (chat) => chat.notifications,
      );
      if (!recipients.length) return;
      const token = await integrations.getDecryptedSecret(
        event.workspaceId,
        'MESSAGING',
        TELEGRAM_PROVIDER_ID,
      );
      if (!token) return;
      const api = new TelegramApi({ token, fetch: this.options.fetch });
      const text = formatRunFinished(event, this.options.frontendUrl);
      const results = await Promise.allSettled(
        recipients.map((chat) => api.sendMessage(chat.chatId, text, AbortSignal.timeout(10_000))),
      );
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length)
        console.warn(
          `[Telegram] ${failed.length} of ${results.length} notification(s) were not delivered:`,
          (failed[0] as PromiseRejectedResult).reason,
        );
    } catch (error) {
      console.warn('[Telegram] Could not send the run notification:', error);
    }
  }
}

export function formatRunFinished(event: RunFinishedEvent, frontendUrl?: string): string {
  const lines = [
    `${STATUS_ICON[event.status]} ${KIND_LABEL[event.kind]} · ${event.name}`,
    event.summary,
  ];
  if (frontendUrl) lines.push(frontendUrl.replace(/\/$/, ''));
  return lines.filter(Boolean).join('\n');
}

/** "3m 20s", "45s", "1h 05m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}
