import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Switch } from '../../components/ui/switch.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import type {
  ApiClient,
  TelegramBotStatusDto,
  TelegramChatDto,
  TelegramPairingCodeDto,
} from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import type { TelegramMode, TelegramRunKind, TelegramSettingsValue } from './telegram-settings.js';

const labelClass = 'mb-1 block text-xs font-medium text-[var(--text-secondary)]';
const helpClass = 'mt-1 text-[11px] text-muted';

/** A titled card: every group of settings of the modal has one. */
function Section({
  icon,
  title,
  help,
  action,
  children,
}: {
  readonly icon: string;
  readonly title: string;
  readonly help?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-surface-2/60 p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-1 text-sm text-[var(--text-accent)]">
            <i className={`ti ${icon}`} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
            {help && <p className="text-[11px] text-muted">{help}</p>}
          </div>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** A setting with a name, a one-line explanation and a switch. The whole row toggles it. */
function SwitchRow({
  id,
  label,
  help,
  checked,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly help?: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex items-center justify-between gap-3 rounded-md px-1 py-1.5 select-none',
        disabled ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--fill-ghost-hover)]',
      )}
    >
      <span className="min-w-0">
        <span id={`${id}-label`} className="block text-xs font-medium text-[var(--text-primary)]">
          {label}
        </span>
        {help && (
          <span id={`${id}-help`} className="block text-[11px] text-muted">
            {help}
          </span>
        )}
      </span>
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={help ? `${id}-help` : undefined}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/** The bot and its paired chats, loaded from the API and refreshed while a code is waiting. */
function useTelegramBot(apiClient: ApiClient | undefined, enabled: boolean) {
  const { t } = useI18n();
  const [status, setStatus] = useState<TelegramBotStatusDto | null>(null);
  const [chats, setChats] = useState<readonly TelegramChatDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!apiClient) return;
      try {
        const result = await apiClient.getTelegramChats(signal);
        setStatus(result.status);
        setChats(result.chats);
        setError(null);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : t('connect.telegramLoadFailed'));
      }
    },
    [apiClient, t],
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [enabled, load]);

  return { status, chats, setChats, error, setError, load };
}

