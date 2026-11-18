import { useEffect, useId, useRef } from 'react';
import { Button } from './button.js';
import { Modal } from './modal.js';

export interface UnsavedChangesDialogLabels {
  readonly title: string;
  readonly description: string;
  readonly cancel: string;
  readonly discard: string;
  readonly save: string;
}

export interface UnsavedChangesDialogProps {
  readonly open: boolean;
  readonly labels: UnsavedChangesDialogLabels;
  readonly isSaving?: boolean;
  /** Keep editing. */
  readonly onCancel: () => void;
  /** Close and drop the changes. */
  readonly onDiscard: () => void;
  /** Save the changes. */
  readonly onSave: () => void;
}

/**
 * Asked when a card with unsaved changes is closed: save them, discard them or keep editing.
 * Shared by every module whose cards are edited as a draft.
 */
export function UnsavedChangesDialog({
  open,
  labels,
  isSaving = false,
  onCancel,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <Modal
      open
      role="alertdialog"
      labelledBy={titleId}
      describedBy={descriptionId}
      closeOnBackdrop={!isSaving}
      onClose={onCancel}
    >
      <div className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {labels.title}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
          {labels.description}
        </p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" disabled={isSaving} onClick={onCancel}>
            {labels.cancel}
          </Button>
          <Button variant="secondary" disabled={isSaving} onClick={onDiscard}>
            {labels.discard}
          </Button>
          <Button isLoading={isSaving} onClick={onSave}>
            {labels.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
