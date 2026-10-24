import React, { useState } from 'react';
import { Skeleton } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { readLayout } from './integration/integration-model.js';

// Loading skeletons of the Integration Tests and Overload Tests modules. Each one repeats the
// geometry of the screen it stands for (sidebar, header, tabs, panes, footer), so nothing moves
// when the data arrives.

const BORDER = 'border-[var(--border)]';

/** Icon button placeholder, the size of an `IconButton`. */
function SkeletonIconButton({ size = 40 }: { readonly size?: 28 | 40 }): React.JSX.Element {
  return <Skeleton className={cn('shrink-0 rounded-md', size === 28 ? 'h-7 w-7' : 'h-10 w-10')} />;
}

/** The sidebar title row: the real title, with placeholders where the action buttons are. */
function SidebarHeader({
  title,
  height,
  actions,
}: {
  readonly title: string;
  readonly height: 'h-11' | 'h-14';
  readonly actions: number;
}): React.JSX.Element {
  return (
    <div className={cn('flex shrink-0 items-center gap-1 border-b pl-3 pr-1.5', BORDER, height)}>
      <h2 className="flex-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
        {title}
      </h2>
      {Array.from({ length: actions }).map((_, index) => (
        <SkeletonIconButton key={index} size={28} />
      ))}
    </div>
  );
}

function SearchBox(): React.JSX.Element {
  return (
    <div className="shrink-0 p-2">
      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  );
}

/** The status bar: where the requests run, and the shortcut hint. */
function FooterSkeleton(): React.JSX.Element {
  return (
    <footer
      className={cn(
        'flex shrink-0 items-center gap-2 border-t bg-[var(--surface-1)] px-3 py-1.5',
        BORDER,
      )}
    >
      <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
      <Skeleton className="h-10 w-72 rounded-md" />
      <span className="flex-1" />
      <Skeleton className="hidden h-2.5 w-40 rounded-full sm:block" />
    </footer>
  );
}

/** A row of the collections tree: chevron, icon and name, `depth` levels in. */
export function TreeRowSkeleton({
  depth,
  kind,
  name,
}: {
  readonly depth: number;
  readonly kind: 'collection' | 'folder' | 'request';
  readonly name: string;
}): React.JSX.Element {
  return (
    <div
      className="flex h-8 items-center gap-1.5 pr-3"
      style={{ paddingLeft: 8 + depth * 14 }}
      data-testid="skeleton-tree-row"
    >
      {kind === 'request' ? (
        <Skeleton className="ml-4 h-2.5 w-7 shrink-0 rounded-sm" />
      ) : (
        <>
          <Skeleton className="h-3 w-3 shrink-0 rounded-sm" />
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
        </>
      )}
      <Skeleton className={cn('h-3 rounded-full', name)} />
    </div>
  );
}

function IntegrationSidebarSkeleton({ title }: { readonly title: string }): React.JSX.Element {
  return (
    <aside
      className={cn('flex w-[280px] shrink-0 flex-col border-r bg-[var(--surface-1)]', BORDER)}
    >
      <SidebarHeader title={title} height="h-11" actions={3} />
      <SearchBox />
      <div className="min-h-0 flex-1 overflow-hidden pb-3">
        <TreeRowSkeleton depth={0} kind="collection" name="w-32" />
        <TreeRowSkeleton depth={1} kind="folder" name="w-24" />
        <TreeRowSkeleton depth={2} kind="request" name="w-28" />
        <TreeRowSkeleton depth={2} kind="request" name="w-36" />
        <TreeRowSkeleton depth={2} kind="request" name="w-20" />
        <TreeRowSkeleton depth={1} kind="request" name="w-32" />
        <TreeRowSkeleton depth={1} kind="request" name="w-24" />
        <TreeRowSkeleton depth={0} kind="collection" name="w-28" />
      </div>
    </aside>
  );
}

/** The URL bar: method, address, code, save and send. */
function UrlBarSkeleton(): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 items-center">
        <Skeleton className="h-10 w-[124px] shrink-0 rounded-md rounded-r-none" />
        <Skeleton className="-ml-px h-10 min-w-0 flex-1 rounded-md rounded-l-none" />
      </div>
      <SkeletonIconButton />
      <SkeletonIconButton />
      <Skeleton className="h-10 w-24 shrink-0 rounded-md" />
    </div>
  );
}