/** `m:ss` left until `expiresAt`. */
function countdown(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface TelegramConfigFormProps {
  readonly value: TelegramSettingsValue;
  readonly onChange: (next: TelegramSettingsValue) => void;
  readonly apiClient?: ApiClient;
  readonly isReadOnly?: boolean;
  readonly canRemove?: boolean;
  /** True once the integration was saved: only then the bot exists and chats can be paired. */
  readonly isSaved: boolean;
  readonly secret: string;
  readonly onSecretChange: (secret: string) => void;
  readonly hasExistingSecret: boolean;
  readonly isEnabled: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
}

/**
 * Everything the Telegram integration needs, in the order a person sets it up: connect the bot,
 * pair chats, choose who answers, choose what is reported.
 */
export function TelegramConfigForm({
  value,
  onChange,
  apiClient,
  isReadOnly = false,
  canRemove = true,
  isSaved,
  secret,
  onSecretChange,
  hasExistingSecret,
  isEnabled,
  onEnabledChange,
}: TelegramConfigFormProps) {
  const { t } = useI18n();
  const { status, chats, setChats, error, setError, load } = useTelegramBot(
    apiClient,
    isSaved && Boolean(apiClient),
  );
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [pairing, setPairing] = useState<TelegramPairingCodeDto | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    if (!apiClient) return;
    const controller = new AbortController();
    void apiClient
      .getAgents(controller.signal)
      .then(setAgents)
      .catch(() => undefined);
    return () => controller.abort();
  }, [apiClient]);

  // While a code is waiting: tick the countdown, pick up the chat that pairs with it, and drop
  // the code when it expires.
  useEffect(() => {
    if (!pairing) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const poll = window.setInterval(() => void load(), 4_000);
    const expiry = window.setTimeout(
      () => setPairing(null),
      Math.max(0, new Date(pairing.expiresAt).getTime() - Date.now()),
    );
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
      window.clearTimeout(expiry);
    };
  }, [pairing, load]);

  const run = async (action: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connect.saveFailed'));
    } finally {
      setIsBusy(false);
    }
  };

  const copyCommand = (command: string) => {
    void navigator.clipboard?.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };

  const toggle = (kind: TelegramRunKind | 'onlyFailures', checked: boolean) =>
    onChange({ ...value, notify: { ...value.notify, [kind]: checked } });
  const notifyOptions: readonly { kind: TelegramRunKind; label: string }[] = [
    { kind: 'e2e', label: t('connect.telegramNotifyE2e') },
    { kind: 'integration', label: t('connect.telegramNotifyIntegration') },
    { kind: 'load', label: t('connect.telegramNotifyLoad') },
  ];

  const online = Boolean(status?.running && status.botUsername);
  const botUsername = status?.botUsername ?? '';
  const message = error ?? (online ? null : status?.error);
  const isLoadingStatus = isSaved && !status && !error;
  const command = pairing ? `/start ${pairing.code}` : '';

  return (
    <div className="space-y-3">
      {isSaved && (
        <div
          className={cn(
            'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5',
            online
              ? 'border-[var(--border-success)] bg-[var(--bg-success)]'
              : 'border-border bg-surface-2/60',
          )}
          data-testid="telegram-status"
        >
          {isLoadingStatus ? (
            <Skeleton className="h-4 w-48" />
          ) : (
            <>
              <span
                className={cn(
                  'flex min-w-0 items-center gap-2 text-xs font-medium',
                  online ? 'text-[var(--text-success)]' : 'text-[var(--text-secondary)]',
                )}
              >
                <i
                  className={cn('ti text-[8px]', online ? 'ti-circle-filled' : 'ti-circle')}
                  aria-hidden="true"
                />
                <span className="truncate">
                  {online
                    ? t('connect.telegramStatusOnline', {
                        bot: botUsername,
                        mode: status?.mode ?? '',
                      })
                    : t('connect.telegramStatusOffline')}
                </span>
              </span>
              {online && (
                <a
                  href={`https://t.me/${botUsername}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-[11px] font-medium text-[var(--text-accent)] hover:underline"
                >
                  {t('connect.telegramOpenBot', { bot: botUsername })}
                  <i className="ti ti-external-link ml-1" aria-hidden="true" />
                </a>
              )}
            </>
          )}
        </div>
      )}

      {message && (
        <p
          className="rounded-md border border-[var(--border-danger)] bg-[var(--bg-danger)] px-3 py-2 text-[11px] text-[var(--text-danger)]"
          role="alert"
        >
          {/* Telegram's own wording ("terminated by other getUpdates request") does not say what to do. */}
          {/conflict|getupdates/i.test(message) ? t('connect.telegramConflictHelp') : message}
        </p>
      )}

      <Section
        icon="ti-plug-connected"
        title={t('connect.telegramSectionConnection')}
        help={t('connect.telegramSectionConnectionHelp')}
      >
        <div>
          <label htmlFor="cfg-secret" className={labelClass}>
            {t('connect.secretLabel')}
          </label>
          <Input
            id="cfg-secret"
            name="integration-secret-pat"
            type="password"
            placeholder={
              hasExistingSecret
                ? t('connect.keepSecretPlaceholder')
                : t('connect.secretPlaceholder')
            }
            value={secret}
            onChange={(event) => onSecretChange(event.target.value)}
            disabled={isReadOnly}
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
          />
          <p className={helpClass}>
            {hasExistingSecret && <>{t('connect.existingSecretHelp')} </>}
            {t('connect.telegramTokenHelp')}{' '}
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--text-accent)] hover:underline"
            >
              {t('connect.telegramOpenBotFather')}
            </a>
          </p>
        </div>
        <SwitchRow
          id="cfg-enable"
          label={t('connect.enableIntegration')}
          help={t('connect.telegramEnableHelp')}
          checked={isEnabled}
          onChange={onEnabledChange}
          disabled={isReadOnly}
        />
        <details className="group rounded-md border border-border bg-surface-1/60">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-[var(--text-secondary)] select-none">
            {t('connect.telegramAdvanced')}
            <i
              className="ti ti-chevron-down transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="border-t border-border p-3">
            <label htmlFor="cfg-telegram-mode" className={labelClass}>
              {t('connect.telegramMode')}
            </label>
            <Select
              id="cfg-telegram-mode"
              value={value.mode}
              onChange={(event) => onChange({ ...value, mode: event.target.value as TelegramMode })}
              disabled={isReadOnly}
            >
              <option value="auto">{t('connect.telegramModeAuto')}</option>
              <option value="polling">{t('connect.telegramModePolling')}</option>
              <option value="webhook">{t('connect.telegramModeWebhook')}</option>
            </Select>
          </div>
        </details>
      </Section>

      {isSaved && apiClient && (
        <Section
          icon="ti-users"
          title={t('connect.telegramChats')}
          help={t('connect.telegramChatsHelp')}
          action={
            !isReadOnly && online ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() =>
                  void run(async () => setPairing(await apiClient.createTelegramPairingCode()))
                }
              >
                <i className="ti ti-link" aria-hidden="true" />
                {t('connect.telegramPair')}
              </Button>
            ) : undefined
          }
        >
          {pairing && (
            <div className="space-y-3 rounded-md border border-[var(--border-accent)] bg-surface-1 p-3">
              <div className="flex items-center justify-between gap-3">
                <code className="text-2xl font-bold tracking-[0.3em] text-[var(--text-primary)]">
                  {pairing.code}
                </code>
                <Badge variant="outline" className="shrink-0 tabular-nums">
                  <i className="ti ti-clock mr-1" aria-hidden="true" />
                  {t('connect.telegramCodeExpires', {
                    time: countdown(pairing.expiresAt, now),
                  })}
                </Badge>
              </div>
              <p className="text-[11px] text-muted">
                {t('connect.telegramPairHelp', { code: pairing.code, bot: pairing.botUsername })}
              </p>
              <div className="flex flex-wrap gap-2">
                <a
                  href={pairing.deepLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-[var(--fill-accent)] px-3 text-xs font-semibold text-[#091624] hover:bg-[var(--fill-accent-hover)]"
                >
                  <i className="ti ti-brand-telegram" aria-hidden="true" />
                  {t('connect.telegramOpenLink')}
                </a>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => copyCommand(command)}
                >
                  <i className={cn('ti', copied ? 'ti-check' : 'ti-copy')} aria-hidden="true" />
                  {copied ? t('connect.telegramCopied') : t('connect.telegramCopyCommand')}
                </Button>
              </div>
            </div>
          )}

          {chats.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-5 text-center">
              <i
                className="ti ti-brand-telegram mb-1 block text-2xl text-muted"
                aria-hidden="true"
              />
              <p className="text-xs font-medium text-[var(--text-secondary)]">
                {t('connect.telegramNoChats')}
              </p>
              <p className="mt-0.5 text-[11px] text-muted">
                {online ? t('connect.telegramNoChatsHelp') : t('connect.telegramSaveFirst')}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border bg-surface-1/60">
              {chats.map((chat) => {
                const cli = chat.agentId?.startsWith('cli:') ? chat.agentId.slice(4) : null;
                return (
                  <li key={chat.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--bg-accent)] text-xs font-bold text-[var(--text-accent)]"
                        aria-hidden="true"
                      >
                        {chat.displayName.trim().charAt(0).toUpperCase() || '?'}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                          {chat.displayName}
                        </span>
                        {cli && (
                          <Badge variant="outline" className="mt-0.5 px-2 py-0 text-[10px]">
                            <i className="ti ti-terminal-2 mr-1" aria-hidden="true" />
                            {t('connect.telegramChatCli', { cli })}
                          </Badge>
                        )}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3">
                      <label className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)] select-none">
                        {t('connect.telegramChatNotifications')}
                        <Switch
                          checked={chat.notifications}
                          disabled={isReadOnly || isBusy}
                          onChange={(event) => {
                            const notifications = event.target.checked;
                            void run(async () => {
                              const updated = await apiClient.updateTelegramChat(chat.id, {
                                notifications,
                              });
                              setChats((prev) =>
                                prev.map((item) => (item.id === updated.id ? updated : item)),
                              );
                            });
                          }}
                        />
                      </label>
                      {!isReadOnly && canRemove && (
                        <IconButton
                          type="button"
                          size="sm"
                          icon={<i className="ti ti-trash" aria-hidden="true" />}
                          label={t('connect.telegramRemoveChat', { name: chat.displayName })}
                          disabled={isBusy}
                          onClick={() =>
                            void run(async () => {
                              await apiClient.removeTelegramChat(chat.id);
                              setChats((prev) => prev.filter((item) => item.id !== chat.id));
                            })
                          }
                        />
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      <Section
        icon="ti-robot"
        title={t('connect.telegramSectionAnswers')}
        help={t('connect.telegramSectionAnswersHelp')}
      >
        <div>
          <label htmlFor="cfg-telegram-agent" className={labelClass}>
            {t('connect.telegramDefaultAgent')}
          </label>
          <Select
            id="cfg-telegram-agent"
            value={value.defaultAgentId}
            onChange={(event) => onChange({ ...value, defaultAgentId: event.target.value })}
            disabled={isReadOnly}
          >
            <option value="">{t('connect.telegramDefaultAgentAuto')}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} ({agent.slug})
              </option>
            ))}
          </Select>
          <p className={helpClass}>{t('connect.telegramAgentHelp')}</p>
        </div>
        <SwitchRow
          id="cfg-telegram-knowledge"
          label={t('connect.telegramUseKnowledge')}
          help={t('connect.telegramUseKnowledgeHelp')}
          checked={value.useKnowledge}
          onChange={(checked) => onChange({ ...value, useKnowledge: checked })}
          disabled={isReadOnly}
        />
      </Section>

      <Section
        icon="ti-bell"
        title={t('connect.telegramNotifications')}
        help={t('connect.telegramNotificationsHelp')}
      >
        <div>
          {notifyOptions.map(({ kind, label }) => (
            <SwitchRow
              key={kind}
              id={`cfg-telegram-notify-${kind}`}
              label={label}
              checked={value.notify[kind]}
              onChange={(checked) => toggle(kind, checked)}
              disabled={isReadOnly}
            />
          ))}
        </div>
        <SwitchRow
          id="cfg-telegram-notify-failures"
          label={t('connect.telegramOnlyFailures')}
          help={t('connect.telegramOnlyFailuresHelp')}
          checked={value.notify.onlyFailures}
          onChange={(checked) => toggle('onlyFailures', checked)}
          disabled={isReadOnly}
        />
      </Section>
    </div>
  );
}
