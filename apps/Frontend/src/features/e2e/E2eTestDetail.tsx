import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { ResizableSidebar } from '../../components/layout/ResizableSidebar.js';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import { FormattedContent } from '../../components/ui/formatted-content.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import { saveWithDrafts } from '../shared/media.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { E2ePlannedSteps, E2eSection } from './E2ePlannedSteps.js';
import { E2eRegenerateDialog, type E2eRegenerateChoice } from './E2eRegenerateDialog.js';
import { E2eStepFixDialog } from './E2eStepFixDialog.js';
import { E2eFailureReason } from './E2eFailureReason.js';
import { E2eResultControl } from './E2eResultControl.js';
import { E2eScriptPanel } from './E2eScriptPanel.js';
import { E2eTestStatusLabel } from './E2eStatus.js';
import { E2eEvidencePlayer, Placeholder } from './E2eEvidencePlayer.js';
import { E2eExecutedSteps, E2eLinkedCase } from './E2eTestEvidence.js';
import { E2eEditSavedCase, E2eLinkedSavedCase, useSavedCaseLink } from './E2eLinkedSavedCase.js';
import {
  ACTIVE_TEST_STATUSES,
  isQuickTunnelUrl,
  safeE2eOutput,
  type E2eEnvironment,
  type E2ePriority,
  type E2eReporting,
  type E2eStepResult,
  type E2eTestDetail as E2eTestDetailDto,
  formatDuration,
  stepsNotRun,
  testStepTexts,
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
type DetailTab = 'preview' | 'testCase' | 'code' | 'beforeRun' | 'afterRun';
const detailTabs: readonly { id: DetailTab; label: TranslationKey; icon: string }[] = [
  { id: 'preview', label: 'e2e.preview', icon: 'ti-player-play' },
  { id: 'testCase', label: 'e2e.testCaseTab', icon: 'ti-clipboard-list' },
  { id: 'code', label: 'e2e.code', icon: 'ti-code' },
  { id: 'beforeRun', label: 'e2e.beforeRun', icon: 'ti-database-plus' },
  { id: 'afterRun', label: 'e2e.afterRun', icon: 'ti-eraser' },
];

/** The run page while the test loads: the title row, the tab bar and the preview, as loaded. */
function E2eTestDetailSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-busy="true"
      data-testid="e2e-test-detail-skeleton"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-6 w-72 max-w-[50vw] rounded-md" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-8 w-36 rounded-md" />
          <Skeleton className="h-8 w-32 rounded-md" />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
        <div className="flex flex-wrap gap-1 border-b border-[var(--border)] p-1.5">
          {[28, 36, 24, 32, 32].map((width, index) => (
            <Skeleton key={index} className="h-8 rounded-md" style={{ width: width * 4 }} />
          ))}
        </div>
        <div className="p-3">
          <Skeleton className="aspect-video max-h-[480px] w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}

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
  const [tab, setTab] = useState<DetailTab>('preview');
  const [busy, setBusy] = useState(false);
  // What the AI was just asked, until the request is accepted: the feedback of the click.
  const [starting, setStarting] = useState<string | null>(null);
  const { runActivity } = useActivityRunner();
  const [showLogs, setShowLogs] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // The failed step whose fix with the AI is being written.
  const [fixing, setFixing] = useState<E2eStepResult | null>(null);
  const [environments, setEnvironments] = useState<readonly E2eEnvironment[]>([]);
  // What the user picked and has not run yet; null while the select shows what the test holds.
  const [environmentDraft, setEnvironmentDraft] = useState<string | null>(null);
  const savedCase = useSavedCaseLink(apiClient, testId, test?.savedCase, setTest);

  useEffect(() => {
    let active = true;
    // Promise.resolve first: a client or a server without environments means "none".
    void Promise.resolve()
      .then(() => apiClient.getE2eEnvironments())
      .then((list) => {
        if (active) setEnvironments(list);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [apiClient]);

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

  if (!test) {
    return (
      <div className="flex flex-col gap-4" data-testid="e2e-test-detail">
        <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}>
          <i className="ti ti-arrow-left" aria-hidden="true" />
          {t('e2e.back')}
        </Button>
        {error ? (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        ) : (
          <E2eTestDetailSkeleton />
        )}
      </div>
    );
  }

  /** Resolves with the test as soon as it is no longer queued or running. */
  const untilIdle = async (): Promise<E2eTestDetailDto> => {
    for (;;) {
      const current = await apiClient.getE2eTest(testId);
      if (!ACTIVE_TEST_STATUSES.includes(current.status)) return current;
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
    }
  };

  /**
   * Sends one request that changes the test and reloads it. While the request is on its way the
   * page says so (`starting`), and what the AI does afterwards is an activity of the notification
   * center: running until the test stops, failed if the run ended in error. Failures to start are
   * shown on the page.
   */
  const perform = async (
    send: () => Promise<void>,
    ai?: { readonly title: string; readonly starting: string },
  ) => {
    const begin = async () => {
      setBusy(true);
      setStarting(ai?.starting ?? null);
      try {
        await send();
        await load();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : t('e2e.actionFailed'));
        throw reason;
      } finally {
        setBusy(false);
        setStarting(null);
      }
    };
    if (!ai) {
      await begin().catch(() => undefined);
      return;
    }
    await runActivity({ kind: 'agent', title: ai.title }, async () => {
      await begin();
      const finished = await untilIdle();
      if (finished.status === 'error' || finished.status === 'cancelled')
        throw new Error(finished.error ?? t('e2e.actionFailed'));
    }).catch(() => undefined);
  };

  const rerun = (regenerate: boolean, choice?: E2eRegenerateChoice) =>
    perform(
      async () => {
        const send = (guidance?: E2eRegenerateChoice) =>
          // Empty means "inherit the run's environment", which clears the test's own.
          environmentDraft !== null
            ? apiClient.rerunE2eTest(testId, regenerate, guidance, environmentDraft || null)
            : guidance
              ? apiClient.rerunE2eTest(testId, regenerate, guidance)
              : apiClient.rerunE2eTest(testId, regenerate);
        // The images of the instructions were pasted as drafts: they are uploaded now, and removed
        // again when the test cannot be started, so only a confirmed rewrite leaves files behind.
        if (choice) await saveWithDrafts(apiClient, 'e2e', choice, send);
        else await send();
        setEnvironmentDraft(null);
      },
      regenerate
        ? {
            title: t('e2e.regenerateActivity', { test: test.code }),
            starting: t('e2e.regenerateStarting'),
          }
        : undefined,
    );

  /** Rewrites one failed step with the AI (only that step of the script) and runs the test. */
  const fixStep = (position: number, instructions: string) =>
    perform(
      // The images of the instructions are uploaded now and removed again if the AI cannot start.
      () =>
        saveWithDrafts(apiClient, 'e2e', { instructions }, (draft) =>
          apiClient.fixE2eTestStep(testId, position, draft.instructions),
        ),
      {
        title: t('e2e.fixStepActivity', { position, test: test.code }),
        starting: t('e2e.fixStepStarting', { position }),
      },
    );

  const plannedSteps = testStepTexts(test);
  const runEnvironment = environments.find((item) => item.id === test.creation.environmentId);
  const selectedEnvironment = environmentDraft ?? test.environmentId ?? '';
  // What the next execution uses: the test's own environment, else the run's.
  const activeEnvironment = environments.find(
    (item) => item.id === (test.environmentId ?? test.creation.environmentId),
  );
  // The outcome of the run belongs to the run tabs; the script tabs are about the code alone.
  const showsRun = tab === 'preview' || tab === 'testCase';
  // The user passed it by hand: the error and analysis of the run no longer describe the result.
  const overruled = test.status === 'passed' && test.resultSource === 'manual';

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="e2e-test-detail" aria-busy={active}>
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
            <div className="flex flex-wrap items-center gap-2">
              {environments.length > 0 && (
                <div className="flex items-center gap-2" title={t('e2e.testEnvironmentHint')}>
                  <span className="text-xs text-[var(--text-secondary)]">
                    {t('e2e.testEnvironment')}
                  </span>
                  <Select
                    selectSize="sm"
                    containerClassName="w-52"
                    aria-label={t('e2e.testEnvironment')}
                    value={selectedEnvironment}
                    disabled={busy || active}
                    onChange={(event) => setEnvironmentDraft(event.target.value)}
                  >
                    <option value="">
                      {runEnvironment
                        ? `${t('e2e.testEnvironmentInherit')} (${runEnvironment.name})`
                        : t('e2e.testEnvironmentInherit')}
                    </option>
                    {environments.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setRegenerating(true)}
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
        {starting && (
          <p
            role="status"
            className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-sm text-[var(--text-secondary)]"
            data-testid="e2e-ai-starting"
          >
            <i
              className="ti ti-loader-2 animate-spin text-[var(--text-accent)]"
              aria-hidden="true"
            />
            {starting}
          </p>
        )}
        {error && (
          <p className="text-sm text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>

      <E2eRegenerateDialog
        open={regenerating}
        initialInstructions={test.scriptInstructions ?? ''}
        hasLastRun={Boolean(test.scriptPath)}
        busy={busy}
        onCancel={() => setRegenerating(false)}
        onConfirm={(choice) => {
          // The rewrite goes on in the background: the dialog does not wait for the upload of the
          // images, the request or the reload, and a failure is shown on the page.
          setRegenerating(false);
          void rerun(true, choice);
        }}
      />

      {fixing && (
        <E2eStepFixDialog
          step={fixing}
          onCancel={() => setFixing(null)}
          onConfirm={(instructions) => {
            // Same as the rewrite of the whole script: it goes on in the background.
            setFixing(null);
            void fixStep(fixing.position, instructions);
          }}
        />
      )}

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
        <div className="flex flex-wrap gap-1 border-b border-[var(--border)] p-1.5" role="tablist">
          {detailTabs.map((item) => (
            <Button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              variant={tab === item.id ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab(item.id)}
            >
              <i className={cn('ti', item.icon)} aria-hidden="true" />
              {t(item.label)}
            </Button>
          ))}
        </div>
        <div className="p-3" role="tabpanel">
          {tab === 'preview' &&
            (active || starting ? (
              <Placeholder icon="ti-loader-2 animate-spin" text={t('e2e.inProgress')} />
            ) : test.hasVideo || test.stepResults.some((step) => step.hasScreenshot) ? (
              <E2eEvidencePlayer
                apiClient={apiClient}
                test={test}
                version={`${test.lastRunAt ?? ''}:${test.attempts}`}
              />
            ) : (
              <Placeholder
                icon="ti-video-off"
                text={t(test.creation.mode === 'backend' ? 'e2e.noVideoBackend' : 'e2e.noVideo')}
              />
            ))}
          {tab === 'testCase' && (
            <div className="flex min-w-0 flex-col gap-6 p-1 lg:flex-row lg:gap-0">
              <div className="flex min-w-0 flex-1 flex-col gap-6 lg:pr-6">
                <E2eSection
                  icon="ti-notes"
                  title={t('e2e.description')}
                  action={
                    <E2eEditSavedCase saved={savedCase} isReadOnly={isReadOnly} disabled={active} />
                  }
                >
                  <TestDescription content={test.description || test.title} />
                </E2eSection>
                <E2eSection icon="ti-list-numbers" title={t('e2e.steps')}>
                  {plannedSteps.length > 0 ? (
                    <E2ePlannedSteps steps={plannedSteps} />
                  ) : (
                    <p className="text-sm text-[var(--text-muted)]">{t('e2e.noSteps')}</p>
                  )}
                </E2eSection>
              </div>
              <ResizableSidebar
                resizeEdge="left"
                defaultWidth={380}
                minWidth={280}
                maxWidth={720}
                className="min-w-0 gap-6 border-l border-[var(--border)] lg:pl-6"
                data-testid="e2e-test-case-side"
              >
                <E2eSection icon="ti-test-pipe" title={t('e2e.savedCaseTitle')}>
                  <E2eLinkedSavedCase
                    apiClient={apiClient}
                    test={test}
                    saved={savedCase}
                    isReadOnly={isReadOnly}
                    disabled={active}
                  />
                </E2eSection>
                <E2eSection icon="ti-link" title={t('e2e.tmLinkedCase')}>
                  <E2eLinkedCase
                    apiClient={apiClient}
                    test={test}
                    reporting={reporting}
                    isReadOnly={isReadOnly}
                    disabled={active}
                    onChanged={setTest}
                  />
                </E2eSection>
                <E2eSection icon="ti-info-circle" title={t('e2e.details')}>
                  <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-y-2 text-sm">
                    <dt className="text-[var(--text-muted)]">{t('e2e.columnType')}</dt>
                    <dd className="text-[var(--text-primary)]">
                      {t(test.creation.mode === 'backend' ? 'e2e.typeBackend' : 'e2e.typeFrontend')}
                    </dd>
                    <dt className="text-[var(--text-muted)]">{t('e2e.baseUrl')}</dt>
                    <dd className="break-all text-[var(--text-primary)]">
                      {test.creation.baseUrl}
                    </dd>
                    {test.creation.localOrigin && (
                      <>
                        <dt className="text-[var(--text-muted)]">{t('e2e.browserOriginLabel')}</dt>
                        <dd className="break-all text-[var(--text-primary)]">
                          {test.creation.localOrigin}
                        </dd>
                      </>
                    )}
                    {activeEnvironment && (
                      <>
                        <dt className="text-[var(--text-muted)]">{t('e2e.testEnvironment')}</dt>
                        <dd className="break-all text-[var(--text-primary)]">
                          {activeEnvironment.name}
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
                        <dd className="text-[var(--text-primary)]">
                          {formatDuration(test.durationMs)}
                        </dd>
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
                </E2eSection>
              </ResizableSidebar>
            </div>
          )}
          {(tab === 'code' || tab === 'beforeRun' || tab === 'afterRun') && (
            <E2eScriptPanel
              key={tab}
              apiClient={apiClient}
              testId={test.id}
              kind={tab === 'code' ? 'spec' : tab}
              mode={test.creation.mode}
              instructions={
                tab === 'beforeRun' ? test.beforeRunInstructions : test.afterRunInstructions
              }
              isReadOnly={isReadOnly}
              disabled={active}
            />
          )}
        </div>
      </div>

      {showsRun && !active && <E2eFailureReason test={test} />}

      {showsRun && !active && (
        <E2eResultControl
          apiClient={apiClient}
          test={test}
          isReadOnly={isReadOnly}
          onChanged={setTest}
        />
      )}

      {/* A run that never reached its steps shows them on the preview; the case tab lists them already. */}
      {showsRun &&
        !active &&
        (test.stepResults.length > 0 || (tab === 'preview' && stepsNotRun(test).length > 0)) && (
          <E2eExecutedSteps
            apiClient={apiClient}
            test={test}
            isReadOnly={isReadOnly}
            onChanged={setTest}
            // Only a test with a script has a step to rewrite.
            {...(test.scriptPath && !busy ? { onFixStep: setFixing } : {})}
          />
        )}

      {showsRun && test.error && !active && !overruled && (
        <section className="rounded-lg border border-red-500/30 bg-red-950/40">
          <h3 className="border-b border-red-500/20 px-4 py-2 text-sm font-semibold text-red-300">
            {t('e2e.errorTitle')}
          </h3>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs text-red-100">
            {safeE2eOutput(test.error)}
          </pre>
        </section>
      )}

      {showsRun && test.analysis && !active && !overruled && (
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

      {showsRun && test.logs && (
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
    </div>
  );
}

// The team's test case template (bold "## Section" headings, <br> lines, box flow diagrams).
const TEST_CASE_TEMPLATE =
  /<br\s*\/?>|<b>\s*#|[┌└│▼]|^\s*#{1,6}\s*(caso de uso|pré-condi|dados de entrada|resultado esperado|pós-condi|fluxo|use case|precondition|input data|expected result)/im;

/** Test case descriptions use the template layout; other text renders as Markdown, HTML or Mermaid. */
function TestDescription({ content }: { readonly content: string }) {
  return TEST_CASE_TEMPLATE.test(content) ? (
    <FormattedContent content={content} className="[overflow-wrap:anywhere]" />
  ) : (
    <MarkdownViewer content={content} showModeToggle={false} className="text-sm" />
  );
}
