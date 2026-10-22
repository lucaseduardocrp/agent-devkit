/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from './button.js';
import { Select } from './select.js';

export type PagingMode = 'pages' | 'scroll';
export const PAGE_SIZES = [25, 50, 100, 200] as const;

interface PagingPreferences {
  readonly mode: PagingMode;
  readonly pageSize: number;
}

function readPreferences(storageKey: string, fallback: PagingPreferences): PagingPreferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!saved || typeof saved !== 'object') return fallback;
    const { mode, pageSize } = saved as Partial<PagingPreferences>;
    return {
      mode: mode === 'scroll' || mode === 'pages' ? mode : fallback.mode,
      pageSize: PAGE_SIZES.some((size) => size === pageSize) ? pageSize! : fallback.pageSize,
    };
  } catch {
    return fallback;
  }
}

export interface Paging {
  readonly mode: PagingMode;
  readonly pageSize: number;
  /** Current page (pages mode), always within 1..pageCount. */
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  /** Shown items are `items.slice(start, end)`. */
  readonly start: number;
  readonly end: number;
  /** Scroll mode: more items wait below the loaded ones. */
  readonly hasMore: boolean;
  readonly setPage: (page: number) => void;
  readonly setPageSize: (pageSize: number) => void;
  readonly setMode: (mode: PagingMode) => void;
  /** Scroll mode: shows the next batch. */
  readonly loadMore: () => void;
}

/**
 * Paging of a client-side list, by pages or by continuous scroll. The mode and page size are
 * remembered per list (`storageKey`); a change of `resetKey` (e.g. the filters) returns to the
 * first page or batch.
 */
export function usePaging(
  total: number,
  options: {
    readonly storageKey: string;
    readonly resetKey?: string;
    readonly defaultPageSize?: number;
  },
): Paging {
  const { storageKey, resetKey = '', defaultPageSize = 25 } = options;
  const [preferences, setPreferences] = useState(() =>
    readPreferences(storageKey, { mode: 'pages', pageSize: defaultPageSize }),
  );
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState(preferences.pageSize);
  const [lastReset, setLastReset] = useState(resetKey);
  // Adjusted while rendering, so the first render after a filter change already shows page 1.
  if (lastReset !== resetKey) {
    setLastReset(resetKey);
    setPage(1);
    setLoaded(preferences.pageSize);
  }
  const save = (next: PagingPreferences) => {
    setPreferences(next);
    setPage(1);
    setLoaded(next.pageSize);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Storage unavailable: the choice lasts for this visit. */
    }
  };
  const { mode, pageSize } = preferences;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const start = mode === 'pages' ? (current - 1) * pageSize : 0;
  const end = Math.min(total, mode === 'pages' ? current * pageSize : loaded);
  return {
    mode,
    pageSize,
    page: current,
    pageCount,
    total,
    start,
    end,
    hasMore: mode === 'scroll' && end < total,
    setPage: (next) => setPage(Math.min(Math.max(1, next), pageCount)),
    setPageSize: (next) => save({ mode, pageSize: next }),
    setMode: (next) => save({ mode: next, pageSize }),
    loadMore: () => setLoaded((count) => Math.max(count, end) + pageSize),
  };
}

