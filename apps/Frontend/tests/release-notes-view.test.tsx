import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { ReleaseNotesView } from '../src/features/release-notes/ReleaseNotesView.js';
import { Sidebar } from '../src/components/layout/Sidebar.js';
import type { ReleaseNote } from '../src/features/release-notes/release-note-types.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type {
  EffectiveAccess,
  ModuleAccessMap,
} from '../src/features/workspaces/workspace-types.js';

const accessWith = (modules: ModuleAccessMap): EffectiveAccess => ({
  ...FULL_ACCESS,
  modules: { ...FULL_ACCESS.modules, ...modules },
});

const note: ReleaseNote = {
  id: 'note-1',
  workspaceId: 'ws',
  title: 'Sprint 190',
  version: '1.2.0',
  content: '# Sprint 190\n\n- Filtros salvos',
  agentId: null,
  itemIds: [],
  createdBy: 'user-1',
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
};
const item = (id: string, title: string, type: string, iterationPath: string): PbiItem => ({
  id,
  workspaceId: 'ws',
  parentId: null,
  kind: 'card',
  title,
  description: '',
  status: 'Done',
  position: 1,
  sourceData: { type, iterationPath },
  links: [],
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
});

function mockClient() {
  return {
    getReleaseNotes: vi.fn().mockResolvedValue([note]),
    createReleaseNote: vi.fn().mockResolvedValue({ ...note, id: 'note-2', title: 'Manual' }),
    updateReleaseNote: vi.fn().mockResolvedValue(note),
    deleteReleaseNote: vi.fn().mockResolvedValue(undefined),
    generateReleaseNote: vi.fn().mockResolvedValue({ ...note, id: 'note-3' }),
    exportReleaseNote: vi
      .fn()
      .mockResolvedValue({ blob: new Blob(['%PDF-']), fileName: 'Sprint-190-1.2.0.pdf' }),
    getAuditHistory: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 }),
    getPbiItems: vi
      .fn()
      .mockResolvedValue([
        item('bug', 'Corrige busca lenta', 'Bug', 'Sprint 190'),
        item('task', 'Filtros salvos', 'Task', 'Sprint 190'),
        item('old', 'Item antigo', 'Task', 'Sprint 189'),
      ]),
    getAgents: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Writer' }]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue('Sprint 190'),
  };
}
const menuName = 'Ações da release note: Sprint 190';
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: menuName }));
  return screen.getByRole('menu', { name: menuName });
}
const renderView = (api: ReturnType<typeof mockClient>) =>
  render(<ReleaseNotesView apiClient={api as unknown as ApiClient} workspaceId="ws" />);

describe('ReleaseNotesView', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:release-note');
    URL.revokeObjectURL = vi.fn();
  });

  it('shows history and Markdown, PDF and DOCX exports in each release note menu', async () => {
    const api = mockClient();
    renderView(api);
    expect(await screen.findByRole('heading', { name: 'Sprint 190', level: 2 })).toBeTruthy();
    let menu = openMenu();
    for (const label of ['Histórico', 'Exportar Markdown', 'Exportar PDF', 'Exportar DOCX'])
      expect(
        within(menu).getByRole(label === 'Histórico' ? 'button' : 'menuitem', {
          name: label,
        }),
      ).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Exportar PDF' }));
    await waitFor(() => expect(api.exportReleaseNote).toHaveBeenCalledWith('note-1', 'pdf'));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    menu = openMenu();
    fireEvent.click(within(menu).getByRole('button', { name: 'Histórico' }));
    await waitFor(() =>
      expect(api.getAuditHistory).toHaveBeenCalledWith(
        'release_note',
        1,
        expect.anything(),
        'note-1',
      ),
    );
  });

  it('creates, edits and deletes release notes manually', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    fireEvent.click(screen.getByRole('button', { name: /Nova release note/ }));
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Manual' } });
    fireEvent.change(screen.getByLabelText('Conteúdo (Markdown)'), {
      target: { value: '# Manual' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(api.createReleaseNote).toHaveBeenCalledWith({
        title: 'Manual',
        version: '',
        content: '# Manual',
      }),
    );
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Editar' }));
    expect(screen.getByLabelText<HTMLInputElement>('Título').value).toBe('Sprint 190');
    fireEvent.change(screen.getByLabelText('Versão'), { target: { value: '1.2.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(api.updateReleaseNote).toHaveBeenCalledWith(
        'note-1',
        expect.objectContaining({ version: '1.2.1' }),
      ),
    );

    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Excluir' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(api.deleteReleaseNote).toHaveBeenCalledWith('note-1'));
  });

  it('generates a release note from selected items of the current iteration with an agent', async () => {
    const api = mockClient();
    renderView(api);
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    fireEvent.click(screen.getByRole('button', { name: /Gerar com agente/ }));
    expect(await screen.findByText('Corrige busca lenta')).toBeTruthy();
    expect(screen.queryByText('Item antigo')).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipo' }), { target: { value: 'Bug' } });
    expect(screen.queryByText('Filtros salvos')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Selecionar visíveis' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Tipo' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Filtros salvos/ }));
    expect(screen.getByText('2 selecionado(s)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Título'), { target: { value: 'Release 1.3' } });
    fireEvent.change(screen.getByLabelText('Instruções adicionais (opcional)'), {
      target: { value: 'Público externo' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Gerar release note/ }));
    await waitFor(() =>
      expect(api.generateReleaseNote).toHaveBeenCalledWith({
        title: 'Release 1.3',
        version: undefined,
        agentId: 'agent-1',
        itemIds: ['bug', 'task'],
        instructions: 'Público externo',
      }),
    );
  });

  it('shows viewers only reading and export actions', async () => {
    const api = mockClient();
    render(
      <PermissionsProvider access={accessWith({ releaseNotes: 'view', pbis: 'view' })}>
        <ReleaseNotesView apiClient={api as unknown as ApiClient} workspaceId="ws" isReadOnly />
      </PermissionsProvider>,
    );
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    expect(screen.queryByRole('button', { name: /Nova release note/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Gerar com agente/ })).toBeNull();
    const menu = openMenu();
    expect(within(menu).getByRole('menuitem', { name: 'Exportar Markdown' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Editar' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });

  it('lets editors without delete or PBI access write release notes manually only', async () => {
    const api = mockClient();
    render(
      <PermissionsProvider access={accessWith({ releaseNotes: 'edit', pbis: 'none' })}>
        <ReleaseNotesView apiClient={api as unknown as ApiClient} workspaceId="ws" />
      </PermissionsProvider>,
    );
    await screen.findByRole('heading', { name: 'Sprint 190', level: 2 });
    expect(screen.getByRole('button', { name: /Nova release note/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Gerar com agente/ })).toBeNull();
    const menu = openMenu();
    expect(within(menu).getByRole('menuitem', { name: 'Editar' })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
    expect(api.getPbiItems).not.toHaveBeenCalled();
  });

  it('groups Spec and Release Notes under the Product menu', () => {
    const onSelectTab = vi.fn();
    render(<Sidebar activeTab="brain" onSelectTab={onSelectTab} />);
    const product = screen.getByTestId('sidebar-product-button');
    expect(product.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(product);
    expect(product.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByTestId('sidebar-release-notes-button'));
    expect(onSelectTab).toHaveBeenCalledWith('releaseNotes');
    fireEvent.click(screen.getByTestId('sidebar-spec-button'));
    expect(onSelectTab).toHaveBeenCalledWith('spec');
  });
});
