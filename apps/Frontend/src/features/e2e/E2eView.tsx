import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { SkeletonRow } from '../../components/ui/skeleton.js';
import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { E2eConfigForm, type E2eSavedCasesSeed } from './E2eConfigForm.js';
import { E2eTestDetail } from './E2eTestDetail.js';
import { E2eCreationStatusLabel, E2eTestStatusLabel } from './E2eStatus.js';
import { E2eImportCasesDialog, E2eReportingDialog, E2eReportStrip } from './E2eTestManagement.js';
import { isCreationActive, needsPolling, type E2eCreationSummary } from './e2e-types.js';

const POLL_MS = 3000;

type Screen =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'edit'; creationId: string }
  | { kind: 'test'; testId: string; creationId: string };
type StatusFilter = 'all' | 'passed' | 'failed' | 'active';
type SortKey = 'updatedAt' | 'createdAt' | 'name';
type TestManagementDialog = { kind: 'reporting' | 'import'; creation: E2eCreationSummary };

export interface E2eViewProps {
  readonly apiClient: ApiClient;
  readonly isReadOnly?: boolean;
  readonly onOpenAgents?: () => void;
  readonly onOpenIntegrations?: () => void;
  /** Opens the form for a new run that automates these saved test cases. */
  readonly initialSavedCases?: E2eSavedCasesSeed;
}

function matchesFilter(creation: E2eCreationSummary, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  // A draft waiting for its plan is still in progress, not a failure.
  const inProgress = isCreationActive(creation.status) || creation.status === 'draft';
  if (filter === 'active') return inProgress;
  if (inProgress) return false;
  const allPassed = creation.total > 0 && creation.passed === creation.total;
  return filter === 'passed' ? allPassed : !allPassed;
}

