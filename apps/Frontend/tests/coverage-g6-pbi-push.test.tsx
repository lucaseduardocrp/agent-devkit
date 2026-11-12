import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';

type DialogProps = {
  item: PbiItem | null;
  onClose: () => void;
  onSubmit: (...args: unknown[]) => void;
};

// The real dialog is covered on its own; this stand-in lets the view receive every shape of push.
vi.mock('../src/features/pbi/PbiPushDialog.js', () => ({
  PbiPushDialog: ({ item, onClose, onSubmit }: DialogProps) =>
    item ? (
      <div role="dialog" aria-label="push">
        <button onClick={onClose}>close-push</button>
        <button onClick={() => onSubmit(item, 'trello', { list: 'a' })}>plain</button>
        <button onClick={() => onSubmit(item, 'trello', {}, 'tpl-1')}>template</button>
        <button onClick={() => onSubmit(item, 'trello', {}, 'tpl-1', { f: 'v' })}>
          template-values
        </button>
      </div>
    ) : null,
}));

const { PbiView } = await import('../src/features/pbi/PbiView.js');

const root: PbiItem = {
  id: 'root',
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: 'Release PBI',
  description: 'Deliver release',
  status: 'New',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};

function setup() {
  let finish: (value: unknown) => void = () => undefined;
  const api = {
    getPbiItems: vi.fn().mockResolvedValue([root]),
    getPbiProviders: vi
      .fn()
      .mockResolvedValue([{ providerId: 'trello', settings: { boardId: 'board' } }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    getWorkspaceMembers: vi.fn().mockResolvedValue([]),
    getWorkItemTypes: vi.fn().mockResolvedValue([]),
    pushPbiItem: vi.fn().mockImplementation(() => new Promise((resolve) => (finish = resolve))),
  };
  render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
  return { api, finish: (value: unknown) => finish(value) };
}

const openPush = async () => {
  await screen.findByRole('button', { name: 'Release PBI' });
  fireEvent.click(screen.getByRole('button', { name: 'Ações: Release PBI' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
  return screen.findByRole('dialog', { name: 'push' });
};

describe('PbiView push requests', () => {
  it('sends the template and its values only when they were chosen', async () => {
    const { api, finish } = setup();
    await openPush();
    fireEvent.click(screen.getByText('plain'));
    await waitFor(() =>
      expect(api.pushPbiItem).toHaveBeenLastCalledWith('root', {
        providerId: 'trello',
        fields: { list: 'a' },
      }),
    );
    finish({ item: root, warnings: [] });

    await openPush();
    fireEvent.click(screen.getByText('template'));
    await waitFor(() =>
      expect(api.pushPbiItem).toHaveBeenLastCalledWith('root', {
        providerId: 'trello',
        fields: {},
        templateId: 'tpl-1',
      }),
    );
    finish({ item: root, warnings: [] });

    await openPush();
    fireEvent.click(screen.getByText('template-values'));
    await waitFor(() =>
      expect(api.pushPbiItem).toHaveBeenLastCalledWith('root', {
        providerId: 'trello',
        fields: {},
        templateId: 'tpl-1',
        fieldValues: { f: 'v' },
      }),
    );
    finish({ item: root, warnings: [] });
  });

  it('closes the dialog, and does not push twice while a push is running', async () => {
    const { api, finish } = setup();
    await openPush();
    fireEvent.click(screen.getByText('close-push'));
    expect(screen.queryByRole('dialog', { name: 'push' })).toBeNull();

    await openPush();
    fireEvent.click(screen.getByText('plain'));
    await waitFor(() => expect(api.pushPbiItem).toHaveBeenCalledTimes(1));
    await openPush();
    fireEvent.click(screen.getByText('plain'));
    expect(api.pushPbiItem).toHaveBeenCalledTimes(1);
    finish({ item: root, warnings: [] });
  });
});
