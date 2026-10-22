import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { FormattedContent } from '../../components/ui/formatted-content.js';
import { E2eCasePicker, errorMessage, type TestManagementSelection } from './E2eTestManagement.js';
import {
  TEST_MANAGEMENT_NAMES,
  formatDuration,
  safeE2eOutput,
  testStepTexts,
  type E2eReporting,
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
              variant="ghost"
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

/** Steps of the latest execution, with their outcome, screenshot and expected result. */
export function E2eExecutedSteps({
  apiClient,
  test,
}: {
  readonly apiClient: ApiClient;
  readonly test: E2eTestDetail;
}) {
  const { t } = useI18n();
  const [enlarged, setEnlarged] = useState<Enlarged | null>(null);
  const version = `${test.lastRunAt ?? ''}:${test.attempts}`;
  const steps = testStepTexts(test);

  return (
    <section
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
      data-testid="e2e-executed-steps"
    >
      <h3 className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--text-primary)]">
        <i className="ti ti-list-check text-[var(--text-accent)]" aria-hidden="true" />
        {t('e2e.executedSteps')}
      </h3>
      <ol className="divide-y divide-[var(--border)]">
        {test.stepResults.map((step) => {
          const planned = steps[step.position - 1];
          const action = planned?.action.trim();
          const expected = planned?.expectedResult.trim();
          const passed = step.status === 'passed';
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
                {step.error && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-950/40 px-2 py-1 font-mono text-xs text-red-200">
                    {safeE2eOutput(step.error)}
                  </pre>
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
      </ol>
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
    </section>
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
