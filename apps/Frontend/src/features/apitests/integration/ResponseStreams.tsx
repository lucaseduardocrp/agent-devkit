import React, { useMemo, useState } from 'react';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { RenderedCode } from '../../brain/RenderedCode.js';
import type { AssertionResult, ScriptLog, StreamMessage } from '../api-test-types.js';
import { grpcStatusLine, headerValue } from './integration-model.js';
import { HeadersTable } from './Timeline.js';

const DIRECTION_ICON: Record<StreamMessage['direction'], string> = {
  sent: 'ti-arrow-up-right text-[var(--text-accent)]',
  received: 'ti-arrow-down-left text-[var(--text-success)]',
  info: 'ti-info-circle text-[var(--text-muted)]',
};

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function MessageRow({
  message,
  start,
}: {
  readonly message: StreamMessage;
  readonly start: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    const value = parseJson(message.data);
    return value !== undefined && typeof value === 'object' ? JSON.stringify(value, null, 2) : null;
  }, [message.data]);
  return (
    <li
      className="border-b border-[var(--border)] px-3 py-1.5 text-xs"
      data-testid="stream-message"
    >
      <div className="flex items-start gap-2">
        <i
          className={cn('ti mt-0.5', DIRECTION_ICON[message.direction])}
          aria-label={t(`apiTests.protocol.directions.${message.direction}`)}
          role="img"
        />
        <span className="w-16 shrink-0 font-mono text-[var(--text-muted)]">
          +{Math.max(0, message.at - start)}ms
        </span>
        {message.event && (
          <span className="shrink-0 rounded bg-[var(--surface-2)] px-1.5 font-mono text-[10px] text-[var(--text-secondary)]">
            {message.event}
          </span>
        )}
        <span
          className={cn(
            'min-w-0 flex-1 font-mono text-[var(--text-primary)]',
            open ? 'hidden' : 'truncate',
          )}
        >
          {message.data}
        </span>
        {open && <span className="flex-1" />}
        {json && (
          <button
            type="button"
            className="shrink-0 text-[var(--text-accent)] hover:underline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? t('apiTests.protocol.collapse') : t('apiTests.protocol.expand')}
          </button>
        )}
      </div>
      {open && json && (
        <div className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface-0)]">
          <RenderedCode code={json} language="json" />
        </div>
      )}
    </li>
  );
}

