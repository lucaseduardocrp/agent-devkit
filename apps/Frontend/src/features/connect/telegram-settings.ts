export type TelegramMode = 'auto' | 'polling' | 'webhook';
export type TelegramRunKind = 'e2e' | 'integration' | 'load';

/** The settings saved with the Telegram integration; paired chats are managed separately. */
export interface TelegramSettingsValue {
  readonly mode: TelegramMode;
  readonly defaultAgentId: string;
  readonly useKnowledge: boolean;
  readonly notify: Readonly<Record<TelegramRunKind, boolean>> & { readonly onlyFailures: boolean };
}

/** Same defaults as the API (modules/messaging/telegram/telegram-settings.ts). */
export function readTelegramSettings(raw: Record<string, unknown> = {}): TelegramSettingsValue {
  const notify = (raw.notify ?? {}) as Record<string, unknown>;
  return {
    mode: raw.mode === 'polling' || raw.mode === 'webhook' ? raw.mode : 'auto',
    defaultAgentId: typeof raw.defaultAgentId === 'string' ? raw.defaultAgentId : '',
    useKnowledge: raw.useKnowledge !== false,
    notify: {
      e2e: notify.e2e !== false,
      integration: notify.integration !== false,
      load: notify.load !== false,
      onlyFailures: notify.onlyFailures === true,
    },
  };
}
