import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiLinks } from '../src/features/pbi/PbiLinks.js';
import { PbiPushDialog } from '../src/features/pbi/PbiPushDialog.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
import type { PbiItem, PbiPushContract, PbiRelation } from '../src/features/pbi/pbi-types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
const card: PbiItem = { ...root, id: 'card', parentId: 'root', kind: 'card', title: 'Verify' };
const summary = (title: string, id: string): NonNullable<PbiRelation['item']> => ({
  id,
  title,
  kind: 'card',
  status: 'New',
  type: 'Task',
  links: [],
});
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

describe('PbiLinks coverage (Vitest 5)', () => {
  it('ignores a relation failure after unmounting', async () => {
    const relations = deferred<PbiRelation[]>();
    const api = { getPbiRelations: vi.fn().mockReturnValue(relations.promise) };
    const view = render(
      <PbiLinks
        apiClient={api as unknown as ApiClient}
        item={root}
        items={[root]}
        onOpenItem={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    view.unmount();
    await act(async () => relations.reject(new Error('gone')));
    expect(api.getPbiRelations).toHaveBeenCalledWith('root');
  });

  it('removes a related link without reloading the hierarchy', async () => {
    const api = {
      getPbiRelations: vi
        .fn()
        .mockResolvedValue([{ type: 'related', origin: 'adk', item: summary('Peer', 'peer') }]),
      removePbiRelation: vi.fn().mockResolvedValue([]),
    };
    const onChanged = vi.fn();
    render(
      <PbiLinks
        apiClient={api as unknown as ApiClient}
        item={root}
        items={[root]}
        onOpenItem={vi.fn()}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remover link: Peer' }));
    await waitFor(() =>
      expect(api.removePbiRelation).toHaveBeenCalledWith('root', 'related', 'peer'),
    );
    await waitFor(() => expect(screen.queryByText('Peer')).toBeNull());
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('PbiPushDialog coverage (Vitest 5)', () => {
  const props = (api: object) => ({
    apiClient: api as unknown as ApiClient,
    item: root,
    providers: [{ providerId: 'azure_devops' as const, settings: {} }],
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  });

  it('ignores a contract failure after unmounting', async () => {
    const contract = deferred<PbiPushContract>();
    const api = {
      getPbiPushContract: vi.fn().mockReturnValue(contract.promise),
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getPbiFieldCatalog: vi.fn().mockResolvedValue([]),
    };
    const view = render(<PbiPushDialog {...props(api)} />);
    await waitFor(() => expect(api.getPbiPushContract).toHaveBeenCalled());
    view.unmount();
    await act(async () => contract.reject(new Error('gone')));
  });

  it('does not reload the contract when a plain custom field loses focus', async () => {
    const api = {
      getPbiPushContract: vi.fn().mockResolvedValue({
        providerId: 'azure_devops',
        update: false,
        fields: [
          {
            key: 'areaPath',
            label: 'Area path',
            required: true,
            options: [],
            value: '',
            status: 'empty',
            allowCustom: true,
          },
        ],
      }),
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getPbiFieldCatalog: vi.fn().mockResolvedValue([]),
    };
    render(<PbiPushDialog {...props(api)} />);
    const input = await screen.findByLabelText(/Area path|Área/);
    fireEvent.change(input, { target: { value: ' proj\\Web ' } });
    fireEvent.blur(input);
    expect(api.getPbiPushContract).toHaveBeenCalledTimes(1);
  });
});

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
    getPbiComments: vi.fn().mockResolvedValue([]),
    pullPbiBoards: vi
      .fn()
      .mockResolvedValue({ results: [{ providerId: 'trello', imported: 2 }], items: [root, card] }),
    pushPbiItem: vi.fn().mockResolvedValue({ item: root, warnings: [] }),
    getPbiPushContract: vi.fn().mockResolvedValue(readyContract),
    getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
    getPbiFieldCatalog: vi.fn().mockResolvedValue([]),
    getPbiRelations: vi.fn().mockResolvedValue([]),
    getAuditHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
  };
}
type Api = ReturnType<typeof mockClient>;
const renderView = (api: Api, onPbiChanged?: () => void) =>
  render(
    <PbiView
      apiClient={api as unknown as ApiClient}
      workspaceId="ws"
      onPbiChanged={onPbiChanged}
    />,
  );
const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Ações' }));

describe('PbiView coverage (Vitest 5)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('ignores members that load or fail after unmounting', async () => {
    for (const settle of ['resolve', 'reject'] as const) {
      const api = mockClient();
      const members = deferred<never[]>();
      api.getWorkspaceMembers.mockReturnValue(members.promise);
      const view = renderView(api);
      await waitFor(() => expect(api.getWorkspaceMembers).toHaveBeenCalled());
      view.unmount();
      await act(async () =>
        settle === 'resolve' ? members.resolve([]) : members.reject(new Error('x')),
      );
    }
  });

  it('ignores child sync, agent and comment failures after the form closes', async () => {
    const api = mockClient();
    const linked: PbiItem = {
      ...root,
      links: [
        {
          id: 'link',
          providerId: 'azure_devops',
          externalId: '1',
          externalUrl: null,
          boardId: 'p',
          syncedAt: root.createdAt,
        },
      ],
    };
    api.getPbiItems.mockResolvedValue([linked]);
    const children = deferred<PbiItem[]>();
    const agents = deferred<never[]>();
    const comments = deferred<never[]>();
    api.syncPbiChildren.mockReturnValue(children.promise);
    api.getAgents.mockReturnValue(agents.promise);
    api.getPbiComments.mockReturnValue(comments.promise);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.syncPbiChildren).toHaveBeenCalledWith('root'));
    expect(api.getAgents).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await act(async () => {
      children.reject(new Error('sync'));
      agents.reject(new Error('agents'));
      comments.reject(new Error('comments'));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps an iteration picked by hand when the board reloads', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      { ...root, sourceData: { iterationPath: 'Proj\\Sprint 1', currentIteration: true } },
      { ...card, parentId: null, sourceData: { iterationPath: 'Proj\\Sprint 2' } },
    ]);
    api.getPbiCurrentIteration.mockResolvedValue(undefined);
    renderView(api);
    const select = await screen.findByRole('combobox', { name: 'Iteração' });
    await waitFor(() => expect(select).toHaveProperty('value', 'Proj\\Sprint 1'));
    fireEvent.change(select, { target: { value: 'Proj\\Sprint 2' } });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Atualizar/ }));
    await waitFor(() => expect(api.getPbiItems).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('combobox', { name: 'Iteração' })).toHaveProperty(
      'value',
      'Proj\\Sprint 2',
    );
  });

  it('leaves reloading to the parent after pulls and pushes', async () => {
    const api = mockClient();
    const onPbiChanged = vi.fn();
    api.pullPbiBoards
      .mockResolvedValueOnce({ results: [{ providerId: 'trello', imported: 1 }], items: [root] })
      .mockRejectedValueOnce(new Error('down'));
    renderView(api, onPbiChanged);
    await screen.findByRole('button', { name: 'Release PBI' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull de todos' }));
    expect(await screen.findByText('1 itens sincronizados.')).toBeInTheDocument();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull de todos' }));
    await waitFor(() => expect(api.pullPbiBoards).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Ações: Release PBI' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    const submit = within(screen.getByRole('dialog')).getByRole('button', { name: 'Fazer push' });
    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    expect(await screen.findByText('Publicado em Trello.')).toBeInTheDocument();
    expect(api.getPbiItems).toHaveBeenCalledTimes(1);
    expect(onPbiChanged).toHaveBeenCalled();
  });

  it('does not open a partial item fetched after unmounting', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([{ ...root, partial: true }]);
    const full = deferred<PbiItem>();
    api.getPbiItem.mockReturnValue(full.promise);
    const view = renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    await waitFor(() => expect(api.getPbiItem).toHaveBeenCalledWith('root'));
    view.unmount();
    await act(async () => full.resolve(root));
  });

  it('stays on the open item when a linked item is not on the board', async () => {
    const api = mockClient();
    api.getPbiRelations.mockResolvedValue([
      { type: 'related', origin: 'adk', item: summary('Elsewhere', 'ghost') },
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click((await within(dialog).findAllByRole('button', { name: /Elsewhere/ }))[0]!);
    expect(within(dialog).getByDisplayValue('Release PBI')).toBeInTheDocument();
  });
});

describe('PbiView form dialog (Vitest 5)', () => {
  it('closes the open item with Escape', async () => {
    renderView(mockClient());
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
