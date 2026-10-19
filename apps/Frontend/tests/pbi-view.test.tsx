import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
import { ActivityCenter, ActivityProvider } from '../src/features/activities/ActivityCenter.js';
import type { PbiItem, PbiPushContract } from '../src/features/pbi/pbi-types.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type {
  EffectiveAccess,
  ModuleAccess,
  PermissionModule,
} from '../src/features/workspaces/workspace-types.js';

function accessWith(modules: Partial<Record<PermissionModule, ModuleAccess>>): EffectiveAccess {
  return { ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, ...modules } };
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
const card: PbiItem = {
  ...root,
  id: 'card',
  parentId: root.id,
  kind: 'card',
  title: 'Verify release',
  description: 'Check deployment',
  position: 2,
};

function trelloContract(list = ''): PbiPushContract {
  return {
    providerId: 'trello',
    update: false,
    fields: [
      {
        key: 'board',
        label: 'Board',
        required: true,
        options: [{ value: 'board', label: 'Main' }],
        value: 'board',
        status: 'resolved',
        reloadOnChange: true,
      },
      {
        key: 'list',
        label: 'List',
        required: true,
        options: [{ value: 'list-1', label: 'Doing' }],
        value: list,
        status: list ? 'resolved' : 'unresolved',
        source: 'New',
      },
      {
        key: 'member',
        label: 'Member',
        required: false,
        options: [{ value: 'm1', label: 'Ana', detail: '@ana' }],
        value: '',
        status: 'empty',
      },
    ],
  };
}

function mockClient() {
  const getPbiItems = vi.fn<() => Promise<PbiItem[]>>().mockResolvedValue([root, card]);
  return {
    getPbiItems,
    syncPbiChildren: vi.fn().mockImplementation(() => getPbiItems()),
    getPbiProviders: vi
      .fn()
      .mockResolvedValue([{ providerId: 'trello', settings: { boardId: 'board' } }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'QA Agent' }]),
    getWorkspaceMembers: vi.fn().mockResolvedValue([
      {
        id: 'member-1',
        workspaceId: 'ws',
        userId: 'user-1',
        role: 'MEMBER',
        permissions: {},
        createdAt: '2026-09-30T00:00:00.000Z',
        user: { id: 'user-1', name: 'Ana Souza', email: 'ana@example.test' },
      },
    ]),
    getPbiContext: vi.fn().mockResolvedValue({ item: root, descendants: [card] }),
    getPbiComments: vi.fn().mockResolvedValue([]),
    createPbiItem: vi.fn().mockResolvedValue(card),
    updatePbiItem: vi.fn().mockResolvedValue(card),
    deletePbiItem: vi.fn().mockResolvedValue(undefined),
    pullPbiBoards: vi
      .fn()
      .mockResolvedValue({ results: [{ providerId: 'trello', imported: 2 }], items: [root, card] }),
    pushPbiItem: vi.fn().mockResolvedValue({ item: card, warnings: [] }),
    getPbiPushContract: vi.fn().mockResolvedValue(trelloContract()),
    getPbiRelations: vi.fn().mockResolvedValue([]),
    addPbiRelations: vi.fn().mockResolvedValue([]),
    removePbiRelation: vi.fn().mockResolvedValue([]),
    createIssueFromPbi: vi.fn().mockResolvedValue({ id: 'issue' }),
    generateTestPlan: vi.fn().mockResolvedValue({ plans: [], csv: '' }),
  };
}

