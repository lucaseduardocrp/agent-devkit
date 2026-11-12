import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';
import { Input, inputVariants } from './input.js';
import { useInfiniteList, type InfiniteListProps } from './use-infinite-list.js';
import { useI18n } from '../../lib/i18n/index.js';

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  /** Extra classes for this option, in the list and in the field when selected (e.g. a color). */
  readonly className?: string;
}

const NO_MATCHES: readonly SearchableSelectOption[] = [];

interface OptionRowProps {
  readonly option: SearchableSelectOption;
  readonly rowId: string;
  readonly index: number;
  readonly selected: boolean;
  readonly active: boolean;
  readonly onChoose: (option: SearchableSelectOption) => void;
}

// Moving the highlight re-renders two rows, not fifty.
const OptionRow = memo(function OptionRow({
  option,
  rowId,
  index,
  selected,
  active,
  onChoose,
}: OptionRowProps) {
  return (
    <li role="presentation">
      <button
        type="button"
        id={`${rowId}-${index}`}
        role="option"
        aria-selected={selected}
        tabIndex={-1}
        className={cn(
          'w-full whitespace-normal break-words px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--fill-ghost-hover)]',
          active && 'bg-[var(--surface-2)]',
          option.className,
        )}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onChoose(option)}
      >
        {option.label}
      </button>
    </li>
  );
});

