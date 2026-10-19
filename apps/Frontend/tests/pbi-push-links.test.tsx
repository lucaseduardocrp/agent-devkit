import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiPushDialog } from '../src/features/pbi/PbiPushDialog.js';
import { PbiLinks } from '../src/features/pbi/PbiLinks.js';
import type { PbiItem, PbiPushContract, PbiRelation } from '../src/features/pbi/pbi-types.js';

const item: PbiItem = {
  id: 'item-1',
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: 'Teste 01 - Create',
  description: '',
  status: 'Active',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};
const other: PbiItem = {
  ...item,
  id: 'item-2',
  title: 'Integração de pagamentos',
  links: [
    {
      id: 'l',
      providerId: 'azure_devops',
      externalId: '50493',
      externalUrl: null,
      boardId: null,
      syncedAt: '2026-10-07T00:00:00.000Z',
    },
  ],
};
const third: PbiItem = { ...item, id: 'item-3', title: 'Relatório mensal' };

function azureContract(values: Record<string, string> = {}): PbiPushContract {
  const type = values.workItemType ?? 'Task';
  return {
    providerId: 'azure_devops',
    update: false,
    fields: [
      {
        key: 'workItemType',
        label: 'Work item type',
        required: true,
        options: [
          { value: 'Task', label: 'Task' },
          { value: 'Bug', label: 'Bug' },
        ],
        value: type,
        status: 'resolved',
        reloadOnChange: true,
      },
      {
        key: 'iterationPath',
        label: 'Iteration path',
        required: true,
        options: [{ value: 'proj\\Sprint 1', label: 'proj\\Sprint 1', detail: 'current' }],
        value: '',
        status: 'empty',
      },
      {
        key: 'assignee',
        label: 'Assigned to',
        required: true,
        options: [{ value: 'ana@x.io', label: 'Ana', detail: 'ana@x.io' }],
        value: '',
        status: 'unresolved',
        source: 'Ana Souza <ana@example.com>',
      },
      {
        key: 'state',
        label: 'State',
        required: true,
        options: [{ value: type === 'Bug' ? 'Approved' : 'In Progress', label: 'State' }],
        value: type === 'Bug' ? 'Approved' : 'In Progress',
        status: 'resolved',
      },
      {
        key: 'custom',
        label: 'Custom field',
        required: false,
        options: [],
        value: '',
        status: 'empty',
      },
    ],
  };
}

