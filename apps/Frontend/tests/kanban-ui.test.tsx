import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  KanbanCardPending,
  KanbanCardSaving,
  KanbanDraftBar,
  KanbanDropPlaceholder,
  kanbanCardStateClass,
  kanbanColumnClass,
} from '../src/components/ui/kanban.js';

const labels = {
  pending: 'pending moves',
  saving: 'Saving',
  offline: 'Offline now',
  error: 'Failed',
  saveNow: 'Save now',
  retry: 'Retry',
  discard: 'Discard',
};

function bar(props: Partial<Parameters<typeof KanbanDraftBar>[0]> = {}) {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  render(
    <KanbanDraftBar
      pending={2}
      saving={0}
      offline={false}
      error={null}
      labels={labels}
      onSave={onSave}
      onDiscard={onDiscard}
      {...props}
    />,
  );
  return { onSave, onDiscard };
}

describe('kanban pieces', () => {
  it('previews the landing slot, the saving skeleton and the pending mark', () => {
    render(
      <>
        <KanbanDropPlaceholder title="Ship docs" label="Move to Done" />
        <KanbanCardSaving label="Saving move" />
        <KanbanCardPending label="Pending change" />
      </>,
    );
    expect(screen.getByTestId('kanban-drop-placeholder')).toHaveTextContent('Move to Done');
    expect(screen.getByTestId('kanban-drop-placeholder')).toHaveTextContent('Ship docs');
    expect(screen.getByRole('status', { name: 'Saving move' })).toBeInTheDocument();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Pending change' })).toBeInTheDocument();
  });

  it('styles drop targets and cards by state', () => {
    expect(kanbanColumnClass(true)).toContain('ring-1');
    expect(kanbanColumnClass(false)).not.toContain('ring-1');
    expect(kanbanCardStateClass(true, false)).toContain('opacity-40');
    expect(kanbanCardStateClass(false, true)).toContain('pointer-events-none');
    expect(kanbanCardStateClass(false, false)).toBe('relative transition-opacity');
  });
});

describe('KanbanDraftBar', () => {
  it('stays out of the way when nothing is pending', () => {
    bar({ pending: 0, saving: 0 });
    expect(screen.queryByTestId('kanban-draft-bar')).not.toBeInTheDocument();
  });

  it('counts pending moves and offers to send or drop them', () => {
    const { onSave, onDiscard } = bar();
    expect(screen.getByTestId('kanban-draft-bar')).toHaveTextContent('2 pending moves');
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('shows progress and blocks sending twice', () => {
    bar({ pending: 0, saving: 3 });
    expect(screen.getByTestId('kanban-draft-bar')).toHaveTextContent('Saving (3)');
    expect((screen.getByRole('button', { name: 'Save now' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('explains that the draft is kept while offline', () => {
    bar({ offline: true });
    expect(screen.getByTestId('kanban-draft-bar')).toHaveTextContent('Offline now');
  });

  it('shows a failure with a retry', () => {
    const { onSave } = bar({ error: 'Server down', offline: true });
    expect(screen.getByTestId('kanban-draft-bar')).toHaveTextContent('Failed: Server down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
