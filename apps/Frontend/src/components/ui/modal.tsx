import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ModalProps {
  readonly open: boolean;
  readonly children: React.ReactNode;
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly role?: 'dialog' | 'alertdialog';
  readonly className?: string;
  readonly closeOnBackdrop?: boolean;
  readonly onClose?: () => void;
}

/** Open modals, innermost last: Escape only closes the one on top. */
const openModals: object[] = [];

/** Everything that scrolls behind the backdrop: the body and the layout's scroll containers. */
function scrollableElements(): HTMLElement[] {
  return [document.body, ...document.querySelectorAll<HTMLElement>('*')].filter((element) => {
    if (element.closest('[data-modal-surface]')) return false;
    const overflow = getComputedStyle(element).overflowY;
    return (
      element.scrollHeight > element.clientHeight &&
      ['auto', 'scroll', 'overlay'].includes(overflow)
    );
  });
}

/** Viewport-level modal surface. Portaling avoids clipping by scroll containers. */
export function Modal({
  open,
  children,
  labelledBy,
  describedBy,
  role = 'dialog',
  className = '',
  closeOnBackdrop = true,
  onClose,
}: ModalProps) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const handle = useRef({});

  useEffect(() => {
    if (!open) return;
    const current = handle.current;
    openModals.push(current);
    return () => {
      openModals.splice(openModals.indexOf(current), 1);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // The page scrolls inside the layout's <main>, not in <body>, so locking the body alone
    // would leave the content behind the backdrop scrolling under the wheel.
    const locked = scrollableElements().map((element) => {
      const previous = element.style.overflow;
      element.style.overflow = 'hidden';
      return { element, previous };
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnBackdrop && openModals.at(-1) === handle.current)
        onCloseRef.current?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      for (const { element, previous } of locked) element.style.overflow = previous;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [closeOnBackdrop, open]);

  if (!open) return null;

  return createPortal(
    <div
      data-modal-surface
      // The section below caps itself at max-h-[calc(100vh-2rem)], so it never exceeds the
      // backdrop's available space; no outer scroll is needed, and items-center keeps shorter
      // modals vertically centered instead of pinned to the top.
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm ${className}`}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="m-auto max-h-[calc(100vh-2rem)] max-w-full"
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