/** Row of tab chips, like `PaneTabs`. */
function PaneTabsSkeleton({ widths }: { readonly widths: readonly string[] }): React.JSX.Element {
  return (
    <div className={cn('flex min-h-10 shrink-0 items-center gap-2 border-b px-2', BORDER)}>
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        {widths.map((width, index) => (
          <div key={index} className="flex h-7 items-center px-2">
            <Skeleton className={cn('h-3 rounded-full', width)} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A key/value row of the request tabs: checkbox, key, value. */
function KeyValueRowSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
      <Skeleton className="h-10 min-w-0 flex-1 rounded-md" />
      <Skeleton className="h-10 min-w-0 flex-[1.4] rounded-md" />
      <SkeletonIconButton size={28} />
    </div>
  );
}

function RequestPaneSkeleton(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneTabsSkeleton widths={['w-8', 'w-7', 'w-12', 'w-7', 'w-14', 'w-16', 'w-8']} />
      <div className="flex flex-col gap-2 p-3">
        <KeyValueRowSkeleton />
        <KeyValueRowSkeleton />
        <KeyValueRowSkeleton />
        <Skeleton className="mt-1 h-3 w-16 rounded-full" />
      </div>
    </div>
  );
}

/** The response side: status chips and a block of text lines. */
function ResponsePaneSkeleton(): React.JSX.Element {
  const lines = ['w-1/3', 'w-2/3', 'w-1/2', 'w-3/4', 'w-2/5', 'w-3/5', 'w-1/4'];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex min-h-10 shrink-0 items-center gap-3 border-b px-3', BORDER)}>
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="h-3 w-14 rounded-full" />
        <Skeleton className="h-3 w-14 rounded-full" />
        <span className="flex-1" />
        <SkeletonIconButton size={28} />
      </div>
      <div className="flex flex-col gap-2.5 p-4">
        {lines.map((width, index) => (
          <Skeleton key={index} className={cn('h-3 rounded-full', width)} />
        ))}
      </div>
    </div>
  );
}

/** Request and response, laid out the way the screen was left (side by side or stacked). */
function SplitSkeleton(): React.JSX.Element {
  const [layout] = useState(readLayout);
  const horizontal = layout === 'horizontal';
  return (
    <div className={cn('flex min-h-0 flex-1', !horizontal && 'flex-col')}>
      <div className="min-h-0 min-w-0 shrink-0 basis-1/2 overflow-hidden">
        <RequestPaneSkeleton />
      </div>
      <div className={cn('shrink-0 bg-[var(--border)]', horizontal ? 'w-px' : 'h-px')} />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <ResponsePaneSkeleton />
      </div>
    </div>
  );
}

/** Loading state of the Integration Tests screen: sidebar, collection header, tabs and editor. */
export function IntegrationTestsSkeleton(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('common.loading')}
      className="-m-5 flex h-[calc(100%+2.5rem)] min-h-[560px] overflow-hidden bg-[var(--surface-0)]"
      data-testid="integration-tests-skeleton"
    >
      <IntegrationSidebarSkeleton title={t('apiTests.collections')} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cn(
            'flex h-14 shrink-0 items-center gap-2 border-b bg-[var(--surface-1)] px-3',
            BORDER,
          )}
        >
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
          <Skeleton className="h-4 w-40 rounded-full" />
          <Skeleton className="h-6 w-6 shrink-0 rounded-md" />
          <span className="flex-1" />
          <Skeleton className="h-10 w-56 rounded-md" />
          <SkeletonIconButton />
          <SkeletonIconButton />
          <SkeletonIconButton />
        </header>
        <div
          className={cn('flex h-9 shrink-0 items-stretch border-b bg-[var(--surface-1)]', BORDER)}
        >
          <div className={cn('flex w-44 items-center gap-2 border-r px-3', BORDER)}>
            <Skeleton className="h-2.5 w-7 shrink-0 rounded-sm" />
            <Skeleton className="h-3 w-20 rounded-full" />
          </div>
          <Skeleton className="my-auto ml-1 h-7 w-7 rounded-md" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <UrlBarSkeleton />
          <SplitSkeleton />
        </div>
        <FooterSkeleton />
      </div>
    </div>
  );
}

/** A scenario of the sidebar list: profile icon, name and test type. */
function ScenarioRowSkeleton({
  name,
  type,
}: {
  readonly name: string;
  readonly type: string;
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-2.5 py-2 pl-3 pr-3" data-testid="skeleton-scenario-row">
      <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
      <span className="flex min-w-0 flex-col gap-1.5">
        <Skeleton className={cn('h-3.5 rounded-full', name)} />
        <Skeleton className={cn('h-2.5 rounded-full', type)} />
      </span>
    </li>
  );
}

