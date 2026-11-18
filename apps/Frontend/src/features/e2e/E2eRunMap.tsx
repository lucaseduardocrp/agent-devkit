import { useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { E2eImage } from './E2eImage.js';
import { E2eTestStatusIcon } from './E2eStatus.js';
import { MAP_CARD, layoutActionMap } from './e2e-run-layout.js';
import {
  e2eImagePath,
  type E2eActionMap,
  type E2eLiveActivity,
  type E2eMapElement,
  type E2eMapImage,
  type E2eMapPage,
  type E2eTestSummary,
  type E2eTouchAction,
} from './e2e-types.js';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5] as const;
const DEFAULT_ZOOM = 2;

/** "Click", "Type into"...: what a test is doing to an element right now. */
const DOING: Record<E2eTouchAction, TranslationKey> = {
  click: 'e2e.runActClick',
  type: 'e2e.runActType',
  press: 'e2e.runActPress',
  check: 'e2e.runActCheck',
  uncheck: 'e2e.runActUncheck',
  select: 'e2e.runActSelect',
  hover: 'e2e.runActHover',
};

/** "Clicked", "Typed into"...: what the tests did to an element. */
const DID: Record<E2eTouchAction, TranslationKey> = {
  click: 'e2e.runDidClick',
  type: 'e2e.runDidType',
  press: 'e2e.runDidPress',
  check: 'e2e.runDidCheck',
  uncheck: 'e2e.runDidUncheck',
  select: 'e2e.runDidSelect',
  hover: 'e2e.runDidHover',
};

type Translate = ReturnType<typeof useI18n>['t'];

export function liveLabel(t: Translate, live: E2eLiveActivity): string {
  return t('e2e.runLiveStep', {
    step: live.step,
    action: t(DOING[live.action]),
    kind: live.kind,
    name: live.name,
  });
}

export interface E2eRunMapProps {
  readonly apiClient: ApiClient;
  readonly map: E2eActionMap;
  /** What goes through the map: the tests of a run, or the flows of the Source. */
  readonly tests: readonly Pick<E2eTestSummary, 'id' | 'title'>[];
  /** Test whose path is traced on the map. */
  readonly tracedTestId: string | null;
  readonly selectedPageId: string | null;
  /** Reloads the page pictures: the trail of a test is replaced when it runs again. */
  readonly version: string | number;
  readonly onSelectPage: (pageId: string) => void;
  /** Shown while the map has no page; the hint of a run when not given. */
  readonly emptyLabel?: string;
  /** Where the picture of a page is served; the trail of the test that took it when not given. */
  readonly imagePath?: (image: E2eMapImage) => string;
  /** Line under a page; its tests and touches when not given. */
  readonly pageStats?: (page: E2eMapPage) => string;
}

