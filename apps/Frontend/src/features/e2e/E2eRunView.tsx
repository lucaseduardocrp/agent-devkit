import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { E2eImage } from './E2eImage.js';
import { E2eRunElementPanel, E2eRunMap, E2eRunPagePanel, liveLabel } from './E2eRunMap.js';
import { E2eTestStatusIcon, E2eTestStatusLabel } from './E2eStatus.js';
import {
  e2eImagePath,
  isCreationActive,
  type E2eActionMap,
  type E2eCreationDetail,
  type E2eTestSummary,
} from './e2e-types.js';

const POLL_MS = 3000;
/** Width of the side panel (tests, page elements) and the least the map keeps beside it. */
const PANEL_DEFAULT = 320;
const PANEL_MIN = 240;
const PANEL_MAX = 720;
const MAP_MIN = 320;

type Tab = 'map' | 'browsers';
type Filter = 'all' | 'passed' | 'failed';
type Selection = { readonly pageId: string; readonly elementId: string | null };

const isPassed = (test: E2eTestSummary) => test.status === 'passed';
const isFailed = (test: E2eTestSummary) => test.status === 'failed' || test.status === 'error';
const isWorking = (test: E2eTestSummary) =>
  test.status === 'running' || test.status === 'generating';

/** The shape of a run while it loads: header, tabs, progress, the map and the tests panel. */
function E2eRunViewSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="e2e-run-skeleton">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-[28rem] max-w-full rounded-md" />
          <Skeleton className="h-4 w-44 rounded-md" />
        </div>
        <Skeleton className="h-10 w-40 rounded-md" />
      </div>
      <div className="flex gap-1 border-b border-[var(--border)] pb-2">
        <Skeleton className="h-6 w-28 rounded-md" />
        <Skeleton className="h-6 w-20 rounded-md" />
      </div>
      <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] px-4 py-3">
        <Skeleton className="h-4 w-24 rounded-md" />
        <Skeleton className="h-1.5 flex-1 rounded-full" />
        <Skeleton className="h-4 w-8 rounded-md" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-0">
        <div className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-0)] [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px]">
          <Skeleton className="absolute left-6 top-[40%] h-4 w-16 rounded-md" />
          <Skeleton className="absolute left-32 top-12 h-44 w-56 rounded-lg" />
          <Skeleton className="absolute left-[26rem] top-[45%] h-44 w-56 rounded-lg" />
          <div className="absolute bottom-3 left-3 flex gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-1">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
        <div className="hidden w-4 shrink-0 lg:block" />
        <div className="flex w-full shrink-0 flex-col rounded-lg border border-[var(--border)] bg-[var(--surface-1)] lg:w-80">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] p-3">
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="h-8 w-36 rounded-md" />
          </div>
          <div className="flex flex-col gap-3 p-3">
            <Skeleton className="h-4 w-24 rounded-md" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-2">
                <Skeleton className="h-4 w-4 shrink-0" />
                <Skeleton className="h-4 flex-1 rounded-md" />
                <Skeleton className="h-3 w-12 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface E2eRunViewProps {
  readonly apiClient: ApiClient;
  readonly creationId: string;
  readonly onBack: () => void;
  readonly onOpenTest: (testId: string) => void;
  /** Opens what the agent saw when it explored the application. */
  readonly onOpenExploration: () => void;
}

/**
 * One run seen as a whole: how far it is, the pages its tests went through and what they
 * touched there, and the browser of each test while it runs.
 */
