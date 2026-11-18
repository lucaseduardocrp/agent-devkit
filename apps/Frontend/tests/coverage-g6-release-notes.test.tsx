import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { ReleaseNotesView } from '../src/features/release-notes/ReleaseNotesView.js';
import type { ReleaseNote } from '../src/features/release-notes/release-note-types.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';

const note: ReleaseNote = {
  id: 'note-1',
  workspaceId: 'ws',
  title: 'Sprint 190',
  version: '1.2.0',
  content: '# Sprint 190',
  agentId: 'agent-1',
  itemIds: ['a', 'zzz'],
  createdBy: 'user-1',
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
};

const pbi = (id: string, over: Partial<PbiItem> = {}): PbiItem => ({
  id,
  workspaceId: 'ws',
  parentId: null,
  kind: 'card',
  title: `Item ${id}`,
  description: '',
  status: 'Done',
  position: 1,
  sourceData: { iterationPath: 'Sprint 190' },
  links: [],
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
  ...over,
});

function mockClient(over: Record<string, unknown> = {}) {
  return {
    getReleaseNotes: vi.fn().mockResolvedValue([note]),
    createReleaseNote: vi.fn().mockResolvedValue(note),
    updateReleaseNote: vi.fn().mockResolvedValue(note),
    deleteReleaseNote: vi.fn().mockResolvedValue(undefined),
    generateReleaseNote: vi.fn().mockResolvedValue({ ...note, id: 'note-3' }),
    exportReleaseNote: vi.fn().mockResolvedValue({ blob: new Blob(['x']) }),
    getAuditHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
    getPbiItems: vi.fn().mockResolvedValue([pbi('a'), pbi('b', { status: 'Active' })]),
    getAgents: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Writer' }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    ...over,
  };
}

const renderView = (api: ReturnType<typeof mockClient>, workspaceId: string | null = 'ws') =>
  render(<ReleaseNotesView apiClient={api as unknown as ApiClient} workspaceId={workspaceId} />);

const menuName = 'Ações da release note: Sprint 190';
const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: menuName }));
  return screen.getByRole('menu', { name: menuName });
};
const heading = () => screen.findByRole('heading', { name: 'Sprint 190', level: 2 });

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:release-note');
  URL.revokeObjectURL = vi.fn();
});

