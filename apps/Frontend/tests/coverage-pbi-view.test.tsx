import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient, AuditHistoryPage } from '../src/lib/api-client.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
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
const azureLink: PbiLink = {
  id: 'azure-link',
  providerId: 'azure_devops',
  externalId: '46873',
  externalUrl: null,
  boardId: 'project',
  syncedAt: '2026-09-30T00:00:00.000Z',
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

function member(userId: string, user?: { name?: string; email?: string }) {
  return {
    id: `member-${userId}`,
    workspaceId: 'ws',
    userId,
    role: 'MEMBER',
    permissions: {},
    createdAt: '2026-09-30T00:00:00.000Z',
    ...(user ? { user: { id: userId, name: '', email: '', ...user } } : {}),
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
    getWorkspaceMembers: vi
      .fn()
      .mockResolvedValue([member('user-1', { name: 'Ana Souza', email: 'ana@example.test' })]),
    getPbiContext: vi.fn().mockResolvedValue({ item: root, descendants: [] }),
    getPbiComments: vi.fn().mockResolvedValue([]),
    createPbiItem: vi.fn().mockResolvedValue(card),
    updatePbiItem: vi.fn().mockResolvedValue(card),
    deletePbiItem: vi.fn().mockResolvedValue(undefined),
    pullPbiBoards: vi
      .fn()
      .mockResolvedValue({ results: [{ providerId: 'trello', imported: 2 }], items: [root, card] }),
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

function renderView(api: Api, workspaceId: string | null = 'ws', refreshToken?: number) {
  return render(
    <PbiView
      apiClient={api as unknown as ApiClient}
      workspaceId={workspaceId}
      refreshToken={refreshToken}
    />,
  );
}
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Ações' }));
}
function openRowMenu(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `Ações: ${title}` }));
}
function failStorageWrites() {
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
}
function dispatchPointer(target: EventTarget, type: string, clientX: number) {
  act(() => {
    target.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { clientX }));
  });
}

describe('PbiView coverage: stored preferences', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('falls back to defaults when stored preferences are corrupt', async () => {
    localStorage.setItem('adk:pbi-columns:ws', '{broken');
    localStorage.setItem('adk:pbi-column-widths:ws', '{broken');
    localStorage.setItem('adk:pbi-saved-filters:ws', '{broken');
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    for (const name of [/^Ordem/, /^Tipo/, /^Tags/, /^Origem/])
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    const cols = screen.getByRole('treegrid').querySelectorAll('col');
    expect(cols[3]?.style.width).toBe('420px');
    expect(screen.getByRole('option', { name: 'Filtros salvos' })).not.toHaveProperty(
      'disabled',
      true,
    );
  });

  it('clamps stored column widths and keeps only well-formed saved filters', async () => {
    localStorage.setItem(
      'adk:pbi-column-widths:ws',
      JSON.stringify({ title: 5000, type: 10, order: 'wide', state: Number.NaN }),
    );
    localStorage.setItem(
      'adk:pbi-saved-filters:ws',
      JSON.stringify([
        {
          id: 'f1',
          name: 'Concluídos',
          query: '',
          source: '',
          status: 'Done',
          iteration: '',
          assignee: '',
        },
        null,
        { id: 2, name: 'Broken' },
      ]),
    );
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const cols = screen.getByRole('treegrid').querySelectorAll('col');
    expect(cols[1]?.style.width).toBe('64px');
    expect(cols[2]?.style.width).toBe('72px');
    expect(cols[3]?.style.width).toBe('900px');
    const saved = screen.getByRole('combobox', { name: 'Filtros salvos' });
    expect(
      within(saved)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Filtros salvos', 'Concluídos']);
  });

  it('ignores saved filters that are not a list', async () => {
    localStorage.setItem('adk:pbi-saved-filters:ws', JSON.stringify({ id: 'x' }));
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const saved = screen.getByRole('combobox', { name: 'Filtros salvos' });
    expect(within(saved).getAllByRole('option')).toHaveLength(1);
  });

  it('shows an empty backlog without loading anything when no workspace is selected', async () => {
    const api = mockClient();
    renderView(api, null);
    expect(
      await screen.findByText('Nenhum PBI ainda. Crie um ou faça Pull das integrações.'),
    ).toBeInTheDocument();
    expect(api.getPbiItems).not.toHaveBeenCalled();
    expect(api.getWorkspaceMembers).not.toHaveBeenCalled();
    expect(
      screen.getByText('Configure um provedor em Integrations para sincronizar.'),
    ).toBeInTheDocument();
  });

  it('toggles columns back on and survives storage failures', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Colunas' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Área' }));
    expect(screen.queryByRole('columnheader', { name: /^Área/ })).not.toBeInTheDocument();
    const setItem = failStorageWrites();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Área' }));
    expect(setItem).toHaveBeenCalled();
    expect(screen.getByRole('columnheader', { name: /^Área/ })).toBeInTheDocument();
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers.indexOf('Área')).toBe(headers.indexOf('Responsável') + 1);
  });
});