export function E2eRunView({
  apiClient,
  creationId,
  onBack,
  onOpenTest,
  onOpenExploration,
}: E2eRunViewProps) {
  const { t, formatDate } = useI18n();
  const [creation, setCreation] = useState<E2eCreationDetail | null>(null);
  const [map, setMap] = useState<E2eActionMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('map');
  const [filter, setFilter] = useState<Filter>('all');
  const [traced, setTraced] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Counts the refreshes, so live frames and page pictures are loaded again. */
  const [tick, setTick] = useState(0);
  const split = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT);
  const [resizing, setResizing] = useState(false);

  /** Keeps the side panel between its limits and leaves the map room to show something. */
  const clampPanel = (value: number) => {
    const room = split.current!.getBoundingClientRect().width - MAP_MIN;
    return Math.round(Math.max(PANEL_MIN, Math.min(PANEL_MAX, room, value)));
  };

  // The panel grows as the pointer moves left: its right edge is the edge of the container.
  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      setPanelWidth(clampPanel(split.current!.getBoundingClientRect().right - event.clientX));
    };
    const stop = () => setResizing(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    // The clamp only reads a ref and constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizing]);

  const startResize = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setResizing(true);
  };
  const resizeWithKeys = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setPanelWidth((current) => clampPanel(current + (event.key === 'ArrowLeft' ? 1 : -1) * 16));
  };

  const load = useCallback(async () => {
    try {
      const [run, actions] = await Promise.all([
        apiClient.getE2eCreation(creationId),
        apiClient.getE2eActionMap(creationId),
      ]);
      setCreation(run);
      setMap(actions);
      setTick((value) => value + 1);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('e2e.runLoadFailed'));
    }
  }, [apiClient, creationId, t]);
  useEffect(() => void load(), [load]);

  const active = Boolean(creation && isCreationActive(creation.status));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const groups = useMemo(() => {
    const result = new Map<string, E2eTestSummary[]>();
    for (const test of creation?.tests ?? []) {
      if (filter === 'passed' ? !isPassed(test) : filter === 'failed' && !isFailed(test)) continue;
      const name = test.category ?? '';
      result.set(name, [...(result.get(name) ?? []), test]);
    }
    return [...result];
  }, [creation, filter]);

  const back = (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <i className="ti ti-chevron-left" aria-hidden="true" />
        {t('e2e.back')}
      </Button>
    </div>
  );

  if (!creation || !map)
    return (
      <div className="flex flex-col gap-4" data-testid="e2e-run-view">
        {back}
        {error ? (
          <div className="flex flex-col items-start gap-3" role="alert">
            <p className="text-sm text-red-400">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('e2e.retry')}
            </Button>
          </div>
        ) : (
          <E2eRunViewSkeleton />
        )}
      </div>
    );

  const tests = creation.tests;
  const total = tests.length;
  const passed = tests.filter(isPassed).length;
  const failed = tests.filter(isFailed).length;
  const working = tests.filter(isWorking).length;
  const queued = tests.filter((test) => test.status === 'pending').length;
  const percent = (count: number) => `${total ? (count / total) * 100 : 0}%`;
  const page = map.pages.find((item) => item.id === selection?.pageId);
  const element = page?.elements.find((item) => item.id === selection?.elementId);
  const pagesOf = (testId: string) =>
    new Set(map.tests.find((test) => test.id === testId)?.path).size;
  const liveOf = (testId: string) => map.tests.find((test) => test.id === testId)?.live ?? null;
  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="e2e-run-view">
      {back}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
            {t('e2e.runTitle', {
              name: creation.name,
              date: formatDate(creation.createdAt, { dateStyle: 'short', timeStyle: 'short' }),
            })}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {t('e2e.runSummary', {
              count: total,
              host: creation.baseUrl.replace(/^https?:\/\//, ''),
            })}
          </p>
        </div>
        {creation.mode === 'frontend' && (
          <Button variant="outline" onClick={onOpenExploration}>
            <i className="ti ti-compass" aria-hidden="true" />
            {t('e2e.runViewExploration')}
          </Button>
        )}
      </div>

      <div className="flex gap-1 border-b border-[var(--border)]" role="tablist">
        {(['map', 'browsers'] as const).map((item) => (
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
            {t(item === 'map' ? 'e2e.runTabMap' : 'e2e.runTabBrowsers')}
          </Button>
        ))}
      </div>

      <div
        className="flex items-center gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 text-sm"
        role="status"
      >
        <span className="flex shrink-0 items-center gap-2 font-medium text-[var(--text-primary)]">
          <i
            className={cn('ti', active ? 'ti-loader-2 animate-spin' : 'ti-circle-check')}
            aria-hidden="true"
          />
          {t(active ? 'e2e.runRunning' : 'e2e.runFinished')}
          {active && (
            <span className="font-normal text-[var(--text-secondary)]">
              {t('e2e.runInProgress', { running: working, queued })}
            </span>
          )}
        </span>
        <span
          className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]"
          aria-hidden="true"
        >
          <span className="bg-emerald-500" style={{ width: percent(passed) }} />
          <span className="bg-red-500" style={{ width: percent(failed) }} />
        </span>
        <span className="shrink-0 font-mono text-[var(--text-secondary)]">
          {t('e2e.runProgress', { done: passed + failed, total })}
        </span>
      </div>
      {creation.error && (
        <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
          {creation.error}
        </p>
      )}

      {tab === 'map' ? (
        <div ref={split} className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-0">
          <E2eRunMap
            apiClient={apiClient}
            map={map}
            tests={tests}
            tracedTestId={traced}
            selectedPageId={selection?.pageId ?? null}
            version={tick}
            onSelectPage={(pageId) => setSelection({ pageId, elementId: null })}
          />
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('e2e.runResizePanel')}
            aria-valuenow={panelWidth}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            tabIndex={0}
            data-testid="e2e-run-panel-resizer"
            className="group hidden w-4 shrink-0 cursor-col-resize touch-none justify-center focus-visible:outline-none lg:flex"
            onPointerDown={startResize}
            onKeyDown={resizeWithKeys}
          >
            <span
              className={cn(
                'h-full w-px bg-transparent transition-all group-hover:w-0.5 group-hover:bg-[var(--fill-accent)] group-focus-visible:w-0.5 group-focus-visible:bg-[var(--fill-accent)]',
                resizing && 'w-0.5 bg-[var(--fill-accent)]',
              )}
            />
          </div>
          <aside
            style={{ '--run-panel-width': `${panelWidth}px` } as CSSProperties}
            className="flex max-h-[70vh] w-full shrink-0 flex-col overflow-y-auto lg:max-h-none lg:w-[var(--run-panel-width)] rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
          >
            {page && element ? (
              <E2eRunElementPanel
                apiClient={apiClient}
                page={page}
                element={element}
                tests={tests}
                version={tick}
                onBack={() => setSelection({ pageId: page.id, elementId: null })}
                onOpenTest={onOpenTest}
              />
            ) : page ? (
              <E2eRunPagePanel
                page={page}
                onBack={() => setSelection(null)}
                onSelectElement={(elementId) => setSelection({ pageId: page.id, elementId })}
              />
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] p-3">
                  <h2 className="font-semibold text-[var(--text-primary)]">{t('e2e.runTests')}</h2>
                  <Select
                    aria-label={t('e2e.runFilterLabel')}
                    value={filter}
                    selectSize="sm"
                    containerClassName="w-36"
                    onChange={(event) => setFilter(event.target.value as Filter)}
                  >
                    <option value="all">{t('e2e.runFilterAll', { count: total })}</option>
                    <option value="passed">{t('e2e.runFilterPassed', { count: passed })}</option>
                    <option value="failed">{t('e2e.runFilterFailed', { count: failed })}</option>
                  </Select>
                </div>
                <div className="flex-1 p-2">
                  {groups.map(([name, items]) => (
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
                        {name || t('e2e.runUncategorized')}
                      </Button>
                      {!collapsed.has(name) && (
                        <ul>
                          {items.map((test) => (
                            <li key={test.id}>
                              <Button
                                variant="ghost"
                                className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal"
                                aria-label={t('e2e.runOpenTest', { title: test.title })}
                                onMouseEnter={() => setTraced(test.id)}
                                onMouseLeave={() => setTraced(null)}
                                onFocus={() => setTraced(test.id)}
                                onBlur={() => setTraced(null)}
                                onClick={() => onOpenTest(test.id)}
                              >
                                <E2eTestStatusIcon status={test.status} />
                                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                                  {test.title}
                                </span>
                                <span className="shrink-0 text-xs text-[var(--text-muted)]">
                                  {t('e2e.runPages', { count: pagesOf(test.id) })}
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
                  {t('e2e.runMapHint')}
                </p>
              </>
            )}
          </aside>
        </div>
      ) : (
        <section className="min-h-0 flex-1 overflow-y-auto">
          <p className="mb-3 text-sm text-[var(--text-secondary)]">
            {t('e2e.runBrowsersCount', { count: total })}
          </p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            {tests.map((test) => {
              const live = liveOf(test.id);
              const cover = [...test.stepResults].reverse().find((step) => step.hasScreenshot);
              const waiting = (
                <span className="text-xs text-[var(--text-muted)]">
                  {t(isWorking(test) ? 'e2e.runBrowserOpening' : 'e2e.runBrowserWaiting')}
                </span>
              );
              return (
                <li key={test.id} className="min-w-0">
                  <Button
                    variant="ghost"
                    className="flex h-auto w-full flex-col items-stretch gap-2 p-0 text-left font-normal"
                    aria-label={t('e2e.runOpenTest', { title: test.title })}
                    onClick={() => onOpenTest(test.id)}
                  >
                    <span
                      className={cn(
                        'flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-[var(--surface-1)]',
                        isWorking(test) ? 'border-[var(--fill-accent)]' : 'border-[var(--border)]',
                      )}
                    >
                      {test.status === 'running' ? (
                        <E2eImage
                          apiClient={apiClient}
                          path={e2eImagePath.live(test.id)}
                          version={tick}
                          alt={t('e2e.runBrowserAlt', { title: test.title })}
                          className="h-full w-full object-cover object-top"
                          fallback={waiting}
                        />
                      ) : isWorking(test) || test.status === 'pending' ? (
                        waiting
                      ) : cover ? (
                        <E2eImage
                          apiClient={apiClient}
                          path={e2eImagePath.step(test.id, cover.position)}
                          alt={t('e2e.runBrowserAlt', { title: test.title })}
                          className="h-full w-full object-cover object-top"
                          fallback={<E2eTestStatusLabel status={test.status} />}
                        />
                      ) : (
                        <E2eTestStatusLabel status={test.status} />
                      )}
                    </span>
                    <span className="flex items-start gap-2 px-1">
                      <E2eTestStatusIcon status={test.status} />
                      <span className="min-w-0 text-sm text-[var(--text-primary)]">
                        <span className="line-clamp-2">{test.title}</span>
                        {live && (
                          <span className="block truncate text-xs text-[var(--text-muted)]">
                            {liveLabel(t, live)}
                          </span>
                        )}
                      </span>
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