export function SearchableSelect({
  options,
  value,
  onChange,
  label,
  placeholder,
  emptyMessage,
  disabled = false,
  className,
  searchable = true,
  placement = 'bottom',
  customOptionLabel,
  pageSize,
  hasMore,
  loadingMore = false,
  onLoadMore,
  loadingMessage,
  onQueryChange,
  localFilter = true,
  'data-testid': testId,
}: {
  readonly options: readonly SearchableSelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly emptyMessage: string;
  readonly disabled?: boolean;
  /** Classes for the field, e.g. its width or font. */
  readonly className?: string;
  /** false: pick only, no typing; the field is a button with a down arrow. */
  readonly searchable?: boolean;
  /** Where the list opens; 'top' for fields at the bottom of the screen. */
  readonly placement?: 'bottom' | 'top';
  /**
   * Lets the user pick a value that is not in the list: what they type is offered as one more
   * option, labelled by this function. The field keeps its value while they type, and a value
   * outside the list is shown as typed.
   */
  readonly customOptionLabel?: (typed: string) => string;
  /** Text of the row shown while the next page loads. */
  readonly loadingMessage?: string;
  /**
   * Called with what the user types, for a source that searches on its own (an API). Debounce
   * in the parent if each call costs a request.
   */
  readonly onQueryChange?: (query: string) => void;
  /** false: `options` already match the search (the source filtered them); show them as they are. */
  readonly localFilter?: boolean;
  readonly 'data-testid'?: string;
} & InfiniteListProps) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const anchor = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  // The list is drawn on the page, not inside the field's container, so a scrolling or clipped
  // parent (a modal body, a card) can neither cut it off nor grow a horizontal scrollbar.
  const place = useCallback(() => {
    const field = anchor.current;
    /* v8 ignore next -- the anchor is always mounted while the list is open */
    if (!field) return;
    const box = field.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - 8;
    const above = box.top - 8;
    const up = placement === 'top' || (below < 160 && above > below);
    setPosition({
      position: 'fixed',
      left: box.left,
      width: box.width,
      maxHeight: Math.max(120, Math.min(240, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }),
    });
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onScroll = (event: Event) => {
      // Scrolling the list itself does not move the field.
      if (!list.current?.contains(event.target as Node)) place();
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, place]);

  const selected = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );

  // Searching never blocks typing: the field shows each key at once and the list catches up.
  const deferredQuery = useDeferredValue(query);
  // The lowercase text of every option is built once per open list, not once per keystroke.
  const entries = useMemo(
    () =>
      open && searchable
        ? options.map((option) => ({
            option,
            value: option.value.toLocaleLowerCase(),
            label: option.label.toLocaleLowerCase(),
          }))
        : [],
    [open, searchable, options],
  );
  const filtered = useMemo(() => {
    if (!open || !searchable) return NO_MATCHES;
    const typed = deferredQuery.trim();
    const needle = typed.toLocaleLowerCase();
    // A source that filters by itself already sent only what matches.
    const search = localFilter ? needle : '';
    const matches: SearchableSelectOption[] = [];
    let exact = false;
    for (const entry of entries) {
      if (entry.value === needle || entry.label === needle) exact = true;
      if (!search || entry.value.includes(search) || entry.label.includes(search))
        matches.push(entry.option);
    }
    return customOptionLabel && typed && !exact
      ? [...matches, { value: typed, label: customOptionLabel(typed) }]
      : matches;
  }, [open, searchable, entries, deferredQuery, customOptionLabel, localFilter]);
  const shown = useMemo(() => (searchable ? filtered : options), [searchable, filtered, options]);
  // Only the first page is drawn; the next ones come in as the list is scrolled.
  const { visible, onScroll } = useInfiniteList(shown, {
    list,
    resetKey: deferredQuery,
    active: open,
    activeIndex,
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(hasMore === undefined ? {} : { hasMore }),
    loadingMore,
    ...(onLoadMore ? { onLoadMore } : {}),
  });

  const lastQuery = useRef('');
  useEffect(() => {
    if (lastQuery.current === deferredQuery) return;
    lastQuery.current = deferredQuery;
    onQueryChange?.(deferredQuery);
  }, [deferredQuery, onQueryChange]);
  const loadingRow = loadingMore ? (
    <li
      role="status"
      className="flex items-center gap-2 px-3 py-2 text-xs text-[var(--text-muted)]"
    >
      <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
      {loadingMessage ?? t('common.loading')}
    </li>
  ) : null;

  // Always call the latest handler without giving the rows a new function each render.
  const latestOnChange = useRef(onChange);
  latestOnChange.current = onChange;
  const choose = useCallback((option: SearchableSelectOption) => {
    latestOnChange.current(option.value);
    setQuery('');
    setOpen(false);
  }, []);

  // Keyboard navigation keeps the highlighted option in view.
  useEffect(() => {
    if (open)
      document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, id]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) =>
        event.key === 'ArrowDown'
          ? Math.min(index + 1, Math.max((open ? visible.length : options.length) - 1, 0))
          : Math.max(index - 1, 0),
      );
    }
    if (event.key === 'Enter' && open && visible[activeIndex]) {
      event.preventDefault();
      choose(visible[activeIndex]);
    }
  };

  const openList = () => {
    setActiveIndex(
      Math.max(
        0,
        options.findIndex((option) => option.value === value),
      ),
    );
    setOpen(true);
  };
  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return openList();
      setActiveIndex((index) =>
        event.key === 'ArrowDown'
          ? Math.min(index + 1, visible.length - 1)
          : Math.max(index - 1, 0),
      );
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && visible[activeIndex]) choose(visible[activeIndex]);
      else openList();
    }
  };

  return (
    <div
      ref={anchor}
      className="relative"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        // The list is drawn outside this element, but focus moving into it is still inside.
        if (!event.currentTarget.contains(next) && !list.current?.contains(next)) setOpen(false);
      }}
    >
      {searchable ? (
        <div className="relative">
          <Input
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={
              open && visible[activeIndex] ? `${id}-${activeIndex}` : undefined
            }
            value={open ? query : (selected?.label ?? (customOptionLabel ? value : ''))}
            className={cn('pr-10', className, !open && selected?.className)}
            data-testid={testId}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            onFocus={() => {
              setQuery('');
              setActiveIndex(0);
              setOpen(true);
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              setOpen(true);
              if (value && !customOptionLabel) onChange('');
            }}
            onKeyDown={onKeyDown}
          />
          <i
            className={cn(
              'ti ti-chevron-down pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--text-secondary)] transition-transform',
              open && 'rotate-180',
              disabled && 'opacity-50',
            )}
            aria-hidden="true"
          />
        </div>
      ) : (
        <button
          type="button"
          role="combobox"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && options[activeIndex] ? `${id}-${activeIndex}` : undefined}
          className={cn(
            inputVariants(),
            'items-center justify-between gap-2 pr-3 text-left',
            className,
            selected?.className,
          )}
          disabled={disabled}
          data-testid={testId}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={onButtonKeyDown}
        >
          <span className={cn('truncate', !selected && 'text-[var(--text-muted)]')}>
            {selected?.label ?? placeholder}
          </span>
          <i
            className={cn(
              'ti ti-chevron-down shrink-0 text-[var(--text-secondary)] transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      )}
      {open &&
        !disabled &&
        position &&
        createPortal(
          <ul
            ref={list}
            onScroll={onScroll}
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            style={{ ...position, zIndex: 1000 }}
            className="overflow-y-auto overflow-x-hidden rounded-md border border-[var(--border)] bg-[var(--surface-1)] py-1 shadow-lg"
          >
            {visible.length ? (
              <>
                {visible.map((option, index) => (
                  <OptionRow
                    key={option.value}
                    option={option}
                    rowId={id}
                    index={index}
                    selected={option.value === value}
                    active={index === activeIndex}
                    onChoose={choose}
                  />
                ))}
                {loadingRow}
              </>
            ) : loadingRow ? (
              loadingRow
            ) : (
              <li className="px-3 py-2 text-sm text-[var(--text-muted)]">{emptyMessage}</li>
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
