import React, { useMemo, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import {
  flattenItems,
  isActiveRun,
  type ApiCollection,
  type ApiRun,
  type ApiRunTarget,
  type CollectionRunResult,
} from '../api-test-types.js';
import { RunStatusBadge } from '../ApiTestShared.js';
import { formatDuration } from './integration-model.js';
import { EmptyPane, MethodLabel } from './integration-parts.js';
import { ResponsePane } from './ResponsePane.js';

type Filter = 'all' | 'passed' | 'failed';

export function CollectionRunner({
  collection,
  run,
  target,
  readOnly,
  onRun,
  onCancel,
  onReset,
  onOpenRequest,
}: {
  readonly collection: ApiCollection;
  readonly run: ApiRun<CollectionRunResult> | null;
  readonly target: ApiRunTarget;
  readonly readOnly: boolean;
  readonly onRun: (options: { itemIds: string[]; bail: boolean }) => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  readonly onOpenRequest: (requestId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const requests = useMemo(() => flattenItems(collection.items), [collection.items]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [bail, setBail] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number | null>(null);

  const selectedIds = requests.map((entry) => entry.request.id).filter((id) => !excluded.has(id));
  const start = () =>
    onRun({ itemIds: selectedIds.length === requests.length ? [] : selectedIds, bail });
  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const results = run?.result?.results ?? [];
  const shown = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) =>
      filter === 'all' ? true : filter === 'passed' ? result.passed : !result.passed,
    );
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  const current = selected !== null ? results[selected] : undefined;
  const active = run ? isActiveRun(run) : false;
  const total = run?.result?.total ?? 0;

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t('apiTests.ui.runnerTitle')}
      data-testid="collection-runner"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <i className="ti ti-run text-lg text-[var(--text-accent)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {t('apiTests.ui.runnerTitle')}
          </h2>
          <p className="truncate text-xs text-[var(--text-muted)]">{collection.name}</p>
        </div>
        {run && <RunStatusBadge status={run.status} />}
        {run && active && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            <i className="ti ti-player-stop" aria-hidden="true" />
            {t('apiTests.cancelRun')}
          </Button>
        )}
        {run && !active && !readOnly && (
          <>
            <Button size="sm" onClick={start} data-testid="run-again">
              <i className="ti ti-refresh" aria-hidden="true" />
              {t('apiTests.ui.runAgain')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onReset}>
              {t('apiTests.ui.reset')}
            </Button>
          </>
        )}
      </header>

      {!run ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.ui.runnerHint')}</p>
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface-1)]">
              <label className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={excluded.size === 0}
                  onChange={(event) =>
                    setExcluded(
                      event.target.checked
                        ? new Set()
                        : new Set(requests.map((entry) => entry.request.id)),
                    )
                  }
                />
                {t('apiTests.ui.selectAll')}
                <span className="ml-auto font-normal text-[var(--text-muted)]">
                  {selectedIds.length}/{requests.length}
                </span>
              </label>
              <ul className="max-h-[50vh] overflow-y-auto">
                {requests.map(({ request, path }) => (
                  <li key={request.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--fill-ghost-hover)]">
                      <input
                        type="checkbox"
                        checked={!excluded.has(request.id)}
                        onChange={() => toggle(request.id)}
                        aria-label={request.name}
                      />
                      <MethodLabel method={request.method} className="w-8" />
                      <span className="truncate text-[var(--text-primary)]">
                        {[...path, request.name].join(' / ')}
                      </span>
                    </label>
                  </li>
                ))}
                {!requests.length && (
                  <li className="p-3 text-xs text-[var(--text-muted)]">
                    {t('apiTests.noRequests')}
                  </li>
                )}
              </ul>
            </div>
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={bail}
                onChange={(event) => setBail(event.target.checked)}
              />
              {t('apiTests.bail')}
            </label>
            {!readOnly && (
              <Button
                className="self-start"
                disabled={!selectedIds.length}
                onClick={start}
                data-testid="run-collection"
              >
                <i className="ti ti-player-play" aria-hidden="true" />
                {t('apiTests.runCollection')}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1" data-testid="run-results">
          <div className="flex w-1/2 min-w-[300px] flex-col border-r border-[var(--border)]">
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border)] px-4 py-2 text-xs">
              <span className="text-[var(--text-secondary)]">
                {t('apiTests.ui.totalRequests', { n: total || results.length })}
              </span>
              <span className="text-[var(--text-success)]">
                {t('apiTests.ui.passedCount', { n: passed })}
              </span>
              <span className={failed ? 'text-[var(--text-danger)]' : 'text-[var(--text-muted)]'}>
                {t('apiTests.ui.failedCount', { n: failed })}
              </span>
              {run.result && (
                <span className="text-[var(--text-muted)]">
                  {formatDuration(run.result.durationMs)}
                </span>
              )}
              <span
                className="ml-auto flex items-center gap-0.5"
                role="group"
                aria-label={t('apiTests.filter')}
              >
                {(['all', 'passed', 'failed'] as const).map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={filter === key ? 'secondary' : 'ghost'}
                    className="h-7 px-2"
                    onClick={() => setFilter(key)}
                  >
                    {key === 'all' ? t('common.all') : t(`apiTests.ui.${key}`)}
                  </Button>
                ))}
              </span>
            </div>
            {active && total > 0 && (
              <div className="h-0.5 w-full shrink-0 bg-[var(--surface-2)]">
                <div
                  className="h-full bg-[var(--fill-accent)] transition-all"
                  style={{ width: `${Math.round((results.length / total) * 100)}%` }}
                />
              </div>
            )}
            {run.error && (
              <p role="alert" className="m-3 text-xs text-[var(--text-danger)]">
                {run.error}
              </p>
            )}
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {shown.map(({ result, index }) => (
                <li key={`${result.requestId}-${index}`} className="group flex items-center">
                  <button
                    type="button"
                    onClick={() => setSelected(index)}
                    className={cn(
                      'flex h-9 min-w-0 flex-1 items-center gap-2 px-4 text-left text-xs hover:bg-[var(--fill-ghost-hover)]',
                      selected === index && 'bg-[var(--fill-ghost-selected)]',
                    )}
                  >
                    <i
                      className={cn(
                        'ti',
                        result.passed
                          ? 'ti-circle-check text-[var(--text-success)]'
                          : 'ti-circle-x text-[var(--text-danger)]',
                      )}
                      aria-hidden="true"
                    />
                    <MethodLabel method={result.method} className="w-8" />
                    <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                      {[...result.path, result.name].join(' / ')}
                    </span>
                    <span
                      className={cn(
                        'font-mono',
                        result.status !== null && result.status < 400
                          ? 'text-[var(--text-success)]'
                          : 'text-[var(--text-danger)]',
                      )}
                    >
                      {result.status ?? '—'}
                    </span>
                    <span className="w-14 text-right font-mono text-[var(--text-muted)]">
                      {formatDuration(result.durationMs)}
                    </span>
                  </button>
                  <IconButton
                    size="xs"
                    className="invisible mr-2 group-hover:visible"
                    icon={<i className="ti ti-external-link" aria-hidden="true" />}
                    label={t('apiTests.ui.openRequest')}
                    onClick={() => onOpenRequest(result.requestId)}
                  />
                </li>
              ))}
              {!results.length && (
                <li className="p-4 text-xs text-[var(--text-muted)]">
                  {run.status === 'queued' && run.target === 'local'
                    ? t('apiTests.localRunHint')
                    : t('apiTests.waitingResults')}
                </li>
              )}
            </ul>
          </div>
          <div className="min-w-0 flex-1">
            {current ? (
              <ResponsePane
                key={selected}
                target={target}
                entries={[
                  {
                    runId: run.id,
                    at: Date.parse(run.finishedAt ?? run.createdAt) || Date.now(),
                    result: current,
                    error: null,
                  },
                ]}
              />
            ) : (
              <EmptyPane icon="ti-list-details">
                <p>{t('apiTests.ui.selectResult')}</p>
              </EmptyPane>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