/** A titled block of the plan, as `Section` draws it: title and hint, then its content. */
function PlanSectionSkeleton({
  title,
  hint,
  first,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly first?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className={cn('flex flex-col gap-4', !first && cn('border-t pt-6', BORDER))}>
      <header className="flex flex-col gap-1.5">
        <Skeleton className={cn('h-4 rounded-full', title)} />
        <Skeleton className={cn('h-3 rounded-full', hint)} />
      </header>
      {children}
    </section>
  );
}

/** Rows of the scenario's request list: checkbox, method, name, weight and share. */
export function RequestRowsSkeleton({ rows = 4 }: { readonly rows?: number }): React.JSX.Element {
  const names = ['w-40', 'w-56', 'w-32', 'w-48'];
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <li
          key={index}
          className="flex items-center gap-3 px-4 py-2"
          data-testid="skeleton-request-row"
        >
          <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
          <Skeleton className="h-2.5 w-8 shrink-0 rounded-sm" />
          <Skeleton className={cn('h-3 rounded-full', names[index % names.length])} />
          <span className="flex-1" />
          <Skeleton className="h-10 w-14 rounded-md" />
          <Skeleton className="h-3 w-8 rounded-full" />
        </li>
      ))}
    </>
  );
}

function PlanSkeleton(): React.JSX.Element {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PlanSectionSkeleton title="w-24" hint="w-2/3" first>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, index) => (
            <div
              key={index}
              className={cn(
                'flex h-[72px] flex-col items-start justify-between rounded-lg border p-3',
                BORDER,
              )}
            >
              <Skeleton className="h-4 w-4 rounded-sm" />
              <Skeleton className="h-3 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </PlanSectionSkeleton>
      <PlanSectionSkeleton title="w-32" hint="w-1/2">
        <Skeleton className="h-44 w-full rounded-lg" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_40px] items-center gap-2"
            >
              <Skeleton className="h-3 w-10 rounded-full" />
              <Skeleton className="h-10 rounded-md" />
              <Skeleton className="h-10 rounded-md" />
              <SkeletonIconButton />
            </div>
          ))}
        </div>
      </PlanSectionSkeleton>
      <PlanSectionSkeleton title="w-28" hint="w-3/5">
        <ul
          className={cn(
            'flex flex-col divide-y rounded-lg border',
            BORDER,
            'divide-[var(--border)]',
          )}
        >
          <RequestRowsSkeleton />
        </ul>
      </PlanSectionSkeleton>
    </div>
  );
}

/** Loading state of the Overload Tests screen: scenario list, scenario header, tabs and plan. */
export function LoadTestsSkeleton(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('common.loading')}
      className="-m-5 flex h-[calc(100%+2.5rem)] min-h-[560px] overflow-hidden bg-[var(--surface-0)]"
      data-testid="load-tests-skeleton"
    >
      <aside
        className={cn('flex w-[280px] shrink-0 flex-col border-r bg-[var(--surface-1)]', BORDER)}
      >
        <SidebarHeader title={t('apiTests.scenarios')} height="h-14" actions={2} />
        <SearchBox />
        <ul className="min-h-0 flex-1 overflow-hidden pb-3">
          <ScenarioRowSkeleton name="w-32" type="w-14" />
          <ScenarioRowSkeleton name="w-40" type="w-10" />
          <ScenarioRowSkeleton name="w-28" type="w-16" />
          <ScenarioRowSkeleton name="w-36" type="w-12" />
          <ScenarioRowSkeleton name="w-24" type="w-14" />
        </ul>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <header
            className={cn(
              'flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b bg-[var(--surface-1)] px-3 py-2',
              BORDER,
            )}
          >
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
            <Skeleton className="h-4 w-44 rounded-full" />
            <Skeleton className="h-6 w-6 shrink-0 rounded-md" />
            <span className="flex-1" />
            <Skeleton className="h-10 w-56 rounded-md" />
            <Skeleton className="h-10 w-48 rounded-md" />
            <SkeletonIconButton />
            <SkeletonIconButton />
            <Skeleton className="h-10 w-24 shrink-0 rounded-md" />
          </header>
          <PaneTabsSkeleton widths={['w-8', 'w-10']} />
          <div className="min-h-0 flex-1 overflow-hidden p-6">
            <PlanSkeleton />
          </div>
        </div>
        <FooterSkeleton />
      </div>
    </div>
  );
}