describe('PbiView coverage: column resizing', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('resizes columns with the pointer and persists the width', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const handle = screen.getByRole('separator', { name: 'Colunas: Título' });
    // Moving or releasing without an active drag does nothing.
    dispatchPointer(window, 'pointermove', 50);
    dispatchPointer(window, 'pointerup', 50);
    expect(localStorage.getItem('adk:pbi-column-widths:ws')).toBeNull();
    dispatchPointer(handle, 'pointerdown', 100);
    expect(document.body.style.cursor).toBe('col-resize');
    dispatchPointer(window, 'pointermove', 160);
    expect(handle).toHaveAttribute('aria-valuenow', '480');
    dispatchPointer(window, 'pointermove', -5000);
    expect(handle).toHaveAttribute('aria-valuenow', '72');
    dispatchPointer(window, 'pointerup', 0);
    expect(document.body.style.cursor).toBe('');
    expect(JSON.parse(localStorage.getItem('adk:pbi-column-widths:ws') ?? '{}')).toMatchObject({
      title: 72,
    });
  });

  it('keeps resizing when storage is unavailable', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const handle = screen.getByRole('separator', { name: 'Colunas: Estado' });
    failStorageWrites();
    dispatchPointer(handle, 'pointerdown', 0);
    dispatchPointer(window, 'pointermove', 5000);
    dispatchPointer(window, 'pointerup', 0);
    expect(handle).toHaveAttribute('aria-valuenow', '900');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '892');
  });

  it('resizes columns with the keyboard', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const handle = screen.getByRole('separator', { name: 'Colunas: Tipo' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '232');
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(handle).toHaveAttribute('aria-valuenow', '212');
    fireEvent.keyDown(handle, { key: 'Enter' });
    expect(handle).toHaveAttribute('aria-valuenow', '212');
    expect(JSON.parse(localStorage.getItem('adk:pbi-column-widths:ws') ?? '{}')).toMatchObject({
      type: 212,
    });
  });
});