export function E2eView({
  apiClient,
  isReadOnly = false,
  onOpenAgents: openAgents,
  onOpenIntegrations: openIntegrations,
  initialSavedCases,
}: E2eViewProps) {
  const { t, formatDate } = useI18n();
  const { can } = usePermissions();
  // Links to other modules (here, in the form and in the dialogs) only appear for members
  // who can open them.
  const onOpenAgents = can('agents') ? openAgents : undefined;
  const onOpenIntegrations = can('integrations') ? openIntegrations : undefined;
  // Delete includes edit, so a read-only member never gets it.
  const canDelete = !isReadOnly && can('e2e', 'delete');
  // Imported cases come from test plans.
  const canImportCases = can('testplans');
  const [screen, setScreen] = useState<Screen>(() =>
    initialSavedCases && !isReadOnly ? { kind: 'new' } : { kind: 'list' },
  );
  const [creations, setCreations] = useState<readonly E2eCreationSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<SortKey>('updatedAt');
  const [pendingDelete, setPendingDelete] = useState<E2eCreationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tmDialog, setTmDialog] = useState<TestManagementDialog | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await apiClient.getE2eCreations();
      setCreations(list);
      setLoadError(null);
      return list;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('e2e.loadFailed'));
      return null;
    }
  }, [apiClient, t]);

  useEffect(() => {
    if (screen.kind !== 'list') return;
    void load().then((list) => {
      // Open the newest run so its progress is visible right away.
      const first = list?.[0];
      if (first) setExpanded((current) => (current.size ? current : new Set([first.id])));
    });
  }, [load, screen.kind]);

  const hasActive = Boolean(creations?.some(needsPolling));
  useEffect(() => {
    if (screen.kind !== 'list' || !hasActive) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, load, screen.kind]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...(creations ?? [])]
      .filter((creation) => matchesFilter(creation, filter))
      .filter(
        (creation) =>
          !query ||
          creation.name.toLowerCase().includes(query) ||
          creation.tests.some((test) => `${test.code} ${test.title}`.toLowerCase().includes(query)),
      )
      .sort((a, b) =>
        sort === 'name' ? a.name.localeCompare(b.name) : b[sort].localeCompare(a[sort]),
      );
  }, [creations, filter, search, sort]);

  const runAction = async (action: () => Promise<void>) => {
    setActionError(null);
    try {
      await action();
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('e2e.actionFailed'));
    }
  };

  const pullScripts = async (creation: E2eCreationSummary) => {
    setNotice(null);
    await runAction(async () => {
      const result = await apiClient.pullE2eCreation(creation.id);
      setNotice(t('e2e.pullResult', { ...result, name: creation.name }));
    });
  };

  const publish = (creation: E2eCreationSummary) => {
    setNotice(null);
    void runAction(async () => {
      await apiClient.publishE2eCreation(creation.id);
    });
  };

  const closeTmDialog = (message: string | null) => {
    setTmDialog(null);
    setNotice(message);
    void load();
  };

  const confirmDelete = async (target: E2eCreationSummary) => {
    setDeleting(true);
    await runAction(() => apiClient.deleteE2eCreation(target.id));
    setDeleting(false);
    setPendingDelete(null);
  };

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (screen.kind === 'new' || screen.kind === 'edit')
    return (
      <E2eConfigForm
        key={screen.kind === 'edit' ? screen.creationId : 'new'}
        apiClient={apiClient}
        creationId={screen.kind === 'edit' ? screen.creationId : undefined}
        initialSavedCases={screen.kind === 'new' ? initialSavedCases : undefined}
        onCancel={() => setScreen({ kind: 'list' })}
        onOpenAgents={onOpenAgents}
        onOpenIntegrations={onOpenIntegrations}
        onCreated={(creation) => {
          setExpanded(new Set([creation.id]));
          setNotice(screen.kind === 'edit' ? t('e2e.saved', { name: creation.name }) : null);
          setScreen({ kind: 'list' });
        }}
      />
    );

  if (screen.kind === 'test')
    return (
      <E2eTestDetail
        apiClient={apiClient}
        testId={screen.testId}
        reporting={creations?.find((item) => item.id === screen.creationId)?.reporting ?? null}
        isReadOnly={isReadOnly}
        onBack={() => setScreen({ kind: 'list' })}
      />
    );

  const dateFormat = { dateStyle: 'short', timeStyle: 'short' } as const;

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="e2e-view">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <i
              className="ti ti-player-play text-2xl text-[var(--fill-accent)]"
              aria-hidden="true"
            />
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              {t('e2e.title')}
            </h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('e2e.subtitle')}</p>
        </div>
        {!isReadOnly && (
          <Button onClick={() => setScreen({ kind: 'new' })}>
            <i className="ti ti-plus" aria-hidden="true" />
            {t('e2e.newRun')}
          </Button>
        )}
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-secondary)]">
        {t('e2e.tip')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-64">
          <Input
            aria-label={t('e2e.searchPlaceholder')}
            placeholder={t('e2e.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leftIcon={<i className="ti ti-search" aria-hidden="true" />}
          />
        </div>
        <Select
          aria-label={t('e2e.filterLabel')}
          value={filter}
          onChange={(event) => setFilter(event.target.value as StatusFilter)}
          containerClassName="w-44"
        >
          <option value="all">{t('e2e.filterAll')}</option>
          <option value="passed">{t('e2e.filterPassed')}</option>
          <option value="failed">{t('e2e.filterFailed')}</option>
          <option value="active">{t('e2e.filterActive')}</option>
        </Select>
        <Select
          aria-label={t('e2e.sortLabel')}
          value={sort}
          onChange={(event) => setSort(event.target.value as SortKey)}
          containerClassName="w-56"
        >
          <option value="updatedAt">{t('e2e.sortModified')}</option>
          <option value="createdAt">{t('e2e.sortCreated')}</option>
          <option value="name">{t('e2e.sortName')}</option>
        </Select>
      </div>

      {notice && (
        <p
          className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
          role="status"
        >
          {notice}
        </p>
      )}
      {actionError && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {actionError}
        </p>
      )}

      {loadError && !creations ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-red-400">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('e2e.retry')}
          </Button>
        </div>
      ) : !creations ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : creations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border)] px-6 py-16 text-center">
          <i className="ti ti-video text-4xl text-[var(--text-muted)]" aria-hidden="true" />
          <p className="font-medium text-[var(--text-primary)]">{t('e2e.empty')}</p>
          <p className="text-sm text-[var(--text-secondary)]">{t('e2e.emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <thead className="bg-[var(--surface-1)] text-[var(--text-secondary)]">
              <tr>
                <th className="w-10" />
                <th className="px-3 py-3 font-medium">{t('e2e.columnName')}</th>
                <th className="px-3 py-3 font-medium">{t('e2e.columnStatus')}</th>
                <th className="w-12" />
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-[var(--text-secondary)]">
                    {t('e2e.noMatches')}
                  </td>
                </tr>
              )}
              {visible.map((creation) => {
                const open = expanded.has(creation.id);
                const active = isCreationActive(creation.status);
                return [
                  <tr
                    key={creation.id}
                    className="border-t border-[var(--border)] align-top hover:bg-[var(--fill-ghost-hover)]"
                  >
                    <td className="py-2 pl-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={open}
                        aria-label={t('e2e.toggleRun', { name: creation.name })}
                        onClick={() => toggle(creation.id)}
                      >
                        <i
                          className={cn(
                            'ti ti-chevron-down transition-transform',
                            !open && '-rotate-90',
                          )}
                          aria-hidden="true"
                        />
                      </Button>
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-medium text-[var(--text-primary)]">
                        {creation.name}
                      </span>
                      {creation.executionTarget === 'local' && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 align-middle text-xs text-[var(--text-secondary)]">
                          <i className="ti ti-device-laptop" aria-hidden="true" />
                          {t('e2e.localRunBadge')}
                        </span>
                      )}
                      <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                        {creation.baseUrl}
                        {creation.path}
                      </span>
                      {creation.repository && (
                        <span className="mt-0.5 flex items-center gap-1 font-mono text-xs text-[var(--text-muted)]">
                          <i
                            className={cn(
                              'ti',
                              creation.repository.provider === 'github'
                                ? 'ti-brand-github'
                                : 'ti-brand-azure',
                            )}
                            aria-hidden="true"
                          />
                          {creation.repository.name}@{creation.repository.branch}
                          {creation.repository.path && `/${creation.repository.path}`}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <E2eCreationStatusLabel
                        status={creation.status}
                        passed={creation.passed}
                        total={creation.total}
                      />
                      <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                        {formatDate(creation.createdAt, dateFormat)}
                      </span>
                      {creation.error && (
                        <span className="mt-1 block max-w-xl text-xs text-red-400">
                          {creation.error}
                        </span>
                      )}
                      {creation.executionTarget === 'local' &&
                        isCreationActive(creation.status) && (
                          <span className="mt-1 block max-w-xl text-xs text-[var(--text-secondary)]">
                            {t('e2e.localRunWaiting')}
                          </span>
                        )}
                    </td>
                    <td className="py-2 pr-2 text-right">
                      {!isReadOnly && (
                        <ActionsMenu portal>
                          {!active && (
                            <Button
                              variant="ghost"
                              role="menuitem"
                              className="flex w-full justify-start text-left"
                              onClick={() => {
                                setNotice(null);
                                setActionError(null);
                                setScreen({ kind: 'edit', creationId: creation.id });
                              }}
                            >
                              <i className="ti ti-pencil" aria-hidden="true" />
                              {t('e2e.editRun')}
                            </Button>
                          )}
                          {active ? (
                            <Button
                              variant="ghost"
                              role="menuitem"
                              className="flex w-full justify-start text-left"
                              onClick={() =>
                                void runAction(() => apiClient.cancelE2eCreation(creation.id))
                              }
                            >
                              <i className="ti ti-player-stop" aria-hidden="true" />
                              {t('e2e.cancelRun')}
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              role="menuitem"
                              className="flex w-full justify-start text-left"
                              onClick={() =>
                                void runAction(() => apiClient.rerunE2eCreation(creation.id))
                              }
                            >
                              <i className="ti ti-refresh" aria-hidden="true" />
                              {t('e2e.rerunAll')}
                            </Button>
                          )}
                          {creation.repository && !active && (
                            <Button
                              variant="ghost"
                              role="menuitem"
                              className="flex w-full justify-start text-left"
                              onClick={() => void pullScripts(creation)}
                            >
                              <i className="ti ti-download" aria-hidden="true" />
                              {t('e2e.pullScripts')}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            role="menuitem"
                            className="flex w-full justify-start text-left"
                            onClick={() => setTmDialog({ kind: 'reporting', creation })}
                          >
                            <i className="ti ti-settings" aria-hidden="true" />
                            {t('e2e.tmTitle')}
                          </Button>
                          {canImportCases && !needsPolling(creation) && (
                            <Button
                              variant="ghost"
                              role="menuitem"
                              className="flex w-full justify-start text-left"
                              onClick={() => setTmDialog({ kind: 'import', creation })}
                            >
                              <i className="ti ti-file-import" aria-hidden="true" />
                              {t('e2e.tmImport')}
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              role="menuitem"
                              className="flex w-full justify-start text-left text-red-400"
                              onClick={() => setPendingDelete(creation)}
                            >
                              <i className="ti ti-trash" aria-hidden="true" />
                              {t('e2e.deleteRun')}
                            </Button>
                          )}
                        </ActionsMenu>
                      )}
                    </td>
                  </tr>,
                  open && (
                    <tr key={`${creation.id}-tests`} className="bg-[var(--surface-1)]">
                      <td />
                      <td colSpan={3} className="pb-3 pr-3">
                        <E2eReportStrip
                          creation={creation}
                          isReadOnly={isReadOnly}
                          onPublish={() => publish(creation)}
                        />
                        {creation.tests.length === 0 ? (
                          <p className="flex items-center gap-2 py-3 text-sm text-[var(--text-secondary)]">
                            {active && (
                              <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
                            )}
                            {active
                              ? t('e2e.planningHint')
                              : creation.status === 'draft'
                                ? t('e2e.draftHint')
                                : creation.error}
                          </p>
                        ) : (
                          <table className="w-full text-sm" aria-label={creation.name}>
                            <thead className="text-[var(--text-secondary)]">
                              <tr>
                                <th className="py-2 pr-3 font-medium">{t('e2e.columnTest')}</th>
                                <th className="py-2 pr-3 font-medium">{t('e2e.columnType')}</th>
                                <th className="py-2 pr-3 font-medium">{t('e2e.columnLatest')}</th>
                                <th className="py-2 font-medium">{t('e2e.columnModified')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {creation.tests.map((test) => (
                                <tr key={test.id} className="border-t border-[var(--border)]">
                                  <td className="py-2 pr-3">
                                    <Button
                                      variant="link"
                                      className="h-auto whitespace-normal p-0 text-left font-normal text-[var(--text-primary)]"
                                      onClick={() =>
                                        setScreen({
                                          kind: 'test',
                                          testId: test.id,
                                          creationId: creation.id,
                                        })
                                      }
                                    >
                                      {test.code}-{test.title}
                                    </Button>
                                    {test.externalCase && (
                                      <span className="ml-2 inline-flex items-center gap-1 font-mono text-xs text-[var(--text-muted)]">
                                        <i className="ti ti-link" aria-hidden="true" />
                                        {test.externalCase.caseId}
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2 pr-3 text-[var(--text-secondary)]">
                                    {t(
                                      creation.mode === 'backend'
                                        ? 'e2e.typeBackend'
                                        : 'e2e.typeFrontend',
                                    )}
                                  </td>
                                  <td className="py-2 pr-3">
                                    <E2eTestStatusLabel status={test.status} />
                                  </td>
                                  <td className="py-2 text-[var(--text-secondary)]">
                                    {formatDate(test.updatedAt, dateFormat)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {tmDialog?.kind === 'reporting' && (
        <E2eReportingDialog
          apiClient={apiClient}
          creation={tmDialog.creation}
          onClose={() => setTmDialog(null)}
          onSaved={() => closeTmDialog(t('e2e.tmReportingSaved', { name: tmDialog.creation.name }))}
          onOpenIntegrations={onOpenIntegrations}
        />
      )}
      {tmDialog?.kind === 'import' && (
        <E2eImportCasesDialog
          apiClient={apiClient}
          creation={tmDialog.creation}
          onClose={() => setTmDialog(null)}
          onImported={(result) =>
            closeTmDialog(
              t('e2e.tmImportResult', {
                imported: result.imported,
                skipped: result.skipped,
                name: tmDialog.creation.name,
              }),
            )
          }
          onOpenIntegrations={onOpenIntegrations}
        />
      )}

      {pendingDelete && (
        <ConfirmationDialog
          open
          title={t('e2e.deleteTitle')}
          description={t('e2e.deleteDescription', { name: pendingDelete.name })}
          confirmLabel={t('e2e.deleteConfirm')}
          cancelLabel={t('e2e.cancel')}
          destructive
          isLoading={deleting}
          onConfirm={() => void confirmDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