describe('PbiView', () => {
  beforeEach(() => localStorage.clear());
  it('loads missing Azure children when opening a linked PBI', async () => {
    const api = mockClient();
    const linkedRoot: PbiItem = {
      ...root,
      links: [
        {
          id: 'azure-link',
          providerId: 'azure_devops',
          externalId: '46873',
          externalUrl: null,
          boardId: 'project',
          syncedAt: '2026-09-30T00:00:00.000Z',
        },
      ],
    };
    api.getPbiItems.mockResolvedValue([linkedRoot]);
    api.syncPbiChildren.mockResolvedValue([linkedRoot, card]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    expect(api.syncPbiChildren).toHaveBeenCalledWith('root');
    const sidebar = within(screen.getByRole('dialog')).getByRole('complementary');
    expect(
      await within(sidebar).findByRole('button', { name: 'Verify release' }),
    ).toBeInTheDocument();
  });
  it('opens a PBI from the row and loads comments when switching to a card', async () => {
    const api = mockClient();
    api.getPbiComments.mockImplementation((id: string) =>
      Promise.resolve([
        {
          id: `${id}-comment`,
          body: id === 'root' ? 'PBI discussion' : 'Task discussion',
          author: 'Ana',
          createdAt: '2026-09-30T12:00:00.000Z',
        },
      ]),
    );
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    const title = await screen.findByRole('button', { name: 'Release PBI' });
    const row = title.closest('tr')!;
    expect(row.firstElementChild?.querySelector('button')).toHaveAttribute(
      'aria-label',
      'Recolher Release PBI',
    );
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Verify release')).toBeInTheDocument();
    fireEvent.click(title);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('PBI discussion')).toBeInTheDocument();
    const sidebar = within(dialog).getByRole('complementary');
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Verify release' }));
    expect(await within(dialog).findByText('Task discussion')).toBeInTheDocument();
    expect(api.getPbiComments).toHaveBeenCalledWith('card');
  });
  it('offers a retry when comments cannot be loaded', async () => {
    const api = mockClient();
    api.getPbiComments.mockRejectedValueOnce(new Error('Azure unavailable')).mockResolvedValueOnce([
      {
        id: 'comment-1',
        body: 'Recovered comment',
        author: 'Alex',
        createdAt: '2026-09-30T12:00:00.000Z',
      },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Azure unavailable');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(await within(dialog).findByText('Recovered comment')).toBeInTheDocument();
  });
  it('renders Azure comment HTML and encoded entities without showing entity codes', async () => {
    const api = mockClient();
    api.getPbiComments.mockResolvedValue([
      {
        id: 'one',
        body: '<p><strong>@Alex</strong> &gt; approved</p>',
        author: 'Alex',
        createdAt: '2026-09-30T12:00:00.000Z',
      },
      {
        id: 'two',
        body: 'Resultado &gt; esperado &amp; validado',
        author: 'Sam',
        createdAt: '2026-09-30T13:00:00.000Z',
      },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('@Alex', { selector: 'strong' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Resultado > esperado & validado/)).toBeInTheDocument();
    expect(dialog.textContent).not.toContain('&gt;');
  });
  it('shows related Azure work items separately from child cards', async () => {
    const api = mockClient();
    const related: PbiItem = {
      ...card,
      id: 'related',
      parentId: null,
      title: 'Related analysis',
      links: [
        {
          id: 'link',
          providerId: 'azure_devops',
          externalId: '99',
          externalUrl: null,
          boardId: 'project',
          syncedAt: '2026-09-30T00:00:00.000Z',
        },
      ],
    };
    api.getPbiItems.mockResolvedValue([
      { ...root, sourceData: { relatedExternalIds: ['99'] } },
      card,
      related,
    ]);
    api.getPbiRelations.mockResolvedValue([
      {
        type: 'related',
        origin: 'azure_devops',
        item: {
          id: 'related',
          title: 'Related analysis',
          kind: 'card',
          status: 'New',
          type: 'Task',
          links: [{ providerId: 'azure_devops', externalId: '99', externalUrl: null }],
        },
      },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const relatedSection = within(screen.getByRole('dialog')).getByRole('region', {
      name: 'Links',
    });
    expect(await within(relatedSection).findByText('Relacionado (1)')).toBeInTheDocument();
    expect(within(relatedSection).getByTitle('Lido de Azure DevOps')).toBeInTheDocument();
    fireEvent.click(within(relatedSection).getByRole('button', { name: /Related analysis/ }));
    expect(
      within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('textbox', {
        name: 'Título',
      }).value,
    ).toBe('Related analysis');
    await waitFor(() => expect(api.getPbiComments).toHaveBeenCalledWith('related'));
    expect(
      await within(screen.getByRole('dialog')).findByText('Nenhum comentário neste item.'),
    ).toBeInTheDocument();
  });
  it('expands a PBI to show tasks and bugs and formats its Markdown description', async () => {
    const api = mockClient();
    api.getPbiCurrentIteration.mockResolvedValue('Sprint 190');
    api.getPbiItems.mockResolvedValue([
      {
        ...root,
        description:
          '#### Introdução\n\nTexto com **destaque**.\n\n&lt;div&gt;Escapado&lt;/div&gt;',
        sourceData: { iterationPath: 'Sprint 190' },
      },
      { ...card, sourceData: { type: 'Task', iterationPath: 'Sprint 191' } },
      { ...card, id: 'bug', title: 'Fix release', sourceData: { type: 'Bug' } },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    expect(await screen.findByText('Release PBI')).toBeInTheDocument();
    expect(screen.getByText('Verify release')).toBeInTheDocument();
    expect(screen.getByText('Fix release')).toBeInTheDocument();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Iteração' }).value).toBe(
      'Sprint 190',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Introdução' })).toBeInTheDocument();
    expect(within(dialog).getByText('destaque', { selector: 'strong' })).toBeInTheDocument();
    expect(within(dialog).getByText('<div>Escapado</div>')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: 'QA Agent' })).toBeInTheDocument(),
    );
  });
  it('shows a hierarchical backlog and pulls every integration', async () => {
    const api = mockClient();
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    expect(await screen.findByText('Release PBI')).toBeInTheDocument();
    // Cards are tree rows of the same table, one level below their PBI.
    const parentRow = screen.getByRole('button', { name: 'Release PBI' }).closest('tr');
    const cardRow = screen.getByRole('button', { name: 'Verify release' }).closest('tr');
    expect(parentRow).toHaveAttribute('aria-level', '1');
    expect(parentRow).toHaveAttribute('aria-expanded', 'true');
    expect(cardRow).toHaveAttribute('aria-level', '2');
    expect(cardRow?.closest('table')).toBe(parentRow?.closest('table'));
    fireEvent.click(screen.getByRole('button', { name: 'Recolher Release PBI' }));
    expect(parentRow).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Verify release')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expandir Release PBI' }));
    expect(screen.getByText('Verify release')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull de todos' }));
    await waitFor(() => expect(api.pullPbiBoards).toHaveBeenCalledOnce());
    expect(await screen.findByText('2 itens sincronizados.')).toBeInTheDocument();
  });

  it('keeps type labels on one line and distinguishes PBI, task and bug', async () => {
    const api = mockClient();
    const typedRoot = { ...root, sourceData: { type: 'Product Backlog Item' } };
    const longType = 'A very long custom work item type that needs truncation';
    api.getPbiItems.mockResolvedValue([
      typedRoot,
      { ...card, sourceData: { type: 'Task' } },
      { ...card, id: 'bug', title: 'Fix release', sourceData: { type: 'Bug' } },
      { ...card, id: 'custom', title: 'Custom work', sourceData: { type: longType } },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    const pbiType = await screen.findByTitle('Product Backlog Item');
    const taskType = screen.getByTitle('Task');
    const bugType = screen.getByTitle('Bug');
    const customType = screen.getByTitle(longType);
    expect(pbiType.querySelector('i')).toHaveClass('ti-layout-kanban');
    expect(taskType.querySelector('i')).toHaveClass('ti-checklist');
    expect(bugType.querySelector('i')).toHaveClass('ti-bug');
    expect(taskType.className).not.toBe(bugType.className);
    expect(customType.querySelector('span')).toHaveClass('truncate');
    expect(customType.querySelector('span')).toHaveClass('whitespace-nowrap');
    // The type column keeps its default (resizable) width and clips long names.
    expect(customType.closest('td')).toHaveClass('overflow-hidden');
    const typeColumn = customType.closest('table')?.querySelectorAll('col')[2];
    expect(typeColumn?.style.width).toBe('224px');
  });

  it('opens the push modal, selects a provider and publishes the card', async () => {
    const api = mockClient();
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    await screen.findByRole('button', { name: 'Recolher Release PBI' });
    fireEvent.click(screen.getByRole('button', { name: 'Ações: Verify release' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Trello')).toBeInTheDocument();
    const list = await within(dialog).findByRole('combobox', { name: /Lista/ });
    await waitFor(() => expect(list).toHaveProperty('disabled', false));
    expect(api.getPbiPushContract).toHaveBeenCalledWith('card', 'trello', {});
    // "New" could not be mapped to a Trello list, so the list is highlighted and required.
    expect(list).toHaveAttribute('aria-invalid', 'true');
    expect(
      within(dialog).getByText('Não foi possível mapear “New”. Selecione um valor.'),
    ).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Fazer push' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(list, { target: { value: 'list-1' } });
    expect(list).toHaveAttribute('aria-invalid', 'false');
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.pushPbiItem).toHaveBeenCalledWith('card', {
        providerId: 'trello',
        fields: { board: 'board', list: 'list-1', member: '' },
      }),
    );
    expect(await screen.findByText('Publicado em Trello.')).toBeInTheDocument();
  });

  it('shows nested cards, edits their properties and saves their parent', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      root,
      card,
      { ...card, id: 'grandchild', parentId: 'card', title: 'Check logs' },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    await screen.findByRole('button', { name: 'Recolher Release PBI' });
    expect(screen.getByText('Check logs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recolher Verify release' }));
    expect(screen.queryByText('Check logs')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expandir Verify release' }));
    expect(screen.getByText('Check logs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verify release' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Descrição' }).textContent).toBe(
      'Check deployment',
    );
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: 'QA Agent' })).toBeInTheDocument(),
    );
    fireEvent.change(within(dialog).getByLabelText('Agente atribuído'), {
      target: { value: 'agent-1' },
    });
    fireEvent.change(within(dialog).getByLabelText('Prioridade'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.updatePbiItem).toHaveBeenCalledWith(
        'card',
        expect.objectContaining({
          parentId: 'root',
          sourceData: expect.objectContaining({ adkAgentId: 'agent-1', adkPriority: '1' }),
        }),
      ),
    );
  });

  it('lets the user choose visible columns and remembers them', async () => {
    const api = mockClient();
    const view = render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    await screen.findByText('Release PBI');
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Colunas' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tags' }));
    expect(screen.queryByRole('columnheader', { name: 'Tags' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('adk:pbi-columns:ws') ?? '[]')).not.toContain('tags');
    view.unmount();
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    await screen.findByText('Release PBI');
    expect(screen.queryByRole('columnheader', { name: 'Tags' })).not.toBeInTheDocument();
  });

  it('creates a subitem from the item editor', async () => {
    const api = mockClient();
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Adicionar card' }),
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Item pai').value).toBe('root');
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Nested task' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.createPbiItem).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'card',
          title: 'Nested task',
          parentId: 'root',
        }),
      ),
    );
  });

  it('creates an issue and test plan from the PBI context', async () => {
    const api = mockClient();
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ações: Release PBI' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar issue de' }));
    await waitFor(() => expect(api.createIssueFromPbi).toHaveBeenCalledWith('root'));
    fireEvent.click(screen.getByRole('button', { name: 'Ações: Release PBI' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar testes de' }));
    await waitFor(() =>
      expect(api.generateTestPlan).toHaveBeenCalledWith(
        expect.stringContaining('Verify release: Check deployment'),
        { title: 'Release PBI', sourceType: 'pbi', sourceId: 'root' },
      ),
    );
  });

  it('filters imported cards by source and iteration while keeping their parent visible', async () => {
    const api = mockClient();
    const importedCard: PbiItem = {
      ...card,
      sourceData: { type: 'Task', areaPath: 'Acme', iterationPath: 'Sprint 190', tags: 'QA' },
      links: [
        {
          id: 'link',
          providerId: 'azure_devops',
          externalId: '42',
          externalUrl: null,
          boardId: 'project',
          syncedAt: '2026-09-30T00:00:00.000Z',
        },
      ],
    };
    api.getPbiItems.mockResolvedValue([
      root,
      importedCard,
      { ...root, id: 'other', title: 'Unrelated PBI', position: 3 },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    expect(await screen.findByText('Unrelated PBI')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Origem' }), {
      target: { value: 'azure_devops' },
    });
    expect(screen.getByText('Release PBI')).toBeInTheDocument();
    expect(screen.getByText('Verify release')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated PBI')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), {
      target: { value: 'Sprint 190' },
    });
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('QA')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recolher Release PBI' }));
    expect(screen.getByText('Release PBI')).toBeInTheDocument();
    expect(screen.queryByText('Verify release')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expandir Release PBI' }));
    expect(screen.getByText('Verify release')).toBeInTheDocument();
  });

  it('keeps pull and push in notifications after navigating away', async () => {
    const api = mockClient();
    let finishPull!: (value: Awaited<ReturnType<typeof api.pullPbiBoards>>) => void;
    let finishPush!: (value: { item: PbiItem; warnings: string[] }) => void;
    api.getPbiPushContract.mockResolvedValue(trelloContract('list-1'));
    api.getPbiItems.mockResolvedValueOnce([root]).mockResolvedValue([root, card]);
    api.pullPbiBoards.mockReturnValue(
      new Promise((resolve) => {
        finishPull = resolve;
      }),
    );
    api.pushPbiItem.mockReturnValue(
      new Promise((resolve) => {
        finishPush = resolve;
      }),
    );
    function Harness() {
      const [showPbis, setShowPbis] = useState(true);
      const [refreshToken, setRefreshToken] = useState(0);
      return (
        <ActivityProvider>
          <button onClick={() => setShowPbis((value) => !value)}>
            {showPbis ? 'Navigate away' : 'Return to PBIs'}
          </button>
          <ActivityCenter />
          {showPbis && (
            <PbiView
              apiClient={api as unknown as ApiClient}
              workspaceId="ws"
              refreshToken={refreshToken}
              onPbiChanged={() => setRefreshToken((value) => value + 1)}
            />
          )}
        </ActivityProvider>
      );
    }
    render(<Harness />);
    await screen.findByRole('button', { name: 'Release PBI' });
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull de todos' }));
    expect(api.pullPbiBoards).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate away' }));
    fireEvent.click(screen.getByRole('button', { name: /abrir central de atividades/i }));
    expect(screen.getByText('Pull de todos')).toBeInTheDocument();
    await act(async () =>
      finishPull({ results: [{ providerId: 'trello', imported: 2 }], items: [root, card] }),
    );
    expect(screen.getByText('Concluída')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Return to PBIs' }));
    expect(await screen.findByText('Verify release')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações: Verify release' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    const pushButton = within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Fazer push',
    });
    await waitFor(() => expect(pushButton).toHaveProperty('disabled', false));
    fireEvent.click(pushButton);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate away' }));
    expect(screen.getByText('Publicar: Verify release')).toBeInTheDocument();
    await act(async () => finishPush({ item: card, warnings: [] }));
    expect(screen.getAllByText('Concluída')).toHaveLength(2);
  });
  it('shows every child of a matching item and searches accent-insensitively in HTML descriptions', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      { ...root, description: '<div><b>Introdução</b> Justificativa do fluxo</div>' },
      card,
      { ...card, id: 'other-card', title: 'Unrelated task', description: 'Nothing here' },
      { ...root, id: 'other', title: 'Other PBI', description: 'Different', position: 3 },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    expect(await screen.findByText('Other PBI')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'introducao justifica' },
    });
    await waitFor(() => expect(screen.queryByText('Other PBI')).not.toBeInTheDocument());
    expect(screen.getByText('Release PBI')).toBeInTheDocument();
    expect(screen.getByText('Verify release')).toBeInTheDocument();
    expect(screen.getByText('Unrelated task')).toBeInTheDocument();
    expect(screen.getByText('Introdução Justificativa do fluxo')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'unrelated' },
    });
    await waitFor(() => expect(screen.queryByText('Verify release')).not.toBeInTheDocument());
    expect(screen.getByText('Release PBI')).toBeInTheDocument();
    expect(screen.getByText('Unrelated task')).toBeInTheDocument();
  });

  it('saves, reapplies and deletes filter presets per workspace', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      root,
      card,
      { ...root, id: 'other', title: 'Other PBI', status: 'Done', position: 3 },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    expect(await screen.findByText('Other PBI')).toBeInTheDocument();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar filtro' }).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado' }), {
      target: { value: 'Done' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Nome do filtro' }), {
      target: { value: 'Concluídos' },
    });
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Salvar filtro' }),
    );
    expect(JSON.parse(localStorage.getItem('adk:pbi-saved-filters:ws') ?? '[]')).toEqual([
      expect.objectContaining({ name: 'Concluídos', status: 'Done', query: '' }),
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado' }), { target: { value: '' } });
    expect(screen.getByText('Release PBI')).toBeInTheDocument();
    const saved = screen.getByRole('combobox', { name: 'Filtros salvos' });
    fireEvent.change(saved, {
      target: { value: screen.getByRole('option', { name: 'Concluídos' }).getAttribute('value') },
    });
    expect(screen.queryByText('Release PBI')).not.toBeInTheDocument();
    expect(screen.getByText('Other PBI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir filtro salvo: Concluídos' }));
    expect(localStorage.getItem('adk:pbi-saved-filters:ws')).toBe('[]');
    expect(screen.queryByRole('option', { name: 'Concluídos' })).not.toBeInTheDocument();
  });

  it('assigns a PBI to a workspace member and filters by assignee', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      { ...root, sourceData: { adkAssigneeUserId: 'user-1' } },
      card,
      { ...root, id: 'other', title: 'Other PBI', position: 3 },
    ]);
    render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
    expect(await screen.findByText('Other PBI')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole('option', { name: 'Ana Souza' }).length).toBeGreaterThan(0),
    );
    expect(screen.getByText('Ana Souza', { selector: 'span' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Responsável' }), {
      target: { value: 'user-1' },
    });
    expect(screen.queryByText('Other PBI')).not.toBeInTheDocument();
    expect(screen.getByText('Verify release')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Responsável' }), {
      target: { value: 'none' },
    });
    expect(screen.getByText('Other PBI')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Other PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Histórico' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Responsável'), { target: { value: 'user-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.updatePbiItem).toHaveBeenCalledWith(
        'other',
        expect.objectContaining({
          sourceData: expect.objectContaining({ adkAssigneeUserId: 'user-1' }),
        }),
      ),
    );
  });
});

