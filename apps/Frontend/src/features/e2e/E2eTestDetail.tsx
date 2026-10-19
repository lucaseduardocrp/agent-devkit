import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { E2eScriptPanel } from './E2eScriptPanel.js';
import { E2eTestStatusLabel } from './E2eStatus.js';
import { E2eExecutedSteps, E2eLinkedCase } from './E2eTestEvidence.js';
import {
  ACTIVE_TEST_STATUSES,
  isQuickTunnelUrl,
  safeE2eOutput,
  type E2ePriority,
  type E2eReporting,
  type E2eTestDetail as E2eTestDetailDto,
  formatDuration,
  type E2eVerdict,
} from './e2e-types.js';

const POLL_MS = 3000;
const priorityKeys: Record<E2ePriority, TranslationKey> = {
  high: 'e2e.priorityHigh',
  medium: 'e2e.priorityMedium',
  low: 'e2e.priorityLow',
};
const verdictKeys: Record<E2eVerdict, TranslationKey> = {
  app_bug: 'e2e.verdictAppBug',
  test_issue: 'e2e.verdictTestIssue',
  environment: 'e2e.verdictEnvironment',
};

export interface E2eTestDetailProps {
  readonly apiClient: ApiClient;
  readonly testId: string;
  /** The run's test management target; defaults the platform when linking a case. */
  readonly reporting?: E2eReporting | null;
  readonly isReadOnly?: boolean;
  readonly onBack: () => void;
}