describe('PbiView coverage: rows', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('styles every work item type and hides test cases and items marked for deletion', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      { ...root, id: 'sac', title: 'SAC item', sourceData: { type: 'SAC' } },
      { ...root, id: 'plan', title: 'Plan item', sourceData: { adkCardType: 'Plano de testes' } },
      { ...root, id: 'epic', title: 'Epic item', sourceData: { type: 'Epic' } },
      { ...root, id: 'feature', title: 'Feature item', sourceData: { type: 'Feature' } },
      { ...root, id: 'task', title: 'Tarefa item', sourceData: { type: 'tarefa' } },
      { ...root, id: 'story', title: 'Story item', sourceData: { type: 'User Story' } },
      { ...root, id: 'plain', title: 'Plain PBI', sourceData: { type: 7 } },
      { ...root, id: 'plain-card', kind: 'card', title: 'Plain card' },
      { ...root, id: 'test-case', title: 'Hidden case', sourceData: { type: 'Test Case' } },
      { ...root, id: 'excluir', title: ' Excluir ' },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'SAC item' });
    const iconOf = (title: string) => screen.getByTitle(title).querySelector('i');
    expect(iconOf('SAC')).toHaveClass('ti-message-circle');
    expect(iconOf('Plano de testes')).toHaveClass('ti-clipboard-list');
    expect(iconOf('Epic')).toHaveClass('ti-flag');
    expect(iconOf('Feature')).toHaveClass('ti-sparkles');
    expect(iconOf('tarefa')).toHaveClass('ti-checklist');
    expect(iconOf('User Story')).toHaveClass('ti-layout-kanban');
    expect(iconOf('7')).toHaveClass('ti-folder');
    expect(iconOf('Card')).toHaveClass('ti-file-description');
    expect(screen.queryByText('Hidden case')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^\s*Excluir\s*$/ })).not.toBeInTheDocument();
    expect(screen.getByText(/7 PBIs · 1 cards/)).toBeInTheDocument();
  });

  it('links sources, previews descriptions as text and toggles rows from the keyboard', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      {
        ...root,
        description:
          '<p>Tom &amp; Jerry &#x41;&#66; &bogus; &#0; &#x110000;</p><script>x()</script>',
        links: [
          { ...azureLink, externalUrl: 'https://dev.azure.com/item/1' },
          { ...azureLink, id: 'other', providerId: 'gitlab' as never, externalId: '9' },
        ],
      },
      card,
    ]);
    renderView(api);
    const title = await screen.findByRole('button', { name: 'Release PBI' });
    expect(screen.getByRole('link', { name: 'Azure DevOps' })).toHaveAttribute(
      'href',
      'https://dev.azure.com/item/1',
    );
    expect(screen.getByText('gitlab')).toBeInTheDocument();
    expect(screen.getByText('Tom & Jerry AB &bogus; &#0; &#x110000;')).toBeInTheDocument();
    const row = title.closest('tr')!;
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(row, { key: 'a' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(row, { key: ' ' });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const cardRow = screen.getByRole('button', { name: 'Verify release' }).closest('tr')!;
    fireEvent.click(cardRow);
    fireEvent.keyDown(cardRow, { key: 'Enter' });
    expect(cardRow).not.toHaveAttribute('aria-expanded');
    // Local items are counted under the local source filter only.
    fireEvent.change(screen.getByRole('combobox', { name: 'Origem' }), {
      target: { value: 'local' },
    });
    expect(screen.getByRole('button', { name: 'Verify release' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Filtrar PBIs' }), {
      target: { value: 'nothing matches this' },
    });
    expect(await screen.findByText('Nenhum item corresponde à busca.')).toBeInTheDocument();
  });

  it('paginates root items and changes the page size', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        ...root,
        id: `pbi-${index}`,
        title: `PBI ${String(index).padStart(2, '0')}`,
        position: index,
      })),
    );
    renderView(api);
    await screen.findByRole('button', { name: 'PBI 00' });
    expect(screen.getByText(/Exibindo 1–\s*25 de 30/)).toBeInTheDocument();
    const previous = screen.getByRole('button', { name: 'Página anterior' });
    expect(previous).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getByRole('button', { name: 'PBI 29' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PBI 00' })).not.toBeInTheDocument();
    expect(screen.getByText('Página 2 de 2')).toBeInTheDocument();
    fireEvent.click(previous);
    expect(screen.getByRole('button', { name: 'PBI 00' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'PBIs por página' }), {
      target: { value: '50' },
    });
    expect(screen.getByRole('button', { name: 'PBI 29' })).toBeInTheDocument();
    expect(screen.getByText('Página 1 de 1')).toBeInTheDocument();
  });
});

