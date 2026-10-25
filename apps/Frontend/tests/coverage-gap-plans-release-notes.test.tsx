import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { ReleaseNotesView } from '../src/features/release-notes/ReleaseNotesView.js';
import type { ReleaseNote } from '../src/features/release-notes/release-note-types.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';

const note = (overrides: Partial<ReleaseNote> = {}): ReleaseNote => ({
  id: 'note-1',
  workspaceId: 'ws',
  title: 'Sprint 190',
  version: '',
  content: '# Sprint 190',
  agentId: null,
  itemIds: [],
  createdBy: 'user-1',
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
  ...overrides,
});
const item = (id: string, overrides: Partial<PbiItem> = {}): PbiItem => ({
  id,
  workspaceId: 'ws',
  parentId: null,
  kind: 'card',
  title: `Item ${id}`,
  description: '',
  status: 'Done',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
  ...overrides,
});

function mockClient(notes: ReleaseNote[] = [note()]) {
  return {
    getReleaseNotes: vi.fn().mockResolvedValue(notes),
    createReleaseNote: vi.fn(),
    updateReleaseNote: vi.fn(),
    deleteReleaseNote: vi.fn().mockResolvedValue(undefined),
    generateReleaseNote: vi.fn(),
    exportReleaseNote: vi.fn().mockResolvedValue({ blob: new Blob(['# x']) }),
    getAuditHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
    getPbiItems: vi.fn().mockResolvedValue([]),
    getAgents: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Writer' }]),
    getPbiCurrentIteration: vi.fn().mockRejectedValue(new Error('no iteration')),
  };
}
type Api = ReturnType<typeof mockClient>;
const renderView = (api: Api, workspaceId: string | null = 'ws') =>
  render(<ReleaseNotesView apiClient={api as unknown as ApiClient} workspaceId={workspaceId} />);
const openMenu = (title = 'Sprint 190') => {
  fireEvent.click(screen.getByRole('button', { name: `Ações da release note: ${title}` }));
  return screen.getByRole('menu', { name: `Ações da release note: ${title}` });
};
const openGenerator = () =>
  fireEvent.click(screen.getByRole('button', { name: /Gerar com agente/ }));