export function E2eTestDetail({
  apiClient,
  testId,
  reporting = null,
  isReadOnly = false,
  onBack,
}: E2eTestDetailProps) {
  const { t, formatDate } = useI18n();
  const [test, setTest] = useState<E2eTestDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const [busy, setBusy] = useState(false);
  const [showLogs, setShowLogs] = useState(false);

  const load = useCallback(async () => {
    try {
      setTest(await apiClient.getE2eTest(testId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.loadFailed'));
    }
  }, [apiClient, testId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = test ? ACTIVE_TEST_STATUSES.includes(test.status) : false;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const rerun = async (regenerate: boolean) => {
    setBusy(true);
    try {
      await apiClient.rerunE2eTest(testId, regenerate);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!test) {
    return (
      <div className="flex flex-col gap-4 p-6" data-testid="e2e-test-detail">
        <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
          <i className="ti ti-arrow-left" aria-hidden="true" />
          {t('e2e.back')}
        </Button>
        {error ? (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        ) : (
          <Skeleton className="h-96 w-full" />
        )}
      </div>
    );
  }

  return (
    <div
      className="grid min-w-0 gap-6 p-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]"
      data-testid="e2e-test-detail"
      aria-busy={active}
    >
      <aside className="flex min-w-0 flex-col gap-4">
        <InfoCard icon="ti-notes" title={t('e2e.description')}>
          <p className="min-w-0 whitespace-pre-wrap text-sm text-[var(--text-primary)] [overflow-wrap:anywhere]">
            {test.description || test.title}
          </p>
        </InfoCard>
        {test.steps.length > 0 && (
          <InfoCard icon="ti-list-numbers" title={t('e2e.steps')}>
            <ol className="list-decimal space-y-1 pl-4 text-sm text-[var(--text-secondary)]">
              {test.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
          </InfoCard>
        )}
        <InfoCard icon="ti-link" title={t('e2e.tmLinkedCase')}>
          <E2eLinkedCase
            apiClient={apiClient}
            test={test}
            reporting={reporting}
            isReadOnly={isReadOnly}
            disabled={active}
            onChanged={setTest}
          />
        </InfoCard>
        <InfoCard icon="ti-info-circle" title={t('e2e.details')}>
          <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-[var(--text-muted)]">{t('e2e.columnType')}</dt>
            <dd className="text-[var(--text-primary)]">
              {t(test.creation.mode === 'backend' ? 'e2e.typeBackend' : 'e2e.typeFrontend')}
            </dd>
            <dt className="text-[var(--text-muted)]">{t('e2e.baseUrl')}</dt>
            <dd className="break-all text-[var(--text-primary)]">{test.creation.baseUrl}</dd>
            {test.creation.localOrigin && (
              <>
                <dt className="text-[var(--text-muted)]">{t('e2e.browserOriginLabel')}</dt>
                <dd className="break-all text-[var(--text-primary)]">
                  {test.creation.localOrigin}
                </dd>
              </>
            )}
            <dt className="text-[var(--text-muted)]">{t('e2e.priority')}</dt>
            <dd className="text-[var(--text-primary)]">{t(priorityKeys[test.priority])}</dd>
            <dt className="text-[var(--text-muted)]">{t('e2e.attempts')}</dt>
            <dd className="text-[var(--text-primary)]">{test.attempts}</dd>
            {test.durationMs !== null && (
              <>
                <dt className="text-[var(--text-muted)]">{t('e2e.duration')}</dt>
                <dd className="text-[var(--text-primary)]">{formatDuration(test.durationMs)}</dd>
              </>
            )}
            {test.lastRunAt && (
              <>
                <dt className="text-[var(--text-muted)]">{t('e2e.executedOn')}</dt>
                <dd className="break-all text-[var(--text-primary)]">
                  {test.executedOn ?? t('e2e.executedOnServers')}
                </dd>
                <dt className="text-[var(--text-muted)]">{t('e2e.lastRun')}</dt>
                <dd className="text-[var(--text-primary)]">
                  {formatDate(test.lastRunAt, { dateStyle: 'short', timeStyle: 'short' })}
                </dd>
              </>
            )}
          </dl>
        </InfoCard>
      </aside>

      <main className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
            <i className="ti ti-arrow-left" aria-hidden="true" />
            {t('e2e.back')}
          </Button>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex flex-wrap items-center gap-3 text-xl font-semibold text-[var(--text-primary)]">
              <E2eTestStatusLabel status={test.status} />
              <span>
                {test.code}-{test.title}
              </span>
            </h2>
            {!isReadOnly && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void rerun(true)}
                  disabled={busy || active}
                >
                  <i className="ti ti-sparkles" aria-hidden="true" />
                  {t('e2e.regenerateTest')}
                </Button>
                <Button size="sm" onClick={() => void rerun(false)} disabled={busy || active}>
                  <i className="ti ti-player-play" aria-hidden="true" />
                  {t('e2e.rerunTest')}
                </Button>
              </div>
            )}
          </div>
          {error && (
            <p className="text-sm text-red-400" role="alert">
              {error}
            </p>
          )}
        </div>

        {test.creation.mode === 'frontend' &&
          isQuickTunnelUrl(test.creation.baseUrl) &&
          !test.creation.localOrigin && (
            <p
              role="alert"
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300"
            >
              {t('e2e.tunnelOriginMissing')}
            </p>
          )}

        <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
          <div className="flex gap-1 border-b border-[var(--border)] p-1.5" role="tablist">
            {(['preview', 'code'] as const).map((item) => (
              <Button
                key={item}
                role="tab"
                aria-selected={tab === item}
                variant={tab === item ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setTab(item)}
              >
                {t(item === 'preview' ? 'e2e.preview' : 'e2e.code')}
              </Button>
            ))}
          </div>
          <div className="p-3" role="tabpanel">
            {tab === 'preview' ? (
              active ? (
                <Placeholder icon="ti-loader-2 animate-spin" text={t('e2e.inProgress')} />
              ) : test.hasVideo ? (
                <TestVideo
                  apiClient={apiClient}
                  testId={test.id}
                  version={`${test.lastRunAt ?? ''}:${test.attempts}`}
                />
              ) : (
                <Placeholder
                  icon="ti-video-off"
                  text={t(test.creation.mode === 'backend' ? 'e2e.noVideoBackend' : 'e2e.noVideo')}
                />
              )
            ) : (
              <E2eScriptPanel
                apiClient={apiClient}
                testId={test.id}
                isReadOnly={isReadOnly}
                disabled={active}
              />
            )}
          </div>
        </div>

        {!active && test.stepResults.length > 0 && (
          <E2eExecutedSteps apiClient={apiClient} test={test} />
        )}

        {test.error && !active && (
          <section className="rounded-lg border border-red-500/30 bg-red-950/40">
            <h3 className="border-b border-red-500/20 px-4 py-2 text-sm font-semibold text-red-300">
              {t('e2e.errorTitle')}
            </h3>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs text-red-100">
              {safeE2eOutput(test.error)}
            </pre>
          </section>
        )}

        {test.analysis && !active && (
          <section className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
            <h3 className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)]">
              <i className="ti ti-sparkles text-[var(--text-accent)]" aria-hidden="true" />
              {t('e2e.analysisTitle')}
              {test.verdict && (
                <span
                  className={cn(
                    'ml-auto rounded-full px-2 py-0.5 text-xs font-medium',
                    test.verdict === 'app_bug'
                      ? 'bg-red-500/15 text-red-300'
                      : 'bg-amber-500/15 text-amber-300',
                  )}
                >
                  {t(verdictKeys[test.verdict])}
                </span>
              )}
            </h3>
            <p className="whitespace-pre-wrap px-4 py-3 text-sm text-[var(--text-secondary)]">
              {safeE2eOutput(test.analysis)}
            </p>
          </section>
        )}

        {test.logs && (
          <section className="rounded-lg border border-[var(--border)]">
            <Button
              variant="ghost"
              className="w-full justify-between rounded-b-none"
              aria-expanded={showLogs}
              onClick={() => setShowLogs((value) => !value)}
            >
              {t('e2e.logs')}
              <i
                className={cn('ti ti-chevron-down transition-transform', showLogs && 'rotate-180')}
                aria-hidden="true"
              />
            </Button>
            {showLogs && (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-[var(--border)] px-4 py-3 font-mono text-xs text-[var(--text-secondary)]">
                {safeE2eOutput(test.logs)}
              </pre>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function TestVideo({
  apiClient,
  testId,
  version,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly version: string;
}) {
  const { t } = useI18n();
  const [video, setVideo] = useState<{ url: string; type: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [unplayable, setUnplayable] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setVideo(null);
    setFailed(false);
    setUnplayable(false);
    const load = async () => {
      // Object storage: the player streams straight from a signed URL (no API download).
      const signed = await apiClient.getE2eTestVideoUrl(testId, controller.signal);
      if (signed) {
        setVideo({ url: signed.url, type: signed.mimeType });
        return;
      }
      const blob = await apiClient.getE2eTestVideo(testId, controller.signal);
      objectUrl = URL.createObjectURL(blob);
      setVideo({ url: objectUrl, type: blob.type });
    };
    load().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, testId, version]);

  if (failed) return <Placeholder icon="ti-video-off" text={t('e2e.videoFailed')} />;
  if (!video) return <Placeholder icon="ti-loader-2 animate-spin" text={t('e2e.videoLoading')} />;
  // Without this, a browser that cannot decode the file shows a silent grey player.
  if (unplayable)
    return (
      <div className="mx-auto flex aspect-video w-full max-w-2xl flex-col items-center justify-center gap-3 rounded-md bg-[var(--surface-0)] text-sm text-[var(--text-muted)]">
        <i className="ti ti-video-off text-3xl" aria-hidden="true" />
        {t('e2e.videoUnplayable')}
        <a
          href={video.url}
          download={`${testId}.${video.type.includes('mp4') ? 'mp4' : 'webm'}`}
          className="text-[var(--text-accent)] underline-offset-4 hover:underline"
        >
          {t('e2e.downloadVideo')}
        </a>
      </div>
    );
  return (
    <video
      src={video.url}
      controls
      playsInline
      onError={() => setUnplayable(true)}
      className="mx-auto block aspect-video w-full max-w-2xl rounded-md bg-black"
      data-testid="e2e-video"
    />
  );
}

function Placeholder({ icon, text }: { readonly icon: string; readonly text: string }) {
  return (
    <div className="mx-auto flex aspect-video w-full max-w-2xl flex-col items-center justify-center gap-3 rounded-md bg-[var(--surface-0)] text-sm text-[var(--text-muted)]">
      <i className={cn('ti text-3xl', icon)} aria-hidden="true" />
      {text}
    </div>
  );
}

function InfoCard({
  icon,
  title,
  children,
}: {
  readonly icon: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
        <i className={cn('ti', icon)} aria-hidden="true" />
        {title}
      </h3>
      <div className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3">
        {children}
      </div>
    </section>
  );
}