describe('PbiView coverage: loading and actions', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('falls back to the iteration flagged as current when the provider lookup fails', async () => {
    const api = mockClient();
    api.getPbiCurrentIteration.mockRejectedValue(new Error('offline'));
    api.getPbiItems.mockResolvedValue([
      { ...root, sourceData: { iterationPath: 'Sprint 1' } },
      {
        ...root,
        id: 'current',
        title: 'Current PBI',
        sourceData: { iterationPath: 'Sprint 2', currentIteration: true },
      },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'Current PBI' });
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Iteração' }).value).toBe(
      'Sprint 2',
    );
    expect(screen.queryByRole('button', { name: 'Release PBI' })).not.toBeInTheDocument();
  });

  it('reports load failures and member failures, then retries', async () => {
    const api = mockClient();
    api.getPbiItems.mockRejectedValueOnce('offline').mockRejectedValueOnce(new Error('HTTP 500'));
    api.getWorkspaceMembers.mockRejectedValue(new Error('forbidden'));
    renderView(api);
    expect(await screen.findByText(/Não foi possível carregar os PBIs\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Release PBI' })).toBeInTheDocument();
    expect(
      screen.getByText('Não foi possível carregar os membros do workspace.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/HTTP 500/)).not.toBeInTheDocument();
  });

  it('labels members by name, email or id', async () => {
    const api = mockClient();
    api.getWorkspaceMembers.mockResolvedValue([
      member('user-b', { email: 'bea@example.test' }),
      member('user-c'),
      member('user-a', { name: 'Ana' }),
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    const assignee = screen.getByRole('combobox', { name: 'Responsável' });
    await waitFor(() =>
      expect(
        within(assignee)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Todos os responsáveis', 'Sem responsável', 'Ana', 'bea@example.test', 'user-c']),
    );
  });

  it('reloads after a failed pull and reports provider errors', async () => {
    const api = mockClient();
    api.pullPbiBoards.mockResolvedValue({
      results: [{ providerId: 'trello', imported: 0, error: 'HTTP 401' }],
      items: [],
    });
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    expect(api.getPbiItems).toHaveBeenCalledTimes(1);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull de todos' }));
    await waitFor(() => expect(api.getPbiItems).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('ignores pull and push results after unmounting', async () => {
    const api = mockClient();
    let finishPull!: (value: unknown) => void;
    api.pullPbiBoards.mockReturnValue(new Promise((resolve) => (finishPull = resolve)));
    const view = renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull de todos' }));
    view.unmount();
    await act(async () => finishPull({ results: [], items: [] }));
    expect(api.getPbiItems).toHaveBeenCalledTimes(1);
  });

  it('asks for an integration before pushing and keeps failed pushes quiet', async () => {
    const api = mockClient();
    api.getPbiProviders.mockResolvedValueOnce([]);
    api.pushPbiItem.mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue({
      item: root,
      warnings: ['Tags ignored.'],
    });
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Configure uma integração para fazer push.',
    );
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Atualizar/ }));
    await waitFor(() => expect(api.getPbiProviders).toHaveBeenCalledTimes(2));
    await screen.findByRole('button', { name: 'Release PBI' });

    const publish = async () => {
      openRowMenu('Release PBI');
      fireEvent.click(screen.getByRole('menuitem', { name: 'Publicar' }));
      const submit = within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Fazer push',
      });
      await waitFor(() => expect(submit).toHaveProperty('disabled', false));
      fireEvent.click(submit);
    };
    await publish();
    await waitFor(() => expect(api.pushPbiItem).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Publicado em/)).not.toBeInTheDocument();
    await publish();
    expect(await screen.findByText('Publicado em Trello. Tags ignored.')).toBeInTheDocument();
  });

  it('shows action errors from Error and non-Error failures', async () => {
    const api = mockClient();
    api.createIssueFromPbi
      .mockRejectedValueOnce('nope')
      .mockRejectedValueOnce(new Error('HTTP 409'));
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar issue de' }));
    expect(await screen.findByText(/Não foi possível concluir a ação\./)).toBeInTheDocument();
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar issue de' }));
    expect(await screen.findByText(/HTTP 409/)).toBeInTheDocument();
  });

  it('creates tests from a PBI without descendants', async () => {
    const api = mockClient();
    const onOpenTestPlans = vi.fn();
    render(
      <PbiView
        apiClient={api as unknown as ApiClient}
        workspaceId="ws"
        onOpenTestPlans={onOpenTestPlans}
      />,
    );
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Criar testes de' }));
    await waitFor(() => expect(onOpenTestPlans).toHaveBeenCalled());
    expect(api.generateTestPlan).toHaveBeenCalledWith('Release PBI\n\nDeliver release', {
      title: 'Release PBI',
      sourceType: 'pbi',
      sourceId: 'root',
    });
    expect(screen.getByText('Casos de teste criados.')).toBeInTheDocument();
  });

  it('cancels a delete confirmation', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.deletePbiItem).not.toHaveBeenCalled();
  });
});

