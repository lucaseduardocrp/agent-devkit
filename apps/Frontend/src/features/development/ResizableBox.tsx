import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';

type Axis = 'x' | 'y' | 'xy';

interface Props {
  readonly children: ReactNode;
  readonly 'aria-label': string;
  readonly className?: string;
  /** No sizing and no handles: the box is laid out by its class alone (a maximized panel). */
  readonly disabled?: boolean;
  /** `y`: only the bottom edge, for a panel that fills the width. */
  readonly axes?: 'both' | 'y';
  /** Fills the height the parent (a flex column) has left, until it is dragged to a size. */
  readonly fill?: boolean;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly defaultHeight?: number;
  readonly minHeight?: number;
  readonly minWidth?: number;
  readonly maxHeight?: number;
  readonly labels: { readonly width: string; readonly height: string; readonly both: string };
}

const STEP = 10;
const HANDLE =
  'absolute z-20 touch-none transition-colors hover:bg-[var(--fill-accent)] focus-visible:bg-[var(--fill-accent)] focus-visible:outline-none';

/**
 * A panel whose right edge, bottom edge and bottom-right corner can be dragged (or moved with the
 * arrow keys). It never grows past the width of what holds it, and whatever does not fit at a
 * small size is cut off instead of spilling out: the content decides what to keep.
 */
export function ResizableBox({
  children,
  className,
  disabled = false,
  axes = 'both',
  fill = false,
  onKeyDown,
  defaultHeight = 360,
  minHeight = 160,
  minWidth = 320,
  maxHeight = 1600,
  labels,
  'aria-label': ariaLabel,
}: Props) {
  const box = useRef<HTMLElement>(null);
  const [size, setSize] = useState<{ width: number | null; height: number | null }>({
    width: null,
    height: fill ? null : defaultHeight,
  });
  const filling = size.height === null;
  const [axis, setAxis] = useState<Axis | null>(null);
  const start = useRef({ x: 0, y: 0, width: 0, height: 0 });

  const maxWidth = () =>
    box.current?.parentElement?.getBoundingClientRect().width || window.innerWidth;
  const clampWidth = (value: number) => Math.min(maxWidth(), Math.max(minWidth, value));
  const clampHeight = (value: number) => Math.min(maxHeight, Math.max(minHeight, value));

  useEffect(() => {
    if (!axis) return;
    const move = (event: PointerEvent) => {
      setSize((current) => ({
        width:
          axis === 'y'
            ? current.width
            : clampWidth(start.current.width + event.clientX - start.current.x),
        height:
          axis === 'x'
            ? current.height
            : clampHeight(start.current.height + event.clientY - start.current.y),
      }));
    };
    const stop = () => setAxis(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.userSelect = 'none';
    document.body.style.cursor =
      axis === 'x' ? 'col-resize' : axis === 'y' ? 'row-resize' : 'nwse-resize';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    // The clamps only read refs and props that do not change while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis]);

  const press =
    (which: Axis) =>
    (event: { button: number; clientX: number; clientY: number; preventDefault(): void }) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = box.current!.getBoundingClientRect();
      start.current = {
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height,
      };
      setAxis(which);
    };

  const keys = (which: Axis) => (event: KeyboardEvent) => {
    const grow = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    if (!horizontal && !vertical) return;
    event.preventDefault();
    const rect = box.current!.getBoundingClientRect();
    setSize((current) => ({
      width: horizontal && which !== 'y' ? clampWidth(rect.width + grow * STEP) : current.width,
      height: vertical && which !== 'x' ? clampHeight(rect.height + grow * STEP) : current.height,
    }));
  };

  return (
    <div
      className={cn(
        'group/box relative',
        fill && (filling ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0'),
        // The handle hangs in the gap below the box. The last box has no gap after it: once it has a
        // size of its own it keeps room for the handle, so a scrolling parent can reach it.
        !disabled && !filling && 'last:mb-4',
      )}
      // Squeezed by a panel dragged taller, this one keeps its minimum and the parent scrolls.
      style={fill && filling && !disabled ? { minHeight } : undefined}
    >
      <section
        ref={box}
        aria-label={ariaLabel}
        className={cn('relative overflow-hidden', filling && fill && 'min-h-0 flex-1', className)}
        onKeyDown={onKeyDown}
        style={
          disabled
            ? undefined
            : {
                width: size.width ?? undefined,
                height: size.height ?? undefined,
                minHeight: filling ? minHeight : undefined,
                maxWidth: '100%',
              }
        }
      >
        {children}
        {!disabled && (
          <>
            {axes === 'both' && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={labels.width}
                tabIndex={0}
                className={cn(
                  HANDLE,
                  'inset-y-0 right-0 w-1 cursor-col-resize',
                  axis === 'x' && 'bg-[var(--fill-accent)]',
                )}
                onPointerDown={press('x')}
                onKeyDown={keys('x')}
              />
            )}
            {axes === 'both' && (
              <div
                role="separator"
                aria-label={labels.both}
                tabIndex={0}
                className={cn(
                  HANDLE,
                  'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
                  axis === 'xy' && 'bg-[var(--fill-accent)]',
                )}
                onPointerDown={press('xy')}
                onKeyDown={keys('xy')}
              />
            )}
          </>
        )}
      </section>
      {!disabled && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={labels.height}
          tabIndex={0}
          style={{ width: size.width ?? '100%', maxWidth: '100%' }}
          className={cn(
            'group absolute left-0 top-full z-20 flex h-4 cursor-row-resize touch-none items-center focus-visible:outline-none',
            // The last panel fills the parent: a handle hanging below it would add scroll to a page
            // that already fits, so it sits on the bottom edge instead.
            filling && 'group-last/box:bottom-0 group-last/box:top-auto group-last/box:h-2',
          )}
          onPointerDown={press('y')}
          onKeyDown={keys('y')}
        >
          <span
            className={cn(
              'h-px w-full bg-transparent transition-all group-hover:h-0.5 group-hover:bg-[var(--fill-accent)] group-focus-visible:h-0.5 group-focus-visible:bg-[var(--fill-accent)]',
              axis === 'y' && 'h-0.5 bg-[var(--fill-accent)]',
            )}
          />
        </div>
      )}
    </div>
  );
}