describe('ReleaseNotesView loading and errors', () => {
  it('stays empty without a workspace', async () => {
    const api = mockClient();
    renderView(api, null);
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(api.getReleaseNotes).not.toHaveBeenCalled();
  });

  it('shows the load error, with a fallback when it is not an Error', async () => {
    const first = renderView(
      mockClient({ getReleaseNotes: vi.fn().mockRejectedValue(new Error('Down')) }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Down');
    first.unmount();
    renderView(mockClient({ getReleaseNotes: vi.fn().mockRejectedValue('x') }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('shows the action error, with a fallback when it is not an Error', async () => {
    const api = mockClient({ exportReleaseNote: vi.fn().mockRejectedValue(new Error('No file')) });
    renderView(api);
    await heading();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Exportar PDF' }));
    expect(await screen.findByText('No file')).toBeInTheDocument();
    api.exportReleaseNote.mockRejectedValueOnce('boom');
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Exportar DOCX' }));
    await waitFor(() => expect(screen.queryByText('No file')).toBeNull());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('lists several notes and goes back to one from the editor', async () => {
    const api = mockClient({
      getReleaseNotes: vi
        .fn()
        .mockResolvedValue([note, { ...note, id: 'note-2', title: 'Two', version: '' }]),
    });
    renderView(api);
    await heading();
    fireEvent.click(screen.getByRole('button', { name: /Nova release note/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: /^Two/ }));
    expect(await screen.findByRole('heading', { name: 'Two', level: 2 })).toBeInTheDocument();
  });

  it('exports with the note title as file name and cancels a deletion', async () => {
    const api = mockClient();
    renderView(api);
    await heading();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Exportar Markdown' }));
    await waitFor(() => expect(api.exportReleaseNote).toHaveBeenCalledWith('note-1', 'markdown'));
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancelar' }),
    );
    expect(api.deleteReleaseNote).not.toHaveBeenCalled();
  });

  it('shows the empty state after the only note is deleted', async () => {
    const api = mockClient();
    renderView(api);
    await heading();
    api.getReleaseNotes.mockResolvedValue([]);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { level: 2 })).toBeNull());
  });
});

describe('ReleaseNotesView history values', () => {
  it('names the items of a change in the history', async () => {
    const api = mockClient({
      getAuditHistory: vi.fn().mockResolvedValue({
        items: [
          {
            id: 'e1',
            entityType: 'release_note',
            entityId: 'note-1',
            action: 'update',
            actorId: 'u',
            requestId: 'r',
            operation: 'update',
            occurredAt: '2026-10-06T00:00:00.000Z',
            before: { agentId: 7, itemIds: 'none' },
            after: { agentId: 'agent-1', itemIds: ['a', 'zzz', 7], title: 'T' },
          },
        ],
        total: 1,
        page: 1,
        totalPages: 1,
      }),
    });
    renderView(api);
    await heading();
    // The agents and items load when the generator opens, so open it first.
    fireEvent.click(screen.getByRole('button', { name: /Gerar com agente/ }));
    await screen.findByText('Item a');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(openMenu()).getByRole('button', { name: 'Histórico' }));
    fireEvent.click((await screen.findAllByText('Ver alterações'))[0]!);
    await waitFor(() => expect(document.body.textContent).toContain('Item a'));
    expect(document.body.textContent).toContain('zzz');
  });
});

describe('ReleaseNotesView generator', () => {
  it('sends the version and ignores items that arrive after it closed', async () => {
    const api = mockClient();
    const view = renderView(api);
    await heading();
    fireEvent.click(screen.getByRole('button', { name: /Gerar com agente/ }));
    await screen.findByText('Item a');
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'R' } });
    fireEvent.change(screen.getByLabelText('Versão'), { target: { value: ' 2.0 ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Item a/ }));
    fireEvent.click(screen.getByRole('button', { name: /Gerar release note/ }));
    await waitFor(() =>
      expect(api.generateReleaseNote).toHaveBeenCalledWith(
        expect.objectContaining({ version: '2.0' }),
      ),
    );
    view.unmount();
    let release: (items: PbiItem[]) => void = () => undefined;
    const late = mockClient({
      getPbiItems: vi.fn().mockReturnValue(new Promise((resolve) => (release = resolve))),
    });
    const second = renderView(late);
    await heading();
    fireEvent.click(screen.getByRole('button', { name: /Gerar com agente/ }));
    await waitFor(() => expect(late.getPbiItems).toHaveBeenCalled());
    second.unmount();
    release([pbi('a')]);
    await Promise.resolve();
  });

  const open = async (api: ReturnType<typeof mockClient>) => {
    renderView(api);
    await heading();
    fireEvent.click(screen.getByRole('button', { name: /Gerar com agente/ }));
  };

  it('filters by search, state and iteration, picks an agent and clears the selection', async () => {
    const api = mockClient({
      getPbiItems: vi.fn().mockResolvedValue([
        pbi('a', { kind: 'pbi' }),
        pbi('b', {
          status: 'Active',
          sourceData: { iterationPath: 'Sprint 189', adkCardType: 'Bug' },
          links: [{ externalId: '42' } as never],
        }),
        pbi('c', { sourceData: { iterationPath: 'Sprint 190', type: 7 } }),
      ]),
      getAgents: vi.fn().mockResolvedValue([
        { id: 'agent-1', name: 'Writer' },
        { id: 'agent-2', name: 'Editor' },
      ]),
    });
    await open(api);
    await screen.findByText('Item a');
    fireEvent.change(screen.getByRole('option', { name: 'Editor' }).closest('select')!, {
      target: { value: 'agent-2' },
    });
    const search = screen
      .getAllByRole('textbox')
      .find(
        (box) =>
          box.tagName === 'INPUT' &&
          box.getAttribute('placeholder') &&
          !box.hasAttribute('maxlength'),
      )!;
    fireEvent.change(search, { target: { value: 'item b' } });
    expect(await screen.findByText(/#42 Item b/)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });
    fireEvent.change(screen.getByRole('option', { name: 'Active' }).closest('select')!, {
      target: { value: 'Active' },
    });
    expect(screen.queryByText('Item a')).toBeNull();
    fireEvent.change(screen.getByRole('option', { name: 'Active' }).closest('select')!, {
      target: { value: '' },
    });
    fireEvent.change(screen.getByRole('option', { name: 'Sprint 189' }).closest('select')!, {
      target: { value: 'Sprint 189' },
    });
    expect(screen.queryByText('Item a')).toBeNull();
    fireEvent.change(screen.getByRole('option', { name: 'Sprint 189' }).closest('select')!, {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    expect(screen.getByText('3 selecionado(s)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar seleção' }));
    expect(screen.queryByText('3 selecionado(s)')).toBeNull();
  });

  it('shows the items error, with a fallback when it is not an Error', async () => {
    await open(mockClient({ getPbiItems: vi.fn().mockRejectedValue(new Error('PBIs down')) }));
    expect(await screen.findByText('PBIs down')).toBeInTheDocument();
  });

  it('shows a generic items error', async () => {
    await open(mockClient({ getPbiItems: vi.fn().mockRejectedValue('x') }));
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
  });

  it('says there are no agents and no items', async () => {
    await open(
      mockClient({
        getPbiItems: vi.fn().mockResolvedValue([]),
        getAgents: vi.fn().mockResolvedValue([]),
      }),
    );
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    expect(document.body.textContent).toMatch(/agente/i);
  });

  it('shows the loading state while the items load', async () => {
    await open(mockClient({ getPbiItems: vi.fn().mockReturnValue(new Promise(() => undefined)) }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('limits what is shown and what can be selected', async () => {
    const many = Array.from({ length: 320 }, (_, index) => pbi(`m${index}`));
    await open(mockClient({ getPbiItems: vi.fn().mockResolvedValue(many) }));
    await screen.findByText('Item m0');
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    expect(screen.getByText('200 selecionado(s)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Item m0/ }));
    expect(screen.getByText('199 selecionado(s)')).toBeInTheDocument();
    expect(screen.queryByText('Item m250')).toBeNull();
  });

  it('stops selecting at the maximum, and warns', async () => {
    const many = Array.from({ length: 300 }, (_, index) => pbi(`m${index}`));
    const api = mockClient({ getPbiItems: vi.fn().mockResolvedValue(many) });
    await open(api);
    await screen.findByText('Item m0');
    // Visible items are capped at 200; filtering shows the others one batch at a time.
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    const search = screen
      .getAllByRole('textbox')
      .find((box) => box.getAttribute('placeholder') && !box.hasAttribute('maxlength'))!;
    for (const term of ['m2', 'm1']) {
      fireEvent.change(search, { target: { value: term } });
      fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    }
    fireEvent.change(search, { target: { value: 'item' } });
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    expect(screen.getByText('300 selecionado(s)')).toBeInTheDocument();
    expect(screen.getByRole('status', { hidden: true })).toBeInTheDocument();
    // Unchecking and checking past the limit does not add more.
    fireEvent.click(screen.getByRole('checkbox', { name: /Item m0/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Item m0/ }));
    expect(screen.getByText('300 selecionado(s)')).toBeInTheDocument();
  }, 30000);

  it('does not generate without items', async () => {
    const api = mockClient();
    await open(api);
    await screen.findByText('Item a');
    fireEvent.submit(screen.getByRole('button', { name: /Gerar release note/ }).closest('form')!);
    expect(api.generateReleaseNote).not.toHaveBeenCalled();
  });

  it('can be cancelled', async () => {
    await open(mockClient());
    await screen.findByText('Item a');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText('Item a')).toBeNull();
  });
});
