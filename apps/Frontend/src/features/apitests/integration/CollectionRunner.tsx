import React, { useMemo, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import {
  flattenItems,
  isActiveRun,
  type ApiCollection,
  type ApiRun,
  type ApiRunTarget,
  type CollectionRunResult,
  type RequestResult,
} from '../api-test-types.js';
import { downloadBlob } from '../api-test-ui.js';
import { RunStatusBadge } from '../ApiTestShared.js';
import { FileButton } from './ClientCertificates.js';
import { readFileText } from './file-read.js';
import { formatDuration } from './integration-model.js';
import { EmptyPane, MethodLabel, SettingField } from './integration-parts.js';
import { ResponsePane } from './ResponsePane.js';
import { MAX_DATA_COLUMNS, MAX_DATA_ROWS, parseDataFile, type DataFile } from './runner-data.js';

type Filter = 'all' | 'passed' | 'failed' | 'skipped';

export interface RunnerOptions {
  readonly itemIds: string[];
  readonly bail: boolean;
  readonly iterations: number;
  readonly delayMs: number;
  /** Rows of the data file; each iteration takes the next one. */
  readonly data?: Record<string, string>[];
}

const PREVIEW_ROWS = 5;
const status = (result: RequestResult): Exclude<Filter, 'all'> =>
  result.skipped ? 'skipped' : result.passed ? 'passed' : 'failed';
const STATUS_ICON = {
  passed: 'ti-circle-check text-[var(--text-success)]',
  failed: 'ti-circle-x text-[var(--text-danger)]',
  skipped: 'ti-player-skip-forward text-[var(--text-muted)]',
} as const;

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
  readonly onRun: (options: RunnerOptions) => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
  readonly onOpenRequest: (requestId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const requests = useMemo(() => flattenItems(collection.items), [collection.items]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [bail, setBail] = useState(false);
  const [iterations, setIterations] = useState(1);
  const [delayMs, setDelayMs] = useState(0);
  const [data, setData] = useState<{ name: string; file: DataFile } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<number | null>(null);

  const selectedIds = requests.map((entry) => entry.request.id).filter((id) => !excluded.has(id));
  const rows = data?.file.ok ? data.file.rows : undefined;
  const start = () =>
    onRun({
      itemIds: selectedIds.length === requests.length ? [] : selectedIds,
      bail,
      // With a data file, one iteration per row unless fewer were asked.
      iterations: rows
        ? Math.min(iterations > 1 ? iterations : rows.length, rows.length)
        : iterations,
      delayMs,
      ...(rows ? { data: rows } : {}),
    });
  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const loadData = (files: File[]) => {
    const file = files[0]!;
    void readFileText(file).then(
      (text) => setData({ name: file.name, file: parseDataFile(text, file.name) }),
      () => setData({ name: file.name, file: { ok: false, error: 'empty' } }),
    );
  };

  const results = run?.result?.results ?? [];
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let testsPassed = 0;
  let testsTotal = 0;
  for (const result of results) {
    counts[status(result)]++;
    const checks = [...result.assertions, ...(result.tests ?? [])];
    testsTotal += checks.length;
    testsPassed += checks.filter((check) => check.passed).length;
  }
  const shown = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => filter === 'all' || status(result) === filter);
  const groups = new Map<number, typeof shown>();
  for (const entry of shown) {
    const iteration = entry.result.iteration ?? 1;
    groups.set(iteration, [...(groups.get(iteration) ?? []), entry]);
  }
  const grouped = (run?.result?.iterations ?? 1) > 1 || groups.size > 1;
  const current = selected !== null ? results[selected] : undefined;
  const active = run ? isActiveRun(run) : false;
  const total = run?.result?.total ?? 0;

  const exportResults = () =>
    run &&
    downloadBlob(
      new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
      `${collection.name.replace(/[^\w.-]+/g, '-')}-run-${run.id}.json`,
    );

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
        {run && !active && (
          <Button variant="secondary" size="sm" onClick={exportResults} data-testid="export-run">
            <i className="ti ti-download" aria-hidden="true" />
            {t('apiTests.workbench.exportResults')}
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
              <ul className="max-h-[40vh] overflow-y-auto">
                {requests.map(({ request, path }) => (
                  <li key={request.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--fill-ghost-hover)]">
                      <input
                        type="checkbox"
                        checked={!excluded.has(request.id)}
                        onChange={() => toggle(request.id)}
                        aria-label={request.name}
                      />
                      <MethodLabel method={request.method} kind={request.kind} className="w-8" />
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
            <div className="grid grid-cols-2 gap-3">
              <SettingField
                label={t('apiTests.workbench.iterations')}
                hint={t('apiTests.workbench.iterationsHint')}
              >
                <Input
                  type="number"
                  min={1}
                  max={MAX_DATA_ROWS}
                  aria-label={t('apiTests.workbench.iterations')}
                  value={iterations}
                  onChange={(event) =>
                    setIterations(
                      Math.min(MAX_DATA_ROWS, Math.max(1, Number(event.target.value) || 1)),
                    )
                  }
                  data-testid="runner-iterations"
                />
              </SettingField>
              <SettingField label={t('apiTests.workbench.delay')}>
                <Input
                  type="number"
                  min={0}
                  aria-label={t('apiTests.workbench.delay')}
                  value={delayMs}
                  onChange={(event) => setDelayMs(Math.max(0, Number(event.target.value) || 0))}
                  data-testid="runner-delay"
                />
              </SettingField>
            </div>
            <div className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-[var(--text-primary)]">
                  {t('apiTests.workbench.dataFile')}
                </span>
                {data && (
                  <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">
                    {data.name}
                  </span>
                )}
                <span className="ml-auto flex gap-2">
                  <FileButton
                    label={t('apiTests.workbench.chooseDataFile')}
                    accept=".csv,.json,text/csv,application/json"
                    onFiles={loadData}
                    testId="data-file-input"
                  />
                  {data && (
                    <Button variant="ghost" size="sm" onClick={() => setData(null)}>
                      {t('apiTests.remove')}
                    </Button>
                  )}
                </span>
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                {t('apiTests.workbench.dataFileHint', {
                  rows: MAX_DATA_ROWS,
                  columns: MAX_DATA_COLUMNS,
                })}
              </p>
              {data && !data.file.ok && (
                <p role="alert" className="text-xs text-[var(--text-danger)]">
                  {t(`apiTests.workbench.dataErrors.${data.file.error}`, {
                    rows: MAX_DATA_ROWS,
                    columns: MAX_DATA_COLUMNS,
                  })}
                </p>
              )}
              {data?.file.ok && (
                <div className="overflow-x-auto" data-testid="data-preview">
                  <p className="mb-1 text-[11px] text-[var(--text-secondary)]">
                    {t('apiTests.workbench.dataRows', { n: data.file.rows.length })}
                  </p>
                  <table className="w-full text-left font-mono text-[11px]">
                    <thead>
                      <tr className="text-[var(--text-muted)]">
                        {data.file.columns.map((column) => (
                          <th key={column} className="border-b border-[var(--border)] px-2 py-1">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.file.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                        <tr key={index} className="text-[var(--text-primary)]">
                          {data.file.ok &&
                            data.file.columns.map((column) => (
                              <td key={column} className="max-w-48 truncate px-2 py-1">
                                {row[column]}
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
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
                disabled={!selectedIds.length || Boolean(data && !data.file.ok)}
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
                {t('apiTests.ui.passedCount', { n: counts.passed })}
              </span>
              <span
                className={counts.failed ? 'text-[var(--text-danger)]' : 'text-[var(--text-muted)]'}
              >
                {t('apiTests.ui.failedCount', { n: counts.failed })}
              </span>
              {counts.skipped > 0 && (
                <span className="text-[var(--text-muted)]">
                  {t('apiTests.workbench.skippedCount', { n: counts.skipped })}
                </span>
              )}
              <span className="text-[var(--text-muted)]" data-testid="tests-count">
                {t('apiTests.workbench.testsCount', { passed: testsPassed, total: testsTotal })}
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
                {(['all', 'passed', 'failed', 'skipped'] as const).map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={filter === key ? 'secondary' : 'ghost'}
                    className="h-7 px-2"
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    {key === 'all'
                      ? t('common.all')
                      : key === 'skipped'
                        ? t('apiTests.workbench.skipped')
                        : t(`apiTests.ui.${key}`)}
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              {[...groups].map(([iteration, entries]) => (
                <section
                  key={iteration}
                  aria-label={
                    grouped ? t('apiTests.workbench.iteration', { n: iteration }) : undefined
                  }
                >
                  {grouped && (
                    <h3 className="sticky top-0 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      {t('apiTests.workbench.iteration', { n: iteration })}
                    </h3>
                  )}
                  <ul>
                    {entries.map(({ result, index }) => (
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
                            className={cn('ti', STATUS_ICON[status(result)])}
                            aria-label={t(
                              status(result) === 'skipped'
                                ? 'apiTests.workbench.skipped'
                                : `apiTests.ui.${status(result) as 'passed' | 'failed'}`,
                            )}
                          />
                          <MethodLabel method={result.method} kind={result.kind} className="w-8" />
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate',
                              result.skipped
                                ? 'text-[var(--text-muted)]'
                                : 'text-[var(--text-primary)]',
                            )}
                          >
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
                            {result.skipped ? '' : (result.status ?? '—')}
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
                  </ul>
                </section>
              ))}
              {!results.length && (
                <p className="p-4 text-xs text-[var(--text-muted)]">
                  {run.status === 'queued' && run.target === 'local'
                    ? t('apiTests.localRunHint')
                    : t('apiTests.waitingResults')}
                </p>
              )}
            </div>
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
