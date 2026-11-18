import { useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '../../lib/utils.js';

const KEY_STEP = 24;

export interface SplitHandleProps {
  /** Width of the pane at the right of the handle. */
  readonly width: number;
  readonly onChange: (width: number) => void;
  readonly min: number;
  /** The box that holds both panes; the right pane never takes more than its width minus `reserve`. */
  readonly container: RefObject<HTMLElement | null>;
  /** Width that stays for the pane at the left. */
  readonly reserve: number;
  readonly label: string;
}

/**
 * Vertical divider between two panes: drag it (or use the arrow keys) to change the width of the
 * pane at its right.
 */
export function SplitHandle({ width, onChange, min, container, reserve, label }: SplitHandleProps) {
  const [dragging, setDragging] = useState(false);
  const start = useRef({ pointerX: 0, width });

  const clamp = (value: number): number => {
    const available = container.current?.getBoundingClientRect().width || Infinity;
    return Math.round(Math.max(min, Math.min(value, available - reserve)));
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) =>
      // The pane is at the right: moving the pointer to the left makes it wider.
      onChange(clamp(start.current.width - (event.clientX - start.current.pointerX)));
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
    // `clamp` only reads refs and props that do not change while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, onChange]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuenow={width}
      tabIndex={0}
      data-testid="split-handle"
      className={cn(
        'relative hidden w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none lg:block',
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-[var(--border)] after:transition-colors after:content-['']",
        'hover:after:w-0.5 hover:after:bg-[var(--fill-accent)] focus-visible:after:w-0.5 focus-visible:after:bg-[var(--fill-accent)]',
        dragging && 'after:w-0.5 after:bg-[var(--fill-accent)]',
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        start.current = { pointerX: event.clientX, width };
        setDragging(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onChange(clamp(width + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP)));
      }}
    />
  );
}
