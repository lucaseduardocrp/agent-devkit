import React from 'react';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import type { RequestResult, RequestTimeline } from '../api-test-types.js';
import { formatDuration, isOkStatus, type ResponseEntry } from './integration-model.js';
import { MethodLabel } from './integration-parts.js';

/** Name/value rows, as the Headers tab shows them. */
export function HeadersTable({
  headers,
  empty,
}: {
  readonly headers: Readonly<Record<string, string>>;
  readonly empty: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const rows = Object.entries(headers);
  if (!rows.length) return <p className="p-3 text-xs text-[var(--text-muted)]">{empty}</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
          <th className="px-3 py-2 font-medium">{t('common.name')}</th>
          <th className="px-3 py-2 font-medium">{t('apiTests.value')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key} className="border-b border-[var(--border)]">
            <td className="w-2/5 px-3 py-1.5 font-mono text-[var(--text-secondary)]">{key}</td>
            <td className="break-all px-3 py-1.5 font-mono text-[var(--text-primary)]">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const PHASES = ['dns', 'connect', 'tls', 'firstByte', 'download'] as const;
const PHASE_COLOR: Record<(typeof PHASES)[number], string> = {
  dns: 'bg-teal-400',
  connect: 'bg-orange-400',
  tls: 'bg-[var(--fill-pro)]',
  firstByte: 'bg-[var(--fill-accent)]',
  download: 'bg-[var(--fill-success)]',
};

/** The phases of the request as bars along its total time. */
function Timings({
  timings,
}: {
  readonly timings: NonNullable<RequestTimeline['timings']>;
}): React.JSX.Element {
  const { t } = useI18n();
  const total = Math.max(timings.total, 1);
  let offset = 0;
  return (
    <div className="flex flex-col gap-1.5" data-testid="timeline-timings">
      {PHASES.map((phase) => {
        const value = timings[phase];
        if (value === undefined) return null;
        const left = offset;
        offset += value;
        return (
          <div key={phase} className="grid grid-cols-[110px_1fr_64px] items-center gap-2">
            <span className="text-[var(--text-secondary)]">
              {t(`apiTests.protocol.phases.${phase}`)}
            </span>
            <div className="relative h-2 rounded-sm bg-[var(--surface-2)]">
              <div
                className={cn('absolute inset-y-0 rounded-sm', PHASE_COLOR[phase])}
                style={{
                  left: `${Math.min(100, (left / total) * 100)}%`,
                  width: `${Math.max(1, Math.min(100, (value / total) * 100))}%`,
                }}
              />
            </div>
            <span className="text-right font-mono text-[var(--text-primary)]">
              {formatDuration(Math.round(value))}
            </span>
          </div>
        );
      })}
      <div className="grid grid-cols-[110px_1fr_64px] gap-2 border-t border-[var(--border)] pt-1.5">
        <span className="font-semibold text-[var(--text-primary)]">
          {t('apiTests.protocol.phases.total')}
        </span>
        <span />
        <span className="text-right font-mono font-semibold text-[var(--text-primary)]">
          {formatDuration(Math.round(timings.total))}
        </span>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-[var(--text-primary)]">{title}</h3>
      {children}
    </section>
  );
}

/** The request as it was sent: method, URL, headers, body, the timings and the redirects. */
export function RequestTimelineView({
  result,
}: {
  readonly result: RequestResult;
}): React.JSX.Element {
  const { t } = useI18n();
  const timeline = result.timeline;
  if (!timeline)
    return (
      <p className="p-3 text-xs text-[var(--text-muted)]" data-testid="response-timeline">
        {t('apiTests.protocol.noTimeline')}
      </p>
    );
  return (
    <div className="flex flex-col gap-5 p-3 text-xs" data-testid="response-timeline">
      <Section title={t('apiTests.request')}>
        <p className="break-all font-mono">
          <span className="font-bold text-[var(--text-accent)]">{timeline.request.method}</span>{' '}
          <span className="text-[var(--text-primary)]">{timeline.request.url}</span>
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[var(--text-secondary)]">
          {timeline.httpVersion && (
            <>
              <dt>{t('apiTests.protocol.httpVersion')}</dt>
              <dd className="font-mono text-[var(--text-primary)]">{timeline.httpVersion}</dd>
            </>
          )}
          {timeline.remoteAddress && (
            <>
              <dt>{t('apiTests.protocol.remoteAddress')}</dt>
              <dd className="font-mono text-[var(--text-primary)]">{timeline.remoteAddress}</dd>
            </>
          )}
        </dl>
        <div className="rounded-md border border-[var(--border)]">
          <HeadersTable headers={timeline.request.headers} empty={t('apiTests.ui.noHeaders')} />
        </div>
        {timeline.request.bodyPreview && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2 font-mono text-[var(--text-primary)]">
            {timeline.request.bodyPreview}
          </pre>
        )}
      </Section>
      {timeline.timings && (
        <Section title={t('apiTests.protocol.timings')}>
          <Timings timings={timeline.timings} />
        </Section>
      )}
      {timeline.redirects?.length ? (
        <Section title={t('apiTests.protocol.redirects')}>
          <ol className="flex flex-col gap-1" data-testid="timeline-redirects">
            {timeline.redirects.map((redirect, index) => (
              <li key={index} className="flex gap-2 font-mono">
                <span className="text-[var(--text-warning)]">{redirect.status}</span>
                <span className="break-all text-[var(--text-secondary)]">{redirect.url}</span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
    </div>
  );
}

/** The sends of the request, newest first. */
export function HistoryList({
  entries,
}: {
  readonly entries: readonly ResponseEntry[];
}): React.JSX.Element {
  return (
    <ul className="flex flex-col" data-testid="response-history">
      {entries.map((entry, index) => (
        <li
          key={`${entry.runId}-${index}`}
          className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-xs"
        >
          <span className="w-16 shrink-0 font-mono text-[var(--text-muted)]">
            {new Date(entry.at).toLocaleTimeString()}
          </span>
          {entry.result && <MethodLabel method={entry.result.method} kind={entry.result.kind} />}
          <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">
            {entry.result?.url ?? entry.error}
          </span>
          {entry.result && (
            <>
              <span
                className={cn(
                  'font-mono',
                  isOkStatus(entry.result.kind, entry.result.status)
                    ? 'text-[var(--text-success)]'
                    : 'text-[var(--text-danger)]',
                )}
              >
                {entry.result.status ?? '—'}
              </span>
              <span className="w-14 text-right font-mono text-[var(--text-muted)]">
                {formatDuration(entry.result.durationMs)}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
