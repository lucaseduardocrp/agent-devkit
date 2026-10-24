import React, { useEffect, useState } from 'react';
import { ActionsMenu } from '../../../components/ui/actions-menu.js';
import { Button } from '../../../components/ui/button.js';
import { ModeSwitch, type ViewMode } from '../../../components/ui/mode-switch.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { RenderedCode } from '../../brain/RenderedCode.js';
import type { ApiRunTarget } from '../api-test-types.js';
import { downloadBlob } from '../api-test-ui.js';
import {
  formatDuration,
  formatSize,
  prettyBody,
  statusLine,
  type PaneLayout,
  type PendingSend,
  type ResponseEntry,
} from './integration-model.js';
import { EmptyPane, MethodLabel, PaneTabs } from './integration-parts.js';

type ResponseTab = 'response' | 'headers' | 'timeline' | 'tests';

function Stopwatch({ since }: { readonly since: number }): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-2xl text-[var(--text-primary)]">
      {formatDuration(Math.max(0, now - since))}
    </span>
  );
}

function Shortcuts(): React.JSX.Element {
  const { t } = useI18n();
  const rows = [
    [t('apiTests.ui.shortcutSend'), 'Ctrl + Enter'],
    [t('apiTests.ui.shortcutSave'), 'Ctrl + S'],
  ];
  return (
    <EmptyPane icon="ti-send !text-7xl opacity-40">
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2" data-testid="response-placeholder">
        {rows.map(([label, keys]) => (
          <React.Fragment key={label}>
            <dt className="text-right">{label}</dt>
            <dd className="text-left font-mono text-[var(--text-secondary)]">{keys}</dd>
          </React.Fragment>
        ))}
      </dl>
    </EmptyPane>
  );
}

