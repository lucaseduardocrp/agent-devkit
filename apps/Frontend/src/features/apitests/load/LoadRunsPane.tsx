import React from 'react';
import { Button } from '../../../components/ui/button.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { isActiveRun, type ApiRun, type LoadSummary, type LoadTick } from '../api-test-types.js';
import { RunStatusBadge } from '../ApiTestShared.js';
import { EmptyPane } from '../integration/integration-parts.js';
import { AreaChart } from './load-charts.js';
import { formatMetric } from './load-model.js';

const seconds = (value: number) => `${Math.round(value)}s`;

function Timeline({ timeline }: { readonly timeline: readonly LoadTick[] }): React.JSX.Element {
  const { t } = useI18n();
  if (timeline.length < 2)
    return <p className="text-xs text-[var(--text-muted)]">{t('apiTests.waitingMetrics')}</p>;
  const series: {
    key: 'rps' | 'p95' | 'vus' | 'errors';
    y: (tick: LoadTick) => number;
    format: (v: number) => string;
  }[] = [
    { key: 'rps', y: (tick) => tick.requests, format: (v) => `${Math.round(v)}/s` },
    { key: 'p95', y: (tick) => tick.p95, format: (v) => `${Math.round(v)} ms` },
    { key: 'vus', y: (tick) => tick.vus, format: (v) => String(Math.round(v)) },
    { key: 'errors', y: (tick) => tick.errors, format: (v) => `${Math.round(v)}/s` },
  ];
  return (
    <div className="grid gap-x-8 gap-y-6 md:grid-cols-2" data-testid="timeline-chart">
      {series.map((item) => (
        <AreaChart
          key={item.key}
          title={t(`apiTests.series.${item.key}`)}
          points={timeline.map((tick) => ({ x: tick.t, y: item.y(tick) }))}
          formatX={seconds}
          formatY={item.format}
          height={96}
        />
      ))}
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
    <section className="flex flex-col gap-3 border-t border-[var(--border)] pt-5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      {children}
    </section>
  );
}

