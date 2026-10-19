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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnBackdrop && openModals.at(-1) === handle.current)
        onCloseRef.current?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [closeOnBackdrop, open]);

  if (!open) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[100] flex min-h-screen items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm ${className}`}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="max-h-[calc(100vh-2rem)] max-w-full"
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
