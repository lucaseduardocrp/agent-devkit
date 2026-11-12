import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

/** Width of the divider; it stays on screen at any size, so a hidden column can be dragged back. */
/** Width of the divider of a column inside a card; between loose panels it is the page gap. */
const CARD_HANDLE = 6;
const GAP_HANDLE = 16;
const STEP = 10;

interface Props {
  /** The resizable column. */
  readonly side: ReactNode;
  /** What fills the rest; it may shrink to nothing. */
  readonly children: ReactNode;
  readonly sidePosition?: 'left' | 'right';
  readonly defaultWidth: number;
  readonly label: string;
  /** Without the divider line: the gap between the columns is only a place to grab. */
  readonly plain?: boolean;
  /** Takes the column and its divider away; what fills the rest keeps its place (and its state). */
  readonly collapsed?: boolean;
  /** Pulled narrower than this, the column is given up: `onCollapse` is called instead. */
  readonly minWidth?: number;
  /** Asks the owner to collapse the column; the width goes back to the default for next time. */
  readonly onCollapse?: () => void;
  readonly className?: string;
  readonly sideClassName?: string;
}

/**
 * Two columns with a divider that can be dragged (or moved with the arrow keys) from nothing to
 * everything: the column can be hidden entirely, or take all the room and leave only itself. The
 * divider is never inside a column, so it is always there to pull the hidden one back. Whatever
 * does not fit is cut off, never spilled.
 */
export function SplitLayout({
  side,
  children,
  sidePosition = 'left',
  defaultWidth,
  label,
  plain = false,
  collapsed = false,
  minWidth = 0,
  onCollapse,
  className,
  sideClassName,
}: Props) {
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });
  const HANDLE = plain ? GAP_HANDLE : CARD_HANDLE;
  const sign = sidePosition === 'left' ? 1 : -1;

  const room = () =>
    Math.max(0, (row.current?.getBoundingClientRect().width || window.innerWidth) - HANDLE);
  const clamp = (value: number) => Math.min(room(), Math.max(0, value));

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) =>
      setWidth(clamp(start.current.width + sign * (event.clientX - start.current.x)));
    const stop = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    // The clamp only reads a ref and the divider's constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, sign]);

  // A column too narrow to read is not left as an empty strip: it is collapsed, and it comes back
  // at its default width.
  const tooNarrow = !collapsed && minWidth > 0 && width < minWidth;
  useEffect(() => {
    if (!tooNarrow) return;
    setDragging(false);
    setWidth(defaultWidth);
    onCollapse?.();
    // Only the width crossing the minimum matters; the owner's callback may change every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooNarrow]);

  const keys = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const toward = event.key === 'ArrowRight' ? 1 : -1;
    setWidth((current) => clamp(current + sign * toward * STEP));
  };

  const column = (
    <div
      className={cn('flex min-w-0 shrink-0 flex-col overflow-hidden', sideClassName)}
      style={{ width, maxWidth: `calc(100% - ${HANDLE}px)` }}
    >
      {side}
    </div>
  );
  const divider = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(room())}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      style={{ width: HANDLE }}
      className={cn(
        'group relative z-10 shrink-0 cursor-col-resize touch-none focus-visible:outline-none',
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors after:content-['']",
        plain ? 'after:bg-transparent' : 'after:bg-[var(--border)]',
        'hover:after:w-0.5 hover:after:bg-[var(--fill-accent)] focus-visible:after:w-0.5 focus-visible:after:bg-[var(--fill-accent)]',
        dragging && 'after:w-0.5 after:bg-[var(--fill-accent)]',
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        start.current = { x: event.clientX, width };
        setDragging(true);
      }}
      onKeyDown={keys}
    />
  );
  const rest = <div className="min-w-0 flex-1 overflow-hidden">{children}</div>;

  return (
    <div ref={row} className={cn('flex min-w-0', className)}>
      {sidePosition === 'left' ? (
        <>
          {!collapsed && column}
          {!collapsed && divider}
          {rest}
        </>
      ) : (
        <>
          {rest}
          {!collapsed && divider}
          {!collapsed && column}
        </>
      )}
    </div>
  );
}
