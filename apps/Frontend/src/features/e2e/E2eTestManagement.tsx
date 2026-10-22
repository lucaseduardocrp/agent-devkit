import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { SearchableSelect } from '../../components/ui/searchable-select.js';
import {
  TEST_MANAGEMENT_NAMES,
  needsPolling,
  type E2eCreationSummary,
  type E2eImportResult,
  type E2eLastReport,
  type ExternalTestCase,
  type RemoteContainer,
  type TestManagementProvider,
  type TestManagementProviderId,
} from './e2e-types.js';

/** Where test cases live on a test management platform; empty strings mean "not chosen". */
export interface TestManagementTarget {
  readonly provider: TestManagementProviderId | '';
  readonly planId: string;
  readonly suiteId: string;
}

export interface TestManagementSelection extends TestManagementTarget {
  readonly caseIds: readonly string[];
}

export const EMPTY_SELECTION: TestManagementSelection = {
  provider: '',
  planId: '',
  suiteId: '',
  caseIds: [],
};

type Remote<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly data: T };

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Loads with `loader` whenever it changes; a null loader means there is nothing to load. */
function useRemote<T>(loader: (() => Promise<T>) | null): readonly [Remote<T>, () => void] {
  const { t } = useI18n();
  const [state, setState] = useState<Remote<T>>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!loader) {
      setState({ status: 'idle' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    void loader().then(
      (data) => {
        if (active) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (active)
          setState({ status: 'error', message: errorMessage(error, t('e2e.tmLoadFailed')) });
      },
    );
    return () => {
      active = false;
    };
  }, [loader, attempt, t]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return [state, retry] as const;
}

function useProviders(apiClient: ApiClient) {
  return useRemote(useCallback(() => apiClient.getTestManagementProviders(), [apiClient]));
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
      {label}
      {children}
    </label>
  );
}

function RemoteError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-red-400" role="alert">
      {message}
      <Button variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>
        {t('e2e.retry')}
      </Button>
    </p>
  );
}

/** Platform, plan and suite pickers; labels follow each platform's own naming. */
function TargetFields({
  apiClient,
  providers,
  retryProviders,
  value,
  onChange,
  onOpenIntegrations,
  stacked = false,
}: {
  readonly apiClient: ApiClient;
  readonly providers: Remote<readonly TestManagementProvider[]>;
  readonly retryProviders: () => void;
  readonly value: TestManagementTarget;
  readonly onChange: (value: TestManagementTarget) => void;
  readonly onOpenIntegrations?: () => void;
  readonly stacked?: boolean;
}) {
  const { t } = useI18n();
  const { provider, planId } = value;
  const list = providers.status === 'ready' ? providers.data : [];
  const capabilities = list.find((item) => item.id === provider)?.capabilities;
  const hasSuites = Boolean(capabilities?.suiteLabel);
  const [plans, retryPlans] = useRemote<readonly RemoteContainer[]>(
    useMemo(
      () => (provider ? () => apiClient.getTestManagementPlans(provider) : null),
      [apiClient, provider],
    ),
  );
  const [suites, retrySuites] = useRemote<readonly RemoteContainer[]>(
    useMemo(
      () =>
        provider && planId && hasSuites
          ? () => apiClient.getTestManagementSuites(provider, planId)
          : null,
      [apiClient, provider, planId, hasSuites],
    ),
  );

  if (providers.status === 'error')
    return <RemoteError message={providers.message} onRetry={retryProviders} />;
  if (providers.status !== 'ready')
    return <p className="text-sm text-[var(--text-muted)]">{t('e2e.tmLoading')}</p>;
  if (!list.some((item) => item.configured))
    return (
      <p className="text-sm text-amber-400">
        {t('e2e.tmNoPlatforms')}{' '}
        {onOpenIntegrations && (
          <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenIntegrations}>
            {t('nav.connect')}
          </Button>
        )}
      </p>
    );

  const options = (remote: Remote<readonly RemoteContainer[]>, empty: string) =>
    remote.status === 'ready' ? (
      <>
        <option value="">{empty}</option>
        {remote.data.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </>
    ) : (
      <option value="">{t('e2e.tmLoading')}</option>
    );

  return (
    <div className={cn('grid gap-3', !stacked && 'sm:grid-cols-3')}>
      <Field label={t('e2e.tmPlatform')}>
        <Select
          value={provider}
          onChange={(event) =>
            onChange({
              provider: event.target.value as TestManagementProviderId,
              planId: '',
              suiteId: '',
            })
          }
        >
          <option value="">{t('e2e.tmSelect')}</option>
          {list.map((item) => (
            <option key={item.id} value={item.id} disabled={!item.configured}>
              {item.configured ? item.name : t('e2e.tmNotConfigured', { name: item.name })}
            </option>
          ))}
        </Select>
      </Field>
      {capabilities && (
        <Field label={capabilities.planLabel}>
          {plans.status === 'error' ? (
            <RemoteError message={plans.message} onRetry={retryPlans} />
          ) : (
            <Select
              value={planId}
              disabled={plans.status !== 'ready'}
              onChange={(event) => onChange({ ...value, planId: event.target.value, suiteId: '' })}
            >
              {options(plans, t('e2e.tmSelect'))}
            </Select>
          )}
        </Field>
      )}
      {capabilities?.suiteLabel && planId && (
        <Field label={capabilities.suiteLabel}>
          {suites.status === 'error' ? (
            <RemoteError message={suites.message} onRetry={retrySuites} />
          ) : (
            <Select
              value={value.suiteId}
              disabled={suites.status !== 'ready'}
              onChange={(event) => onChange({ ...value, suiteId: event.target.value })}
            >
              {options(suites, t(capabilities.suiteRequired ? 'e2e.tmSelect' : 'e2e.tmAllSuites'))}
            </Select>
          )}
        </Field>
      )}
    </div>
  );
}

