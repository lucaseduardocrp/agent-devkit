import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { Input } from './input.js';

export interface SearchableSelectOption {
  readonly value: string;
  readonly label: string;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  label,
  placeholder,
  emptyMessage,
  disabled = false,
}: {
  readonly options: readonly SearchableSelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly emptyMessage: string;
  readonly disabled?: boolean;
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

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={open && filtered[activeIndex] ? `${id}-${activeIndex}` : undefined}
        value={open ? query : (selected?.label ?? '')}
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
      {open && !disabled && (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] py-1 shadow-lg"
        >
          {filtered.length ? (
            filtered.map((option, index) => (
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
