import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';

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
}) {
  const { t } = useI18n();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = new Set(values);
  const chosen = values.map(
    (value) => options.find((option) => option.value === value) ?? { value, label: value },
  );
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search
      ? options.filter((option) =>
          `${option.value} ${option.label} ${option.description ?? ''}`
            .toLocaleLowerCase()
            .includes(search),
        )
      : options;
  }, [options, query]);
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
          ? Math.min(index + 1, Math.max(filtered.length - 1, 0))
          : Math.max(index - 1, 0),
      );
    }
    if (event.key === 'Enter' && open && filtered[activeIndex]) {
      event.preventDefault();
      toggle(filtered[activeIndex].value);
    }
  };

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
          setQuery('');
        }
      }}
    >
      <div
        className={cn(
          'flex min-h-[40px] w-full flex-wrap items-center gap-1.5 rounded-md border bg-surface-2 px-2 py-1.5 text-sm shadow-sm transition-colors focus-within:ring-2',
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
            open && filtered[activeIndex] ? `${listId}-${activeIndex}` : undefined
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
      </div>
      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable="true"
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] py-1 shadow-lg"
        >
          {filtered.length ? (
            filtered.map((option, index) => (
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
          ) : (
            <li className="px-3 py-2 text-sm text-[var(--text-muted)]">{emptyMessage}</li>
          )}
        </ul>
      )}
    </div>
  );
}
