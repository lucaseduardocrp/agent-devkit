import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
} from 'react';

/** Options drawn per step. Lists of thousands of items are never rendered whole. */
export const DEFAULT_PAGE_SIZE = 50;
/** How close to the end of the list (in px) the next step starts loading. */
const THRESHOLD = 64;

/** The props every select with a long list takes, so they all load the same way. */
export interface InfiniteListProps {
  /** Options drawn per step as the user scrolls. */
  readonly pageSize?: number;
  /** The source has more options than `options` holds (a paginated API). */
  readonly hasMore?: boolean;
  /** The next page is being fetched; shows the loading row and holds further requests. */
  readonly loadingMore?: boolean;
  /** Asks the parent for the next page; called once the options already held are all shown. */
  readonly onLoadMore?: () => void;
}

/**
 * Infinite scroll for a dropdown: shows the first `pageSize` items, adds a page each time the
 * list is scrolled near its end, and, once everything held is shown, asks `onLoadMore` for more.
 *
 * `resetKey` goes back to the first page (a new search); `active` is whether the list is open.
 */
export function useInfiniteList<T>(
  items: readonly T[],
  {
    list,
    resetKey,
    active,
    activeIndex,
    pageSize = DEFAULT_PAGE_SIZE,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
  }: InfiniteListProps & {
    list: RefObject<HTMLElement | null>;
    resetKey: unknown;
    active: boolean;
    /** The highlighted index; reaching the end with the keyboard loads the next page too. */
    activeIndex: number;
  },
): { visible: readonly T[]; onScroll: (event: UIEvent<HTMLElement>) => void } {
  const [count, setCount] = useState(pageSize);
  // One request per page held: scrolling or re-rendering must not repeat it.
  const requestedAt = useRef(-1);

  // A new search or a reopened list starts again at the top.
  useLayoutEffect(() => {
    setCount(pageSize);
    requestedAt.current = -1;
    if (list.current) list.current.scrollTop = 0;
  }, [resetKey, active, pageSize, list]);

  const visible = useMemo(() => items.slice(0, count), [items, count]);

  const loadMore = useCallback(() => {
    if (count < items.length) {
      setCount((current) => current + pageSize);
    } else if (hasMore && !loadingMore && onLoadMore && requestedAt.current !== items.length) {
      requestedAt.current = items.length;
      onLoadMore();
    }
  }, [count, items.length, pageSize, hasMore, loadingMore, onLoadMore]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      const element = event.currentTarget;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < THRESHOLD) loadMore();
    },
    [loadMore],
  );

  // Moving with the arrow keys toward the end brings the next page in before it is reached.
  useEffect(() => {
    if (active && activeIndex >= visible.length - 2) loadMore();
  }, [active, activeIndex, visible.length, loadMore]);

  // A list too short to scroll (a tall screen, few matches) would never reach the end: fill it.
  useEffect(() => {
    const element = list.current;
    if (!active || !element || element.clientHeight === 0) return;
    if (element.scrollHeight <= element.clientHeight + 1) loadMore();
  });

  return { visible, onScroll };
}
