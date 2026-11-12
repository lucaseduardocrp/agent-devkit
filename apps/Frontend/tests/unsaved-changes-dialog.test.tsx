import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UnsavedChangesDialog } from '../src/components/ui/unsaved-changes-dialog.js';

const labels = {
  title: 'Leave?',
  description: 'You have unsaved changes.',
  cancel: 'Cancel',
  discard: 'Discard',
  save: 'Save',
};

function setup(props: { open?: boolean; isSaving?: boolean } = {}) {
  const handlers = { onCancel: vi.fn(), onDiscard: vi.fn(), onSave: vi.fn() };
  render(
    <UnsavedChangesDialog open={props.open ?? true} labels={labels} {...props} {...handlers} />,
  );
  return handlers;
}

describe('UnsavedChangesDialog', () => {
  it('renders nothing while closed', () => {
    setup({ open: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers cancel, discard and save, focusing cancel first', () => {
    const { onCancel, onDiscard, onSave } = setup();
    expect(screen.getByRole('alertdialog', { name: 'Leave?' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('keeps editing on Escape and blocks the choices while saving', () => {
    const { onCancel } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('disables cancel and discard while saving', () => {
    setup({ isSaving: true });
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