export function LoadRunDetail({
  run,
  onCancel,
}: {
  readonly run: ApiRun<LoadSummary>;
  readonly onCancel?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const summary = run.result;
  const tiles: [string, string][] = summary
    ? [
        [t('apiTests.metrics.requests'), String(summary.totalRequests)],
        [t('apiTests.metrics.rps'), `${summary.rps}/s`],
        [t('apiTests.metrics.p95'), `${summary.latency.p95} ms`],
        [t('apiTests.metrics.p99'), `${summary.latency.p99} ms`],
        [t('apiTests.metrics.avg'), `${summary.latency.avg} ms`],
        [t('apiTests.metrics.errorRate'), `${(summary.errorRate * 100).toFixed(2)} %`],
        [t('apiTests.metrics.maxVus'), String(summary.maxVus)],
        [t('apiTests.metrics.duration'), `${summary.durationSec} s`],
      ]
    : [];
  return (
    <div className="flex flex-col gap-5" data-testid="load-run-detail">
      <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
        <RunStatusBadge status={run.status} />
        <span className="flex items-center gap-1.5">
          <i
            className={cn('ti', run.target === 'local' ? 'ti-device-laptop' : 'ti-cloud')}
            aria-hidden="true"
          />
          {t(run.target === 'local' ? 'apiTests.targetLocal' : 'apiTests.targetRemote')}
        </span>
        {run.claimLabel && <span className="text-[var(--text-muted)]">{run.claimLabel}</span>}
        <span className="text-[var(--text-muted)]">{new Date(run.createdAt).toLocaleString()}</span>
        {summary?.abortedBy && (
          <span className="flex items-center gap-1 text-[var(--text-warning)]">
            <i className="ti ti-alert-triangle" aria-hidden="true" />
            {t('apiTests.abortedBy', { metric: summary.abortedBy })}
          </span>
        )}
        {isActiveRun(run) && onCancel && (
          <Button variant="secondary" size="sm" className="ml-auto" onClick={onCancel}>
            <i className="ti ti-player-stop" aria-hidden="true" />
            {t('apiTests.cancelRun')}
          </Button>
        )}
      </div>
      {run.error && (
        <p
          role="alert"
          className="rounded-md bg-[var(--bg-danger)] p-3 text-xs text-[var(--text-danger)]"
        >
          {run.error}
        </p>
      )}
      {run.status === 'queued' && run.target === 'local' && (
        <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.localRunHint')}</p>
      )}
      {isActiveRun(run) && !summary && (
        <p className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
          {t('apiTests.waitingMetrics')}
        </p>
      )}
      {summary && (
        <>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
            {tiles.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-[var(--surface-0)] p-4">
                <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
                <dd className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {summary.timeline && (
            <Section title={t('apiTests.timeline')}>
              <Timeline timeline={summary.timeline} />
            </Section>
          )}

          {summary.thresholds.length > 0 && (
            <Section title={t('apiTests.thresholds')}>
              <ul
                className="flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]"
                aria-label={t('apiTests.thresholds')}
              >
                {summary.thresholds.map((threshold, index) => (
                  <li key={index} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <i
                      className={cn(
                        'ti',
                        threshold.passed
                          ? 'ti-circle-check text-[var(--text-success)]'
                          : 'ti-circle-x text-[var(--text-danger)]',
                      )}
                      aria-hidden="true"
                    />
                    <span className="font-mono text-[var(--text-primary)]">
                      {t(`apiTests.metrics.${threshold.metric}`)}{' '}
                      {{ lt: '<', lte: '≤', gt: '>', gte: '≥' }[threshold.operator]}{' '}
                      {formatMetric(threshold.metric, threshold.value)}
                    </span>
                    <span className="ml-auto text-xs text-[var(--text-muted)]">
                      {t('apiTests.actual')}:{' '}
                      <span className="font-mono text-[var(--text-secondary)]">
                        {formatMetric(threshold.metric, threshold.actual)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="grid gap-6 border-t border-[var(--border)] pt-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {t('apiTests.statusCodes')}
              </h3>
              <ul className="flex flex-col gap-1 text-xs">
                {Object.entries(summary.statusCodes).map(([code, count]) => (
                  <li key={code} className="flex justify-between font-mono">
                    <span
                      className={
                        Number(code) < 400
                          ? 'text-[var(--text-success)]'
                          : 'text-[var(--text-danger)]'
                      }
                    >
                      {code}
                    </span>
                    <span className="text-[var(--text-secondary)]">{count}</span>
                  </li>
                ))}
              </ul>
              {Object.keys(summary.errors).length > 0 && (
                <>
                  <h3 className="mt-2 text-sm font-semibold text-[var(--text-primary)]">
                    {t('apiTests.errors')}
                  </h3>
                  <ul className="flex flex-col gap-1 text-xs">
                    {Object.entries(summary.errors).map(([message, count]) => (
                      <li key={message} className="flex justify-between gap-2">
                        <span className="truncate text-[var(--text-danger)]">{message}</span>
                        <span className="font-mono text-[var(--text-secondary)]">{count}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            {summary.perRequest && (
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t('apiTests.loadUi.perRequest')}
                </h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                      <th className="pb-2 font-medium">{t('apiTests.request')}</th>
                      <th className="pb-2 text-right font-medium">
                        {t('apiTests.metrics.requests')}
                      </th>
                      <th className="pb-2 text-right font-medium">{t('apiTests.failedShort')}</th>
                      <th className="pb-2 text-right font-medium">{t('apiTests.metrics.avg')}</th>
                      <th className="pb-2 text-right font-medium">p95</th>
                    </tr>
                  </thead>
                  <tbody className="text-[var(--text-secondary)]">
                    {summary.perRequest.map((entry) => (
                      <tr
                        key={entry.requestId}
                        className="border-b border-[var(--border)] last:border-0"
                      >
                        <td className="truncate py-2 pr-2 text-[var(--text-primary)]">
                          {entry.name}
                        </td>
                        <td className="py-2 text-right font-mono">{entry.count}</td>
                        <td
                          className={cn(
                            'py-2 text-right font-mono',
                            entry.failed > 0 && 'text-[var(--text-danger)]',
                          )}
                        >
                          {entry.failed}
                        </td>
                        <td className="py-2 text-right font-mono">{entry.avg} ms</td>
                        <td className="py-2 text-right font-mono">{entry.p95} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Runs of the scenario, newest first, and the one being looked at. */
export function LoadRunsPane({
  runs,
  run,
  onSelect,
  onCancel,
}: {
  readonly runs: readonly ApiRun[];
  readonly run: ApiRun<LoadSummary> | null;
  readonly onSelect: (id: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  if (!runs.length && !run) {
    return (
      <EmptyPane icon="ti-chart-line !text-6xl opacity-40">
        <p>{t('apiTests.noRuns')}</p>
      </EmptyPane>
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <ul
        className="w-60 shrink-0 overflow-y-auto border-r border-[var(--border)] py-1"
        aria-label={t('apiTests.loadUi.runs')}
      >
        {runs.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className={cn(
                'flex w-full flex-col items-start gap-1.5 px-4 py-2.5 text-left hover:bg-[var(--fill-ghost-hover)]',
                run?.id === item.id && 'bg-[var(--fill-ghost-selected)]',
              )}
            >
              <RunStatusBadge status={item.status} />
              <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                <i
                  className={cn('ti', item.target === 'local' ? 'ti-device-laptop' : 'ti-cloud')}
                  aria-hidden="true"
                />
                {new Date(item.createdAt).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {run ? (
          <div className="mx-auto max-w-5xl">
            <LoadRunDetail run={run} onCancel={onCancel} />
          </div>
        ) : (
          <EmptyPane icon="ti-list-details">
            <p>{t('apiTests.selectRun')}</p>
          </EmptyPane>
        )}
      </div>
    </div>
  );
}
