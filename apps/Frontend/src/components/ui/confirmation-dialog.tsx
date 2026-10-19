import { useEffect, useId, useRef } from 'react';
import { Button } from './button.js';
import { Modal } from './modal.js';

export interface ConfirmationDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly isLoading?: boolean;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  isLoading = false,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isLoading) onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isLoading, onCancel, open]);

  if (!open) return null;

  return (
    <Modal
      open
      role="alertdialog"
      labelledBy={titleId}
      describedBy={descriptionId}
      closeOnBackdrop={!isLoading}
      onClose={onCancel}
    >
      <div
        data-testid="confirmation-dialog-backdrop"
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          {description}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" disabled={isLoading} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            isLoading={isLoading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