describe('PbiView coverage: saved filters', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('sorts presets, overwrites by name and ignores blank names', async () => {
    renderView(mockClient());
    await screen.findByRole('button', { name: 'Release PBI' });
    const query = screen.getByRole('textbox', { name: 'Filtrar PBIs' });
    const saveAs = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar filtro' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Nome do filtro' }), {
        target: { value: name },
      });
      fireEvent.submit(screen.getByRole('textbox', { name: 'Nome do filtro' }).closest('form')!);
    };
    fireEvent.change(query, { target: { value: 'zeta' } });
    saveAs('Zeta');
    fireEvent.change(query, { target: { value: 'alpha' } });
    saveAs('Alpha');
    const stored = () =>
      JSON.parse(localStorage.getItem('adk:pbi-saved-filters:ws') ?? '[]') as {
        id: string;
        name: string;
        query: string;
      }[];
    expect(stored().map((entry) => entry.name)).toEqual(['Alpha', 'Zeta']);
    const zetaId = stored()[1]!.id;
    fireEvent.change(query, { target: { value: 'zeta 2' } });
    saveAs('zeta');
    expect(stored()).toEqual([
      expect.objectContaining({ name: 'Alpha' }),
      expect.objectContaining({ id: zetaId, name: 'zeta', query: 'zeta 2' }),
    ]);
    // A blank name does nothing; cancel closes the dialog.
    saveAs('   ');
    expect(screen.getByRole('textbox', { name: 'Nome do filtro' })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('textbox', { name: 'Nome do filtro' })).not.toBeInTheDocument();
    // Unknown preset ids are ignored.
    fireEvent.change(screen.getByRole('combobox', { name: 'Filtros salvos' }), {
      target: { value: '' },
    });
    expect((query as HTMLInputElement).value).toBe('zeta 2');
    const setItem = failStorageWrites();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir filtro salvo: zeta' }));
    expect(setItem).toHaveBeenCalled();
    expect(screen.queryByRole('option', { name: 'zeta' })).not.toBeInTheDocument();
  });
});

