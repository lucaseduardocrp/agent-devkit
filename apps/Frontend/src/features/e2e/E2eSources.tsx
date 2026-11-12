import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { isDesktopApp } from '../../lib/desktop.js';
import { Hint } from '../development/development-ui.js';
import { EnvironmentDialog } from './E2eEnvironments.js';
import { Select } from '../../components/ui/select.js';
import { Skeleton, SkeletonButton, SkeletonInput } from '../../components/ui/skeleton.js';
import { E2eImage } from './E2eImage.js';
import { EXPLORATION_ACTION_LABELS } from './E2eExploration.js';
import { E2eRunMap } from './E2eRunMap.js';
import { E2eSourceOverview } from './E2eSourceOverview.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import {
  e2eImagePath,
  formatDuration,
  type E2eEnvironment,
  type E2eExecutionTarget,
  type E2eSourceFlow,
  type E2eSourceState,
} from './e2e-types.js';

type Tab = 'overview' | 'map' | 'script';

const TAB_LABELS: Record<Tab, TranslationKey> = {
  overview: 'e2e.sourcesTabOverview',
  map: 'e2e.runTabMap',
  script: 'e2e.sourcesTabScript',
};

const FLOW_ICONS: Record<E2eSourceFlow['action'], string> = {
  navigate: 'ti-link',
  sign_in: 'ti-login-2',
  click: 'ti-pointer',
};

/** The page while it loads: the same header, tabs, map and flow list it will show. */
function SourcesSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4"
      data-testid="e2e-sources-skeleton"
      aria-busy="true"
    >
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="flex flex-wrap items-center gap-2">
        <SkeletonInput className="w-64" data-testid="skeleton-sources-select" />
        <SkeletonInput className="w-52" />
        <SkeletonButton className="w-44 lg:ml-auto" />
      </div>
      <div className="flex gap-2 border-b border-[var(--border)] pb-2">
        <Skeleton className="h-6 w-24 rounded-md" />
        <Skeleton className="h-6 w-28 rounded-md" />
        <Skeleton className="h-6 w-20 rounded-md" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-6">
          <div className="flex items-center gap-6">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-[196px] w-[220px] rounded-lg" />
            <Skeleton className="h-[196px] w-[220px] rounded-lg" />
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3 lg:w-80">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-6" />
          </div>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-8 w-full rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}

const POLL_MS = 3000;

type Target = 'auto' | E2eExecutionTarget;

export interface E2eSourcesProps {
  readonly apiClient: ApiClient;
  readonly isReadOnly?: boolean;
  /** Follows the exploration of the Source live; receives the hidden run that carries it. */
  readonly onExplore: (anchorId: string) => void;
}

/**
 * The Source of the workspace: the documentation of the whole system (written from the Brain and
 * from what the agent discovers) and the map of the application it explored. There is a single
 * Source; updating it replaces the previous one.
 */
