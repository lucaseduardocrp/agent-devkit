import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { cn } from '../../lib/utils.js';

const MenuContext = createContext<() => void>(() => undefined);

const ITEM_CLASS = 'flex h-8 w-full items-center justify-between gap-3 px-3 text-left font-normal';

/**
 * A menu that opens under its trigger and closes on Escape, on a click outside it, or once an
 * item was chosen. The arrow keys move between its items.
 */
export function MenuPanel({
  label,
  onClose,
  align = 'left',
  className,
  children,
}: {
  readonly label: string;
  readonly onClose: () => void;
  /** Which edge of the trigger's wrapper the menu lines up with. */
  readonly align?: 'left' | 'right';
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  // The panel is drawn in a portal on the body, so no ancestor's overflow can clip it. It is placed
  // under the element the menu was rendered in (the trigger's wrapper).
  useLayoutEffect(() => {
    const rect = anchor.current!.parentElement!.getBoundingClientRect();
    setPosition(
      align === 'right'
        ? { top: rect.bottom + 4, right: window.innerWidth - rect.right }
        : { top: rect.bottom + 4, left: rect.left },
    );
  }, [align]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element;
      if (panel.current!.contains(target)) return;
      // The trigger that opened this menu toggles it on click; closing here would reopen it.
      const trigger = target.closest('[aria-haspopup="menu"][aria-expanded="true"]');
      if (trigger && anchor.current!.parentElement!.contains(trigger)) return;
      onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      return onClose();
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    // Only this menu's own rows, not the ones of an open submenu.
    const rows = [
      ...panel.current!.querySelectorAll<HTMLButtonElement>(':scope > [role^="menuitem"]'),
    ].filter((row) => !row.disabled);
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    rows[(current + step + rows.length) % rows.length]?.focus();
  };

  return (
    <>
      <span ref={anchor} hidden />
      {createPortal(
        <MenuContext.Provider value={onClose}>
          <div
            ref={panel}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            style={position}
            className={cn(
              'fixed z-50 min-w-56 rounded-md border border-[var(--border)] bg-[var(--surface-2)] py-1 shadow-xl',
              className,
            )}
            onKeyDown={move}
          >
            {children}
          </div>
        </MenuContext.Provider>,
        document.body,
      )}
    </>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 border-t border-[var(--border)]" />;
}

interface ItemProps {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  /** A check at the end: the item is an option that is on, or the one chosen of a group. */
  readonly checked?: boolean;
  readonly radio?: boolean;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  /** Leave the menu open after choosing, as the options that can be turned on and off do. */
  readonly keepOpen?: boolean;
}

export function MenuItem({
  children,
  onSelect,
  checked,
  radio = false,
  shortcut,
  disabled,
  keepOpen = false,
}: ItemProps) {
  const close = useContext(MenuContext);
  const role = checked === undefined ? 'menuitem' : radio ? 'menuitemradio' : 'menuitemcheckbox';
  return (
    <Button
      variant="ghost"
      size="sm"
      role={role}
      {...(checked === undefined ? {} : { 'aria-checked': checked })}
      disabled={disabled}
      className={ITEM_CLASS}
      onClick={() => {
        onSelect();
        if (!keepOpen) close();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="shrink-0 text-xs text-[var(--text-muted)]">{shortcut}</span>}
      {checked && (
        <i className="ti ti-check shrink-0 text-[var(--text-accent)]" aria-hidden="true" />
      )}
    </Button>
  );
}

/** An item that opens a menu of its own beside it; `value` is the choice it currently holds. */
export function SubMenu({
  label,
  value,
  disabled,
  children,
}: {
  readonly label: string;
  readonly value?: ReactNode;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onMouseLeave={() => setOpen(false)}>
      <Button
        variant="ghost"
        size="sm"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={ITEM_CLASS}
        onClick={() => setOpen(!open)}
        onMouseEnter={() => !disabled && setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') setOpen(true);
        }}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value !== undefined && (
          <span className="shrink-0 text-xs text-[var(--text-muted)]">{value}</span>
        )}
        <i className="ti ti-chevron-right shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute right-full top-0 z-40 mr-1 min-w-44 rounded-md border border-[var(--border)] bg-[var(--surface-2)] py-1 shadow-xl"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface PickerItem {
  readonly key: string;
  readonly label: string;
  /** A second, quieter text after the label: a hash, a date. */
  readonly detail?: string;
  /** A small tag after the label, such as "default". */
  readonly tag?: string;
}

/** A list with a search box, for the submenus that hold many choices (branches, commits). */
export function PickerList({
  placeholder,
  items,
  selected,
  empty,
  onPick,
}: {
  readonly placeholder: string;
  readonly items: readonly PickerItem[];
  readonly selected: string | null;
  readonly empty: string;
  readonly onPick: (key: string) => void;
}) {
  const close = useContext(MenuContext);
  const [query, setQuery] = useState('');
  const shown = items.filter((item) =>
    `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="w-72">
      <div className="border-b border-[var(--border)] p-2">
        <Input
          autoFocus
          className="h-8 text-xs"
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div role="group" aria-label={placeholder} className="max-h-64 overflow-y-auto py-1">
        {shown.length === 0 && (
          <p className="px-3 py-2 text-xs text-[var(--text-muted)]">{empty}</p>
        )}
        {shown.map((item) => (
          <Button
            key={item.key}
            variant="ghost"
            size="sm"
            role="menuitemradio"
            aria-checked={item.key === selected}
            title={item.label}
            className={ITEM_CLASS}
            onClick={() => {
              onPick(item.key);
              close();
            }}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.detail && (
              <span className="shrink-0 font-mono text-xs text-[var(--text-muted)]">
                {item.detail}
              </span>
            )}
            {item.tag && (
              <span className="shrink-0 text-xs text-[var(--text-muted)]">{item.tag}</span>
            )}
            {item.key === selected && (
              <i className="ti ti-check shrink-0 text-[var(--text-accent)]" aria-hidden="true" />
            )}
          </Button>
        ))}
      </div>
    </div>
  );
}
