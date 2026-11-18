import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SearchableSelect, type SearchableSelectOption } from './searchable-select.js';

const REMOTE_PAGE_SIZE = 25;
/** Wait this long after the last key before asking the source: one request per pause, not per key. */
const SEARCH_DELAY_MS = 300;

export interface RemotePage<T> {
  readonly items: readonly T[];
  /** How many items match in the source, across every page. */
  readonly total: number;
}

/**
 * A searchable select whose options live behind a paginated, searchable API: it loads the first
 * page, searches in the source as the user types (debounced) and loads the next page as the
 * list is scrolled, so a source with thousands of items is never fetched whole.
 */
export function RemoteSelect<T>({
  label,
  value,
  onChange,
  fetchPage,
  toOption,
  placeholder,
  emptyMessage,
  errorMessage,
  pageSize = REMOTE_PAGE_SIZE,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** One page (1-based) of the items matching `q`; must honor the signal. */
  readonly fetchPage: (
    request: { q: string; page: number; pageSize: number },
    signal: AbortSignal,
  ) => Promise<RemotePage<T>>;
  readonly toOption: (item: T) => SearchableSelectOption;
  readonly placeholder: string;
  readonly emptyMessage: string;
  /** Shown instead of `emptyMessage` when the source could not be read. */
  readonly errorMessage: string;
  readonly pageSize?: number;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<readonly SearchableSelectOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The picked option outlives the page it came from: a new search must not blank the field.
  const [chosen, setChosen] = useState<SearchableSelectOption | null>(null);

  // The latest callbacks, without restarting the search each time the parent renders.
  const latest = useRef({ fetchPage, toOption });
  latest.current = { fetchPage, toOption };
  const inflight = useRef<AbortController | null>(null);
  const loadedPage = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const request = useCallback(
    async (q: string, page: number) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setLoading(true);
      try {
        const result = await latest.current.fetchPage({ q, page, pageSize }, controller.signal);
        if (controller.signal.aborted) return;
        const next = result.items.map(latest.current.toOption);
        // Offset pages can overlap when items change between requests.
        setOptions((current) => {
          const base = page === 1 ? [] : current;
          const seen = new Set(base.map((option) => option.value));
          return [...base, ...next.filter((option) => !seen.has(option.value))];
        });
        setTotal(result.total);
        loadedPage.current = page;
        setFailed(false);
      } catch {
        if (controller.signal.aborted) return;
        if (page === 1) setOptions([]);
        setFailed(true);
      }
      setLoading(false);
    },
    [pageSize],
  );

  // A new search starts again at the first page.
  useEffect(() => {
    void request(query, 1);
  }, [query, request]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      inflight.current?.abort();
    },
    [],
  );

  const onQueryChange = useCallback((typed: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(typed.trim()), SEARCH_DELAY_MS);
  }, []);

  const onLoadMore = useCallback(() => {
    void request(query, loadedPage.current + 1);
  }, [request, query]);

  const shown = useMemo(
    () =>
      chosen && chosen.value === value && !options.some((option) => option.value === value)
        ? [chosen, ...options]
        : options,
    [chosen, value, options],
  );

  return (
    <SearchableSelect
      label={label}
      options={shown}
      value={value}
      placeholder={placeholder}
      emptyMessage={failed ? errorMessage : emptyMessage}
      localFilter={false}
      pageSize={pageSize}
      hasMore={!failed && options.length < total}
      loadingMore={loading}
      onLoadMore={onLoadMore}
      onQueryChange={onQueryChange}
      onChange={(next) => {
        setChosen(options.find((option) => option.value === next) ?? null);
        onChange(next);
      }}
    />
  );
}