describe('PbiPushDialog', () => {
  it('highlights unmapped fields, reloads dependent options and submits the values', async () => {
    const getPbiPushContract = vi.fn(
      async (_id: string, providerId: string, values: Record<string, string>) =>
        providerId === 'github_projects'
          ? {
              providerId,
              update: true,
              fields: [
                {
                  key: 'repository',
                  label: 'Repository',
                  required: false,
                  options: [{ value: 'acme/web', label: 'acme/web' }],
                  value: '',
                  status: 'empty',
                  allowCustom: true,
                  reloadOnChange: true,
                  readOnly: false,
                },
              ],
            }
          : azureContract(values),
    );
    const onSubmit = vi.fn();
    render(
      <PbiPushDialog
        apiClient={{ getPbiPushContract } as unknown as ApiClient}
        item={{ ...other, links: [] }}
        providers={[
          { providerId: 'azure_devops', settings: {} },
          { providerId: 'github_projects', settings: {} },
        ]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Carregando campos');
    const assignee = await within(dialog).findByRole('combobox', { name: /Responsável/ });
    expect(assignee).toHaveAttribute('aria-invalid', 'true');
    expect(
      within(dialog).getByText(
        'Não foi possível mapear “Ana Souza <ana@example.com>”. Selecione um valor.',
      ),
    ).toBeInTheDocument();
    const iteration = within(dialog).getByRole('combobox', { name: /Iteration path/ });
    expect(iteration).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getAllByText('Selecione um valor.')).toHaveLength(1);
    expect(
      within(dialog).getByRole('option', { name: 'proj\\Sprint 1 · current' }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /Custom field/ })).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    const submit = within(dialog).getByRole('button', { name: 'Fazer push' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(iteration, { target: { value: 'proj\\Sprint 1' } });
    fireEvent.change(assignee, { target: { value: 'ana@x.io' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Tipo do work item/ }), {
      target: { value: 'Bug' },
    });
    await waitFor(() =>
      expect(getPbiPushContract).toHaveBeenLastCalledWith('item-2', 'azure_devops', {
        workItemType: 'Bug',
        iterationPath: 'proj\\Sprint 1',
        assignee: 'ana@x.io',
        state: 'In Progress',
        custom: '',
      }),
    );
    // Choices that are still offered survive the reload; the state follows the new type.
    await waitFor(() =>
      expect(
        (within(dialog).getByRole('combobox', { name: /Estado/ }) as HTMLSelectElement).value,
      ).toBe('Approved'),
    );
    expect((assignee as HTMLSelectElement).value).toBe('ana@x.io');
    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-2' }),
      'azure_devops',
      {
        workItemType: 'Bug',
        iterationPath: 'proj\\Sprint 1',
        assignee: 'ana@x.io',
        state: 'Approved',
        custom: '',
      },
    );

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Plataforma' }), {
      target: { value: 'github_projects' },
    });
    const repository = await within(dialog).findByRole('combobox', { name: /Repositório/ });
    expect(within(dialog).getByText(/O item vinculado será atualizado/)).toBeInTheDocument();
    fireEvent.change(repository, { target: { value: 'acme/api' } });
    fireEvent.blur(repository, { target: { value: ' acme/api ' } });
    await waitFor(() =>
      expect(getPbiPushContract).toHaveBeenLastCalledWith('item-2', 'github_projects', {
        repository: 'acme/api',
      }),
    );
    await waitFor(() => expect((repository as HTMLInputElement).value).toBe('acme/api'));
  });

  it('shows load errors with retry and ignores submits while invalid', async () => {
    const getPbiPushContract = vi
      .fn()
      .mockRejectedValueOnce(new Error('A integração do board retornou um erro: HTTP 401'))
      .mockRejectedValueOnce('boom')
      .mockResolvedValue({
        providerId: 'trello',
        update: false,
        fields: [
          {
            key: 'unknownKey',
            label: 'Fallback label',
            required: true,
            options: [],
            value: 'gone',
            status: 'resolved',
            readOnly: true,
          },
        ],
      });
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <PbiPushDialog
        apiClient={{ getPbiPushContract } as unknown as ApiClient}
        item={item}
        providers={[{ providerId: 'trello', settings: {} }]}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 401');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByText('Não foi possível carregar os campos da plataforma.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    const field = await screen.findByRole('combobox', { name: /Fallback label/ });
    expect(field).toHaveProperty('disabled', true);
    fireEvent.submit(field.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalled();
    rerender(
      <PbiPushDialog
        apiClient={{ getPbiPushContract } as unknown as ApiClient}
        item={null}
        providers={[]}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts on a platform the item is not linked to yet and survives unmounting', async () => {
    let resolve!: (value: PbiPushContract) => void;
    const getPbiPushContract = vi.fn(
      () =>
        new Promise<PbiPushContract>((done) => {
          resolve = done;
        }),
    );
    const { unmount } = render(
      <PbiPushDialog
        apiClient={{ getPbiPushContract } as unknown as ApiClient}
        item={other}
        providers={[
          { providerId: 'azure_devops', settings: {} },
          { providerId: 'jira', settings: {} },
        ]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(getPbiPushContract).toHaveBeenCalledWith('item-2', 'jira', {});
    expect(screen.getByRole('option', { name: 'Azure DevOps · vinculado' })).toBeInTheDocument();
    unmount();
    await act(async () => resolve(azureContract()));
  });
});

describe('PbiLinks', () => {
  const summary = (entry: PbiItem): NonNullable<PbiRelation['item']> => ({
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    status: entry.status,
    type: 'Task',
    links: entry.links.map(({ providerId, externalId, externalUrl }) => ({
      providerId,
      externalId,
      externalUrl,
    })),
  });

  it('links existing items like Azure "Add link" and removes links', async () => {
    const api = {
      getPbiRelations: vi.fn().mockResolvedValue([
        { type: 'parent', origin: 'adk', item: summary(third) },
        { type: 'related', origin: 'azure_devops', item: null, externalId: '777' },
      ]),
      addPbiRelations: vi
        .fn()
        .mockRejectedValueOnce(new Error('Não é possível criar este vínculo: ciclo'))
        .mockResolvedValue([
          { type: 'parent', origin: 'adk', item: summary(third) },
          { type: 'successor', origin: 'adk', item: summary(other) },
        ]),
      removePbiRelation: vi
        .fn()
        .mockRejectedValueOnce('nope')
        .mockResolvedValue([{ type: 'successor', origin: 'adk', item: summary(other) }]),
    };
    const onChanged = vi.fn();
    const onOpenItem = vi.fn();
    render(
      <PbiLinks
        apiClient={api as unknown as ApiClient}
        item={item}
        items={[item, other, third]}
        onOpenItem={onOpenItem}
        onChanged={onChanged}
      />,
    );
    const section = screen.getByRole('region', { name: 'Links' });
    expect(within(section).getByRole('status')).toHaveTextContent('Carregando links');
    expect(await within(section).findByText('Pai (1)')).toBeInTheDocument();
    expect(within(section).getByText('#777 · não importado')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Task Relatório mensal' }));
    expect(onOpenItem).toHaveBeenCalledWith('item-3');

    fireEvent.click(within(section).getByRole('button', { name: /Adicionar link/ }));
    fireEvent.click(within(section).getByRole('menuitem', { name: 'Item existente' }));
    const form = within(section).getByRole('form', { name: 'Item existente' });
    expect(within(form).getByText('Teste 01 - Create')).toBeInTheDocument();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Tipo de link' }), {
      target: { value: 'predecessor' },
    });
    const search = within(form).getByRole('textbox', { name: 'Buscar itens por ID ou título' });
    fireEvent.change(search, { target: { value: 'nada disso' } });
    expect(within(form).getByText('Nenhum item encontrado.')).toBeInTheDocument();
    // Search ignores accents and matches provider IDs.
    fireEvent.change(search, { target: { value: 'integracao' } });
    fireEvent.click(
      within(within(form).getByRole('listbox')).getByRole('button', { name: /Integração/ }),
    );
    fireEvent.change(search, { target: { value: '50493' } });
    expect(
      within(within(form).getByRole('listbox')).getByRole('option', { selected: true }),
    ).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'relatorio' } });
    fireEvent.click(
      within(within(form).getByRole('listbox')).getByRole('button', { name: /Relatório/ }),
    );
    fireEvent.click(
      within(within(form).getByRole('listbox')).getByRole('button', { name: /Relatório/ }),
    );
    fireEvent.click(
      within(within(form).getByRole('listbox')).getByRole('button', { name: /Relatório/ }),
    );
    fireEvent.click(
      within(form).getByRole('button', { name: 'Remover seleção: Relatório mensal' }),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Adicionar link' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('ciclo');
    fireEvent.click(within(form).getByRole('button', { name: 'Adicionar link' }));
    await waitFor(() =>
      expect(api.addPbiRelations).toHaveBeenLastCalledWith('item-1', 'predecessor', ['item-2']),
    );
    expect(await within(section).findByText('Sucessor (1)')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(
      within(section).getByRole('button', { name: 'Remover link: Relatório mensal' }),
    );
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar os links.',
    );
    fireEvent.click(
      within(section).getByRole('button', { name: 'Remover link: Relatório mensal' }),
    );
    await waitFor(() =>
      expect(api.removePbiRelation).toHaveBeenLastCalledWith('item-1', 'parent', 'item-3'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(within(section).queryByText('Pai (1)')).not.toBeInTheDocument();
  });

  it('creates new linked items and picks a single parent', async () => {
    const created = { ...third, id: 'new-1', title: 'Nova tarefa' };
    const api = {
      getPbiRelations: vi.fn().mockResolvedValue([]),
      createPbiItem: vi.fn().mockResolvedValue(created),
      addPbiRelations: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ type: 'parent', origin: 'adk', item: summary(other) }]),
      removePbiRelation: vi.fn(),
    };
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const onOpenItem = vi.fn();
    render(
      <PbiLinks
        apiClient={api as unknown as ApiClient}
        item={item}
        items={[item, other, third]}
        onOpenItem={onOpenItem}
        onChanged={onChanged}
      />,
    );
    const section = screen.getByRole('region', { name: 'Links' });
    expect(await within(section).findByText('Nenhum link neste item.')).toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: /Adicionar link/ }));
    fireEvent.click(within(section).getByRole('menuitem', { name: 'Novo item' }));
    let form = within(section).getByRole('form', { name: 'Novo item' });
    expect(
      (within(form).getByRole('combobox', { name: 'Tipo de link' }) as HTMLSelectElement).value,
    ).toBe('child');
    fireEvent.submit(form);
    expect(api.createPbiItem).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByRole('textbox', { name: 'Título' }), {
      target: { value: 'Nova tarefa' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Criar e vincular' }));
    await waitFor(() => expect(onOpenItem).toHaveBeenCalledWith('new-1'));
    expect(api.createPbiItem).toHaveBeenCalledWith({
      kind: 'card',
      title: 'Nova tarefa',
      parentId: 'item-1',
    });
    expect(api.addPbiRelations).not.toHaveBeenCalled();

    fireEvent.click(within(section).getByRole('button', { name: /Adicionar link/ }));
    fireEvent.click(within(section).getByRole('menuitem', { name: 'Novo item' }));
    form = within(section).getByRole('form', { name: 'Novo item' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Tipo de link' }), {
      target: { value: 'tests' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Título' }), {
      target: { value: 'Plano' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Criar e vincular' }));
    await waitFor(() =>
      expect(api.addPbiRelations).toHaveBeenCalledWith('item-1', 'tests', ['new-1']),
    );
    expect(api.createPbiItem).toHaveBeenLastCalledWith({ kind: 'pbi', title: 'Plano' });

    fireEvent.click(within(section).getByRole('button', { name: /Adicionar link/ }));
    fireEvent.click(within(section).getByRole('menuitem', { name: 'Item existente' }));
    form = within(section).getByRole('form', { name: 'Item existente' });
    fireEvent.change(within(form).getByRole('combobox', { name: 'Tipo de link' }), {
      target: { value: 'parent' },
    });
    const search = within(form).getByRole('textbox', { name: 'Buscar itens por ID ou título' });
    fireEvent.change(search, { target: { value: 'a' } });
    fireEvent.click(
      within(within(form).getByRole('listbox')).getByRole('button', { name: /Integração/ }),
    );
    fireEvent.click(
      within(within(form).getByRole('listbox')).getByRole('button', { name: /Relatório/ }),
    );
    expect(
      within(within(form).getByRole('listbox')).getAllByRole('option', { selected: true }),
    ).toHaveLength(1);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(api.addPbiRelations).toHaveBeenLastCalledWith('item-1', 'parent', ['item-3']),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    fireEvent.click(within(section).getByRole('button', { name: /Adicionar link/ }));
    fireEvent.click(within(section).getByRole('menuitem', { name: 'Item existente' }));
    form = within(section).getByRole('form', { name: 'Item existente' });
    fireEvent.submit(form);
    fireEvent.click(within(form).getByRole('button', { name: 'Cancelar' }));
    expect(within(section).queryByRole('form')).not.toBeInTheDocument();
  });

  it('retries failed loads and hides editing when read-only', async () => {
    const api = {
      getPbiRelations: vi
        .fn()
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockRejectedValueOnce('offline')
        .mockResolvedValue([{ type: 'related', origin: 'adk', item: summary(other) }]),
    };
    render(
      <PbiLinks
        apiClient={api as unknown as ApiClient}
        item={item}
        items={[item]}
        isReadOnly
        onOpenItem={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Não foi possível carregar os links.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Relacionado (1)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Adicionar link/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remover link/ })).not.toBeInTheDocument();
  });
});
