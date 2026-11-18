import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { FormattedContent } from '../../components/ui/formatted-content.js';
import { E2eCollapsibleSection } from './E2eCollapsibleSection.js';
import { E2eCasePicker, errorMessage, type TestManagementSelection } from './E2eTestManagement.js';
import {
  TEST_MANAGEMENT_NAMES,
  effectiveStepStatus,
  formatDuration,
  safeE2eOutput,
  stepsNotRun,
  testStepTexts,
  type E2eReporting,
  type E2eResultDecision,
  type E2eStepResult,
  type E2eTestDetail,
  type TestManagementProviderId,
} from './e2e-types.js';

/** The test management case a test automates, with link and unlink actions. */
export function E2eLinkedCase({
  apiClient,
  test,
  reporting,
  isReadOnly,
  disabled,
  onChanged,
}: {
  readonly apiClient: ApiClient;
  readonly test: E2eTestDetail;
  /** The run's reporting target supplies the default platform, plan and suite. */
  readonly reporting: E2eReporting | null;
  readonly isReadOnly: boolean;
  readonly disabled: boolean;
  readonly onChanged: (test: E2eTestDetail) => void;
}) {
  const { t } = useI18n();
  // Linking picks the case from a test plan.
  const canPickCases = usePermissions().can('testplans');
  const [editing, setEditing] = useState(false);
  const [selection, setSelection] = useState<TestManagementSelection>({
    provider: reporting?.provider ?? 'azure_devops',
    planId: reporting?.planId ?? '',
    suiteId: reporting?.suiteId ?? '',
    caseIds: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const external = test.externalCase;
  const selectedCaseId = selection.caseIds[0];

  const save = async (link: boolean) => {
    if (link && (!selection.provider || !selectedCaseId)) return;
    setBusy(true);
    setError(null);
    try {
      const suiteId = selection.suiteId;
      onChanged(
        await apiClient.linkE2eTestCase(
          test.id,
          link
            ? {
                provider: selection.provider as TestManagementProviderId,
                caseId: selectedCaseId as string,
                // Cases are only listed (and so selectable) once a plan is chosen.
                planId: selection.planId,
                ...(suiteId ? { suiteId } : {}),
              }
            : null,
        ),
      );
      setEditing(false);
    } catch (reason) {
      setError(errorMessage(reason, t('e2e.actionFailed')));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(true);
  };

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="e2e-linked-case">
      {external ? (
        <>
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-[var(--text-muted)]">
              {TEST_MANAGEMENT_NAMES[external.provider]}
            </span>
            {external.url ? (
              <a
                href={external.url}
                target="_blank"
                rel="noreferrer"
                title={t('e2e.tmOpenCase')}
                className="inline-flex items-center gap-1 font-mono text-[var(--text-accent)] underline-offset-4 hover:underline"
              >
                {external.caseId}
                <i className="ti ti-external-link" aria-hidden="true" />
              </a>
            ) : (
              <span className="font-mono text-[var(--text-primary)]">{external.caseId}</span>
            )}
          </p>
          <p className="text-[var(--text-primary)]">{external.title}</p>
          {!isReadOnly && (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              disabled={busy || disabled}
              onClick={() => void save(false)}
            >
              <i className="ti ti-unlink" aria-hidden="true" />
              {t('e2e.tmUnlink')}
            </Button>
          )}
        </>
      ) : editing ? (
        <form className="flex flex-col gap-2" onSubmit={submit}>
          <E2eCasePicker apiClient={apiClient} value={selection} single onChange={setSelection} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" isLoading={busy} disabled={busy || !selectedCaseId}>
              {t('e2e.tmLink')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              {t('e2e.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-[var(--text-muted)]">{t('e2e.tmNoLinkedCase')}</p>
          {!isReadOnly && canPickCases && (
            <Button
              variant="secondary"
              size="sm"
              className="w-fit"
              disabled={disabled}
              onClick={() => setEditing(true)}
            >
              <i className="ti ti-link" aria-hidden="true" />
              {t('e2e.tmLink')}
            </Button>
          )}
        </>
      )}
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

interface Enlarged {
  readonly position: number;
  readonly url: string;
}

const MAX_NOTE = 2_000;

/**
 * The user's own decision about one step: pass it, fail it, or give back what the run reported.
 * The test passes once no step counts as failed. Scripts, video and evidence are kept.
 */
function E2eStepDecision({
  apiClient,
  testId,
  step,
  onChanged,
  onFix,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly step: E2eStepResult;
  readonly onChanged: (test: E2eTestDetail) => void;
  /** Opens the AI fix of this step; offered only while the step counts as failed. */
  readonly onFix?: () => void;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<E2eResultDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const passed = effectiveStepStatus(step) === 'passed';

  const decide = async (decision: E2eResultDecision) => {
    setPending(decision);
    setError(null);
    try {
      onChanged(
        await apiClient.setE2eStepResult(
          testId,
          step.position,
          decision,
          decision === 'run' ? undefined : note.trim(),
        ),
      );
      setNote('');
    } catch (reason) {
      setError(errorMessage(reason, t('e2e.actionFailed')));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={`e2e-step-decision-${step.position}`}>
      <Input
        aria-label={`${t('e2e.resultNoteLabel')} (${step.position})`}
        placeholder={t('e2e.resultNoteLabel')}
        value={note}
        maxLength={MAX_NOTE}
        disabled={pending !== null}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {passed ? (
          <Button
            size="sm"
            variant="destructive"
            aria-label={`${t('e2e.resultMarkFailed')} (${step.position})`}
            disabled={pending !== null}
            isLoading={pending === 'failed'}
            onClick={() => void decide('failed')}
          >
            <i className="ti ti-circle-x" aria-hidden="true" />
            {t('e2e.resultMarkFailed')}
          </Button>
        ) : (
          <Button
            size="sm"
            aria-label={`${t('e2e.resultMarkPassed')} (${step.position})`}
            disabled={pending !== null}
            isLoading={pending === 'passed'}
            onClick={() => void decide('passed')}
          >
            <i className="ti ti-circle-check" aria-hidden="true" />
            {t('e2e.resultMarkPassed')}
          </Button>
        )}
        {!passed && onFix && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`${t('e2e.fixStepButton')} (${step.position})`}
            disabled={pending !== null}
            onClick={onFix}
          >
            <i className="ti ti-sparkles" aria-hidden="true" />
            {t('e2e.fixStepButton')}
          </Button>
        )}
        {step.manualStatus && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`${t('e2e.resultUseRun')} (${step.position})`}
            disabled={pending !== null}
            isLoading={pending === 'run'}
            onClick={() => void decide('run')}
          >
            <i className="ti ti-arrow-back-up" aria-hidden="true" />
            {t('e2e.resultUseRun')}
          </Button>
        )}
      </div>
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Steps of the latest execution, with their outcome, screenshot and expected result. Whoever can
 * edit also decides, step by step, which ones count as passed or failed.
 */
export function E2eExecutedSteps({
  apiClient,
  test,
  isReadOnly = true,
  onChanged,
  onFixStep,
}: {
  readonly apiClient: ApiClient;
  readonly test: E2eTestDetail;
  readonly isReadOnly?: boolean;
  readonly onChanged?: (test: E2eTestDetail) => void;
  /** Asks to fix one failed step with the AI; without it the steps offer no such action. */
  readonly onFixStep?: (step: E2eStepResult) => void;
}) {
  const { t } = useI18n();
  const [enlarged, setEnlarged] = useState<Enlarged | null>(null);
  const version = `${test.lastRunAt ?? ''}:${test.attempts}`;
  const steps = testStepTexts(test);
  const notRun = stepsNotRun(test);

  return (
    <E2eCollapsibleSection
      title={t('e2e.executedSteps')}
      icon="ti-list-check"
      testId="e2e-executed-steps"
    >
      <ol className="divide-y divide-[var(--border)]">
        {test.stepResults.map((step) => {
          const planned = steps[step.position - 1];
          const action = planned?.action.trim();
          const expected = planned?.expectedResult.trim();
          const passed = effectiveStepStatus(step) === 'passed';
          return (
            <li key={step.position} className="flex gap-3 px-4 py-3">
              <i
                role="img"
                aria-label={t(passed ? 'e2e.testPassed' : 'e2e.testFailed')}
                className={cn(
                  'ti mt-0.5 text-base',
                  passed
                    ? 'ti-circle-check-filled text-emerald-400'
                    : 'ti-alert-circle-filled text-red-400',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-2 text-sm text-[var(--text-primary)]">
                  <span>
                    {step.position}. {step.title}
                  </span>
                  <span className="text-xs text-[var(--text-muted)]">
                    {formatDuration(step.durationMs)}
                  </span>
                </p>
                {(action || expected) && (
                  <dl className="mt-1.5 space-y-1 text-xs text-[var(--text-secondary)]">
                    {action && (
                      <div>
                        <dt className="inline font-semibold text-[var(--text-accent)]">
                          {t('e2e.executedStep')}:
                        </dt>{' '}
                        <dd className="inline">
                          <FormattedContent content={action} inline />
                        </dd>
                      </div>
                    )}
                    {expected && (
                      <div>
                        <dt className="inline font-semibold text-emerald-400">
                          {t('e2e.expectedResult')}:
                        </dt>{' '}
                        <dd className="inline">
                          <FormattedContent content={expected} inline />
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
                {step.manualStatus ? (
                  <p className="mt-1 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs text-sky-200">
                    {t('e2e.stepResultByUser')}
                    {step.manualNote ? ` ${step.manualNote}` : ''}
                  </p>
                ) : (
                  step.error && (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-950/40 px-2 py-1 font-mono text-xs text-red-200">
                      {safeE2eOutput(step.error)}
                    </pre>
                  )
                )}
                {onChanged && !isReadOnly && (
                  <E2eStepDecision
                    apiClient={apiClient}
                    testId={test.id}
                    step={step}
                    onChanged={onChanged}
                    {...(onFixStep ? { onFix: () => onFixStep(step) } : {})}
                  />
                )}
              </div>
              {step.hasScreenshot && (
                <StepScreenshot
                  apiClient={apiClient}
                  testId={test.id}
                  position={step.position}
                  version={version}
                  onOpen={setEnlarged}
                />
              )}
            </li>
          );
        })}
        {notRun.map((step) => (
          <li
            key={`not-run-${step.position}`}
            className="flex gap-3 px-4 py-3 opacity-70"
            data-testid={`e2e-step-not-run-${step.position}`}
          >
            <i
              role="img"
              aria-label={t('e2e.stepNotRun')}
              className="ti ti-circle-dashed mt-0.5 text-base text-[var(--text-muted)]"
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-2 text-sm text-[var(--text-primary)]">
                <span>
                  {step.position}. {step.action}
                </span>
                <span className="text-xs text-[var(--text-muted)]">{t('e2e.stepNotRun')}</span>
              </p>
              {step.expectedResult.trim() && (
                <p className="mt-1.5 text-xs text-[var(--text-secondary)]">
                  <span className="font-semibold text-emerald-400">{t('e2e.expectedResult')}:</span>{' '}
                  <FormattedContent content={step.expectedResult.trim()} inline />
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
      {test.stepResults.length === 0 && notRun.length > 0 && (
        <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-secondary)]">
          {t('e2e.failedBeforeSteps')}
        </p>
      )}
      {enlarged && (
        <Modal open onClose={() => setEnlarged(null)}>
          <div className="relative rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-2xl">
            <Button
              variant="secondary"
              size="sm"
              className="absolute right-4 top-4"
              aria-label={t('common.close')}
              onClick={() => setEnlarged(null)}
            >
              <i className="ti ti-x" aria-hidden="true" />
            </Button>
            <img
              src={enlarged.url}
              alt={t('e2e.screenshotAlt', { position: enlarged.position })}
              className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-4rem)] rounded"
            />
          </div>
        </Modal>
      )}
    </E2eCollapsibleSection>
  );
}

function StepScreenshot({
  apiClient,
  testId,
  position,
  version,
  onOpen,
}: {
  readonly apiClient: ApiClient;
  readonly testId: string;
  readonly position: number;
  readonly version: string;
  readonly onOpen: (value: Enlarged) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    apiClient
      .getE2eStepScreenshot(testId, position, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, testId, position, version]);

  if (failed)
    return (
      <span
        className="flex h-16 w-28 shrink-0 items-center justify-center rounded bg-[var(--surface-0)] text-[var(--text-muted)]"
        title={t('e2e.screenshotFailed')}
        aria-label={t('e2e.screenshotFailed')}
        role="img"
      >
        <i className="ti ti-photo-off text-xl" aria-hidden="true" />
      </span>
    );
  if (!url) return <Skeleton className="h-16 w-28 shrink-0" />;
  return (
    <Button
      variant="ghost"
      className="h-auto shrink-0 p-0"
      aria-label={t('e2e.enlargeScreenshot', { position })}
      onClick={() => onOpen({ position, url })}
    >
      <img
        src={url}
        alt={t('e2e.screenshotAlt', { position })}
        className="h-16 w-28 rounded border border-[var(--border)] object-cover object-top"
      />
    </Button>
  );
}
