import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';
import { WorkItemTypesPanel } from '../src/features/work-item-types/WorkItemTypesPanel.js';
import {
  defaultWorkItemTypes,
  resolveTypePalette,
  resolveWorkItemType,
  useWorkItemTypes,
  WorkItemTypeBadge,
  type WorkItemType,
} from '../src/features/work-item-types/work-item-types.js';

afterEach(() => vi.restoreAllMocks());

const TYPES: WorkItemType[] = [
  { key: 'bug', label: 'Bug', color: 'red', icon: 'bug', aliases: ['defeito', 'erro'] },
  { key: '', label: 'Épico Ágil', color: '#112233', icon: 'flag', aliases: [] },
];

function setup(canEdit = true, onSaved?: (types: readonly WorkItemType[]) => void) {
  const api = new ApiClient();
  vi.spyOn(api, 'getWorkItemTypes').mockResolvedValue(TYPES);
  const save = vi.spyOn(api, 'saveWorkItemTypes');
  render(<WorkItemTypesPanel apiClient={api} canEdit={canEdit} onSaved={onSaved} />);
  return { api, save };
}

describe('WorkItemTypesPanel', () => {
  it('shows the loading skeleton and then the loaded types', async () => {
    setup();
    expect(screen.getByTestId('work-item-types-loading')).toBeTruthy();
    expect(await screen.findByTestId('work-item-types-panel')).toBeTruthy();
    expect(screen.getAllByLabelText('Nome')).toHaveLength(2);
  });

  it('shows an error when loading fails', async () => {
    const api = new ApiClient();
    vi.spyOn(api, 'getWorkItemTypes').mockRejectedValue(new Error('x'));
    render(<WorkItemTypesPanel apiClient={api} canEdit />);
    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível carregar');
  });

  it('ignores results that arrive after unmount', async () => {
    const api = new ApiClient();
    let resolve: (list: readonly WorkItemType[]) => void = () => undefined;
    vi.spyOn(api, 'getWorkItemTypes').mockReturnValue(new Promise((r) => (resolve = r)));
    const view = render(<WorkItemTypesPanel apiClient={api} canEdit />);
    view.unmount();
    resolve(TYPES);
    await Promise.resolve();
    const api2 = new ApiClient();
    vi.spyOn(api2, 'getWorkItemTypes').mockRejectedValue(new Error('x'));
    const view2 = render(<WorkItemTypesPanel apiClient={api2} canEdit />);
    view2.unmount();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('hides editing controls and disables fields without permission', async () => {
    setup(false);
    await screen.findByTestId('work-item-types-panel');
    expect(screen.queryByText(/Adicionar tipo/)).toBeNull();
    expect(screen.queryByLabelText(/Remover tipo/)).toBeNull();
    expect((screen.getAllByLabelText('Nome')[0] as HTMLInputElement).disabled).toBe(true);
  });

  it('edits fields, colors and saves with derived keys and parsed aliases', async () => {
    const onSaved = vi.fn();
    const { save } = setup(true, onSaved);
    save.mockImplementation(async (types) => types);
    await screen.findByTestId('work-item-types-panel');
    const names = screen.getAllByLabelText('Nome');
    fireEvent.change(names[0]!, { target: { value: 'Falha' } });
    const keys = screen.getAllByLabelText('Chave');
    fireEvent.change(keys[0]!, { target: { value: 'Minha Chave Ç' } });
    const aliases = screen.getAllByLabelText(/Apelidos/);
    fireEvent.change(aliases[0]!, { target: { value: ' a, ,b ' } });
    fireEvent.click(screen.getAllByLabelText('sky')[0]!);
    const custom = screen.getAllByLabelText('Cor personalizada');
    fireEvent.change(custom[0]!, { target: { value: '#abcdef' } });
    fireEvent.change(custom[1]!, { target: { value: '#445566' } });
    fireEvent.click(screen.getByText(/Salvar tipos/));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith([
      { key: 'minha-chave-c', label: 'Falha', color: '#abcdef', icon: 'bug', aliases: ['a', 'b'] },
      { key: 'epico-agil', label: 'Épico Ágil', color: '#445566', icon: 'flag', aliases: [] },
    ]);
    expect(screen.getByText('Tipos salvos.')).toBeTruthy();
  });

  it('saves without an onSaved callback', async () => {
    const { save } = setup();
    save.mockImplementation(async (types) => types);
    await screen.findByTestId('work-item-types-panel');
    fireEvent.click(screen.getByText(/Salvar tipos/));
    await screen.findByText('Tipos salvos.');
  });

  it('shows the error message or the fallback when saving fails', async () => {
    const { save } = setup();
    save.mockRejectedValueOnce(new Error('Falhou feio'));
    await screen.findByTestId('work-item-types-panel');
    fireEvent.click(screen.getByText(/Salvar tipos/));
    expect((await screen.findByRole('alert')).textContent).toBe('Falhou feio');
    save.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByText(/Salvar tipos/));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Não foi possível salvar os tipos.'),
    );
  });

  it('adds, removes and restores defaults', async () => {
    setup();
    await screen.findByTestId('work-item-types-panel');
    fireEvent.click(screen.getByText(/Adicionar tipo/));
    expect(screen.getAllByLabelText('Nome')).toHaveLength(3);
    expect((screen.getAllByLabelText('Nome')[2] as HTMLInputElement).value).toBe('Novo tipo');
    fireEvent.click(screen.getByLabelText('Remover tipo: Bug'));
    expect(screen.getAllByLabelText('Nome')).toHaveLength(2);
    fireEvent.click(screen.getByText('Restaurar padrão'));
    expect(screen.getAllByLabelText('Nome')).toHaveLength(defaultWorkItemTypes.length);
  });

  it('picks an icon through the searchable picker', async () => {
    setup();
    await screen.findByTestId('work-item-types-panel');
    fireEvent.click(screen.getByLabelText('Ícone: bug'));
    const search = screen.getByLabelText('Pesquisar ícones');
    fireEvent.change(search, { target: { value: 'zzzz-no-such-icon' } });
    expect(screen.getByText('Nenhum ícone encontrado.')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'flag' } });
    fireEvent.click(screen.getAllByLabelText('flag')[0]!);
    expect(screen.getAllByLabelText('Ícone: flag')).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText(/^Ícone: /)[1]!);
    fireEvent.change(screen.getByLabelText('Pesquisar ícones'), { target: { value: 'flag' } });
    fireEvent.click(screen.getAllByLabelText('Fechar')[0]!);
    await waitFor(() => expect(screen.queryByLabelText('Pesquisar ícones')).toBeNull());
    fireEvent.click(screen.getAllByLabelText('Ícone: flag')[0]!);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Pesquisar ícones')).toBeNull());
  });
});

