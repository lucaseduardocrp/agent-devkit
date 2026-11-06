import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';

const base: PbiItem = {
  id: 'root',
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: 'Release PBI',
  description: 'Deliver',
  status: 'New',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};
const item = (patch: Partial<PbiItem>): PbiItem => ({ ...base, ...patch });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function mockClient(items: PbiItem[] = [base], providerId = 'trello') {
  const getPbiItems = vi.fn<() => Promise<PbiItem[]>>().mockResolvedValue(items);
  return {
    getPbiItems,
    syncPbiChildren: vi.fn().mockImplementation(() => getPbiItems()),
    getPbiProviders: vi.fn().mockResolvedValue([{ providerId, settings: { boardId: 'b' } }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    getWorkspaceMembers: vi.fn().mockResolvedValue([]),
    getWorkItemTypes: vi.fn().mockResolvedValue([]),
    getPbiItem: vi.fn().mockResolvedValue(base),
    getPbiContext: vi.fn().mockResolvedValue({ item: base, descendants: [] }),
    getPbiComments: vi.fn().mockResolvedValue([]),
    getPbiRelations: vi.fn().mockResolvedValue([]),
    updatePbiItem: vi.fn().mockResolvedValue(base),
    pullPbiBoards: vi
      .fn()
      .mockResolvedValue({ results: [{ providerId, imported: 1 }], items }),
    getPbiPushContract: vi.fn().mockResolvedValue({ providerId, update: false, fields: [] }),
    getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
    getAuditHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
  };
}
type Api = ReturnType<typeof mockClient>;

const renderView = (api: Api, isReadOnly = false) =>
  render(
    <PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" isReadOnly={isReadOnly} />,
  );

const store = new Map<string, string>();
const dataTransfer = {
  setData: (type: string, value: string) => store.set(type, value),
  getData: (type: string) => store.get(type) ?? '',
};
const column = (name: string) => screen.getByRole('region', { name });
const cardOf = (title: string) => screen.getByText(title).closest('[draggable]') as HTMLElement;
const openRowMenu = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Ações: ${title}` }));

beforeEach(() => {
  localStorage.clear();
  store.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('PbiView view mode storage', () => {
  it('falls back to the list and still switches when storage is unavailable', async () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      if (key === 'adk:pbi-view:ws') throw new Error('blocked');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (key === 'adk:pbi-view:ws') throw new Error('blocked');
      setItem.call(this, key, value);
    });
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const kanban = screen.getByRole('button', { name: 'Kanban' });
    fireEvent.click(kanban);
    expect(kanban.getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers the chosen view mode', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    expect(localStorage.getItem('adk:pbi-view:ws')).toBe('kanban');
  });
});

describe('PbiView Kanban extras', () => {
  const items = [
    base,
    item({ id: 'z', title: 'Zeta card', status: 'Zeta', position: 1 }),
    item({ id: 'a', title: 'Alpha card', status: 'Alpha', position: 1 }),
    item({
      id: 'g',
      title: 'Ghost owner',
      status: 'Done',
      position: 2,
      sourceData: { adkAssigneeUserId: 'ghost-user' },
    }),
  ];

  it('sorts unknown states, shows unknown assignees and an empty column', async () => {
    localStorage.setItem('adk:pbi-view:ws', 'kanban');
    renderView(mockClient(items));
    await screen.findByText('Zeta card');
    const names = screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Zeta'));
    expect(within(column('Done')).getByText('ghost-user')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Filtros/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'Zeta' },
    });
    await waitFor(() => expect(within(column('Done')).queryByText('Ghost owner')).toBeNull());
    expect(within(column('Done')).getByText('Sem itens')).toBeTruthy();
  });

  it('keeps the current drop target when leaving another column', async () => {
    localStorage.setItem('adk:pbi-view:ws', 'kanban');
    renderView(mockClient(items));
    await screen.findByText('Zeta card');
    fireEvent.dragStart(cardOf('Release PBI'), { dataTransfer });
    fireEvent.dragOver(column('Done'), { dataTransfer });
    fireEvent.dragLeave(column('Alpha'));
    expect(screen.queryByTestId('kanban-drop-placeholder')).not.toBeNull();
  });

  it('does not accept drops or dragging in read-only mode', async () => {
    localStorage.setItem('adk:pbi-view:ws', 'kanban');
    const api = renderView(mockClient(items), true);
    await screen.findByText('Zeta card');
    expect(cardOf('Release PBI').getAttribute('draggable')).toBe('false');
    fireEvent.dragOver(column('Done'), { dataTransfer });
    expect(screen.queryByTestId('kanban-drop-placeholder')).toBeNull();
    store.set('text/plain', 'root');
    fireEvent.drop(column('Done'), { dataTransfer });
    expect(screen.queryByTestId('kanban-draft-bar')).toBeNull();
    api.unmount();
  });

  it('marks a card as saving while its move is being sent', async () => {
    localStorage.setItem('adk:pbi-view:ws', 'kanban');
    const api = mockClient(items);
    api.updatePbiItem.mockReturnValue(new Promise(() => undefined));
    renderView(api);
    await screen.findByText('Zeta card');
    fireEvent.dragStart(cardOf('Release PBI'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar agora' }));
    await waitFor(() => expect(api.updatePbiItem).toHaveBeenCalled());
    expect(await screen.findByTestId('kanban-card-saving')).toBeTruthy();
  });
});

describe('PbiView partial items', () => {
  const partial = item({ partial: true });

  it('opens the publish dialog with the full item once it loads', async () => {
    const api = mockClient([partial]);
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    await waitFor(() => expect(api.getPbiItem).toHaveBeenCalledWith('root'));
    await waitFor(() => expect(api.getPbiPushContract).toHaveBeenCalled());
  });

  it('does not open the publish dialog when the view is gone before the item loads', async () => {
    const api = mockClient([partial]);
    const pending = deferred<PbiItem>();
    api.getPbiItem.mockReturnValue(pending.promise);
    const view = renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    await waitFor(() => expect(api.getPbiItem).toHaveBeenCalled());
    view.unmount();
    await act(async () => {
      pending.resolve(base);
      await Promise.resolve();
    });
    expect(api.getPbiPushContract).not.toHaveBeenCalled();
  });

  it('keeps the newest form when an older item finishes loading or fails', async () => {
    const other = item({ id: 'other', title: 'Other PBI', partial: true, position: 2 });
    const api = mockClient([partial, other]);
    const first = deferred<PbiItem>();
    const second = deferred<PbiItem>();
    api.getPbiItem.mockImplementation((id: string) =>
      id === 'root' ? first.promise : second.promise,
    );
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Other PBI' }));
    await act(async () => {
      first.resolve(base);
      await Promise.resolve();
    });
    expect((screen.getByPlaceholderText('Título') as HTMLInputElement).value).toBe('Other PBI');
    await act(async () => {
      second.resolve(other);
      await Promise.resolve();
    });
    expect((screen.getByPlaceholderText('Título') as HTMLInputElement).value).toBe('Other PBI');
  });

  it('keeps the newest form when an older item fails to load', async () => {
    const other = item({ id: 'other', title: 'Other PBI', partial: true, position: 2 });
    const api = mockClient([partial, other]);
    const first = deferred<PbiItem>();
    api.getPbiItem.mockImplementation((id: string) =>
      id === 'root' ? first.promise : new Promise<PbiItem>(() => undefined),
    );
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Other PBI' }));
    await act(async () => {
      first.reject('plain failure');
      await Promise.resolve();
    });
    expect((screen.getByPlaceholderText('Título') as HTMLInputElement).value).toBe('Other PBI');
    expect(screen.getByText('Não foi possível concluir a ação.')).toBeTruthy();
  });

  it('ignores the result of an item load that ends after unmounting', async () => {
    const failing = deferred<PbiItem>();
    const api = mockClient([partial]);
    api.getPbiItem.mockReturnValue(failing.promise);
    const view = renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    view.unmount();
    await act(async () => {
      failing.reject(new Error('late'));
      await Promise.resolve();
      await Promise.resolve();
    });
  });
});

describe('PbiView provider names and deleting', () => {
  it('names unknown providers by their id when pulling', async () => {
    const api = mockClient([base], 'custom-board');
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Pull apenas de custom-board/ }));
    await waitFor(() => expect(api.pullPbiBoards).toHaveBeenCalledWith('custom-board'));
  });

  it('does nothing when deleting an item that is no longer in the list', async () => {
    const api = mockClient([base]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = await screen.findByRole('dialog');
    api.getPbiItems.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    const reload = screen
      .getAllByRole('menuitem')
      .find((entry) => /Atualizar|Recarregar/.test(entry.textContent ?? ''));
    fireEvent.click(reload!);
    await waitFor(() => expect(api.getPbiItems).toHaveBeenCalledTimes(2));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('PbiView without a workspace', () => {
  it('stores the view mode under the default key', async () => {
    render(<PbiView apiClient={mockClient() as unknown as ApiClient} workspaceId={null} />);
    await screen.findByText('Nenhum PBI ainda. Crie um ou faça Pull das integrações.');
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    expect(localStorage.getItem('adk:pbi-view:default')).toBe('kanban');
  });

});