/** The pages the tests of a run went through, from its start, joined by the way each test took. */
export function E2eRunMap({
  apiClient,
  map,
  tests,
  tracedTestId,
  selectedPageId,
  version,
  onSelectPage,
  emptyLabel,
  imagePath = (image) => e2eImagePath.trail(image, 'page'),
  pageStats,
}: E2eRunMapProps) {
  const { t } = useI18n();
  const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
  const layout = useMemo(() => layoutActionMap(map), [map]);
  const scale = ZOOMS[zoom]!;
  const traced = map.tests.find((test) => test.id === tracedTestId);
  const running = map.tests.find((test) => test.live);
  const runningTitle = tests.find((test) => test.id === running?.id)?.title;

  return (
    <div className="relative min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-0)] [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px]">
      {layout.nodes.length === 0 ? (
        <p className="flex h-full min-h-[420px] items-center justify-center px-6 text-center text-sm text-[var(--text-secondary)]">
          {emptyLabel ?? t('e2e.runMapEmpty')}
        </p>
      ) : (
        <div className="h-full overflow-auto p-6" data-testid="e2e-run-map">
          <div
            className="relative"
            style={{ width: layout.width * scale, height: layout.height * scale }}
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
            >
              <svg
                className="pointer-events-none absolute inset-0 overflow-visible"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                {layout.edges.map((edge) => {
                  const onTrace = tracedTestId !== null && edge.testIds.includes(tracedTestId);
                  return (
                    <path
                      key={edge.id}
                      d={edge.d}
                      fill="none"
                      data-traced={onTrace}
                      strokeWidth={onTrace ? 2.5 : 1.5}
                      className={cn(
                        edge.failed ? 'stroke-red-400' : 'stroke-emerald-400',
                        onTrace && 'stroke-[var(--fill-accent)]',
                        tracedTestId !== null && !onTrace && 'opacity-15',
                      )}
                    />
                  );
                })}
              </svg>
              <span
                className="absolute -translate-y-1/2 whitespace-nowrap text-xs text-[var(--text-accent)]"
                style={{ left: 0, top: layout.start.y }}
              >
                {t('e2e.runStart', { count: tests.length })}
              </span>
              {layout.nodes.map(({ page, x, y }) => (
                <Button
                  key={page.id}
                  variant="ghost"
                  aria-label={t('e2e.runOpenPage', { path: page.path })}
                  aria-pressed={selectedPageId === page.id}
                  data-traced={Boolean(traced?.path.includes(page.id))}
                  className={cn(
                    'absolute flex h-auto flex-col items-stretch gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-2 text-left font-normal',
                    selectedPageId === page.id && 'ring-2 ring-[var(--fill-accent)]',
                    traced && !traced.path.includes(page.id) && 'opacity-30',
                  )}
                  style={{ left: x, top: y, width: MAP_CARD.width, height: MAP_CARD.height }}
                  onClick={() => onSelectPage(page.id)}
                >
                  <span className="flex items-baseline gap-2 overflow-hidden text-xs">
                    <span className="shrink-0 font-mono font-semibold text-[var(--text-primary)]">
                      {page.path}
                    </span>
                    <span className="truncate text-[var(--text-muted)]">{page.title}</span>
                  </span>
                  {page.image ? (
                    <E2eImage
                      apiClient={apiClient}
                      path={imagePath(page.image)}
                      version={version}
                      alt={t('e2e.runPageAlt', { path: page.path })}
                      className="min-h-0 w-full flex-1 rounded border border-[var(--border)] object-cover object-top"
                    />
                  ) : (
                    <span className="min-h-0 flex-1 rounded border border-dashed border-[var(--border)]" />
                  )}
                  <span className="truncate text-xs text-[var(--text-muted)]">
                    {page.failedTestIds.length > 0 && (
                      <span className="text-red-400">
                        {t('e2e.runFailedHere', { count: page.failedTestIds.length })}{' '}
                      </span>
                    )}
                    {pageStats
                      ? pageStats(page)
                      : t('e2e.runPageStats', {
                          tests: page.testIds.length,
                          touches: page.touches,
                        })}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('e2e.runZoomOut')}
          disabled={zoom === 0}
          onClick={() => setZoom((value) => value - 1)}
        >
          <i className="ti ti-minus" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('e2e.runZoomIn')}
          disabled={zoom === ZOOMS.length - 1}
          onClick={() => setZoom((value) => value + 1)}
        >
          <i className="ti ti-plus" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('e2e.runZoomReset')}
          onClick={() => setZoom(DEFAULT_ZOOM)}
        >
          <i className="ti ti-maximize" aria-hidden="true" />
        </Button>
      </div>
      {running?.live && (
        <p
          className="absolute bottom-3 left-1/2 flex max-w-[60%] -translate-x-1/2 items-center gap-2 truncate rounded-md bg-black/80 px-3 py-1.5 text-xs text-white"
          role="status"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden="true" />
          <span className="truncate font-mono">{runningTitle}</span>
          <span className="truncate">{liveLabel(t, running.live)}</span>
        </p>
      )}
    </div>
  );
}

/** The elements the tests touched on a page of the map. */
export function E2eRunPagePanel({
  page,
  onBack,
  onSelectElement,
}: {
  readonly page: E2eMapPage;
  readonly onBack: () => void;
  readonly onSelectElement: (elementId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="e2e-run-page-panel">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <i className="ti ti-chevron-left" aria-hidden="true" />
        {t('e2e.runTests')}
      </Button>
      <div>
        <p className="text-xs text-[var(--text-muted)]">{page.title}</p>
        <h3 className="break-all font-semibold text-[var(--text-primary)]">
          {t('e2e.runPageElements', { path: page.path })}
        </h3>
      </div>
      {page.elements.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">{t('e2e.runNoElements')}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {page.elements.map((element) => (
            <li key={element.id}>
              <Button
                variant="ghost"
                className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal"
                aria-label={t('e2e.runOpenElement', { name: element.name || element.kind })}
                onClick={() => onSelectElement(element.id)}
              >
                <span className="shrink-0 text-xs capitalize text-[var(--text-muted)]">
                  {element.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                  {element.name}
                </span>
                <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
                  {t('e2e.runValueCount', { count: element.touches.length })}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One element of a page: where it is, what the tests did to it and which tests touched it. */
export function E2eRunElementPanel({
  apiClient,
  page,
  element,
  tests,
  version,
  onBack,
  onOpenTest,
}: {
  readonly apiClient: ApiClient;
  readonly page: E2eMapPage;
  readonly element: E2eMapElement;
  readonly tests: readonly E2eTestSummary[];
  readonly version: string | number;
  readonly onBack: () => void;
  readonly onOpenTest: (testId: string) => void;
}) {
  const { t } = useI18n();
  // Touches of tests that are no longer in the run have nothing to open.
  const touches = element.touches.flatMap((touch) => {
    const test = tests.find((item) => item.id === touch.testId);
    return test ? [{ touch, test }] : [];
  });
  const actions = [...new Set(touches.map(({ touch }) => touch.action))];
  const values = new Map<string, number>();
  for (const { touch } of touches)
    if (touch.value !== null) values.set(touch.value, (values.get(touch.value) ?? 0) + 1);
  const testCount = new Set(touches.map(({ test }) => test.id)).size;

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="e2e-run-element-panel">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <i className="ti ti-chevron-left" aria-hidden="true" />
        {t('e2e.runPageElements', { path: page.path })}
      </Button>
      <div>
        <p className="text-xs text-[var(--text-muted)]">
          {t('e2e.runElementOn', { path: page.path })}
        </p>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">
          <span className="capitalize">{element.kind}</span> {element.name}
        </h3>
        <p className="text-xs text-[var(--text-secondary)]">
          {t('e2e.runElementTouched', { count: testCount })}
          {actions.map((action) => (
            <span key={action} className="ml-2 text-[var(--text-muted)]">
              {t(DID[action])}
            </span>
          ))}
        </p>
      </div>
      {element.image && (
        <div className="relative overflow-hidden rounded border border-[var(--border)]">
          <E2eImage
            apiClient={apiClient}
            path={e2eImagePath.trail(element.image, 'element')}
            version={version}
            alt={t('e2e.runElementAlt', { name: element.name || element.kind })}
            className="block aspect-video w-full object-cover object-top"
          />
          {element.box && (
            <span
              data-testid="e2e-run-element-box"
              className="pointer-events-none absolute rounded-sm border-2 border-[var(--fill-accent)] bg-[var(--fill-accent)]/20"
              style={{
                left: `${element.box.x * 100}%`,
                top: `${element.box.y * 100}%`,
                width: `${element.box.width * 100}%`,
                height: `${element.box.height * 100}%`,
              }}
            />
          )}
        </div>
      )}
      {values.size > 0 && (
        <section>
          <h4 className="text-sm font-semibold text-[var(--text-primary)]">{t('e2e.runValues')}</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {[...values].map(([value, count]) => (
              <li key={value} className="flex justify-between gap-3 font-mono text-xs">
                <span className="break-all text-[var(--text-secondary)]">{value}</span>
                <span className="shrink-0 text-[var(--text-muted)]">
                  {t('e2e.runValueCount', { count })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4 className="flex justify-between text-sm font-semibold text-[var(--text-primary)]">
          {t('e2e.runTouches')}
          <span className="font-normal text-[var(--text-muted)]">{touches.length}</span>
        </h4>
        <ul className="mt-1 flex flex-col gap-1">
          {touches.map(({ touch, test }, index) => {
            return (
              <li key={index}>
                <Button
                  variant="ghost"
                  className="flex h-auto w-full items-center justify-start gap-2 px-2 py-1.5 text-left font-normal"
                  onClick={() => onOpenTest(test.id)}
                >
                  <E2eTestStatusIcon status={test.status} />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-primary)]">
                    {test.title}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
                    {t('e2e.runTouchStep', { step: touch.step })}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