describe('PbiView coverage: item editor', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders Markdown blocks in descriptions', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      {
        ...root,
        description: [
          '> Quoted text',
          '',
          '```',
          'const x = 1;',
          '```',
          '',
          '---',
          '',
          '1. First step',
          '2. Second step',
          '',
          '- [x] Done item',
          '- [ ] Open item',
          '',
          '| Name | Value |',
          '| --- | --- |',
          '| Alpha | 1 |',
        ].join('\n'),
      },
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const editor = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Descrição' });
    expect(editor.querySelector('blockquote')).toHaveTextContent('Quoted text');
    expect(editor.querySelector('pre code')).toHaveTextContent('const x = 1;');
    expect(editor.querySelector('hr')).not.toBeNull();
    expect(editor.querySelector('ol')?.querySelectorAll('li')).toHaveLength(2);
    expect(editor.querySelector('ul')).toHaveTextContent('☑ Done item');
    expect(editor.querySelector('ul')).toHaveTextContent('☐ Open item');
    expect(editor.querySelector('th')).toHaveTextContent('Name');
    expect(editor.querySelector('td')).toHaveTextContent('Alpha');
  });

  it('sanitizes HTML descriptions and saves the edited description', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      {
        ...root,
        description: [
          '<p class="x" onclick="evil()" style="color: red; position: fixed; background-color: url(x.png)">Safe</p>',
          '<script>alert(1)</script><iframe src="x"></iframe>',
          '<font>Unwrapped</font>',
          '<a href="javascript:alert(1)">Bad link</a>',
          '<a href="https://example.test" title="t">Good link</a>',
          '<a href="relative/page">Relative</a>',
          '<span style="position: absolute">Plain span</span>',
        ].join(''),
      },
    ]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    const editor = within(dialog).getByRole('textbox', { name: 'Descrição' });
    expect(editor.querySelector('script, iframe, font')).toBeNull();
    expect(editor).toHaveTextContent('Unwrapped');
    const paragraph = editor.querySelector('p')!;
    expect(paragraph.getAttribute('style')).toBe('color: red');
    expect(paragraph.hasAttribute('class')).toBe(false);
    expect(paragraph.hasAttribute('onclick')).toBe(false);
    expect(within(editor).getByText('Bad link')).not.toHaveAttribute('href');
    expect(within(editor).getByText('Good link')).toHaveAttribute('href', 'https://example.test');
    expect(within(editor).getByText('Relative')).toHaveAttribute('href', 'relative/page');
    expect(within(editor).getByText('Plain span')).not.toHaveAttribute('style');
    editor.innerHTML = '<p>Edited <img src="x" onerror="evil()"></p>';
    fireEvent.blur(editor);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.updatePbiItem).toHaveBeenCalledWith(
        'root',
        expect.objectContaining({ description: '<p>Edited </p>' }),
      ),
    );
  });

  it('falls back to plain text when DOMParser is unavailable', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      { ...root, description: 'Plain **bold** text' },
      { ...root, id: 'html', title: 'Html PBI', description: '<b>Rich</b> text' },
    ]);
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    vi.stubGlobal('DOMParser', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Release PBI' }));
    let editor = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Descrição' });
    expect(editor.textContent?.replace(/\s+/g, ' ').trim()).toBe('Plain bold text');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Html PBI' }));
    editor = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Descrição' });
    expect(editor.querySelector('b')).toBeNull();
    expect(editor.textContent).toContain('Rich');
  });

  it('edits card type, parent and keeps former assignees selectable', async () => {
    const api = mockClient();
    const grandchild: PbiItem = {
      ...card,
      id: 'grandchild',
      parentId: 'card',
      title: 'Check logs',
    };
    const other: PbiItem = { ...root, id: 'other', title: 'Other PBI', position: 3 };
    api.getPbiItems.mockResolvedValue([
      root,
      { ...card, status: '', sourceData: { adkAssigneeUserId: 'former', type: 'Spike' } },
      grandchild,
      other,
    ]);
    api.getAgents.mockRejectedValue(new Error('HTTP 403'));
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify release' }));
    const dialog = screen.getByRole('dialog');
    expect(
      await within(dialog).findByText('Não foi possível carregar os agentes.'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('former', { selector: 'strong' })).toBeInTheDocument();
    expect(within(dialog).getByText('backlog', { selector: 'strong' })).toBeInTheDocument();
    const assignee = within(dialog).getByLabelText<HTMLSelectElement>('Responsável');
    expect(assignee.value).toBe('former');
    const cardType = within(dialog).getByLabelText<HTMLSelectElement>('Tipo do card');
    expect(cardType.value).toBe('Spike');
    fireEvent.change(cardType, { target: { value: 'Bug' } });
    const parent = within(dialog).getByLabelText<HTMLSelectElement>('Item pai');
    // A card cannot be moved under itself or its own descendants.
    expect(within(parent).queryByRole('option', { name: 'Check logs' })).not.toBeInTheDocument();
    expect(
      within(parent).queryByRole('option', { name: 'Verify release' }),
    ).not.toBeInTheDocument();
    fireEvent.change(parent, { target: { value: '' } });
    expect(parent.value).toBe('');
    fireEvent.change(parent, { target: { value: 'other' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.updatePbiItem).toHaveBeenCalledWith(
        'card',
        expect.objectContaining({
          parentId: 'other',
          description: '<p>Check deployment</p>',
          sourceData: {
            adkPriority: '3',
            adkAgentId: '',
            adkAssigneeUserId: 'former',
            adkCardType: 'Bug',
          },
        }),
      ),
    );
  });

  it('creates a PBI from the menu and a card from a row', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('button', { name: 'Release PBI' });
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Novo PBI/ }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Novo PBI' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Fresh' } });
    const editor = within(dialog).getByRole('textbox', { name: 'Descrição' });
    editor.innerHTML = '   ';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar item' }));
    await waitFor(() =>
      expect(api.createPbiItem).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'pbi', title: 'Fresh', description: '', parentId: null }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    openRowMenu('Release PBI');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Adicionar card' }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Novo card' })).toBeInTheDocument();
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Item pai').value).toBe('root');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the empty card list after syncing an Azure PBI without children', async () => {
    const api = mockClient();
    const linked: PbiItem = { ...root, links: [azureLink] };
    api.getPbiItems.mockResolvedValue([linked]);
    api.syncPbiChildren.mockResolvedValue([linked]);
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    await waitFor(() => expect(api.syncPbiChildren).toHaveBeenCalledWith('root'));
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).queryByText('Sincronizando cards...')).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByText('Nenhum card vinculado a este PBI.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    // The synced PBI is expanded, so the table shows that it has no cards.
    expect(screen.getByText('Nenhum card vinculado a este PBI.')).toBeInTheDocument();
  });

  it('shows card sync errors and retries on the next open', async () => {
    const api = mockClient();
    const linked: PbiItem = { ...root, links: [azureLink] };
    api.getPbiItems.mockResolvedValue([linked]);
    api.syncPbiChildren
      .mockRejectedValueOnce(new Error('Azure offline'))
      .mockRejectedValueOnce('down');
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Release PBI' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Azure offline')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Release PBI' }));
    expect(
      await within(screen.getByRole('dialog')).findByText('Não foi possível sincronizar os cards.'),
    ).toBeInTheDocument();
  });

  it('drops the links panel when the open item disappears after a refresh', async () => {
    const api = mockClient();
    const view = renderView(api, 'ws', 0);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify release' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Nenhum link neste item.')).toBeInTheDocument();
    api.getPbiItems.mockResolvedValue([root]);
    view.rerender(
      <PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" refreshToken={1} />,
    );
    await waitFor(() =>
      expect(within(dialog).queryByRole('region', { name: 'Links' })).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Título').value).toBe('Verify release');
  });

  it('resolves audit values to readable names', async () => {
    const api = mockClient();
    api.getPbiItems.mockResolvedValue([
      root,
      { ...card, sourceData: { adkAssigneeUserId: 'user-1' } },
    ]);
    const event = {
      id: 'evt',
      entityType: 'pbi',
      entityId: 'card',
      action: 'update',
      actorId: null,
      requestId: 'req',
      operation: 'ui',
      occurredAt: '2026-09-30T12:00:00.000Z',
      before: {
        title: 'Before',
        adkAssigneeUserId: '',
        adkAgentId: '',
        parentId: 'missing-parent',
        position: 1,
      },
      after: {
        title: 'After',
        adkAssigneeUserId: 'user-1',
        adkAgentId: 'agent-1',
        parentId: 'root',
        description: '<p>Rich &amp; plain</p>',
      },
    } as const;
    const later = {
      ...event,
      id: 'evt-2',
      before: null,
      after: { title: 'Later', adkAssigneeUserId: 'gone-user', adkAgentId: 'gone-agent' },
    };
    api.getAuditHistory.mockResolvedValue({
      items: [event, later] as unknown as AuditHistoryPage['items'],
      total: 2,
      page: 1,
      totalPages: 1,
    });
    renderView(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify release' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: 'QA Agent' })).toBeInTheDocument(),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Histórico' }));
    await screen.findAllByText('Ver alterações');
    const history = document.querySelector('dialog')!;
    const text = history.textContent ?? '';
    for (const expected of [
      'Sem responsável',
      'Não atribuído',
      'missing-parent',
      'Ana Souza',
      'QA Agent',
      'Release PBI',
      'Rich & plain',
      'gone-user',
      'gone-agent',
    ])
      expect(text).toContain(expected);
  });
});