describe('PbiView permissions', () => {
  beforeEach(() => localStorage.clear());
  const renderWithAccess = (
    api: ReturnType<typeof mockClient>,
    access: EffectiveAccess,
    isReadOnly?: boolean,
  ) =>
    render(
      <PermissionsProvider access={access}>
        <PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" isReadOnly={isReadOnly} />
      </PermissionsProvider>,
    );

  it('deletes an item after confirmation when the member may delete', async () => {
    const api = mockClient();
    renderWithAccess(api, FULL_ACCESS);
    fireEvent.click(await screen.findByRole('button', { name: 'Ações: Release PBI' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excluir' }));
    const confirm = screen.getByRole('alertdialog');
    expect(
      within(confirm).getByText('Excluir Release PBI e seus cards locais?'),
    ).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(api.deletePbiItem).toHaveBeenCalledWith('root'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('hides delete and cross-module actions the member cannot use', async () => {
    const api = mockClient();
    renderWithAccess(
      api,
      accessWith({ pbis: 'edit', issues: 'none', testplans: 'view', agents: 'none' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Ações: Release PBI' }));
    const menu = screen.getByRole('menu', { name: 'Ações: Release PBI' });
    expect(within(menu).getByRole('menuitem', { name: 'Editar' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Publicar' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Excluir' })).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Criar issue de' }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Criar testes de' }),
    ).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Editar' }));
    const dialog = screen.getByRole('dialog');
    // Without access to agents the editor neither loads nor shows the agent assignment.
    expect(within(dialog).getByRole('button', { name: 'Salvar item' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Agente atribuído')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Agente atribuído')).not.toBeInTheDocument();
    expect(await within(dialog).findByText('Nenhum link neste item.')).toBeInTheDocument();
    expect(await within(dialog).findByText('Nenhum comentário neste item.')).toBeInTheDocument();
    expect(api.getAgents).not.toHaveBeenCalled();
  });

  it('keeps cross-module actions when the member may edit issues and test plans', async () => {
    const api = mockClient();
    renderWithAccess(api, accessWith({ pbis: 'edit', issues: 'edit', testplans: 'edit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ações: Release PBI' }));
    const menu = screen.getByRole('menu', { name: 'Ações: Release PBI' });
    expect(within(menu).getByRole('menuitem', { name: 'Criar issue de' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Criar testes de' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Excluir' })).not.toBeInTheDocument();
  });

  it('shows only reading controls when the member can just view PBIs', async () => {
    const api = mockClient();
    renderWithAccess(api, accessWith({ pbis: 'view' }));
    await screen.findByRole('button', { name: 'Release PBI' });
    expect(screen.queryByRole('button', { name: 'Ações: Release PBI' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
    expect(screen.getByRole('menuitem', { name: /Atualizar/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Pull de todos/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Novo PBI/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Título')).toHaveProperty('disabled', true);
    expect(within(dialog).queryByRole('button', { name: 'Salvar item' })).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: 'Adicionar card' }),
    ).not.toBeInTheDocument();
    expect(await within(dialog).findByText('Nenhum link neste item.')).toBeInTheDocument();
    expect(await within(dialog).findByText('Nenhum comentário neste item.')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('button', { name: /Adicionar link/ }),
    ).not.toBeInTheDocument();
    expect(api.syncPbiChildren).not.toHaveBeenCalled();
  });

  it('hides row actions when the view is read-only even with full access', async () => {
    const api = mockClient();
    renderWithAccess(api, FULL_ACCESS, true);
    await screen.findByRole('button', { name: 'Release PBI' });
    expect(screen.queryByRole('button', { name: 'Ações: Release PBI' })).not.toBeInTheDocument();
  });
});
