import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ActionsMenu } from '../src/components/ui/actions-menu.js';
import { Button } from '../src/components/ui/button.js';
import { HistoryViewer } from '../src/features/audit/HistoryViewer.js';
import { ApiClient } from '../src/lib/api-client.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

describe('entity action menus', () => {
  it('hides actions, navigates by keyboard, skips disabled options and restores focus', () => {
    const edit = vi.fn();
    const view = render(
      <ActionsMenu>
        <Button onClick={edit}>Edit</Button>
        <Button disabled>Disabled</Button>
        <Button>Delete</Button>
      </ActionsMenu>,
    );
    const trigger = view.getByRole('button', { name: 'Ações' });
    expect(view.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = view.getByRole('menu');
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Delete' }));
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Delete' }));
    fireEvent.keyDown(menu, { key: 'Home' });
    fireEvent.click(view.getByRole('button', { name: 'Edit' }));
    expect(edit).toHaveBeenCalledOnce();
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' });
    expect(view.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(view.getByRole('menu'));
    fireEvent.click(view.getByRole('menu'));
    fireEvent.keyDown(view.getByRole('menu'), { key: 'x' });
    expect(view.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(view.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'x' });
    expect(view.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(view.getByRole('menu')).toBeInTheDocument();
  });
  it('opens individual history outside the closed menu and aborts it when the item changes', async () => {
    const client = new ApiClient();
    const load = vi
      .spyOn(client, 'getAuditHistory')
      .mockResolvedValue({ items: [], page: 1, total: 0, totalPages: 0 });
    const view = render(
      <ActionsMenu>
        <HistoryViewer
          apiClient={client}
          workspaceId="ws"
          entityType="specification"
          entityId="spec-1"
          entityTitle="Login"
        />
      </ActionsMenu>,
    );
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    expect(view.queryByRole('menu')).toBeNull();
    expect(view.getByRole('dialog', { name: 'Histórico · Login' })).toBeInTheDocument();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(view.getByRole('dialog'), escape);
    expect(escape.defaultPrevented).toBe(false);
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith('specification', 1, expect.any(AbortSignal), 'spec-1'),
    );
    view.rerender(
      <ActionsMenu>
        <HistoryViewer
          apiClient={client}
          workspaceId="ws"
          entityType="specification"
          entityId="spec-2"
          entityTitle="Payments"
        />
      </ActionsMenu>,
    );
    expect(view.queryByRole('dialog')).toBeNull();
    expect(load.mock.calls[0]![2]!.aborted).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith('specification', 1, expect.any(AbortSignal), 'spec-2'),
    );
  });
});
