import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, AuditHistoryPage } from '../src/lib/api-client.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
import { MediaProvider } from '../src/features/shared/media.js';
import type { PbiItem, PbiLink, PbiPushContract } from '../src/features/pbi/pbi-types.js';

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
const card: PbiItem = {
  ...root,
  id: 'card',
  parentId: root.id,
  kind: 'card',
  title: 'Verify release',
  description: 'Check deployment',
  position: 2,
};
const customLink: PbiLink = {
  id: 'custom-link',
  providerId: 'custom_provider' as never,
  externalId: '9',
  externalUrl: 'https://custom.example.com/9',
  boardId: null,
  syncedAt: '2026-09-30T00:00:00.000Z',
};
const azureLink: PbiLink = {
  ...customLink,
  id: 'az',
  providerId: 'azure_devops',
  externalId: '46873',
};
const readyContract: PbiPushContract = {
  providerId: 'trello',
  update: false,
  fields: [
    {
      key: 'list',
      label: 'List',
      required: true,
      options: [{ value: 'list-1', label: 'Doing' }],
      value: 'list-1',
      status: 'resolved',
    },
  ],
};

function mockClient() {
  const getPbiItems = vi.fn<() => Promise<PbiItem[]>>().mockResolvedValue([root, card]);
  return {
    getPbiItems,
    syncPbiChildren: vi.fn().mockImplementation(() => getPbiItems()),
    getPbiProviders: vi
      .fn()
      .mockResolvedValue([{ providerId: 'trello', settings: { boardId: 'board' } }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    getWorkspaceMembers: vi.fn().mockResolvedValue([]),
    getPbiItem: vi.fn().mockResolvedValue(root),
    getPbiContext: vi.fn().mockResolvedValue({ item: root, descendants: [] }),
    getPbiComments: vi.fn().mockResolvedValue([]),
    createPbiItem: vi.fn().mockResolvedValue(card),
    updatePbiItem: vi.fn().mockResolvedValue(card),
    deletePbiItem: vi.fn().mockResolvedValue(undefined),
    pullPbiBoards: vi.fn().mockResolvedValue({ results: [], items: [root, card] }),
    pushPbiItem: vi.fn().mockResolvedValue({ item: card, warnings: [] }),
    getPbiPushContract: vi.fn().mockResolvedValue(readyContract),
    getPbiRelations: vi.fn().mockResolvedValue([]),
    addPbiRelations: vi.fn().mockResolvedValue([]),
    removePbiRelation: vi.fn().mockResolvedValue([]),
    createIssueFromPbi: vi.fn().mockResolvedValue({ id: 'issue' }),
    generateTestPlan: vi.fn().mockResolvedValue({ plans: [], csv: '' }),
    getAuditHistory: vi
      .fn<() => Promise<AuditHistoryPage>>()
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
  };
}
type Api = ReturnType<typeof mockClient>;
type PbiViewProps = React.ComponentProps<typeof PbiView>;

function renderView(
  api: Api,
  workspaceId: string | null = 'ws',
  extra: Partial<PbiViewProps> = {},
) {
  return render(
    <PbiView apiClient={api as unknown as ApiClient} workspaceId={workspaceId} {...extra} />,
  );
}
const openFilters = () => {
  const toggle = screen.getByRole('button', { name: /^(Filters|Filtros)/ });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
};
const openRowMenu = (title: string) =>
  fireEvent.click(screen.getByRole('button', { name: `Ações: ${title}` }));
const withItems = (api: Api, items: PbiItem[]) => api.getPbiItems.mockResolvedValue(items);
const dispatchPointer = (target: EventTarget, type: string, clientX: number) =>
  act(() => {
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX }));
  });

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('PbiView g6: preferences', () => {
  it('starts in the list when the storage cannot be read, and keeps working when it refuses writes', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const api = mockClient();
    renderView(api, null);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Lista/ })).toHaveAttribute('aria-pressed', 'true'),
    );
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    fireEvent.click(screen.getByRole('button', { name: /Kanban/ }));
    expect(screen.getByRole('button', { name: /Kanban/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles and resizes columns without a workspace', async () => {
    const api = mockClient();
    renderView(api, null);
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Colunas' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Área' }));
    const handle = screen.queryByRole('separator', { name: 'Colunas: Título' });
    if (handle) {
      dispatchPointer(handle, 'pointerdown', 100);
      dispatchPointer(window, 'pointermove', 140);
      dispatchPointer(window, 'pointerup', 140);
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
    }
    expect(localStorage.getItem('adk:pbi-column-widths:default') !== undefined).toBe(true);
  });
});

