import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../../components/ui/button.js';
import { cn } from '../../../lib/utils.js';

/**
 * A button that opens a floating panel under it. The panel closes on Escape, on a click outside it
 * and when `children` calls `close`; the focus goes back to the button.
 */
export function EditorPopover({
  icon,
  label,
  title,
  width = 360,
  disabled,
  testId,
  children,
}: {
  readonly icon: string;
  readonly label: string;
  /** Accessible name of the panel. */
  readonly title: string;
  readonly width?: number;
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly children: (close: () => void) => React.ReactNode;
}): React.JSX.Element {
  const panelId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const open = position !== null;

  const close = () => {
    setPosition(null);
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) {
        setPosition(null);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPosition(null);
      trigger.current?.focus();
    };
    const reposition = () => setPosition(null);
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid={testId}
        onClick={() => {
          if (open) return setPosition(null);
          const rect = trigger.current?.getBoundingClientRect();
          if (!rect) return;
          setPosition({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
            top: rect.bottom + 4,
          });
        }}
      >
        <i className={cn('ti', icon)} aria-hidden="true" />
        {label}
      </Button>
      {position &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-label={title}
            className="fixed z-[1000] flex max-h-[min(70vh,520px)] flex-col overflow-hidden rounded-md border border-border bg-surface-1 shadow-xl"
            style={{ left: position.left, top: position.top, width }}
            data-testid={testId ? `${testId}-panel` : undefined}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}