/** Platform/plan/suite pickers plus the cases found there, each with a checkbox. */
export function E2eCasePicker({
  apiClient,
  value,
  invalid = false,
  single = false,
  onChange,
  onOpenIntegrations,
}: {
  readonly apiClient: ApiClient;
  readonly value: TestManagementSelection;
  readonly invalid?: boolean;
  readonly single?: boolean;
  readonly onChange: (value: TestManagementSelection) => void;
  readonly onOpenIntegrations?: () => void;
}) {
  const { t } = useI18n();
  const [providers, retryProviders] = useProviders(apiClient);
  const { provider, planId, suiteId } = value;
  const capabilities =
    providers.status === 'ready'
      ? providers.data.find((item) => item.id === provider)?.capabilities
      : undefined;
  const ready = Boolean(
    capabilities && planId && (!capabilities.suiteLabel || !capabilities.suiteRequired || suiteId),
  );
  const [cases, retryCases] = useRemote<readonly ExternalTestCase[]>(
    useMemo(
      () =>
        ready && provider
          ? () =>
              apiClient.getTestManagementCases(provider, {
                planId,
                ...(suiteId ? { suiteId } : {}),
              })
          : null,
      [apiClient, ready, provider, planId, suiteId],
    ),
  );
  const list = cases.status === 'ready' ? cases.data : [];
  const selected = new Set(value.caseIds);
  const allSelected = list.length > 0 && list.every((item) => selected.has(item.caseId));
  const toggle = (caseId: string) =>
    onChange({
      ...value,
      caseIds: selected.has(caseId)
        ? value.caseIds.filter((id) => id !== caseId)
        : [...value.caseIds, caseId],
    });

  return (
    <div className="flex flex-col gap-3" data-testid="e2e-case-picker">
      <TargetFields
        apiClient={apiClient}
        providers={providers}
        retryProviders={retryProviders}
        value={value}
        onChange={(target) => onChange({ ...target, caseIds: [] })}
        onOpenIntegrations={onOpenIntegrations}
        stacked={single}
      />
      {cases.status === 'error' ? (
        <RemoteError message={cases.message} onRetry={retryCases} />
      ) : cases.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
          {t('e2e.tmLoading')}
        </p>
      ) : cases.status === 'idle' ? (
        capabilities && (
          <p className="text-sm text-[var(--text-muted)]">{t('e2e.tmPickLocation')}</p>
        )
      ) : list.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('e2e.tmNoCases')}</p>
      ) : single ? (
        <SearchableSelect
          options={list.map((item) => ({
            value: item.caseId,
            label: `${item.caseId} · ${item.title}`,
          }))}
          value={value.caseIds[0] ?? ''}
          onChange={(caseId) => onChange({ ...value, caseIds: caseId ? [caseId] : [] })}
          label={t('e2e.tmCaseId')}
          placeholder={t('e2e.tmSearchCase')}
          emptyMessage={t('e2e.tmNoCases')}
        />
      ) : (
        <div
          className={cn(
            'overflow-hidden rounded-md border border-[var(--border)]',
            invalid && 'border-red-500/60',
          )}
        >
          <label className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() =>
                onChange({ ...value, caseIds: allSelected ? [] : list.map((item) => item.caseId) })
              }
              className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
            />
            <span className="flex-1">{t('e2e.tmSelectAll')}</span>
            <span className="text-xs text-[var(--text-muted)]">
              {value.caseIds.length}/{list.length}
            </span>
          </label>
          <ul className="max-h-72 overflow-y-auto">
            {list.map((item) => (
              <li key={item.caseId} className="border-b border-[var(--border)] last:border-0">
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-[var(--fill-ghost-hover)]">
                  <input
                    type="checkbox"
                    checked={selected.has(item.caseId)}
                    onChange={() => toggle(item.caseId)}
                    className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
                  />
                  <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
                    {item.caseId}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                    {item.title}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {t('e2e.tmStepCount', { count: item.steps.length })}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {invalid && (
        <p className="text-xs text-red-400" role="alert">
          {t('e2e.tmValidationCases')}
        </p>
      )}
    </div>
  );
}

function Dialog({
  title,
  onClose,
  busy,
  footer,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  return (
    <Modal open labelledBy={titleId} closeOnBackdrop={!busy} onClose={onClose}>
      <div className="flex max-h-[calc(100vh-2rem)] w-[min(720px,calc(100vw-2rem))] flex-col gap-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {children}
        <div className="flex flex-wrap justify-end gap-2">{footer}</div>
      </div>
    </Modal>
  );
}

/** Chooses the platform (and default plan/suite) that receives a run's results. */
export function E2eReportingDialog({
  apiClient,
  creation,
  onClose,
  onSaved,
  onOpenIntegrations,
}: {
  readonly apiClient: ApiClient;
  readonly creation: E2eCreationSummary;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onOpenIntegrations?: () => void;
}) {
  const { t } = useI18n();
  const [providers, retryProviders] = useProviders(apiClient);
  const [target, setTarget] = useState<TestManagementTarget>({
    provider: creation.reporting?.provider ?? '',
    planId: creation.reporting?.planId ?? '',
    suiteId: creation.reporting?.suiteId ?? '',
  });
  const [autoPublish, setAutoPublish] = useState(creation.reporting?.autoPublish ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (stop: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiClient.setE2eReporting(
        creation.id,
        stop
          ? null
          : {
              provider: target.provider as TestManagementProviderId,
              planId: target.planId || null,
              suiteId: target.suiteId || null,
              autoPublish,
            },
      );
      onSaved();
    } catch (reason) {
      setError(errorMessage(reason, t('e2e.actionFailed')));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`${t('e2e.tmTitle')} · ${creation.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          {creation.reporting && (
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={busy}
              onClick={() => void save(true)}
            >
              {t('e2e.tmStopReporting')}
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('e2e.cancel')}
          </Button>
          <Button
            isLoading={busy}
            disabled={busy || !target.provider}
            onClick={() => void save(false)}
          >
            {t('e2e.save')}
          </Button>
        </>
      }
    >
      <TargetFields
        apiClient={apiClient}
        providers={providers}
        retryProviders={retryProviders}
        value={target}
        onChange={setTarget}
        onOpenIntegrations={onOpenIntegrations}
      />
      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={autoPublish}
          onChange={(event) => setAutoPublish(event.target.checked)}
          className="h-4 w-4 cursor-pointer rounded border-[var(--border)]"
        />
        {t('e2e.tmAutoPublish')}
      </label>
      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Adds cases of a test management platform to an existing run. */
export function E2eImportCasesDialog({
  apiClient,
  creation,
  onClose,
  onImported,
  onOpenIntegrations,
}: {
  readonly apiClient: ApiClient;
  readonly creation: E2eCreationSummary;
  readonly onClose: () => void;
  readonly onImported: (result: E2eImportResult) => void;
  readonly onOpenIntegrations?: () => void;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<TestManagementSelection>({
    provider: creation.reporting?.provider ?? '',
    planId: creation.reporting?.planId ?? '',
    suiteId: creation.reporting?.suiteId ?? '',
    caseIds: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onImported(
        await apiClient.importE2eCases(creation.id, {
          provider: selection.provider as TestManagementProviderId,
          // Cases are only listed (and so selectable) once a plan is chosen.
          planId: selection.planId,
          ...(selection.suiteId ? { suiteId: selection.suiteId } : {}),
          caseIds: selection.caseIds,
        }),
      );
    } catch (reason) {
      setError(errorMessage(reason, t('e2e.actionFailed')));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`${t('e2e.tmImport')} · ${creation.name}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('e2e.cancel')}
          </Button>
          <Button
            isLoading={busy}
            disabled={busy || selection.caseIds.length === 0}
            onClick={() => void submit()}
          >
            {t('e2e.tmImportConfirm', { count: selection.caseIds.length })}
          </Button>
        </>
      }
    >
      <p className="text-sm text-[var(--text-secondary)]">{t('e2e.tmImportHint')}</p>
      <E2eCasePicker
        apiClient={apiClient}
        value={selection}
        onChange={setSelection}
        onOpenIntegrations={onOpenIntegrations}
      />
      {error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** Outcome of the latest publication: in progress, published (with its link) or failed. */
export function E2eReportStatus({ report }: { readonly report: E2eLastReport }) {
  const { t } = useI18n();
  const provider = TEST_MANAGEMENT_NAMES[report.provider];
  if (report.status === 'publishing')
    return (
      <p className="flex items-center gap-2 text-sm text-sky-400" role="status">
        <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
        {t('e2e.tmPublishing', { provider })}
      </p>
    );
  if (report.status === 'failed')
    return (
      <p className="flex items-start gap-2 text-sm text-red-400" role="alert">
        <i className="ti ti-alert-circle-filled mt-0.5" aria-hidden="true" />
        {t('e2e.tmPublishFailed', { provider, error: report.error ?? '' })}
      </p>
    );
  return (
    <div className="flex flex-col gap-1" role="status">
      <p className="flex flex-wrap items-center gap-2 text-sm text-emerald-400">
        <i className="ti ti-circle-check-filled" aria-hidden="true" />
        {t('e2e.tmPublished', { provider, count: report.publishedCases })}
        {report.url && (
          <a
            href={report.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[var(--text-accent)] underline-offset-4 hover:underline"
          >
            {t('e2e.tmOpenRun')}
            <i className="ti ti-external-link" aria-hidden="true" />
          </a>
        )}
      </p>
      {report.warnings.length > 0 && (
        <ul className="list-disc pl-6 text-xs text-amber-400">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Where the run reports and its last publication, above its tests; nothing for a run that was
 * never reported. Managing and importing live in the run menu.
 */
export function E2eReportStrip({
  creation,
  isReadOnly,
  onPublish,
}: {
  readonly creation: E2eCreationSummary;
  readonly isReadOnly: boolean;
  readonly onPublish: () => void;
}) {
  const { t } = useI18n();
  const { reporting, lastReport } = creation;
  const busy = needsPolling(creation);
  if (!reporting && !lastReport) return null;
  return (
    <div
      className="flex flex-col gap-2 border-b border-[var(--border)] py-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid="e2e-report-strip"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-secondary)]">
          <i className="ti ti-clipboard-check text-[var(--text-accent)]" aria-hidden="true" />
          {reporting
            ? t('e2e.tmReportingTo', { provider: TEST_MANAGEMENT_NAMES[reporting.provider] })
            : t('e2e.tmNotReported')}
          {reporting?.autoPublish && (
            <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
              {t('e2e.tmAutoPublishOn')}
            </span>
          )}
        </p>
        {lastReport && <E2eReportStatus report={lastReport} />}
      </div>
      {!isReadOnly && reporting && (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0"
          disabled={busy}
          onClick={onPublish}
        >
          <i className="ti ti-send" aria-hidden="true" />
          {t('e2e.tmPublish')}
        </Button>
      )}
    </div>
  );
}