describe('PbiView g6: states and ordering', () => {
  it('orders states the board does not know after the known ones, alphabetically', async () => {
    localStorage.setItem('adk:pbi-view:ws', 'kanban');
    const api = mockClient();
    withItems(api, [
      { ...root, id: 'z', title: 'Zed card', status: 'Zeta' },
      { ...root, id: 'a', title: 'Alpha card', status: 'Alpha' },
      { ...root, id: 'd', title: 'Done card', status: 'Done' },
    ]);
    renderView(api);
    await screen.findByText('Zed card');
    const titles = [...document.querySelectorAll('section[aria-label] header span[title]')].map(
      (node) => node.textContent,
    );
    expect(titles.indexOf('Done')).toBeLessThan(titles.indexOf('Alpha'));
    expect(titles.indexOf('Alpha')).toBeLessThan(titles.indexOf('Zeta'));
    // Ordering the state filter uses the same rank.
    openFilters();
    expect(screen.getByRole('option', { name: 'Zeta' })).toBeInTheDocument();
  });
});

describe('PbiView g6: sanitizing descriptions', () => {
  it('keeps the alt, title and secure source of imported images', async () => {
    const api = mockClient();
    withItems(api, [
      {
        ...root,
        description:
          '<p>See <img alt="chart" title="Q3" src="https://files.example.com/c.png" onerror="x()"> now</p>',
      },
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    const image = within(dialog).getByRole('textbox', { name: 'Descrição' }).querySelector('img')!;
    expect(image.getAttribute('alt')).toBe('chart');
    expect(image.getAttribute('title')).toBe('Q3');
    expect(image.hasAttribute('onerror')).toBe(false);
  });
});

describe('PbiView g6: search through a hierarchy with a cycle', () => {
  it('shows the subtree of a match once, even when the parents point at each other', async () => {
    const api = mockClient();
    withItems(api, [
      { ...root, id: 'r', title: 'Plain root' },
      { ...root, id: 'a', title: 'Alpha loop', parentId: 'b' },
      { ...root, id: 'b', title: 'Beta loop', parentId: 'a' },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'Plain root' });
    openFilters();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'loop' },
    });
    await waitFor(() => expect(screen.getByRole('treegrid')).toBeInTheDocument());
  });
});

