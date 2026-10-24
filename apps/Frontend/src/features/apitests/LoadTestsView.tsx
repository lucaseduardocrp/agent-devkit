import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ResizableSidebar } from '../../components/layout/ResizableSidebar.js';
import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { SearchableSelect } from '../../components/ui/searchable-select.js';
import { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import {
  flattenItems,
  isActiveRun,
  type ApiCollection,
  type ApiCollectionSummary,
  type ApiEnvironment,
  type ApiRun,
  type ApiRunTarget,
  type LoadProfileType,
  type LoadScenario,
  type LoadScenarioInput,
  type LoadSummary,
} from './api-test-types.js';
import { GenerateDialog } from './ApiTestShared.js';
import { LoadTestsSkeleton } from './ApiTestSkeletons.js';
import { downloadBlob } from './api-test-ui.js';
import { EmptyPane, NameDialog, PaneTabs } from './integration/integration-parts.js';
import { LoadPlanPane } from './load/LoadPlanPane.js';
import { LoadRunDialog } from './load/LoadRunDialog.js';
import { LoadRunsPane } from './load/LoadRunsPane.js';
import { PROFILE_ICON, emptyScenario } from './load/load-model.js';

const defaultApiClient = new ApiClient();

export interface LoadTestsViewProps {
  readonly apiClient?: ApiClient;
  readonly isReadOnly?: boolean;
}

type Tab = 'plan' | 'runs';
const snapshot = (draft: LoadScenarioInput | null) => JSON.stringify(draft);

export function LoadTestsView({
  apiClient = defaultApiClient,
  isReadOnly = false,
}: LoadTestsViewProps): React.JSX.Element {
  const { t } = useI18n();
  const [scenarios, setScenarios] = useState<LoadScenario[]>([]);
  const [collections, setCollections] = useState<ApiCollectionSummary[]>([]);
  const [environments, setEnvironments] = useState<ApiEnvironment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoadScenarioInput | null>(null);
  const [saved, setSaved] = useState('null');
  const [collection, setCollection] = useState<ApiCollection | null>(null);
  const [preset, setPreset] = useState({ vus: 20, durationSec: 300 });
  const [runs, setRuns] = useState<ApiRun[]>([]);
  const [run, setRun] = useState<ApiRun<LoadSummary> | null>(null);
  const [target, setTarget] = useState<ApiRunTarget>('remote');
  const [tab, setTab] = useState<Tab>('plan');
  const [filter, setFilter] = useState('');
  const [showRun, setShowRun] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [naming, setNaming] = useState<'new' | 'rename' | 'duplicate' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True until the scenarios, collections and environments are listed.
  const [loading, setLoading] = useState(true);
  // Picking another collection (or creating a scenario) selects all of its requests once loaded.
  const selectAllOnLoad = useRef(false);

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const dirty = draft !== null && snapshot(draft) !== saved;
  const valid = Boolean(draft?.name.trim() && draft.collectionId && draft.requests.length);

  const load = useCallback(async () => {
    try {
      const [list, cols, envs] = await Promise.all([
        apiClient.listLoadScenarios(),
        apiClient.listApiCollections(),
        apiClient.listApiEnvironments(),
      ]);
      setScenarios(list);
      setCollections(cols);
      setEnvironments(envs);
      return list;
    } catch (err) {
      fail(err);
      return [];
    }
  }, [apiClient]);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    if (!draft?.collectionId) {
      setCollection(null);
      return;
    }
    if (collection?.id === draft.collectionId) return;
    apiClient
      .getApiCollection(draft.collectionId)
      .then((loaded) => {
        setCollection(loaded);
        if (selectAllOnLoad.current) {
          selectAllOnLoad.current = false;
          setDraft((current) =>
            current && current.collectionId === loaded.id
              ? {
                  ...current,
                  requests: flattenItems(loaded.items).map(({ request }) => ({
                    requestId: request.id,
                    weight: 1,
                  })),
                }
              : current,
          );
        }
      })
      .catch(fail);
  }, [apiClient, collection?.id, draft?.collectionId]);

  // Follows the run being looked at until it ends.
  useEffect(() => {
    if (!run || !isActiveRun(run)) return;
    const timer = window.setInterval(() => {
      apiClient
        .getApiRun('load', run.id)
        .then((next) => {
          setRun(next as ApiRun<LoadSummary>);
          setRuns((current) => current.map((item) => (item.id === next.id ? next : item)));
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [apiClient, run]);

  const select = async (scenario: LoadScenario) => {
    if (dirty && !window.confirm(t('apiTests.discardChanges'))) return;
    const { id: _id, updatedAt: _updatedAt, ...input } = scenario;
    setSelectedId(scenario.id);
    setDraft(input);
    setSaved(snapshot(input));
    setRun(null);
    setTab('plan');
    setError(null);
    try {
      const list = await apiClient.listApiRuns('load', { scenarioId: scenario.id });
      setRuns(list);
    } catch (err) {
      fail(err);
    }
  };

  const createScenario = (name: string) => {
    const collectionId = collections[0]?.id ?? '';
    selectAllOnLoad.current = true;
    setCollection(null);
    setSelectedId(null);
    setDraft(emptyScenario(name, collectionId));
    setSaved('null');
    setRuns([]);
    setRun(null);
    setTab('plan');
  };

  const applyProfile = async (profile: LoadProfileType) => {
    if (!draft) return;
    if (profile === 'custom') return setDraft({ ...draft, profile });
    try {
      const profiles = await apiClient.getLoadProfiles(preset.vus, preset.durationSec);
      const chosen = profiles.find((item) => item.profile === profile);
      setDraft({
        ...draft,
        profile,
        ...(chosen ? { stages: chosen.stages, thresholds: chosen.thresholds } : {}),
      });
    } catch (err) {
      fail(err);
    }
  };

  const save = async (): Promise<LoadScenario | null> => {
    if (!draft || !valid) return null;
    setError(null);
    try {
      const stored = await apiClient.saveLoadScenario(draft, selectedId ?? undefined);
      const { id: _id, updatedAt: _updatedAt, ...input } = stored;
      setSelectedId(stored.id);
      setDraft(input);
      setSaved(snapshot(input));
      await load();
      return stored;
    } catch (err) {
      fail(err);
      return null;
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 's' &&
        dirty &&
        !isReadOnly
      ) {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const remove = async () => {
    setConfirmDelete(false);
    if (!selectedId) return;
    try {
      await apiClient.deleteLoadScenario(selectedId);
      setSelectedId(null);
      setDraft(null);
      setSaved('null');
      await load();
    } catch (err) {
      fail(err);
    }
  };

  const exportK6 = async () => {
    if (!selectedId) return;
    try {
      const file = await apiClient.exportLoadScenarioK6(selectedId);
      downloadBlob(new Blob([file.body], { type: 'text/javascript' }), file.fileName);
    } catch (err) {
      fail(err);
    }
  };

  /** Runs read the stored scenario, so pending edits are saved first. */
  const openRun = async () => {
    if (dirty || !selectedId) {
      if (!(await save())) return;
    }
    setShowRun(true);
  };

  const start = async () => {
    if (!selectedId) return;
    setStarting(true);
    setError(null);
    try {
      const started = await apiClient.startLoadRun({
        scenarioId: selectedId,
        target,
        authorized: true,
      });
      setRun(started as ApiRun<LoadSummary>);
      setRuns((current) => [started, ...current]);
      setShowRun(false);
      setTab('runs');
    } catch (err) {
      fail(err);
    } finally {
      setStarting(false);
    }
  };

  const requests = useMemo(() => (collection ? flattenItems(collection.items) : []), [collection]);
  const shown = scenarios.filter((scenario) =>
    scenario.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const renderMain = () => {
    if (!collections.length) {
      return (
        <EmptyPane icon="ti-gauge !text-6xl opacity-40">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {t('apiTests.loadTitle')}
          </h2>
          <p className="max-w-md">{t('apiTests.loadNeedsCollection')}</p>
        </EmptyPane>
      );
    }
    if (!draft) {
      return (
        <EmptyPane icon="ti-gauge !text-6xl opacity-40">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {t('apiTests.loadTitle')}
          </h2>
          <p className="max-w-lg">{t('apiTests.loadSubtitle')}</p>
          {!isReadOnly && (
            <div className="mt-2 flex gap-2">
              <Button onClick={() => setNaming('new')}>
                <i className="ti ti-plus" aria-hidden="true" />
                {t('apiTests.newScenario')}
              </Button>
              <Button variant="secondary" onClick={() => setShowGenerate(true)}>
                <i className="ti ti-sparkles" aria-hidden="true" />
                {t('apiTests.generateWithAi')}
              </Button>
            </div>
          )}
        </EmptyPane>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
          <i
            className={cn('ti text-[var(--text-accent)]', PROFILE_ICON[draft.profile])}
            aria-hidden="true"
          />
          <span
            className="min-w-0 truncate text-sm font-semibold text-[var(--text-primary)]"
            data-testid="scenario-title"
          >
            {draft.name}
          </span>
          {dirty && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--fill-warning)]"
              aria-label={t('apiTests.ui.unsaved')}
            />
          )}
          {!isReadOnly && (
            <IconButton
              size="sm"
              icon={<i className="ti ti-pencil text-sm" aria-hidden="true" />}
              label={t('apiTests.loadUi.renameScenario')}
              title={t('apiTests.loadUi.renameScenario')}
              onClick={() => setNaming('rename')}
              data-testid="rename-scenario"
            />
          )}
          <span className="flex-1" />
          <div className="w-56">
            <SearchableSelect
              label={t('apiTests.collection')}
              placeholder={t('apiTests.collection')}
              emptyMessage=""
              searchable={false}
              disabled={isReadOnly}
              value={draft.collectionId}
              options={collections.map((item) => ({ value: item.id, label: item.name }))}
              onChange={(collectionId) => {
                if (collectionId === draft.collectionId) return;
                selectAllOnLoad.current = true;
                setDraft({ ...draft, collectionId, requests: [] });
              }}
              data-testid="scenario-collection"
            />
          </div>
          <div className="w-48">
            <SearchableSelect
              label={t('apiTests.environment')}
              placeholder={t('apiTests.noEnvironment')}
              emptyMessage=""
              searchable={false}
              disabled={isReadOnly}
              value={draft.environmentId ?? ''}
              options={[
                { value: '', label: t('apiTests.noEnvironment') },
                ...environments.map((environment) => ({
                  value: environment.id,
                  label: environment.name,
                })),
              ]}
              onChange={(environmentId) =>
                setDraft({ ...draft, environmentId: environmentId || null })
              }
              data-testid="scenario-environment"
            />
          </div>
          {selectedId && (
            <IconButton
              variant="subtle"
              icon={<i className="ti ti-file-export" aria-hidden="true" />}
              label={t('apiTests.exportK6')}
              title={t('apiTests.exportK6')}
              onClick={() => void exportK6()}
              data-testid="export-k6"
            />
          )}
          {!isReadOnly && (
            <>
              <IconButton
                variant="default"
                icon={<i className="ti ti-device-floppy" aria-hidden="true" />}
                label={t('apiTests.save')}
                title={`${t('apiTests.save')} (Ctrl + S)`}
                disabled={!dirty || !valid}
                onClick={() => void save()}
                data-testid="save-scenario"
              />
              <Button disabled={!valid} onClick={() => void openRun()} data-testid="open-run">
                <i className="ti ti-player-play" aria-hidden="true" />
                {t('apiTests.loadUi.run')}
              </Button>
            </>
          )}
        </header>
        <PaneTabs
          label={draft.name}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'plan', label: t('apiTests.loadUi.plan') },
            { id: 'runs', label: t('apiTests.loadUi.runs'), indicator: runs.length },
          ]}
        />
        <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
          {tab === 'plan' ? (
            <div className="p-6">
              <LoadPlanPane
                draft={draft}
                requests={requests}
                loadingRequests={
                  Boolean(draft.collectionId) && collection?.id !== draft.collectionId
                }
                preset={preset}
                readOnly={isReadOnly}
                onChange={setDraft}
                onPreset={setPreset}
                onApplyProfile={(profile) => void applyProfile(profile)}
              />
            </div>
          ) : (
            <LoadRunsPane
              runs={runs}
              run={run}
              onSelect={(id) =>
                void apiClient
                  .getApiRun('load', id)
                  .then((full) => setRun(full as ApiRun<LoadSummary>))
                  .catch(fail)
              }
              onCancel={() =>
                run &&
                void apiClient
                  .cancelApiRun('load', run.id)
                  .then((next) => setRun(next as ApiRun<LoadSummary>))
                  .catch(fail)
              }
            />
          )}
        </div>
      </div>
    );
  };

  const selectedName = draft?.name ?? '';
  if (loading) return <LoadTestsSkeleton />;

  return (
    <div
      className="-m-5 flex h-[calc(100%+2.5rem)] min-h-[560px] overflow-hidden bg-[var(--surface-0)]"
      data-testid="load-tests-view"
    >
      <ResizableSidebar
        className="border-r border-[var(--border)] bg-[var(--surface-1)]"
        defaultWidth={280}
        minWidth={220}
        maxWidth={480}
        aria-label={t('apiTests.scenarios')}
      >
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--border)] pl-3 pr-1.5">
          <h2 className="flex-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            {t('apiTests.scenarios')}
          </h2>
          {!isReadOnly && (
            <>
              <IconButton
                size="sm"
                icon={<i className="ti ti-plus" aria-hidden="true" />}
                label={t('apiTests.newScenario')}
                title={t('apiTests.newScenario')}
                disabled={!collections.length}
                onClick={() => setNaming('new')}
                data-testid="new-scenario"
              />
              <IconButton
                size="sm"
                icon={<i className="ti ti-sparkles" aria-hidden="true" />}
                label={t('apiTests.generateWithAi')}
                title={t('apiTests.generateWithAi')}
                disabled={!collections.length}
                onClick={() => setShowGenerate(true)}
              />
            </>
          )}
        </div>
        <div className="shrink-0 p-2">
          <Input
            leftIcon={<i className="ti ti-search" aria-hidden="true" />}
            value={filter}
            placeholder={t('apiTests.loadUi.searchScenarios')}
            aria-label={t('apiTests.loadUi.searchScenarios')}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto pb-3">
          {draft && !selectedId && (
            <li className="flex h-12 items-center gap-2 bg-[var(--fill-ghost-selected)] px-3 text-sm">
              <i
                className={cn('ti text-[var(--text-accent)]', PROFILE_ICON[draft.profile])}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate italic text-[var(--text-primary)]">
                {draft.name}
              </span>
              <span className="text-[11px] text-[var(--text-warning)]">
                {t('apiTests.ui.unsaved')}
              </span>
            </li>
          )}
          {shown.map((scenario) => (
            <li
              key={scenario.id}
              className={cn(
                'group flex items-center pr-1 hover:bg-[var(--fill-ghost-hover)]',
                selectedId === scenario.id && 'bg-[var(--fill-ghost-selected)]',
              )}
            >
              <button
                type="button"
                onClick={() => void select(scenario)}
                className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-3 text-left"
                data-testid={`scenario-${scenario.name}`}
              >
                <i
                  className={cn(
                    'ti text-base text-[var(--text-muted)]',
                    PROFILE_ICON[scenario.profile],
                  )}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-[var(--text-primary)]">
                    {scenario.name}
                    {selectedId === scenario.id && dirty && (
                      <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--fill-warning)] align-middle" />
                    )}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {t(`apiTests.profiles.${scenario.profile}.name`)}
                  </span>
                </span>
              </button>
              {!isReadOnly && (
                <div className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 [&_button[aria-haspopup]]:h-7 [&_button[aria-haspopup]]:w-7">
                  <ActionsMenu portal label={t('apiTests.ui.itemActions', { name: scenario.name })}>
                    <Button
                      variant="ghost"
                      role="menuitem"
                      onClick={() => void select(scenario).then(() => setNaming('duplicate'))}
                    >
                      <i className="ti ti-copy" aria-hidden="true" />
                      {t('apiTests.loadUi.duplicate')}
                    </Button>
                    <Button
                      variant="ghost"
                      role="menuitem"
                      data-destructive
                      onClick={() => void select(scenario).then(() => setConfirmDelete(true))}
                    >
                      <i className="ti ti-trash" aria-hidden="true" />
                      {t('apiTests.delete')}
                    </Button>
                  </ActionsMenu>
                </div>
              )}
            </li>
          ))}
          {!scenarios.length && !draft && (
            <li className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
              {t('apiTests.noScenarios')}
            </li>
          )}
        </ul>
      </ResizableSidebar>

      <div className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div
            role="alert"
            className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--bg-danger)] bg-[var(--bg-danger)] px-3 py-1.5 text-xs text-[var(--text-danger)]"
          >
            <span>{error}</span>
            <IconButton
              size="xs"
              icon={<i className="ti ti-x" aria-hidden="true" />}
              label={t('apiTests.close')}
              onClick={() => setError(null)}
            />
          </div>
        )}
        <div className="min-h-0 flex-1">{renderMain()}</div>
        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          <i
            className={cn('ti text-base', target === 'local' ? 'ti-device-laptop' : 'ti-cloud')}
            aria-hidden="true"
          />
          <div className="w-72">
            <SearchableSelect
              label={t('apiTests.target')}
              placeholder={t('apiTests.target')}
              emptyMessage=""
              value={target}
              options={[
                { value: 'remote', label: t('apiTests.targetRemote') },
                { value: 'local', label: t('apiTests.targetLocal') },
              ]}
              onChange={(value) => setTarget(value as ApiRunTarget)}
              searchable={false}
              placement="top"
              data-testid="run-target"
            />
          </div>
          {target === 'local' && <span className="truncate">{t('apiTests.ui.localHint')}</span>}
          <span className="ml-auto hidden sm:inline">Ctrl + S · {t('apiTests.save')}</span>
        </footer>
      </div>

      {draft && (
        <LoadRunDialog
          open={showRun}
          scenario={draft}
          target={target}
          starting={starting}
          onStart={() => void start()}
          onClose={() => setShowRun(false)}
        />
      )}
      <NameDialog
        open={naming !== null}
        title={
          naming === 'rename'
            ? t('apiTests.loadUi.renameScenario')
            : naming === 'duplicate'
              ? t('apiTests.loadUi.duplicate')
              : t('apiTests.newScenario')
        }
        initial={
          naming === 'rename'
            ? selectedName
            : naming === 'duplicate'
              ? t('apiTests.ui.cloneName', { name: selectedName })
              : t('apiTests.newScenarioName')
        }
        confirmLabel={naming === 'rename' ? t('apiTests.ui.rename') : t('apiTests.ui.create')}
        onSubmit={(name) => {
          if (naming === 'new') createScenario(name);
          else if (naming === 'rename' && draft) setDraft({ ...draft, name });
          else if (naming === 'duplicate' && draft) {
            setSelectedId(null);
            setDraft({ ...draft, name });
            setSaved('null');
            setRuns([]);
            setRun(null);
          }
          setNaming(null);
        }}
        onClose={() => setNaming(null)}
      />
      <ConfirmationDialog
        open={confirmDelete}
        title={t('apiTests.loadUi.deleteScenario')}
        description={t('apiTests.deleteScenarioConfirm', { name: selectedName })}
        confirmLabel={t('apiTests.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
      <GenerateDialog
        open={showGenerate}
        kind="load"
        apiClient={apiClient}
        collectionId={draft?.collectionId || collections[0]?.id}
        onClose={() => setShowGenerate(false)}
        onGenerated={({ scenarioId }) => {
          setShowGenerate(false);
          void load().then(async (list) => {
            const scenario = list.find((item) => item.id === scenarioId);
            if (scenario) await select(scenario);
          });
        }}
      />
    </div>
  );
}