/** The messages of a WebSocket, SSE, socket or gRPC stream, in order, with filters. */
export function MessagesView({
  messages,
}: {
  readonly messages: readonly StreamMessage[];
}): React.JSX.Element {
  const { t } = useI18n();
  const [direction, setDirection] = useState<'all' | StreamMessage['direction']>('all');
  const [query, setQuery] = useState('');
  const start = messages[0]?.at ?? 0;
  const text = query.trim().toLowerCase();
  const shown = messages.filter(
    (message) =>
      (direction === 'all' || message.direction === direction) &&
      (!text || `${message.event ?? ''} ${message.data}`.toLowerCase().includes(text)),
  );
  return (
    <div className="flex flex-col" data-testid="response-messages">
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
        <Select
          selectSize="sm"
          containerClassName="w-36"
          aria-label={t('apiTests.protocol.direction')}
          value={direction}
          onChange={(event) => setDirection(event.target.value as typeof direction)}
        >
          <option value="all">{t('common.all')}</option>
          <option value="sent">{t('apiTests.protocol.directions.sent')}</option>
          <option value="received">{t('apiTests.protocol.directions.received')}</option>
          <option value="info">{t('apiTests.protocol.directions.info')}</option>
        </Select>
        <Input
          inputSize="sm"
          aria-label={t('apiTests.protocol.filterMessages')}
          placeholder={t('apiTests.protocol.filterMessages')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
          {shown.length}/{messages.length}
        </span>
      </div>
      {shown.length ? (
        <ul>
          {shown.map((message, index) => (
            <MessageRow key={index} message={message} start={start} />
          ))}
        </ul>
      ) : (
        <p className="p-3 text-xs text-[var(--text-muted)]">{t('apiTests.protocol.noMessages')}</p>
      )}
    </div>
  );
}

const LEVEL_CLASS: Record<ScriptLog['level'], string> = {
  log: 'text-[var(--text-primary)]',
  info: 'text-[var(--text-accent)]',
  warn: 'text-[var(--text-warning)]',
  error: 'text-[var(--text-danger)]',
  debug: 'text-[var(--text-muted)]',
};

/** What the scripts wrote with console.*, in order. */
export function ConsoleView({ logs }: { readonly logs: readonly ScriptLog[] }): React.JSX.Element {
  const { t } = useI18n();
  if (!logs.length)
    return (
      <p className="p-3 text-xs text-[var(--text-muted)]" data-testid="response-console">
        {t('apiTests.protocol.noLogs')}
      </p>
    );
  return (
    <ul className="flex flex-col font-mono text-xs" data-testid="response-console">
      {logs.map((log, index) => (
        <li
          key={index}
          className={cn(
            'flex items-start gap-2 border-b border-[var(--border)] px-3 py-1.5',
            LEVEL_CLASS[log.level],
          )}
        >
          <span className="w-12 shrink-0 uppercase opacity-70">{log.level}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all">{log.message}</span>
          <span className="shrink-0 text-[10px] text-[var(--text-muted)]">{log.source}</span>
        </li>
      ))}
    </ul>
  );
}

/** Assertions and script tests, each passed or failed. */
export function TestsView({
  assertions,
  tests,
}: {
  readonly assertions: readonly AssertionResult[];
  readonly tests: readonly AssertionResult[];
}): React.JSX.Element {
  const { t } = useI18n();
  const groups = [
    { id: 'assertions', title: t('apiTests.tabs.assertions'), items: assertions },
    { id: 'tests', title: t('apiTests.protocol.scriptTests'), items: tests },
  ].filter((group) => group.items.length);
  return (
    <div className="flex flex-col gap-3 p-2" data-testid="response-tests">
      {!groups.length && (
        <p className="p-2 text-xs text-[var(--text-muted)]">{t('apiTests.noAssertions')}</p>
      )}
      {groups.map((group) => (
        <section key={group.id} className="flex flex-col gap-0.5">
          <h3 className="px-2 text-[11px] font-semibold uppercase text-[var(--text-muted)]">
            {group.title}
          </h3>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item, index) => (
              <li
                key={`${item.id}-${index}`}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
              >
                <i
                  className={cn(
                    'ti mt-0.5',
                    item.passed
                      ? 'ti-check text-[var(--text-success)]'
                      : 'ti-x text-[var(--text-danger)]',
                  )}
                  aria-label={
                    item.passed ? t('apiTests.protocol.passed') : t('apiTests.protocol.failed')
                  }
                  role="img"
                />
                <span
                  className={cn(
                    'font-mono',
                    item.passed ? 'text-[var(--text-primary)]' : 'text-[var(--text-danger)]',
                  )}
                >
                  {item.label}
                </span>
                {!item.passed && item.actual !== undefined && (
                  <span className="ml-auto truncate text-[var(--text-muted)]">
                    {t('apiTests.actual')}: {item.actual}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** gRPC trailers, with the name of the status. */
export function TrailersView({
  trailers,
}: {
  readonly trailers: Readonly<Record<string, string>>;
}): React.JSX.Element {
  const { t } = useI18n();
  const status = headerValue(trailers, 'grpc-status');
  const message = headerValue(trailers, 'grpc-message');
  return (
    <div className="flex flex-col" data-testid="response-trailers">
      {status !== undefined && (
        <p className="border-b border-[var(--border)] px-3 py-2 font-mono text-xs text-[var(--text-primary)]">
          {grpcStatusLine(Number(status))}
          {message && <span className="text-[var(--text-secondary)]"> · {decode(message)}</span>}
        </p>
      )}
      <HeadersTable headers={trailers} empty={t('apiTests.protocol.noTrailers')} />
    </div>
  );
}