describe('resolveTypePalette', () => {
  it('falls back to slate for unknown or missing colors', () => {
    expect(resolveTypePalette(undefined).swatch).toBe('bg-slate-500');
    expect(resolveTypePalette('nope').swatch).toBe('bg-slate-500');
    expect(resolveTypePalette('red').swatch).toBe('bg-red-500');
    expect(resolveTypePalette('#123456').style).toBeTruthy();
  });
});

describe('work item type helpers', () => {
  it('resolves by key, label, alias and label prefix', () => {
    expect(resolveWorkItemType(defaultWorkItemTypes, '  ')).toBeUndefined();
    expect(resolveWorkItemType(defaultWorkItemTypes, 'BUG')?.key).toBe('bug');
    expect(resolveWorkItemType(defaultWorkItemTypes, 'Tarefa')?.key).toBe('task');
    expect(resolveWorkItemType(defaultWorkItemTypes, 'Plano de Teste - Sprint 3')?.key).toBe(
      'plano-de-teste',
    );
    expect(resolveWorkItemType(defaultWorkItemTypes, 'desconhecido')).toBeUndefined();
  });

  it('renders badges for known, unknown and empty names', () => {
    const view = render(<WorkItemTypeBadge name="  " types={TYPES} />);
    expect(view.container.innerHTML).toBe('');
    view.rerender(<WorkItemTypeBadge name="Bug" types={TYPES} />);
    expect(view.container.querySelector('.ti-bug')).toBeTruthy();
    view.rerender(<WorkItemTypeBadge name="Outro" types={TYPES} fallbackIcon="star" />);
    expect(view.container.querySelector('.ti-star')).toBeTruthy();
    expect(view.container.textContent).toBe('Outro');
    view.rerender(<WorkItemTypeBadge name="Outro" types={TYPES} />);
    expect(view.container.querySelector('.ti-file-description')).toBeTruthy();
  });

  it('keeps the preview empty-label fallback to the key', async () => {
    setup();
    await screen.findByTestId('work-item-types-panel');
    fireEvent.change(screen.getAllByLabelText('Nome')[0]!, { target: { value: '' } });
    expect(screen.getAllByTitle('bug').length).toBeGreaterThan(0);
  });
});

describe('useWorkItemTypes', () => {
  it('keeps defaults without workspace, loads types and ignores failures', async () => {
    const api = new ApiClient();
    const spy = vi.spyOn(api, 'getWorkItemTypes').mockResolvedValue(TYPES);
    const none = renderHook(() => useWorkItemTypes(api, null));
    expect(none.result.current).toBe(defaultWorkItemTypes);
    expect(spy).not.toHaveBeenCalled();
    const ok = renderHook(() => useWorkItemTypes(api, 'ws'));
    await waitFor(() => expect(ok.result.current).toBe(TYPES));
    spy.mockRejectedValue(new Error('x'));
    const bad = renderHook(() => useWorkItemTypes(api, 'ws', 1));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(bad.result.current).toBe(defaultWorkItemTypes);
    let resolve: (list: readonly WorkItemType[]) => void = () => undefined;
    spy.mockReturnValue(new Promise((r) => (resolve = r)));
    const late = renderHook(() => useWorkItemTypes(api, 'ws', 2));
    late.unmount();
    resolve(TYPES);
    await Promise.resolve();
    await Promise.resolve();
  });
});
