import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { Input, inputVariants } from './input.js';

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
  /** Extra classes for this option, in the list and in the field when selected (e.g. a color). */
  readonly className?: string;
}

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
  readonly 'data-testid'?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return search
      ? options.filter((option) =>
          `${option.value} ${option.label}`.toLocaleLowerCase().includes(search),
        )
      : options;
  }, [options, query]);
  const choose = (option: SearchableSelectOption) => {
    onChange(option.value);
    setQuery('');
    setOpen(false);
  };
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
          ? Math.min(index + 1, Math.max(filtered.length - 1, 0))
          : Math.max(index - 1, 0),
      );
    }
    if (event.key === 'Enter' && open && filtered[activeIndex]) {
      event.preventDefault();
      choose(filtered[activeIndex]);
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
          ? Math.min(index + 1, options.length - 1)
          : Math.max(index - 1, 0),
      );
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
      else openList();
    }
  };

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {searchable ? (
        <Input
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={open && filtered[activeIndex] ? `${id}-${activeIndex}` : undefined}
          value={open ? query : (selected?.label ?? '')}
          className={cn(className, !open && selected?.className)}
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
            if (value) onChange('');
          }}
          onKeyDown={onKeyDown}
        />
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
      {open && !disabled && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className={cn(
            'absolute z-20 max-h-60 w-full min-w-max overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] py-1 shadow-lg',
            placement === 'top' ? 'bottom-full mb-1' : 'mt-1',
          )}
        >
          {(searchable ? filtered : options).length ? (
            (searchable ? filtered : options).map((option, index) => (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={option.value === value}
                  tabIndex={-1}
                  className={cn(
                    'w-full px-3 py-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--fill-ghost-hover)]',
                    index === activeIndex && 'bg-[var(--surface-2)]',
                    option.className,
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  {option.label}
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