/** Page numbers around the current one, with the first and last; `null` marks a gap. */
export function pageWindow(current: number, count: number): (number | null)[] {
  const pages = new Set([1, count, current - 1, current, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= count).sort((a, b) => a - b);
  const result: (number | null)[] = [];
  for (const page of sorted) {
    const previous = result.at(-1);
    if (typeof previous === 'number' && page - previous === 2) result.push(previous + 1);
    else if (typeof previous === 'number' && page - previous > 2) result.push(null);
    result.push(page);
  }
  return result;
}

/** Range, page size, display mode and, in pages mode, the page navigation of a list. */
export function Pagination({
  paging,
  perPageLabel,
  className,
}: {
  readonly paging: Paging;
  /** e.g. "PBIs per page"; also the accessible name of the page size select. */
  readonly perPageLabel: string;
  readonly className?: string;
}) {
  const { t } = useI18n();
  const { mode, page, pageCount, total, start, end } = paging;
  const navButton = (label: string, icon: string, target: number, disabled: boolean) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => paging.setPage(target)}
    >
      <i className={cn('ti', icon)} aria-hidden="true" />
    </Button>
  );
  return (
    <div
      className={cn('flex flex-wrap items-center justify-between gap-3 text-sm', className)}
      data-testid="pagination"
    >
      <div className="flex flex-wrap items-center gap-3 text-[var(--text-muted)]">
        <span aria-live="polite">
          {t('pagination.showing')} {total === 0 ? 0 : start + 1}–{end} {t('pagination.of')} {total}
        </span>
        <label className="flex items-center gap-2">
          {perPageLabel}
          <Select
            aria-label={perPageLabel}
            value={paging.pageSize}
            onChange={(event) => paging.setPageSize(Number(event.target.value))}
            containerClassName="w-24"
            selectSize="sm"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </label>
        <div
          role="group"
          aria-label={t('pagination.mode')}
          className="inline-flex h-8 items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-0.5"
        >
          {(['pages', 'scroll'] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={mode === option ? 'secondary' : 'ghost'}
              aria-pressed={mode === option}
              title={t(option === 'pages' ? 'pagination.pages' : 'pagination.scroll')}
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => paging.setMode(option)}
            >
              <i
                className={cn('ti', option === 'pages' ? 'ti-files' : 'ti-arrows-down')}
                aria-hidden="true"
              />
              {t(option === 'pages' ? 'pagination.pages' : 'pagination.scroll')}
            </Button>
          ))}
        </div>
      </div>
      {mode === 'pages' && (
        <nav aria-label={t('pagination.navigation')} className="flex flex-wrap items-center gap-1">
          {navButton(t('pagination.firstPage'), 'ti-chevrons-left', 1, page <= 1)}
          {navButton(t('pagination.previousPage'), 'ti-chevron-left', page - 1, page <= 1)}
          {pageWindow(page, pageCount).map((number, index) =>
            number === null ? (
              <span
                key={`gap-${index}`}
                className="px-1 text-[var(--text-muted)]"
                aria-hidden="true"
              >
                …
              </span>
            ) : (
              <Button
                key={number}
                type="button"
                size="sm"
                variant={number === page ? 'secondary' : 'ghost'}
                aria-label={t('pagination.goToPage', { page: number })}
                aria-current={number === page ? 'page' : undefined}
                className="min-w-8 px-2 tabular-nums"
                onClick={() => paging.setPage(number)}
              >
                {number}
              </Button>
            ),
          )}
          {navButton(t('pagination.nextPage'), 'ti-chevron-right', page + 1, page >= pageCount)}
          {navButton(t('pagination.lastPage'), 'ti-chevrons-right', pageCount, page >= pageCount)}
          <span className="sr-only">
            {t('pagination.page')} {page} {t('pagination.of')} {pageCount}
          </span>
        </nav>
      )}
    </div>
  );
}

/**
 * Bottom of a list in scroll mode: loads the next batch as it comes near the viewport, with a
 * button for keyboards and browsers without IntersectionObserver.
 */
export function PagingSentinel({ paging }: { readonly paging: Paging }) {
  const { t } = useI18n();
  const marker = useRef<HTMLDivElement>(null);
  const { hasMore, end, loadMore } = paging;
  const load = useRef(loadMore);
  load.current = loadMore;
  // Observing again after each batch fires at once when the end is still in view, so a short
  // batch on a tall screen keeps loading until the viewport is filled.
  useEffect(() => {
    const element = marker.current;
    if (!element || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load.current();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, end]);
  if (paging.mode !== 'scroll' || paging.total === 0) return null;
  return (
    <div ref={marker} className="flex justify-center py-3 text-sm text-[var(--text-muted)]">
      {hasMore ? (
        <Button type="button" variant="ghost" size="sm" onClick={loadMore}>
          <i className="ti ti-arrow-down" aria-hidden="true" />
          {t('pagination.loadMore')}
        </Button>
      ) : (
        <span>{t('pagination.allLoaded')}</span>
      )}
    </div>
  );
}
