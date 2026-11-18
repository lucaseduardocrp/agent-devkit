import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { useInfiniteList, type InfiniteListProps } from './use-infinite-list.js';
import { SelectLoadingRows } from './select-loading-rows.js';

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
  /** Secondary text shown under the label in the list (type, state...). */
  readonly description?: string;
}

/** A searchable list where several options can be picked; picked ones show as chips. */
export function MultiSelect({
  id,
  options,
  values,
  onChange,
  label,
  placeholder,
  emptyMessage,
  disabled = false,
  invalid = false,
  pageSize,
  hasMore,
  loadingMore = false,
  onLoadMore,
  loadingMessage,
  localFilter = true,
  onQueryChange,
  chosenOptions,
}: {
  /** Id of the search input, for an external `<label htmlFor>`. */
  readonly id?: string;
  readonly options: readonly MultiSelectOption[];
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly emptyMessage: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  /** Text of the row shown while the next page loads. */
  readonly loadingMessage?: string;
  /** False when the source does the searching: the options are shown as they come. */
  readonly localFilter?: boolean;
  /** Told what is typed, so a source can search for it. */
  readonly onQueryChange?: (query: string) => void;
  /** Where to find the name of a picked option that the current `options` no longer hold. */
  readonly chosenOptions?: readonly MultiSelectOption[];
} & InfiniteListProps) {
  const { t } = useI18n();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = new Set(values);
  const chosen = values.map(
    (value) =>
      options.find((option) => option.value === value) ??
      chosenOptions?.find((option) => option.value === value) ?? { value, label: value },
  );
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);
  const filtered = useMemo(() => {
    const search = localFilter ? query.trim().toLocaleLowerCase() : '';
    return search
      ? options.filter((option) =>
          `${option.value} ${option.label} ${option.description ?? ''}`
            .toLocaleLowerCase()
            .includes(search),
        )
      : options;
  }, [options, query, localFilter]);
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // The list floats over the page from the body, so no box that scrolls or clips (a modal) cuts it.
  const [place, setPlace] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open || disabled) return;
    const update = () => {
      const rect = box.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      // Opens upwards when the field is near the bottom of the window and there is more room above.
      const up = below < 180 && above > below;
      setPlace({
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(240, Math.max(120, up ? above : below)),
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      });
    };
    update();
    window.addEventListener('resize', update);
    // Capturing: any box the field is in may scroll.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, disabled, values.length]);
  // Only the first page is drawn; the next ones come in as the list is scrolled.
  const { visible, onScroll } = useInfiniteList(filtered, {
    list,
    resetKey: query,
    active: open,
    activeIndex,
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(hasMore === undefined ? {} : { hasMore }),
    loadingMore,
    ...(onLoadMore ? { onLoadMore } : {}),
  });
  const loadingRow = loadingMore ? (
    <SelectLoadingRows message={loadingMessage ?? t('common.loading')} />
  ) : null;
  const toggle = (value: string) => {
    // The search is done once an option is picked; the list stays open for the next one.
    setQuery('');
    onChange(selected.has(value) ? values.filter((item) => item !== value) : [...values, value]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Backspace' && !query && values.length) {
      onChange(values.slice(0, -1));
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) =>
        event.key === 'ArrowDown'
          ? Math.min(index + 1, Math.max(visible.length - 1, 0))
          : Math.max(index - 1, 0),
      );
    }
    if (event.key === 'Enter' && open && visible[activeIndex]) {
      event.preventDefault();
      toggle(visible[activeIndex].value);
    }
  };

  return (
    <div
      ref={box}
      className="relative"
      onBlur={(event) => {
        // The list is in the body, not under this box, but focus on it is still focus here.
        const next = event.relatedTarget as Node | null;
        if (!event.currentTarget.contains(next) && !list.current?.contains(next)) {
          setOpen(false);
          setQuery('');
        }
      }}
    >
      <div
        className={cn(
          'flex max-h-40 min-h-[40px] w-full flex-wrap items-center gap-1.5 overflow-y-auto rounded-md border bg-surface-2 py-1.5 pl-3.5 pr-10 text-sm shadow-sm transition-colors focus-within:ring-2',
          invalid
            ? 'border-red-500/50 focus-within:border-red-500 focus-within:ring-red-500/30'
            : 'border-border focus-within:border-border-accent focus-within:ring-[var(--bg-accent)]',
          disabled && 'cursor-not-allowed opacity-50',
        )}
        onMouseDown={(event) => {
          // Clicking the box (not a chip) focuses the search, like a regular input.
          if (event.target === event.currentTarget) {
            event.preventDefault();
            input.current?.focus();
          }
        }}
      >
        {chosen.map((option) => (
          <span
            key={option.value}
            className="inline-flex max-w-full items-center gap-1 rounded bg-surface-1 py-0.5 pl-2 pr-1 text-xs text-[var(--text-primary)]"
          >
            <span className="truncate" title={option.label}>
              {option.label}
            </span>
            <button
              type="button"
              aria-label={t('common.removeItem', { name: option.label })}
              disabled={disabled}
              className="inline-flex size-4 shrink-0 items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              onClick={() => toggle(option.value)}
            >
              <i className="ti ti-x text-xs" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && visible[activeIndex] ? `${listId}-${activeIndex}` : undefined
          }
          aria-invalid={invalid || undefined}
          value={query}
          placeholder={values.length ? '' : placeholder}
          disabled={disabled}
          autoComplete="off"
          className="min-w-24 flex-1 bg-transparent px-1.5 py-0.5 text-[var(--text-primary)] placeholder:text-muted focus:outline-none disabled:cursor-not-allowed"
          onFocus={() => {
            setActiveIndex(0);
            setOpen(true);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
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
      {open &&
        !disabled &&
        place &&
        createPortal(
          <ul
            style={{
              left: place.left,
              width: place.width,
              maxHeight: place.maxHeight,
              ...(place.top === undefined ? {} : { top: place.top }),
              ...(place.bottom === undefined ? {} : { bottom: place.bottom }),
            }}
            ref={list}
            onScroll={onScroll}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-multiselectable="true"
            className="fixed z-[200] overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] py-1 shadow-lg"
          >
            {visible.length ? (
              visible.map((option, index) => (
                <li key={option.value} role="presentation">
                  <button
                    type="button"
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={selected.has(option.value)}
                    tabIndex={-1}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--fill-ghost-hover)]',
                      index === activeIndex && 'bg-[var(--surface-2)]',
                    )}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggle(option.value)}
                  >
                    <i
                      className={cn(
                        'ti mt-0.5 text-base',
                        selected.has(option.value)
                          ? 'ti-square-check-filled text-[var(--text-primary)]'
                          : 'ti-square text-[var(--text-muted)]',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <span className="block truncate">{option.label}</span>
                      {option.description && (
                        <span className="block truncate text-xs text-[var(--text-muted)]">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))
            ) : loadingRow ? null : (
              <li className="px-3 py-2 text-sm text-[var(--text-muted)]">{emptyMessage}</li>
            )}
            {loadingRow}
          </ul>,
          document.body,
        )}
    </div>
  );
}
