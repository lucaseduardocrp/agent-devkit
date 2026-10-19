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

export interface ResizableSidebarProps {
  readonly children: ReactNode;
  readonly defaultWidth?: number;
  readonly minWidth?: number;
  readonly maxWidth?: number | 'viewport' | 'container';
  readonly resizeEdge?: 'left' | 'right';
  readonly resizeLabel?: string;
  readonly className?: string;
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
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
}: ResizableSidebarProps) {
  const { t } = useI18n();
  const resolvedResizeLabel = resizeLabel ?? t('common.resizeSidebar');
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const dragStart = useRef({ pointerX: 0, width: defaultWidth });
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!isResizing) return;

    const handlePointerMove = (event: PointerEvent) => {
      const pointerDelta = event.clientX - dragStart.current.pointerX;
      const nextWidth =
        dragStart.current.width + (resizeEdge === 'right' ? pointerDelta : -pointerDelta);
      setWidth(
        Math.min(resolveMaxWidth(maxWidth, sidebarRef.current), Math.max(minWidth, nextWidth)),
      );
    };
    const stopResizing = () => setIsResizing(false);

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
  }, [isResizing, maxWidth, minWidth, resizeEdge]);

  const resizeWithKeyboard = (direction: -1 | 1) => {
    setWidth((currentWidth) =>
      Math.min(
        resolveMaxWidth(maxWidth, sidebarRef.current),
        Math.max(minWidth, currentWidth + direction * 10),
      ),
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className={cn('relative flex shrink-0 flex-col', className)}
      style={{ width, maxWidth: maxWidth === 'container' ? '100%' : undefined }}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
      <div
        role="separator"
        aria-label={resolvedResizeLabel}
        aria-orientation="vertical"
        aria-valuemin={minWidth}
        aria-valuemax={resolveMaxWidth(maxWidth, sidebarRef.current)}
        aria-valuenow={width}
        tabIndex={0}
        className={cn(
          'absolute inset-y-0 z-20 w-1 cursor-col-resize touch-none transition-colors hover:bg-[var(--fill-accent)] focus-visible:bg-[var(--fill-accent)] focus-visible:outline-none',
          resizeEdge === 'right' ? 'right-0' : 'left-0',
          isResizing && 'bg-[var(--fill-accent)]',
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragStart.current = { pointerX: event.clientX, width };
          setIsResizing(true);
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
