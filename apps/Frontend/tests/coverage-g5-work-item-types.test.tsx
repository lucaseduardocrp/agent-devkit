import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkItemTypesPanel } from '../src/features/work-item-types/WorkItemTypesPanel.js';
import {
  WorkItemTypeBadge,
  defaultWorkItemTypes,
  resolveTypePalette,
  resolveWorkItemType,
  useWorkItemTypes,
  workItemTypePalette,
  type WorkItemType,
} from '../src/features/work-item-types/work-item-types.js';
import { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const type = (patch: Partial<WorkItemType>): WorkItemType => ({
  key: 'k',
  label: 'Label',
  color: 'red',
  icon: 'bug',
  aliases: [],
  ...patch,
});

describe('resolveTypePalette', () => {
  it('uses palette tokens, custom hex colors and the slate fallback', () => {
    expect(resolveTypePalette('red')).toBe(workItemTypePalette.red);
    expect(resolveTypePalette('#12ab34').style).toEqual({ '--wit': '#12ab34' });
    expect(resolveTypePalette('not-a-color')).toBe(workItemTypePalette.slate);
    expect(resolveTypePalette(undefined)).toBe(workItemTypePalette.slate);
  });
});

describe('resolveWorkItemType', () => {
  const types = [
    type({ key: 'bug', label: 'Bug' }),
    type({ key: 'task', label: 'Task', aliases: ['Tarefa'] }),
    type({ key: 'plan', label: 'Plano de teste' }),
  ];

  it('matches by key, label, alias and label prefix, ignoring case', () => {
    expect(resolveWorkItemType(types, 'bug')?.key).toBe('bug');
    expect(resolveWorkItemType(types, ' TASK ')?.key).toBe('task');
    expect(resolveWorkItemType(types, 'tarefa')?.key).toBe('task');
    expect(resolveWorkItemType(types, 'Plano de Teste - Sprint 3')?.key).toBe('plan');
    expect(resolveWorkItemType(types, 'unknown')).toBeUndefined();
    expect(resolveWorkItemType(types, '   ')).toBeUndefined();
  });
});

describe('useWorkItemTypes', () => {
  it('keeps the defaults without a workspace and when loading fails', async () => {
    const getWorkItemTypes = vi.fn().mockRejectedValue(new Error('down'));
    const idle = renderHook(() => useWorkItemTypes({ getWorkItemTypes }, null));
    expect(idle.result.current).toBe(defaultWorkItemTypes);
    expect(getWorkItemTypes).not.toHaveBeenCalled();

    const failing = renderHook(() => useWorkItemTypes({ getWorkItemTypes }, 'ws'));
    await waitFor(() => expect(getWorkItemTypes).toHaveBeenCalled());
    expect(failing.result.current).toBe(defaultWorkItemTypes);
  });

  it('loads the workspace types and reloads on refresh', async () => {
    const loaded = [type({ key: 'x', label: 'X' })];
    const getWorkItemTypes = vi.fn().mockResolvedValue(loaded);
    const { result, rerender } = renderHook(
      ({ token }) => useWorkItemTypes({ getWorkItemTypes }, 'ws', token),
      { initialProps: { token: 1 } },
    );
    await waitFor(() => expect(result.current).toBe(loaded));
    rerender({ token: 2 });
    await waitFor(() => expect(getWorkItemTypes).toHaveBeenCalledTimes(2));
  });

  it('ignores the answer after unmounting', async () => {
    let resolve: (list: WorkItemType[]) => void = () => {};
    const getWorkItemTypes = vi.fn(() => new Promise<WorkItemType[]>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useWorkItemTypes({ getWorkItemTypes }, 'ws'));
    await waitFor(() => expect(getWorkItemTypes).toHaveBeenCalled());
    unmount();
    resolve([type({})]);
    await Promise.resolve();
    expect(result.current).toBe(defaultWorkItemTypes);
  });
});

describe('WorkItemTypeBadge', () => {
  it('renders nothing for an untyped item', () => {
    const { container } = render(<WorkItemTypeBadge name="  " types={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the configured label and icon', () => {
    render(
      <WorkItemTypeBadge
        name="bug"
        types={[type({ key: 'bug', label: 'Defect', icon: 'flame', color: '#aabbcc' })]}
        className="extra"
      />,
    );
    const badge = screen.getByTitle('bug');
    expect(badge.textContent).toBe('Defect');
    expect(badge.className).toContain('extra');
    expect(badge.style.getPropertyValue('--wit')).toBe('#aabbcc');
    expect(badge.querySelector('.ti-flame')).not.toBeNull();
  });

  it('falls back to the raw name and the fallback icon for unknown types', () => {
    const { rerender } = render(<WorkItemTypeBadge name="Mystery" types={[]} />);
    expect(screen.getByText('Mystery')).toBeTruthy();
    expect(document.querySelector('.ti-file-description')).not.toBeNull();
    rerender(<WorkItemTypeBadge name="Mystery" types={[]} fallbackIcon="star" />);
    expect(document.querySelector('.ti-star')).not.toBeNull();
  });
});

describe('WorkItemTypesPanel', () => {
  const stored = [
    type({ key: 'bug', label: 'Bug', color: 'red', icon: 'bug', aliases: ['defeito', 'falha'] }),
    type({ key: 'custom', label: 'Custom', color: '#336699', icon: 'flame', aliases: [] }),
  ];

  function setup(
    options: { canEdit?: boolean; list?: WorkItemType[] | Error; onSaved?: () => void } = {},
  ) {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    const { list = stored } = options;
    vi.spyOn(client, 'getWorkItemTypes').mockImplementation(() =>
      list instanceof Error ? Promise.reject(list) : Promise.resolve(list),
    );
    const save = vi
      .spyOn(client, 'saveWorkItemTypes')
      .mockImplementation((types) => Promise.resolve([...types]));
    const view = render(
      <WorkItemTypesPanel
        apiClient={client}
        canEdit={options.canEdit ?? true}
        onSaved={options.onSaved}
      />,
    );
    return { client, save, view };
  }

  it('shows a skeleton while loading and then the editable list', async () => {
    const { view } = setup();
    expect(view.getByTestId('work-item-types-loading')).toBeTruthy();
    expect(await view.findByTestId('work-item-types-panel')).toBeTruthy();
    expect(view.getAllByRole('listitem')).toHaveLength(2);
    expect(
      (view.getAllByLabelText('Apelidos (separados por vírgula)')[0] as HTMLInputElement).value,
    ).toBe('defeito, falha');
  });

  it('reports a load failure', async () => {
    const { view } = setup({ list: new Error('x') });
    expect((await view.findByRole('alert')).textContent).toBe(
      'Não foi possível carregar os tipos.',
    );
  });

  it('ignores the load result after unmounting', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    let resolve: (list: WorkItemType[]) => void = () => {};
    let reject: (reason: Error) => void = () => {};
    const spy = vi
      .spyOn(client, 'getWorkItemTypes')
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockImplementationOnce(() => new Promise((_, f) => (reject = f)));
    const first = render(<WorkItemTypesPanel apiClient={client} canEdit />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    first.unmount();
    resolve(stored);
    const second = render(<WorkItemTypesPanel apiClient={client} canEdit />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    second.unmount();
    reject(new Error('late'));
    await Promise.resolve();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('edits names, keys, aliases and colors and saves the result', async () => {
    const onSaved = vi.fn();
    const { save, view } = setup({ onSaved });
    await view.findByTestId('work-item-types-panel');

    const names = view.getAllByLabelText('Nome') as HTMLInputElement[];
    const keys = view.getAllByLabelText('Chave') as HTMLInputElement[];
    fireEvent.change(names[0]!, { target: { value: 'Defeito' } });
    fireEvent.change(keys[0]!, { target: { value: 'Défeito Grave!' } });
    fireEvent.change(view.getAllByLabelText('Apelidos (separados por vírgula)')[0]!, {
      target: { value: ' a , ,b ' },
    });
    fireEvent.click(view.getAllByRole('radio', { name: 'blue' })[0]!);
    fireEvent.change(view.getAllByLabelText('Cor personalizada')[0]!, {
      target: { value: '#112233' },
    });
    expect((view.getAllByLabelText('Cor personalizada')[0] as HTMLInputElement).value).toBe(
      '#112233',
    );
    expect(
      (view.getAllByLabelText('Cor personalizada')[0]!.parentElement as HTMLElement).style
        .backgroundColor,
    ).not.toBe('');

    fireEvent.click(view.getByRole('button', { name: 'Salvar tipos' }));
    expect((await view.findByRole('status')).textContent).toBe('Tipos salvos.');
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({
        key: 'defeito-grave',
        label: 'Defeito',
        color: '#112233',
        aliases: ['a', 'b'],
      }),
      expect.objectContaining({ key: 'custom', aliases: [] }),
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('saves without an onSaved callback and derives a key from the name', async () => {
    const { save, view } = setup({ list: [] });
    await view.findByTestId('work-item-types-panel');
    fireEvent.click(view.getByRole('button', { name: /Adicionar tipo/ }));
    expect(view.getByRole('button', { name: 'Ícone: file-description' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Salvar tipos/ }));
    await view.findByText('Tipos salvos.');
    expect(save).toHaveBeenCalledWith([
      expect.objectContaining({ key: 'novo-tipo', label: 'Novo tipo', color: 'slate' }),
    ]);
  });

  it('reports save failures with the error message or the default text', async () => {
    const { client, save, view } = setup();
    await view.findByTestId('work-item-types-panel');
    save.mockRejectedValueOnce(new Error('Chave duplicada'));
    fireEvent.click(view.getByRole('button', { name: /Salvar tipos/ }));
    expect((await view.findByRole('alert')).textContent).toBe('Chave duplicada');

    save.mockRejectedValueOnce('nope');
    fireEvent.click(view.getByRole('button', { name: /Salvar tipos/ }));
    await waitFor(() =>
      expect(view.getByRole('alert').textContent).toBe('Não foi possível salvar os tipos.'),
    );
    expect(client.saveWorkItemTypes).toHaveBeenCalledTimes(2);
  });

  it('removes types, restores the defaults and clears notices', async () => {
    const { view } = setup();
    await view.findByTestId('work-item-types-panel');
    fireEvent.click(view.getByRole('button', { name: /Salvar tipos/ }));
    await view.findByText('Tipos salvos.');

    fireEvent.click(view.getByRole('button', { name: 'Remover tipo: Bug' }));
    expect(view.queryByText('Tipos salvos.')).toBeNull();
    expect(view.getAllByRole('listitem')).toHaveLength(1);

    fireEvent.click(view.getByRole('button', { name: 'Restaurar padrão' }));
    expect(view.getAllByRole('listitem')).toHaveLength(defaultWorkItemTypes.length);
  });

  it('is read-only without edit permission', async () => {
    const { view } = setup({ canEdit: false });
    await view.findByTestId('work-item-types-panel');
    expect(view.queryByRole('button', { name: /Salvar tipos/ })).toBeNull();
    expect(view.queryByRole('button', { name: /Remover tipo/ })).toBeNull();
    expect((view.getAllByLabelText('Nome')[0] as HTMLInputElement).disabled).toBe(true);
    expect((view.getAllByLabelText('Cor personalizada')[0] as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it('picks an icon from the searchable dialog', { timeout: 30000 }, async () => {
    const { view } = setup();
    await view.findByTestId('work-item-types-panel');

    fireEvent.click(view.getByRole('button', { name: 'Ícone: bug' }));
    const dialog = view.getByRole('dialog');
    const current = within(dialog).getByRole('button', { name: 'bug' });
    expect(current.className).toContain('ring-[var(--border-accent)]');
    expect(within(dialog).getByRole('button', { name: 'flame' }).className).not.toContain(
      'ring-[var(--border-accent)]',
    );

    fireEvent.change(within(dialog).getByLabelText('Pesquisar ícones'), {
      target: { value: 'zzzz-nothing' },
    });
    expect(within(dialog).getByText('Nenhum ícone encontrado.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Pesquisar ícones'), {
      target: { value: ' ROCKET ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'rocket' }));
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('button', { name: 'Ícone: rocket' })).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Ícone: rocket' }));
    fireEvent.click(view.getByRole('button', { name: 'Fechar' }));
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('renders the English copy', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    vi.spyOn(client, 'getWorkItemTypes').mockResolvedValue(stored);
    render(
      <I18nProvider initialLocale="en-US">
        <WorkItemTypesPanel apiClient={client} canEdit />
      </I18nProvider>,
    );
    expect(await screen.findByText('Work item types')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Save types/ })).toBeTruthy();
  });
});

describe('WorkItemTypesPanel dialog and preview', () => {
  it('previews by key when the name is empty and closes the icon dialog with Escape', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    vi.spyOn(client, 'getWorkItemTypes').mockResolvedValue([
      type({ key: 'only-key', label: '', icon: 'bug' }),
    ]);
    render(<WorkItemTypesPanel apiClient={client} canEdit />);
    await screen.findByTestId('work-item-types-panel');
    expect(screen.getByTitle('only-key')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ícone: bug' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