export function E2eSources({ apiClient, isReadOnly = false, onExplore }: E2eSourcesProps) {
  const { t, formatDate } = useI18n();
  // The desktop app always runs the exploration on this computer: nothing to choose.
  const desktop = isDesktopApp();
  const [data, setData] = useState<{
    readonly state: E2eSourceState;
    readonly environments: readonly E2eEnvironment[];
    readonly agents: readonly CustomAgentDto[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [target, setTarget] = useState<Target>('auto');
  const [starting, setStarting] = useState(false);
  const [documenting, setDocumenting] = useState(false);
  const [addingEnvironment, setAddingEnvironment] = useState(false);
  /** Null until a tab is picked: the documentation when there is one, else the map. */
  const [picked, setTab] = useState<Tab | null>(null);
  const [traced, setTraced] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [state, environments, agents] = await Promise.all([
        apiClient.getE2eSource(),
        apiClient.getE2eEnvironments(),
        apiClient.getAgents(),
      ]);
      setData({ state, environments, agents });
      // What the last update used is offered first, so updating the Source is one click.
      setEnvironmentId((current) =>
        environments.some((item) => item.id === current)
          ? current
          : ((
              environments.find((item) => item.id === state.source?.environmentId) ??
              environments[0]
            )?.id ?? ''),
      );
      setAgentId((current) =>
        agents.some((item) => item.id === current)
          ? current
          : ((agents.find((item) => item.id === state.agentId) ?? agents[0])?.id ?? ''),
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.loadFailed'));
    }
  }, [apiClient, t]);
  useEffect(() => void load(), [load]);

  const source = data?.state.source ?? null;
  const busy = data?.state.busy ?? false;
  // An exploration or a documentation is running: follow it until it ends.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const tab: Tab = picked ?? (source?.documentation ? 'overview' : 'map');
  const groups = useMemo(() => {
    const result = new Map<string, E2eSourceFlow[]>();
    for (const flow of source?.flows ?? [])
      result.set(flow.group, [...(result.get(flow.group) ?? []), flow]);
    return [...result];
  }, [source]);

  const explore = async () => {
    setStarting(true);
    setActionError(null);
    try {
      await apiClient.exploreE2eSource({
        environmentId,
        agentId,
        ...(target === 'auto' || desktop ? {} : { executionTarget: target }),
      });
      // The hidden run exists now: follow the exploration live.
      const { anchorId } = await apiClient.getE2eSource();
      if (anchorId) onExplore(anchorId);
      else await load();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : t('e2e.actionFailed'));
    } finally {
      setStarting(false);
    }
  };

  const documentSource = async () => {
    setDocumenting(true);
    setActionError(null);
    try {
      await apiClient.documentE2eSource();
      await load();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : t('e2e.actionFailed'));
    } finally {
      setDocumenting(false);
    }
  };

  if (!data)
    return (
      <div className="flex flex-col gap-4" data-testid="e2e-sources">
        {error ? (
          <div className="flex flex-col items-start gap-3" role="alert">
            <p className="text-sm text-red-400">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('e2e.retry')}
            </Button>
          </div>
        ) : (
          <SourcesSkeleton />
        )}
      </div>
    );

  const { state, environments, agents } = data;
  const closeEnvironment = () => setAddingEnvironment(false);
  const labelOf = (flow: E2eSourceFlow) =>
    `${t(EXPLORATION_ACTION_LABELS[flow.action])} ${flow.target}`;
  const paths = source?.map.tests ?? [];
  const pathOf = (flowId: string) => paths.find((test) => test.id === flowId)?.path ?? [];
  const page = (source?.pages ?? []).find((item) => String(item.index) === pageId);
  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="e2e-sources">
      {source && (
        <p className="text-sm text-[var(--text-secondary)]">
          {t('e2e.sourcesSummary', {
            host: source.startUrl.replace(/^https?:\/\//, ''),
            pages: source.pages.length,
            flows: source.flows.length,
            date: formatDate(source.finishedAt, { dateStyle: 'short', timeStyle: 'short' }),
          })}
        </p>
      )}

      {busy && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200"
          role="status"
        >
          <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
          <span className="flex-1">{t('e2e.sourcesBusy')}</span>
          {state.anchorId && (
            <Button variant="outline" size="sm" onClick={() => onExplore(state.anchorId as string)}>
              {t('e2e.sourcesFollow')}
            </Button>
          )}
        </div>
      )}

      {!isReadOnly && (
        <div className="flex flex-wrap items-center gap-2" data-testid="e2e-sources-controls">
          <Select
            aria-label={t('e2e.sourcesEnvironmentLabel')}
            title={t('e2e.sourcesEnvironmentLabel')}
            value={environmentId}
            containerClassName="w-64"
            onChange={(event) => setEnvironmentId(event.target.value)}
          >
            {environments.length === 0 && (
              <option value="">{t('e2e.sourcesEnvironmentLabel')}</option>
            )}
            {environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.baseUrl.replace(/^https?:\/\//, '')}
              </option>
            ))}
          </Select>
          <Select
            aria-label={t('e2e.sourcesAgentLabel')}
            title={t('e2e.sourcesAgentLabel')}
            value={agentId}
            containerClassName="w-52"
            onChange={(event) => setAgentId(event.target.value)}
          >
            {agents.length === 0 && <option value="">{t('e2e.sourcesAgentLabel')}</option>}
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          {!desktop && (
            <Select
              aria-label={t('e2e.sourcesTargetLabel')}
              title={t('e2e.sourcesTargetLabel')}
              value={target}
              containerClassName="w-56"
              onChange={(event) => setTarget(event.target.value as Target)}
            >
              <option value="auto">{t('e2e.sourcesTargetAuto')}</option>
              <option value="remote">{t('e2e.sourcesTargetRemote')}</option>
              <option value="local">{t('e2e.sourcesTargetLocal')}</option>
            </Select>
          )}
          <div className="flex flex-wrap gap-2 lg:ml-auto">
            <Button variant="outline" onClick={() => setAddingEnvironment(true)}>
              <i className="ti ti-plus" aria-hidden="true" />
              {t('e2e.envAdd')}
            </Button>
            {source && (
              <Button
                variant="outline"
                isLoading={documenting}
                disabled={busy}
                onClick={() => void documentSource()}
              >
                <i className="ti ti-file-text" aria-hidden="true" />
                {t('e2e.sourcesDocument')}
              </Button>
            )}
            <Button
              isLoading={starting}
              disabled={busy || !environmentId || !agentId}
              onClick={() => void explore()}
            >
              <i className="ti ti-compass" aria-hidden="true" />
              {t(source ? 'e2e.sourcesUpdate' : 'e2e.sourcesExplore')}
            </Button>
          </div>
        </div>
      )}
      {!isReadOnly && agents.length === 0 && <Hint>{t('e2e.sourcesNoAgents')}</Hint>}
      {addingEnvironment && (
        <EnvironmentDialog
          apiClient={apiClient}
          environment={null}
          onClose={closeEnvironment}
          onSaved={() => {
            setAddingEnvironment(false);
            void load();
          }}
          onDeleted={closeEnvironment}
        />
      )}

      {actionError && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {actionError}
        </p>
      )}

      {!source ? (
        <Hint>
          {t('e2e.sourcesEmpty')}. {t('e2e.sourcesEmptyHint')}
        </Hint>
      ) : (
        <>
          <div className="flex gap-1 border-b border-[var(--border)]" role="tablist">
            {(['overview', 'map', 'script'] as const).map((item) => (
              <Button
                key={item}
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={tab === item}
                className={cn(
                  'rounded-b-none border-b-2 border-transparent',
                  tab === item && 'border-[var(--fill-accent)] text-[var(--text-primary)]',
                )}
                onClick={() => setTab(item)}
              >
                {t(TAB_LABELS[item])}
              </Button>
            ))}
          </div>

          {tab === 'overview' ? (
            <E2eSourceOverview
              documentation={source.documentation}
              error={source.documentationError}
            />
          ) : tab === 'map' ? (
            <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
              <E2eRunMap
                apiClient={apiClient}
                map={source.map}
                tests={source.flows.map((flow) => ({ id: flow.id, title: labelOf(flow) }))}
                tracedTestId={traced}
                selectedPageId={pageId}
                version={source.finishedAt}
                emptyLabel={t('e2e.sourcesMapEmpty')}
                imagePath={(image) => e2eImagePath.sourcePage(image.index)}
                pageStats={(item) =>
                  t('e2e.sourcesPageStats', { flows: item.testIds.length, actions: item.touches })
                }
                onSelectPage={setPageId}
              />
              <aside className="flex max-h-[70vh] w-full shrink-0 flex-col overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] lg:max-h-none lg:w-80">
                {page ? (
                  <div className="flex flex-col gap-3 p-3" data-testid="e2e-source-page-panel">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-start"
                      onClick={() => setPageId(null)}
                    >
                      <i className="ti ti-chevron-left" aria-hidden="true" />
                      {t('e2e.sourcesFlows')}
                    </Button>
                    <div>
                      <h3 className="font-semibold text-[var(--text-primary)]">{page.title}</h3>
                      <p className="break-all font-mono text-xs text-[var(--text-muted)]">
                        {page.url}
                      </p>
                    </div>
                    {page.hasScreenshot && (
                      <E2eImage
                        apiClient={apiClient}
                        path={e2eImagePath.sourcePage(page.index)}
                        version={source.finishedAt}
                        alt={t('e2e.explorePageAlt', { title: page.title })}
                        className="aspect-video w-full rounded border border-[var(--border)] object-cover object-top"
                      />
                    )}
                    <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
                      {page.summary}
                    </p>
                    {page.elements.length > 0 && (
                      <section>
                        <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                          {t('e2e.sourcesPageControls')}
                        </h4>
                        <ul className="mt-1 flex flex-col divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
                          {page.elements.map((element) => (
                            <li
                              key={element}
                              className="px-2.5 py-1.5 text-xs text-[var(--text-secondary)]"
                            >
                              {element}
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] p-3">
                      <h2 className="font-semibold text-[var(--text-primary)]">
                        {t('e2e.sourcesFlows')}
                      </h2>
                      <span className="text-sm text-[var(--text-muted)]">
                        {source.flows.length}
                      </span>
                    </div>
                    <div className="flex-1 p-2">
                      {groups.map(([name, flows]) => (
                        <section key={name}>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start text-[var(--text-secondary)]"
                            aria-expanded={!collapsed.has(name)}
                            onClick={() => toggle(name)}
                          >
                            <i
                              className={cn(
                                'ti ti-chevron-down transition-transform',
                                collapsed.has(name) && '-rotate-90',
                              )}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
                            <span className="text-xs text-[var(--text-muted)]">{flows.length}</span>
                          </Button>
                          {!collapsed.has(name) && (
                            <ul>
                              {flows.map((flow) => (
                                <li key={flow.id}>
                                  <Button
                                    variant="ghost"
                                    className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal"
                                    aria-label={t('e2e.sourcesOpenFlow', { name: labelOf(flow) })}
                                    onMouseEnter={() => setTraced(flow.id)}
                                    onMouseLeave={() => setTraced(null)}
                                    onFocus={() => setTraced(flow.id)}
                                    onBlur={() => setTraced(null)}
                                    onClick={() => {
                                      setTraced(null);
                                      setPageId(pathOf(flow.id).at(-1) ?? null);
                                    }}
                                  >
                                    <i
                                      className={cn(
                                        'ti shrink-0 text-[var(--text-muted)]',
                                        FLOW_ICONS[flow.action],
                                      )}
                                      aria-hidden="true"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                                      {labelOf(flow)}
                                    </span>
                                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                                      {t('e2e.runPages', {
                                        count: new Set(pathOf(flow.id)).size,
                                      })}
                                    </span>
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </section>
                      ))}
                    </div>
                    <p className="border-t border-[var(--border)] p-3 text-xs text-[var(--text-muted)]">
                      {t('e2e.sourcesFlowsHint')}
                    </p>
                  </>
                )}
              </aside>
            </div>
          ) : (
            <section className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <p className="text-sm text-[var(--text-secondary)]">{t('e2e.sourcesScriptHint')}</p>
              {source.script.length ? (
                <ol className="mt-3 flex flex-col gap-3 border-l border-[var(--border)] pl-3">
                  {source.script.map((entry, index) => (
                    <li key={index} className="grid grid-cols-[3.5rem_1fr] gap-x-2 text-sm">
                      <span className="font-mono text-xs text-[var(--text-muted)]">
                        {t('e2e.exploreLogTime', { time: formatDuration(entry.atMs) })}
                      </span>
                      <span className="min-w-0 break-words text-[var(--text-primary)]">
                        <strong className="font-semibold">
                          {t(EXPLORATION_ACTION_LABELS[entry.action])}
                        </strong>{' '}
                        {entry.target}
                        {entry.result && (
                          <span className="block text-xs text-[var(--text-secondary)]">
                            {t('e2e.exploreLogResult', { result: entry.result })}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-3 text-sm text-[var(--text-muted)]">{t('e2e.exploreNoLog')}</p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
