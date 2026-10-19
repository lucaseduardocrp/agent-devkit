import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiPushDialog } from '../src/features/pbi/PbiPushDialog.js';
import type { PbiItem, PbiPushContract } from '../src/features/pbi/pbi-types.js';
import type {
  FieldMappingTemplate,
  FieldMappingTemplateInput,
  FieldValue,
} from '../src/features/field-mapping/types.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

type Preview = { definitions: never[]; values: Record<string, FieldValue> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const item: PbiItem = {
  id: 'item-1',
  workspaceId: 'ws',
  parentId: null,
  kind: 'card',
  title: 'Exportar relatório',
  description: '',
  status: 'Active',
  position: 1,
  sourceData: {
    customFields: {
      azure_devops: { 'Custom.Risk': 'High', 'Custom.Team': 'Blue' },
      jira: 'not a field map',
      trello: ['also', 'ignored'],
    },
  },
  links: [
    {
      id: 'link-1',
      providerId: 'azure_devops',
      externalId: '42',
      externalUrl: null,
      boardId: null,
      syncedAt: '2026-10-07T00:00:00.000Z',
    },
  ],
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};

const contract: PbiPushContract = {
  providerId: 'azure_devops',
  update: true,
  fields: [
    {
      key: 'workItemType',
      label: 'Work item type',
      required: true,
      options: [{ value: 'Bug', label: 'Bug' }],
      value: 'Bug',
      status: 'resolved',
    },
    {
      key: 'areaPath',
      label: 'Area path',
      required: true,
      options: [{ value: 'proj\\Web', label: 'proj\\Web' }],
      value: '',
      status: 'empty',
      allowCustom: true,
    },
    // A field the backend sent without a value is treated as empty.
    {
      key: 'extra',
      label: 'Extra',
      required: false,
      options: [],
      status: 'empty',
    } as unknown as PbiPushContract['fields'][number],
  ],
};

const template: FieldMappingTemplate = {
  id: 'tpl-1',
  workspaceId: 'ws',
  name: 'Campos do Azure',
  entityType: 'pbi',
  providerId: 'azure_devops',
  scope: '',
  itemType: '',
  rules: [],
  createdAt: '',
  updatedAt: '',
};

function client(previewPbiFields: ReturnType<typeof vi.fn>) {
  return {
    getPbiPushContract: vi.fn().mockResolvedValue(contract),
    getFieldMappingTemplates: vi.fn().mockResolvedValue([template]),
    getPbiFieldCatalog: vi.fn().mockResolvedValue([]),
    saveFieldMappingTemplate: vi.fn(async (input: FieldMappingTemplateInput, id?: string) => ({
      ...template,
      ...input,
      id: id ?? 'tpl-new',
    })),
    previewPbiFields,
  };
}

describe('PbiPushDialog field templates', () => {
  it('previews a field template, revalidates after saving it and pushes with it', async () => {
    const first = deferred<Preview>();
    const previewPbiFields = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({
        definitions: [],
        values: { 'Custom.Risk': 'High', 'System.Tags': ['web', 'export'], Effort: 3 },
      });
    const api = client(previewPbiFields);
    const onSubmit = vi.fn();
    render(
      <PbiPushDialog
        apiClient={api as unknown as ApiClient}
        item={item}
        providers={[{ providerId: 'azure_devops', settings: { project: 'Proj' } }]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const dialog = screen.getByRole('dialog');
    // Every provider is linked already: the first one is used.
    await waitFor(() =>
      expect(api.getPbiPushContract).toHaveBeenCalledWith('item-1', 'azure_devops', {}),
    );
    const area = await within(dialog).findByRole('combobox', { name: /Area path/ });
    expect(area).toHaveAttribute('aria-invalid', 'true');
    expect(area).toHaveAttribute('aria-describedby', 'pbi-push-areaPath-hint');
    expect(within(dialog).getByText('Selecione um valor.')).toBeInTheDocument();
    expect(
      (within(dialog).getByRole('combobox', { name: /Extra/ }) as HTMLSelectElement).value,
    ).toBe('');
    fireEvent.change(area, { target: { value: 'proj\\Web' } });
    expect(area).toHaveAttribute('aria-invalid', 'false');

    const editor = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    await waitFor(() =>
      expect(api.getPbiFieldCatalog).toHaveBeenCalledWith('azure_devops', 'Proj', 'Bug'),
    );
    const templates = await within(editor).findByRole('combobox', { name: 'Template salvo' });
    fireEvent.change(templates, { target: { value: 'tpl-1' } });

    expect(previewPbiFields).toHaveBeenCalledWith('item-1', 'azure_devops', 'tpl-1', 'Proj', 'Bug');
    expect(within(dialog).getByText('Validando mapeamento...')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Fazer push' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.submit(submit.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => first.resolve({ definitions: [], values: { 'Custom.Risk': 'Medium' } }));
    expect(within(dialog).getByText('Prévia dos campos')).toBeInTheDocument();
    expect(within(dialog).getByText('Custom.Risk: Medium')).toBeInTheDocument();

    // Saving the template validates the mapping again.
    fireEvent.click(within(editor).getByRole('button', { name: 'Editar' }));
    const modal = screen.getByRole('dialog', { name: 'Editar template de campos' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar template' }));
    await waitFor(() => expect(previewPbiFields).toHaveBeenCalledTimes(2));
    expect(await within(dialog).findByText('System.Tags: web, export')).toBeInTheDocument();
    expect(within(dialog).getByText('Effort: 3')).toBeInTheDocument();

    await waitFor(() => expect(submit).toHaveProperty('disabled', false));
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledWith(
      item,
      'azure_devops',
      { workItemType: 'Bug', areaPath: 'proj\\Web', extra: undefined },
      'tpl-1',
    );
  });

  it('offers imported custom fields and blocks the push while the preview fails', async () => {
    const previewPbiFields = vi
      .fn()
      .mockRejectedValueOnce(new Error('Campo obrigatório sem valor'))
      .mockRejectedValueOnce('mapeamento inválido');
    const api = client(previewPbiFields);
    api.getPbiFieldCatalog.mockResolvedValue([{ id: 'Custom.Risk', name: 'Risk', type: 'text' }]);
    const onSubmit = vi.fn();
    render(
      <PbiPushDialog
        apiClient={api as unknown as ApiClient}
        item={item}
        providers={[{ providerId: 'azure_devops', settings: {} }]}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const editor = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    fireEvent.change(await within(editor).findByRole('combobox', { name: 'Template salvo' }), {
      target: { value: 'tpl-1' },
    });
    expect(await within(dialog).findByText('Campo obrigatório sem valor')).toBeInTheDocument();
    const submit = within(dialog).getByRole('button', { name: 'Fazer push' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.click(within(editor).getByRole('button', { name: 'Editar' }));
    const modal = screen.getByRole('dialog', { name: 'Editar template de campos' });
    const risk = within(modal).getByRole('combobox', { name: /Risk/ });
    expect(
      within(risk)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Não preencher',
      'Title',
      'Description',
      'Status',
      'azure_devops · Custom.Risk',
      'azure_devops · Custom.Team',
      'Valor fixo',
    ]);
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar template' }));
    expect(await within(dialog).findByText('mapeamento inválido')).toBeInTheDocument();
    expect(within(dialog).queryByText('Prévia dos campos')).not.toBeInTheDocument();
    fireEvent.submit(submit.closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores previews that finish after the template changed', async () => {
    const resolved = deferred<Preview>();
    const rejected = deferred<Preview>();
    const previewPbiFields = vi
      .fn()
      .mockReturnValueOnce(resolved.promise)
      .mockReturnValueOnce(rejected.promise);
    const api = client(previewPbiFields);
    render(
      <PbiPushDialog
        apiClient={api as unknown as ApiClient}
        item={item}
        providers={[{ providerId: 'azure_devops', settings: {} }]}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const editor = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    const templates = await within(editor).findByRole('combobox', { name: 'Template salvo' });
    fireEvent.change(templates, { target: { value: 'tpl-1' } });
    fireEvent.change(templates, { target: { value: '' } });
    expect(within(dialog).queryByText('Validando mapeamento...')).not.toBeInTheDocument();
    await act(async () => resolved.resolve({ definitions: [], values: { Late: 'value' } }));
    expect(within(dialog).queryByText('Late: value')).not.toBeInTheDocument();

    fireEvent.change(templates, { target: { value: 'tpl-1' } });
    fireEvent.change(templates, { target: { value: '' } });
    await act(async () => rejected.reject(new Error('stale failure')));
    expect(within(dialog).queryByText('stale failure')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Validando mapeamento...')).not.toBeInTheDocument();
  });

  it('shows the preview in English and waits for a platform when none is configured', async () => {
    const previewPbiFields = vi.fn().mockResolvedValue({ definitions: [], values: { A: 'B' } });
    const api = client(previewPbiFields);
    const view = render(
      <I18nProvider initialLocale="en-US">
        <PbiPushDialog
          apiClient={api as unknown as ApiClient}
          item={item}
          providers={[]}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>,
    );
    const empty = screen.getByRole('dialog');
    expect(
      (within(empty).getByRole('combobox', { name: 'Platform' }) as HTMLSelectElement).value,
    ).toBe('');
    expect(api.getPbiPushContract).not.toHaveBeenCalled();
    expect(within(empty).getByRole('button', { name: 'Push' })).toHaveProperty('disabled', true);

    view.rerender(
      <I18nProvider initialLocale="en-US">
        <PbiPushDialog
          apiClient={api as unknown as ApiClient}
          item={item}
          providers={[{ providerId: 'azure_devops', settings: {} }]}
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('dialog');
    const editor = await within(dialog).findByRole('region', { name: 'Field mapping' });
    fireEvent.change(await within(editor).findByRole('combobox', { name: 'Saved template' }), {
      target: { value: 'tpl-1' },
    });
    expect(within(dialog).getByText('Validating mapping...')).toBeInTheDocument();
    expect(await within(dialog).findByText('Field preview')).toBeInTheDocument();
    expect(within(dialog).getByText('A: B')).toBeInTheDocument();
  });
});