export function ResponsePane({
  entries,
  pending,
  target,
  layout,
  onToggleLayout,
  onClear,
  onCancel,
}: {
  /** Newest first. */
  readonly entries: readonly ResponseEntry[];
  readonly pending?: PendingSend | null;
  readonly target: ApiRunTarget;
  readonly layout?: PaneLayout;
  readonly onToggleLayout?: () => void;
  readonly onClear?: () => void;
  readonly onCancel?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<ResponseTab>('response');
  const [mode, setMode] = useState<ViewMode>('preview');
  const latest = entries[0] ?? null;
  const result = latest?.result ?? null;
  const headers = Object.entries(result?.response?.headers ?? {});
  const passed = result?.assertions.filter((assertion) => assertion.passed).length ?? 0;
  const failed = (result?.assertions.length ?? 0) - passed;
  const raw = result?.response?.bodyPreview ?? '';
  const body = prettyBody(raw);
  const ok = result?.status !== null && result?.status !== undefined && result.status < 400;

  if (pending) {
    return (
      <section
        className="flex h-full min-h-0 min-w-0 flex-col"
        aria-label={t('apiTests.response')}
        data-testid="response-pane"
      >
        <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
          <Stopwatch since={pending.startedAt} />
          <i
            className="ti ti-refresh animate-spin text-2xl text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <p className="max-w-sm text-xs text-[var(--text-secondary)]">
            {pending.status === 'queued' && target === 'local'
              ? t('apiTests.localRunHint')
              : t('apiTests.sending')}
          </p>
          {onCancel && (
            <Button variant="secondary" size="sm" onClick={onCancel}>
              {t('apiTests.ui.cancelRequest')}
            </Button>
          )}
        </div>
      </section>
    );
  }

  if (!latest) {
    return (
      <section
        className="flex h-full min-h-0 min-w-0 flex-col"
        aria-label={t('apiTests.response')}
        data-testid="response-pane"
      >
        <Shortcuts />
      </section>
    );
  }

  const copy = () => void navigator.clipboard?.writeText(raw);
  const download = () =>
    downloadBlob(
      new Blob([raw], { type: 'text/plain' }),
      `response.${body.language === 'json' ? 'json' : 'txt'}`,
    );

  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={t('apiTests.response')}
      data-testid="response-pane"
    >
      <PaneTabs
        label={t('apiTests.response')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'response', label: t('apiTests.response') },
          { id: 'headers', label: t('apiTests.tabs.headers'), indicator: headers.length },
          { id: 'timeline', label: t('apiTests.timeline') },
          {
            id: 'tests',
            label: t('apiTests.tests'),
            indicator: result?.assertions.length ? `${passed}/${result.assertions.length}` : '',
            tone: failed ? 'danger' : 'success',
          },
        ]}
        right={
          <>
            {result && (
              <div className="flex items-center gap-2 text-xs" data-testid="response-pane-status">
                <span
                  className={cn(
                    'font-semibold',
                    ok ? 'text-[var(--text-success)]' : 'text-[var(--text-danger)]',
                  )}
                  data-testid="response-status"
                >
                  {result.status === null ? t('apiTests.noResponse') : statusLine(result.status)}
                </span>
                <span className="text-[var(--text-secondary)]">
                  {formatDuration(result.durationMs)}
                </span>
                <span className="text-[var(--text-secondary)]">{formatSize(result.sizeBytes)}</span>
              </div>
            )}
            <div className="[&_button[aria-haspopup]]:h-7 [&_button[aria-haspopup]]:w-7">
              <ActionsMenu portal label={t('apiTests.ui.responseActions')}>
                <Button variant="ghost" role="menuitem" onClick={copy} disabled={!raw}>
                  <i className="ti ti-copy" aria-hidden="true" />
                  {t('apiTests.ui.copyResponse')}
                </Button>
                <Button variant="ghost" role="menuitem" onClick={download} disabled={!raw}>
                  <i className="ti ti-download" aria-hidden="true" />
                  {t('apiTests.ui.downloadResponse')}
                </Button>
                {onClear && (
                  <Button variant="ghost" role="menuitem" onClick={onClear}>
                    <i className="ti ti-eraser" aria-hidden="true" />
                    {t('apiTests.ui.clearResponse')}
                  </Button>
                )}
                {onToggleLayout && (
                  <Button variant="ghost" role="menuitem" onClick={onToggleLayout}>
                    <i
                      className={cn(
                        'ti',
                        layout === 'vertical' ? 'ti-layout-columns' : 'ti-layout-rows',
                      )}
                      aria-hidden="true"
                    />
                    {t('apiTests.ui.changeLayout')}
                  </Button>
                )}
              </ActionsMenu>
            </div>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
        {tab === 'response' && (
          <>
            {(latest.error ?? result?.error) && (
              <div
                role="alert"
                className="m-3 rounded-md border border-[var(--bg-danger)] bg-[var(--bg-danger)] p-3 text-xs text-[var(--text-danger)]"
              >
                {latest.error ?? result?.error}
              </div>
            )}
            {result?.response && (
              <div className="relative" data-testid="response-body">
                <div className="sticky top-0 z-10 float-right p-2">
                  <ModeSwitch
                    mode={mode}
                    onChange={setMode}
                    ariaLabel={t('apiTests.ui.responseFormat')}
                  />
                </div>
                {mode === 'preview' ? (
                  <RenderedCode
                    code={body.code || t('apiTests.emptyBody')}
                    language={body.language}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-all p-3.5 font-mono text-xs text-[var(--text-primary)]">
                    {raw || t('apiTests.emptyBody')}
                  </pre>
                )}
              </div>
            )}
          </>
        )}
        {tab === 'headers' &&
          (headers.length ? (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
                  <th className="px-3 py-2 font-medium">{t('common.name')}</th>
                  <th className="px-3 py-2 font-medium">{t('apiTests.value')}</th>
                </tr>
              </thead>
              <tbody>
                {headers.map(([key, value]) => (
                  <tr key={key} className="border-b border-[var(--border)]">
                    <td className="w-2/5 px-3 py-1.5 font-mono text-[var(--text-secondary)]">
                      {key}
                    </td>
                    <td className="break-all px-3 py-1.5 font-mono text-[var(--text-primary)]">
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-3 text-xs text-[var(--text-muted)]">{t('apiTests.ui.noHeaders')}</p>
          ))}
        {tab === 'timeline' && (
          <ul className="flex flex-col" data-testid="response-timeline">
            {entries.map((entry, index) => (
              <li
                key={`${entry.runId}-${index}`}
                className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-xs"
              >
                <span className="w-16 shrink-0 font-mono text-[var(--text-muted)]">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
                {entry.result && <MethodLabel method={entry.result.method} />}
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">
                  {entry.result?.url ?? entry.error}
                </span>
                {entry.result && (
                  <>
                    <span
                      className={cn(
                        'font-mono',
                        entry.result.status !== null && entry.result.status < 400
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
        )}
        {tab === 'tests' && (
          <ul className="flex flex-col gap-0.5 p-2" data-testid="response-tests">
            {!result?.assertions.length && (
              <li className="p-2 text-xs text-[var(--text-muted)]">{t('apiTests.noAssertions')}</li>
            )}
            {result?.assertions.map((assertion) => (
              <li
                key={assertion.id}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
              >
                <i
                  className={cn(
                    'ti mt-0.5',
                    assertion.passed
                      ? 'ti-check text-[var(--text-success)]'
                      : 'ti-x text-[var(--text-danger)]',
                  )}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    'font-mono',
                    assertion.passed ? 'text-[var(--text-primary)]' : 'text-[var(--text-danger)]',
                  )}
                >
                  {assertion.label}
                </span>
                {!assertion.passed && assertion.actual !== undefined && (
                  <span className="ml-auto truncate text-[var(--text-muted)]">
                    {t('apiTests.actual')}: {assertion.actual}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
