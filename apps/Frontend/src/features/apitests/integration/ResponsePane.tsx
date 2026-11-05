import React, { useEffect, useState } from 'react';
import { ActionsMenu } from '../../../components/ui/actions-menu.js';
import { Button } from '../../../components/ui/button.js';
import { ModeSwitch, type ViewMode } from '../../../components/ui/mode-switch.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { RenderedCode } from '../../brain/RenderedCode.js';
import type { ApiRunTarget, RequestResult } from '../api-test-types.js';
import { downloadBlob } from '../api-test-ui.js';
import {
  formatDuration,
  formatSize,
  grpcStatusLine,
  headerValue,
  isHtml,
  isOkStatus,
  prettyBody,
  statusLine,
  type PaneLayout,
  type PendingSend,
  type ResponseEntry,
} from './integration-model.js';
import { EmptyPane, PaneTabs, type PaneTab } from './integration-parts.js';
import { ConsoleView, MessagesView, TestsView, TrailersView } from './ResponseStreams.js';
import { HeadersTable, HistoryList, RequestTimelineView } from './Timeline.js';

type ResponseTab =
  'response' | 'messages' | 'headers' | 'trailers' | 'timeline' | 'tests' | 'console' | 'history';

const STREAM_KINDS = new Set(['websocket', 'sse', 'socket', 'grpc']);

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

/** The status as each protocol names it: HTTP phrases, gRPC codes, a connected socket. */
function useStatusText(): (result: RequestResult) => string {
  const { t } = useI18n();
  return (result) => {
    if (result.skipped) return t('apiTests.protocol.skipped');
    if (result.status === null) return t('apiTests.noResponse');
    if (result.kind === 'grpc') return grpcStatusLine(result.status);
    if (result.kind === 'socket' && result.status === 0) return t('apiTests.protocol.connected');
    return result.response?.statusText
      ? `${result.status} ${result.response.statusText}`
      : statusLine(result.status);
  };
}

function Body({
  result,
  raw,
}: {
  readonly result: RequestResult;
  readonly raw: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<ViewMode>('preview');
  const [page, setPage] = useState(false);
  const body = prettyBody(raw);
  const html = isHtml(headerValue(result.response?.headers ?? {}, 'content-type'), raw);
  return (
    <div className="relative" data-testid="response-body">
      <div className="sticky top-0 z-10 float-right flex items-center gap-1 p-2">
        {html && (
          <Button
            type="button"
            variant={page ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={page}
            onClick={() => setPage(!page)}
            data-testid="html-preview"
          >
            <i className="ti ti-world" aria-hidden="true" />
            {t('apiTests.protocol.htmlPreview')}
          </Button>
        )}
        <ModeSwitch mode={mode} onChange={setMode} ariaLabel={t('apiTests.ui.responseFormat')} />
      </div>
      {result.response?.truncated && (
        <p role="status" className="px-3 pt-3 text-xs text-[var(--text-warning)]">
          {t('apiTests.protocol.truncated', { size: formatSize(raw.length) })}
        </p>
      )}
      {html && page ? (
        // No scripts, forms or same origin: the page is only looked at.
        <iframe
          title={t('apiTests.protocol.htmlPreview')}
          sandbox=""
          srcDoc={raw}
          className="h-[60vh] w-full border-0 bg-white"
        />
      ) : mode === 'preview' ? (
        <RenderedCode code={body.code || t('apiTests.emptyBody')} language={body.language} />
      ) : (
        <pre className="whitespace-pre-wrap break-all p-3.5 font-mono text-xs text-[var(--text-primary)]">
          {raw || t('apiTests.emptyBody')}
        </pre>
      )}
    </div>
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
  const statusText = useStatusText();
  const [chosen, setChosen] = useState<ResponseTab>('response');
  const latest = entries[0] ?? null;
  const result = latest?.result ?? null;
  const headers = result?.response?.headers ?? {};
  const messages = result?.response?.messages ?? [];
  const trailers = result?.response?.trailers;
  const tests = result?.tests ?? [];
  const logs = result?.logs ?? [];
  const checks = [...(result?.assertions ?? []), ...tests];
  const passed = checks.filter((check) => check.passed).length;
  const raw = result?.response?.bodyPreview ?? '';
  const ok = result ? isOkStatus(result.kind, result.status) : false;
  const streaming = Boolean(result && (messages.length || STREAM_KINDS.has(result.kind ?? 'http')));

  const tabs: PaneTab<ResponseTab>[] = [
    { id: 'response', label: t('apiTests.response') },
    ...(streaming
      ? [
          {
            id: 'messages' as const,
            label: t('apiTests.protocol.messages'),
            indicator: messages.length,
          },
        ]
      : []),
    { id: 'headers', label: t('apiTests.tabs.headers'), indicator: Object.keys(headers).length },
    ...(trailers || result?.kind === 'grpc'
      ? [{ id: 'trailers' as const, label: t('apiTests.protocol.trailers') }]
      : []),
    { id: 'timeline', label: t('apiTests.timeline') },
    {
      id: 'tests',
      label: t('apiTests.tests'),
      indicator: checks.length ? `${passed}/${checks.length}` : '',
      tone: passed < checks.length ? 'danger' : 'success',
    },
    {
      id: 'console',
      label: t('apiTests.protocol.console'),
      indicator: logs.length,
      tone: logs.some((log) => log.level === 'error') ? 'danger' : 'default',
    },
    { id: 'history', label: t('apiTests.protocol.history'), indicator: entries.length },
  ];
  const tab = tabs.some((item) => item.id === chosen) ? chosen : 'response';

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
      `response.${prettyBody(raw).language === 'json' ? 'json' : 'txt'}`,
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
        onChange={setChosen}
        tabs={tabs}
        right={
          <>
            {result && (
              <div className="flex items-center gap-2 text-xs" data-testid="response-pane-status">
                <span
                  className={cn(
                    'font-semibold',
                    result.skipped
                      ? 'text-[var(--text-muted)]'
                      : ok
                        ? 'text-[var(--text-success)]'
                        : 'text-[var(--text-danger)]',
                  )}
                  data-testid="response-status"
                >
                  {statusText(result)}
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
            {result?.skipped && (
              <EmptyPane icon="ti-player-skip-forward">
                <p data-testid="response-skipped">{t('apiTests.protocol.skippedHint')}</p>
              </EmptyPane>
            )}
            {result?.response && !result.skipped && (
              <Body key={latest.runId} result={result} raw={raw} />
            )}
          </>
        )}
        {tab === 'messages' && <MessagesView messages={messages} />}
        {tab === 'headers' && <HeadersTable headers={headers} empty={t('apiTests.ui.noHeaders')} />}
        {tab === 'trailers' && <TrailersView trailers={trailers ?? {}} />}
        {tab === 'timeline' &&
          (result ? (
            <RequestTimelineView result={result} />
          ) : (
            <p className="p-3 text-xs text-[var(--text-muted)]">
              {t('apiTests.protocol.noTimeline')}
            </p>
          ))}
        {tab === 'tests' && <TestsView assertions={result?.assertions ?? []} tests={tests} />}
        {tab === 'console' && <ConsoleView logs={logs} />}
        {tab === 'history' && <HistoryList entries={entries} />}
      </div>
    </section>
  );
}
