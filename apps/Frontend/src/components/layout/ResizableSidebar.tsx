import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';

const resolveMaxWidth = (
  maxWidth: number | 'viewport' | 'container',
  element: HTMLElement | null,
): number => {
  if (typeof maxWidth === 'number') return maxWidth;
  if (maxWidth === 'viewport') return window.innerWidth;
  return element?.parentElement?.getBoundingClientRect().width || window.innerWidth;
};

/** Released this far below the minimum width, a collapsible sidebar folds to its compact width. */
const COLLAPSE_SLACK = 60;

export interface ResizableSidebarProps {
  /** Content, or a function of the width shown and whether the edge is being dragged. */
  readonly children: ReactNode | ((width: number, dragging: boolean) => ReactNode);
  readonly defaultWidth?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number | 'viewport' | 'container';
  readonly resizeEdge?: 'left' | 'right';
  readonly resizeLabel?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
  /**
   * Makes the sidebar collapsible: while `collapsed` it is `collapsedWidth` wide. The edge follows
   * the pointer below the minimum width; released well below it, `onCollapse` folds the sidebar,
   * and dragging a folded sidebar open calls `onExpand`.
   */
  readonly collapsed?: boolean;
  readonly collapsedWidth?: number;
  readonly onCollapse?: () => void;
  readonly onExpand?: () => void;
}

export function ResizableSidebar({
  children,
  defaultWidth = 240,
  minWidth = 180,
  maxWidth = 480,
  resizeEdge = 'right',
  resizeLabel,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
  collapsed = false,
  collapsedWidth = 64,
  onCollapse,
  onExpand,
}: ResizableSidebarProps) {
  const { t } = useI18n();
  const resolvedResizeLabel = resizeLabel ?? t('common.resizeSidebar');
  const collapsible = Boolean(onCollapse);
  const [width, setWidth] = useState(defaultWidth);
  // The width while dragging; null when the pointer is up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragStart = useRef({ pointerX: 0, width: defaultWidth });
  const latest = useRef<number | null>(null);
  const frame = useRef(0);
  const sidebarRef = useRef<HTMLElement>(null);
  const isResizing = dragWidth !== null;

  useEffect(() => {
    if (!isResizing) return;

    // Effects run after the commit attached the ref, and the <aside> is always rendered, so the
    // element is known here; holding it keeps a late pointer event safe after the ref detaches.
    const sidebar = sidebarRef.current!;
    const lower = collapsible ? collapsedWidth : minWidth;
    const handlePointerMove = (event: PointerEvent) => {
      const pointerDelta = event.clientX - dragStart.current.pointerX;
      const next =
        dragStart.current.width + (resizeEdge === 'right' ? pointerDelta : -pointerDelta);
      latest.current = Math.min(resolveMaxWidth(maxWidth, sidebar), Math.max(lower, next));
      // The edge follows the pointer at once, without a React render; the state (which the
      // content may depend on) catches up once per frame.
      sidebar.style.width = `${latest.current}px`;
      if (!frame.current)
        frame.current = window.requestAnimationFrame(() => {
          frame.current = 0;
          setDragWidth(latest.current);
        });
    };
    const stopResizing = () => {
      // A second end event before the listeners are removed (pointerup then pointercancel)
      // must not apply the drag again from its starting width.
      const released = latest.current;
      if (released === null) return;
      window.cancelAnimationFrame(frame.current);
      frame.current = 0;
      latest.current = null;
      setDragWidth(null);
      if (collapsible && released < minWidth - COLLAPSE_SLACK) {
        if (!collapsed) onCollapse?.();
        return;
      }
      setWidth(Math.max(minWidth, released));
      if (collapsed) onExpand?.();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing);
    window.addEventListener('pointercancel', stopResizing);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [
    collapsed,
    collapsedWidth,
    collapsible,
    isResizing,
    maxWidth,
    minWidth,
    onCollapse,
    onExpand,
    resizeEdge,
  ]);

  const resizeWithKeyboard = (direction: -1 | 1) => {
    const step = (currentWidth: number) =>
      Math.min(
        resolveMaxWidth(maxWidth, sidebarRef.current),
        Math.max(minWidth, currentWidth + direction * 10),
      );
    // During a drag the width on screen is the pointer's, not the stored one.
    if (isResizing && latest.current !== null) {
      latest.current = step(latest.current);
      dragStart.current = { ...dragStart.current, width: dragStart.current.width + direction * 10 };
      setDragWidth(latest.current);
      return;
    }
    setWidth(step);
  };

  // While dragging, `latest` always holds the pointer's width: it is set on pointer down and
  // cleared only together with the drag itself.
  const shownWidth = isResizing ? latest.current! : collapsed ? collapsedWidth : width;

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'relative flex shrink-0 flex-col',
        // Snaps (fold, unfold, back to the minimum) animate; dragging follows the pointer as is.
        !isResizing && 'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsible && 'overflow-hidden',
        className,
      )}
      style={{ width: shownWidth, maxWidth: maxWidth === 'container' ? '100%' : undefined }}
      aria-label={ariaLabel}
      data-testid={testId}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      {typeof children === 'function' ? children(shownWidth, isResizing) : children}
      <div
        role="separator"
        aria-label={resolvedResizeLabel}
        aria-orientation="vertical"
        aria-valuemin={collapsible ? collapsedWidth : minWidth}
        aria-valuemax={resolveMaxWidth(maxWidth, sidebarRef.current)}
        aria-valuenow={Math.round(shownWidth)}
        tabIndex={0}
        className={cn(
          'absolute inset-y-0 z-20 w-1 cursor-col-resize touch-none transition-colors hover:bg-[var(--fill-accent)] focus-visible:bg-[var(--fill-accent)] focus-visible:outline-none',
          resizeEdge === 'right' ? 'right-0' : 'left-0',
          isResizing && 'bg-[var(--fill-accent)]',
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const start = collapsed ? collapsedWidth : width;
          dragStart.current = { pointerX: event.clientX, width: start };
          latest.current = start;
          setDragWidth(start);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            resizeWithKeyboard(resizeEdge === 'right' ? -1 : 1);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            resizeWithKeyboard(resizeEdge === 'right' ? 1 : -1);
          }
        }}
      />
    </aside>
  );
}