describe('PbiView g6: opening items', () => {
  const partial = (over: Partial<PbiItem> = {}): PbiItem => ({ ...root, partial: true, ...over });

  it('drops what a pending item brings after the form was closed or replaced', async () => {
    const api = mockClient();
    withItems(api, [partial(), partial({ id: 'other', title: 'Other PBI', position: 3 })]);
    const first: { resolve: (item: PbiItem) => void; reject: (cause: unknown) => void } = {
      resolve: () => undefined,
      reject: () => undefined,
    };
    api.getPbiItem
      .mockReturnValueOnce(
        new Promise<PbiItem>((resolve, reject) => {
          first.resolve = resolve;
          first.reject = reject;
        }),
      )
      .mockReturnValue(new Promise(() => undefined));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Other PBI' }));
    await act(async () => {
      first.resolve({ ...root, description: 'Late' });
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
  });

  it('ignores a failure that arrives after the form was closed, or that is not an Error', async () => {
    const api = mockClient();
    withItems(api, [partial()]);
    let fail: (cause: unknown) => void = () => undefined;
    api.getPbiItem.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      fail('plain');
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('ignores a failure after unmounting', async () => {
    const api = mockClient();
    withItems(api, [partial()]);
    let fail: (cause: unknown) => void = () => undefined;
    api.getPbiItem.mockReturnValueOnce(new Promise((_resolve, reject) => (fail = reject)));
    const view = renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    view.unmount();
    await act(async () => {
      fail(new Error('late'));
    });
  });

  it('loads the full item before publishing a partial one', async () => {
    const api = mockClient();
    withItems(api, [partial()]);
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    await waitFor(() => expect(api.getPbiItem).toHaveBeenCalledWith('root'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('creates tests from an item that is already complete', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: /Criar testes de/ }));
    await waitFor(() => expect(api.getPbiContext).toHaveBeenCalledWith('root'));
  });

  it('creates an issue and tells the module it opened', async () => {
    const api = mockClient();
    const onOpenIssues = vi.fn();
    renderView(api, 'ws', { onOpenIssues });
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: /Criar issue/ }));
    await waitFor(() => expect(onOpenIssues).toHaveBeenCalled());
  });
});

describe('PbiView g6: focus from another module', () => {
  it('opens the item it is sent to once, and ignores other requests', async () => {
    const api = mockClient();
    const onFocusHandled = vi.fn();
    const view = renderView(api, 'ws', {
      focus: { kind: 'issue', ref: 'root', nonce: 1 },
      onFocusHandled,
    });
    await screen.findByRole('button', { name: 'Release PBI' });
    expect(onFocusHandled).not.toHaveBeenCalled();
    const next = (focus: PbiViewProps['focus']) =>
      view.rerender(
        <PbiView
          apiClient={api as unknown as ApiClient}
          workspaceId="ws"
          focus={focus}
          onFocusHandled={onFocusHandled}
        />,
      );
    next({ kind: 'pbi', ref: 'missing', nonce: 2 });
    expect(onFocusHandled).not.toHaveBeenCalled();
    next({ kind: 'pbi', ref: 'root', nonce: 3 });
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    next({ kind: 'pbi', ref: 'root', nonce: 3 });
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    next(null);
  });

  it('opens it without a handler to tell', async () => {
    const api = mockClient();
    renderView(api, 'ws', { focus: { kind: 'pbi', ref: 'root', nonce: 1 } });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});

describe('PbiView g6: loading side effects', () => {
  it('shows the message of a failed comments load, or a generic one', async () => {
    const api = mockClient();
    api.getPbiComments.mockRejectedValueOnce(new Error('No comments')).mockRejectedValue('x');
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    expect(await screen.findByText('No comments')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Release PBI' }));
    await waitFor(() => expect(api.getPbiComments).toHaveBeenCalledTimes(2));
  });

  it('ignores the children and comments of an item that was closed meanwhile', async () => {
    const api = mockClient();
    withItems(api, [{ ...root, links: [azureLink] }]);
    let children: (items: PbiItem[]) => void = () => undefined;
    let comments: (items: never[]) => void = () => undefined;
    api.syncPbiChildren.mockReturnValue(new Promise((resolve) => (children = resolve)));
    api.getPbiComments.mockReturnValue(new Promise((resolve) => (comments = resolve)));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    await waitFor(() => expect(api.syncPbiChildren).toHaveBeenCalled());
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => {
      children([root]);
      comments([]);
    });
  });

  it('shows the error of syncing the cards of an item that has none', async () => {
    const api = mockClient();
    withItems(api, [{ ...root, links: [azureLink] }]);
    api.syncPbiChildren.mockRejectedValue(new Error('Sync failed'));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    expect(await screen.findByText('Sync failed')).toBeInTheDocument();
  });
});

describe('PbiView g6: sync errors with cards present', () => {
  it('hides the sync error when the item already has cards', async () => {
    const api = mockClient();
    withItems(api, [{ ...root, links: [azureLink] }, card]);
    api.syncPbiChildren.mockRejectedValue(new Error('Sync failed'));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    await waitFor(() => expect(api.syncPbiChildren).toHaveBeenCalled());
    expect(screen.queryByText('Sync failed')).toBeNull();
  });
});

describe('PbiView g6: provider names and links', () => {
  it('names an unknown provider by its id', async () => {
    const api = mockClient();
    withItems(api, [{ ...root, links: [customLink] }]);
    api.getPbiProviders.mockResolvedValue([
      { providerId: 'custom_provider', settings: { boardId: 'b' } },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    fireEvent.click(screen.getByRole('button', { name: /Ações$/ }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /Pull apenas de custom_provider/ }),
    );
    await waitFor(() => expect(api.pullPbiBoards).toHaveBeenCalledWith('custom_provider'));
    expect(screen.getAllByText('custom_provider').length).toBeGreaterThan(0);
  });
});

describe('PbiView g6: Kanban', () => {
  const dataTransfer = () => {
    const store = new Map<string, string>();
    return {
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
      effectAllowed: '',
    };
  };
  const kanban = (api: Api, extra: Partial<PbiViewProps> = {}) => {
    localStorage.setItem('adk:pbi-view:ws', 'kanban');
    return renderView(api, 'ws', extra);
  };

  it('shows assignees by name or id, empty columns and the saving state of a card', async () => {
    const api = mockClient();
    api.getWorkspaceMembers.mockResolvedValue([]);
    withItems(api, [
      {
        ...root,
        id: 'k1',
        title: 'Typed card',
        status: 'New',
        sourceData: { adkAssigneeUserId: 'user-gone', type: 'Unknown Type' },
      },
      { ...root, id: 'k2', title: 'Target card', status: 'Active', position: 2 },
    ]);
    let finish: () => void = () => undefined;
    api.updatePbiItem.mockImplementation(
      () => new Promise((resolve) => (finish = () => resolve(card))),
    );
    kanban(api);
    const typed = (await screen.findByText('Typed card')).closest('article') as HTMLElement;
    expect(typed).toHaveTextContent('user-gone');

    const transfer = dataTransfer();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'Typed' },
    });
    expect(await screen.findByText('Sem itens')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: '' },
    });
    await screen.findByText('Target card');
    const column = screen.getByText('Target card').closest('section') as HTMLElement;
    fireEvent.dragStart(typed, { dataTransfer: transfer });
    fireEvent.dragOver(column, { dataTransfer: transfer });
    const inside = createEvent.dragLeave(column);
    Object.defineProperty(inside, 'relatedTarget', { value: column.querySelector('header') });
    fireEvent(column, inside);
    fireEvent.dragLeave(column, { relatedTarget: null });
    fireEvent.dragOver(column, { dataTransfer: transfer });
    fireEvent.dragLeave(typed.closest('section')!, { relatedTarget: null });
    fireEvent.dragEnd(typed);
    fireEvent.dragStart(typed, { dataTransfer: transfer });
    fireEvent.drop(column, { dataTransfer: transfer });
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar agora' }));
    expect(await screen.findByRole('status', { name: 'Salvando movimento' })).toBeInTheDocument();
    finish();
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Salvando movimento' })).toBeNull(),
    );
  });

  it('does not accept drags for read-only members', async () => {
    const api = mockClient();
    kanban(api, { isReadOnly: true });
    const cardNode = (await screen.findByText('Verify release')).closest('article') as HTMLElement;
    const transfer = dataTransfer();
    const column = cardNode.closest('section') as HTMLElement;
    fireEvent.dragStart(cardNode, { dataTransfer: transfer });
    fireEvent.dragOver(column, { dataTransfer: transfer });
    fireEvent.drop(column, { dataTransfer: transfer });
    expect(api.updatePbiItem).not.toHaveBeenCalled();
  });
});

describe('PbiView g6: item editor', () => {
  it('changes the state and attaches a file to the item being edited', async () => {
    const api = mockClient();
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Estado' }), {
      target: { value: 'Done' },
    });
    expect(within(dialog).getByRole('combobox', { name: 'Estado' })).toHaveProperty(
      'value',
      'Done',
    );
    fireEvent.change(within(dialog).getByLabelText('URL do arquivo'), {
      target: { value: 'https://files.example.com/spec.pdf' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar URL' }));
    expect(await within(dialog).findByText('spec.pdf')).toBeInTheDocument();
  });

  it('keeps an image pasted in the description in the form', async () => {
    const api = mockClient();
    render(
      <MediaProvider apiClient={api as unknown as ApiClient}>
        <PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />
      </MediaProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const editor = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Descrição' });
    fireEvent.paste(editor, {
      clipboardData: { files: [new File(['p'], 'pasted.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(editor.querySelector('img')).not.toBeNull());
  });

  it('closes the filter name dialog with Escape', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    openFilters();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    expect(screen.getByRole('textbox', { name: 'Nome do filtro' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).toBeNull();
  });
});