describe('ReleaseNotesView coverage gaps', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
  });

  it('shows the empty state without a workspace and does not call the API', async () => {
    const api = mockClient();
    renderView(api, null);
    expect(await screen.findByText(/Nenhuma release note/)).toBeTruthy();
    expect(api.getReleaseNotes).not.toHaveBeenCalled();
    expect(screen.getByText(/Selecione uma release note/)).toBeTruthy();
  });

  it('falls back to generic messages for non-Error load and action failures', async () => {
    const api = mockClient();
    api.getReleaseNotes.mockRejectedValueOnce('boom');
    renderView(api);
    expect((await screen.findByRole('alert')).textContent).toMatch(/release notes/i);

    const failing = mockClient();
    failing.exportReleaseNote.mockRejectedValue('nope');
    renderView(failing);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Exportar Markdown' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(1));
  });

  it('downloads exports with a default file name and shows note metadata', async () => {
    const api = mockClient([note({ version: '2.0', itemIds: ['a', 'b'] })]);
    renderView(api);
    expect(await screen.findByText('Baseada em 2 item(ns)')).toBeTruthy();
    expect(screen.getByText('Versão 2.0')).toBeTruthy();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Exportar Markdown' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('Sprint 190.md');
    click.mockRestore();
  });

  it('cancels deletion, deletes a non-selected note and cancels manual editing', async () => {
    const api = mockClient([note(), note({ id: 'note-2', title: 'Sprint 191' })]);
    renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    fireEvent.click(within(openMenu('Sprint 191')).getByRole('menuitem', { name: 'Excluir' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Sprint 191');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(within(openMenu('Sprint 191')).getByRole('menuitem', { name: 'Excluir' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(api.deleteReleaseNote).toHaveBeenCalledWith('note-2'));
    expect(screen.getByRole('heading', { name: 'Sprint 190', level: 2 })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Sprint 191/ }));
    fireEvent.click(screen.getByRole('button', { name: /Nova release note/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('reports item loading errors with and without an Error instance', async () => {
    const api = mockClient();
    api.getPbiItems.mockRejectedValueOnce(new Error('items down'));
    const { unmount } = renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    openGenerator();
    expect(await screen.findByText('items down')).toBeTruthy();
    unmount();

    const other = mockClient();
    other.getPbiItems.mockRejectedValueOnce('down');
    renderView(other);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    openGenerator();
    expect(await screen.findByText(/Não foi possível carregar os itens/)).toBeTruthy();
  });

  it('ignores item responses that arrive after the generator closes', async () => {
    const api = mockClient();
    let resolveItems: (value: PbiItem[]) => void = () => undefined;
    let rejectItems: (reason: unknown) => void = () => undefined;
    api.getPbiItems
      .mockReturnValueOnce(new Promise((resolve) => (resolveItems = resolve)))
      .mockReturnValueOnce(new Promise((_, reject) => (rejectItems = reject)));
    renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    openGenerator();
    expect(screen.getByText('Carregando itens...')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    resolveItems([item('late')]);
    openGenerator();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    rejectItems(new Error('late failure'));
    await Promise.resolve();
    openGenerator();
    await waitFor(() => expect(api.getPbiItems).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('late failure')).toBeNull();
  });

  it('filters, labels and limits items and resolves item titles in history', async () => {
    const many = Array.from({ length: 305 }, (_, i) =>
      item(`bulk-${i}`, { sourceData: { iterationPath: i < 150 ? 'Sprint 9' : 'Sprint 10' } }),
    );
    const api = mockClient();
    api.getAgents.mockResolvedValue([]);
    api.getPbiItems.mockResolvedValue([
      item('pbi', { kind: 'pbi', title: 'Epic work', status: '', links: [] }),
      item('typed', {
        title: 'Typed card',
        status: 'Active',
        sourceData: { adkCardType: 'Feature', iterationPath: 'Sprint 8' },
        links: [{ externalId: '42' } as PbiItem['links'][number]],
      }),
      ...many,
    ]);
    api.getAuditHistory.mockResolvedValue({
      items: [
        {
          id: 'ev',
          entityType: 'release_note',
          entityId: 'note-1',
          action: 'update',
          actorId: null,
          requestId: 'r',
          operation: 'web',
          occurredAt: '2026-10-06T00:00:00.000Z',
          before: null,
          after: { title: 'Sprint 190', itemIds: ['typed', 'gone', 7] },
        },
      ],
      total: 1,
      page: 1,
      totalPages: 1,
    });
    renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    openGenerator();
    expect(await screen.findByText(/Crie um agente em Agents/)).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /PBI\s*Epic work/ })).toBeTruthy();
    expect(screen.getByText('#42 Typed card')).toBeTruthy();
    expect(screen.getByText(/Exibindo os primeiros 200/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Versão'), { target: { value: '3.0' } });
    expect(screen.getByLabelText<HTMLInputElement>('Versão').value).toBe('3.0');
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado' }), {
      target: { value: 'Active' },
    });
    expect(screen.getByText('#42 Typed card')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Estado' }), { target: { value: '' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), {
      target: { value: 'Sprint 8' },
    });
    expect(screen.queryByText('Epic work')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar por título ou ID' }), {
      target: { value: 'nada disso' },
    });
    expect(await screen.findByText('Nenhum item corresponde aos filtros.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar por título ou ID' }), {
      target: { value: '' },
    });
    await screen.findByText('#42 Typed card');

    fireEvent.click(screen.getByRole('checkbox', { name: /Epic work/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Epic work/ }));
    for (const iteration of ['Sprint 9', 'Sprint 10']) {
      fireEvent.change(screen.getByRole('combobox', { name: 'Iteração' }), {
        target: { value: iteration },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    }
    expect(screen.getByText('300 selecionado(s)')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/300/);
    const unchecked = screen
      .getAllByRole<HTMLInputElement>('checkbox')
      .find((box) => !box.checked) as HTMLInputElement;
    fireEvent.click(unchecked);
    expect(screen.getByText('300 selecionado(s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar seleção' }));
    expect(screen.getByText('0 selecionado(s)')).toBeTruthy();

    fireEvent.click(within(openMenu()).getByRole('button', { name: 'Histórico' }));
    fireEvent.click(await screen.findByText('Ver alterações'));
    expect(await screen.findByText(/Typed card\s+gone/)).toBeTruthy();
  }, 30_000);

  it('keeps a chosen agent, edits instructions and refuses to submit without items', async () => {
    const api = mockClient();
    api.getAgents.mockResolvedValue([
      { id: 'agent-1', name: 'Writer' },
      { id: 'agent-2', name: 'Editor' },
    ]);
    api.getPbiItems.mockResolvedValue([item('a')]);
    renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    openGenerator();
    await screen.findByText('Item a');
    fireEvent.change(screen.getByRole('combobox', { name: 'Agente' }), {
      target: { value: 'agent-2' },
    });
    fireEvent.change(screen.getByLabelText('Instruções adicionais (opcional)'), {
      target: { value: 'curto' },
    });
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'R' } });
    fireEvent.submit(screen.getByLabelText('Título').closest('form') as HTMLFormElement);
    expect(api.generateReleaseNote).not.toHaveBeenCalled();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Agente' }).value).toBe(
      'agent-2',
    );
  });

  it('shows Error messages from loading and actions and generates without instructions', async () => {
    const broken = mockClient();
    broken.getReleaseNotes.mockRejectedValueOnce(new Error('list down'));
    const { unmount } = renderView(broken);
    expect(await screen.findByText('list down')).toBeTruthy();
    unmount();

    const api = mockClient([]);
    api.getPbiItems.mockResolvedValue([item('a')]);
    api.generateReleaseNote.mockRejectedValue(new Error('agent failed'));
    renderView(api);
    expect(await screen.findByText('Nenhuma release note ainda.')).toBeTruthy();
    openGenerator();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Item a/ }));
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'R2' } });
    fireEvent.change(screen.getByLabelText('Versão'), { target: { value: ' 2.1 ' } });
    fireEvent.click(screen.getByRole('button', { name: /Gerar release note/ }));
    await waitFor(() =>
      expect(api.generateReleaseNote).toHaveBeenCalledWith({
        title: 'R2',
        version: '2.1',
        agentId: 'agent-1',
        itemIds: ['a'],
        instructions: undefined,
      }),
    );
    expect(await screen.findByText('agent failed')).toBeTruthy();
  });
});
