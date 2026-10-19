import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  FieldMappingEditor,
  type MappingSourceOption,
} from '../src/features/field-mapping/FieldMappingEditor.js';
import type {
  FieldDefinition,
  FieldMappingTemplate,
  FieldMappingTemplateInput,
} from '../src/features/field-mapping/types.js';
import type { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const template = (id: string, extra: Partial<FieldMappingTemplate> = {}): FieldMappingTemplate => ({
  id,
  workspaceId: 'ws',
  name: `Template ${id}`,
  entityType: 'pbi',
  providerId: 'azure_devops',
  scope: '',
  itemType: '',
  rules: [],
  createdAt: '',
  updatedAt: '',
  ...extra,
});

const definitions: FieldDefinition[] = [
  {
    id: 'severity',
    name: 'Severity',
    type: 'single_select',
    options: [
      { id: 'sev-1', name: 'Critical' },
      { id: 'sev-2', name: 'Minor' },
    ],
  },
  { id: 'labels', name: 'Labels', type: 'multi_select' },
  { id: 'team', name: 'Team', type: 'text', options: [{ id: 'blue', name: 'Blue team' }] },
  { id: 'notes', name: 'Notes', type: 'text' },
  { id: 'created', name: 'Created', type: 'date', readOnly: true },
];

const sources: MappingSourceOption[] = [
  { value: 'core::title', label: 'Title', source: { kind: 'core', key: 'title' } },
  { value: 'core::status', label: 'Status', source: { kind: 'core', key: 'status' } },
  // A custom source without a key (the whole provider payload).
  { value: 'custom:jira:', label: 'Jira payload', source: { kind: 'custom', providerId: 'jira' } },
];

const saved = (input: FieldMappingTemplateInput, id = 'tpl-saved'): FieldMappingTemplate => ({
  ...input,
  id,
  workspaceId: 'ws',
  createdAt: '',
  updatedAt: '',
});

function Harness({
  apiClient,
  initial = '',
  onSaved,
}: {
  apiClient: ApiClient;
  initial?: string;
  onSaved?: () => void;
}) {
  const [selectedId, setSelectedId] = useState(initial);
  return (
    <FieldMappingEditor
      apiClient={apiClient}
      entityType="pbi"
      providerId="azure_devops"
      scope="Project A"
      itemType="Bug"
      sources={sources}
      selectedId={selectedId}
      onSelected={setSelectedId}
      onSaved={onSaved}
    />
  );
}

const summary = (editor: HTMLElement, name: string) =>
  within(within(editor).getByRole('list', { name }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('FieldMappingEditor templates', () => {
  it('summarizes the selected template, edits it in a modal, then deletes it', async () => {
    const templates = [
      template('tpl-1', {
        name: 'Bugs do projeto A',
        scope: 'Project A',
        itemType: 'Bug',
        rules: [
          {
            targetFieldId: 'severity',
            source: { kind: 'core', key: 'title' },
            choices: { Alta: 'sev-1' },
          },
          { targetFieldId: 'labels', source: { kind: 'custom', providerId: 'jira' } },
        ],
      }),
      template('tpl-other-scope', { name: 'Outro projeto', scope: 'Project B' }),
      template('tpl-other-type', { name: 'Só tarefas', itemType: 'Task' }),
      template('tpl-any', { name: 'Qualquer item' }),
    ];
    const saveFieldMappingTemplate = vi.fn(async (input: FieldMappingTemplateInput, id?: string) =>
      saved(input, id),
    );
    const deleteFieldMappingTemplate = vi.fn().mockResolvedValue(undefined);
    const apiClient = {
      getFieldMappingTemplates: vi.fn().mockResolvedValue(templates),
      getPbiFieldCatalog: vi.fn().mockResolvedValue(definitions),
      saveFieldMappingTemplate,
      deleteFieldMappingTemplate,
    } as unknown as ApiClient;
    const onSaved = vi.fn();
    render(<Harness apiClient={apiClient} initial="tpl-1" onSaved={onSaved} />);

    const editor = screen.getByRole('region', { name: 'Mapeamento de campos' });
    expect(within(editor).getByRole('status')).toHaveTextContent('Carregando campos...');
    const picker = await within(editor).findByRole('combobox', { name: 'Template salvo' });
    // Only templates for this scope and item type (or without one) are offered.
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Nenhum template', 'Bugs do projeto A', 'Qualquer item']);
    // Only the fields of the selected template are shown, not the whole catalog.
    expect(summary(editor, 'Campos do template')).toEqual([
      'Severity← Title · 1 conversão(ões) de valor',
      'Labels← Jira payload',
    ]);
    expect(within(editor).queryByText('Notes')).not.toBeInTheDocument();
    expect(within(editor).queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(within(editor).getByRole('button', { name: 'Editar' }));
    const modal = screen.getByRole('dialog', { name: 'Editar template de campos' });
    expect(within(modal).getByRole('textbox', { name: 'Nome do template' })).toHaveProperty(
      'value',
      'Bugs do projeto A',
    );
    // Read-only destination fields are not offered.
    expect(within(modal).queryByText('Created')).not.toBeInTheDocument();
    expect(
      (within(modal).getByRole('combobox', { name: /Labels/ }) as HTMLSelectElement).value,
    ).toBe('custom:jira:');

    // Existing conversions can be retargeted or removed.
    expect(within(modal).getByDisplayValue('Alta')).toBeInTheDocument();
    const severityTargets = within(modal).getAllByRole('combobox', { name: 'Valor de destino' });
    fireEvent.change(severityTargets[0]!, { target: { value: 'sev-2' } });
    expect((severityTargets[0] as HTMLSelectElement).value).toBe('sev-2');

    // A field without options converts to free text; empty drafts are ignored.
    const newSource = within(modal).getAllByRole('textbox', { name: 'Novo valor de origem' });
    const addValue = within(modal).getAllByRole('button', { name: 'Adicionar valor' });
    fireEvent.click(addValue[1]!);
    expect(within(modal).queryAllByRole('textbox', { name: 'Valor de destino' })).toHaveLength(0);
    fireEvent.change(newSource[1]!, { target: { value: '  bug  ' } });
    fireEvent.click(addValue[1]!);
    expect(newSource[1]).toHaveProperty('value', '');
    const freeTarget = within(modal).getByRole('textbox', { name: 'Valor de destino' });
    expect(freeTarget).toHaveProperty('value', '');
    expect(freeTarget).toHaveAttribute('placeholder', 'ID ou valor de destino');
    fireEvent.change(freeTarget, { target: { value: 'defect' } });
    expect(freeTarget).toHaveProperty('value', 'defect');
    // New values for an option field start on its first option.
    fireEvent.change(newSource[0]!, { target: { value: 'Baixa' } });
    fireEvent.click(addValue[0]!);
    expect(
      within(modal)
        .getAllByRole('combobox', { name: 'Valor de destino' })
        .map((select) => (select as HTMLSelectElement).value),
    ).toEqual(['sev-2', 'sev-1']);
    fireEvent.click(within(modal).getAllByRole('button', { name: 'Remover' })[0]!);
    expect(within(modal).queryByDisplayValue('Alta')).not.toBeInTheDocument();

    // Fixed values use the field options when there are any, free text otherwise.
    fireEvent.change(within(modal).getByRole('combobox', { name: /^Team/ }), {
      target: { value: 'constant' },
    });
    const teamValue = within(modal).getByRole('combobox', { name: 'Valor' });
    fireEvent.change(teamValue, { target: { value: 'blue' } });
    expect((teamValue as HTMLSelectElement).value).toBe('blue');
    fireEvent.change(within(modal).getByRole('combobox', { name: /^Notes/ }), {
      target: { value: 'constant' },
    });
    const notesValue = within(modal).getByRole('textbox', { name: 'Valor' });
    fireEvent.change(notesValue, { target: { value: 'Importado' } });
    expect(notesValue).toHaveProperty('value', 'Importado');
    // "Leave unchanged" drops the rule.
    fireEvent.change(within(modal).getByRole('combobox', { name: /^Labels/ }), {
      target: { value: '' },
    });
    expect(within(modal).queryByRole('textbox', { name: 'Valor de destino' })).toBeNull();

    fireEvent.change(within(modal).getByRole('textbox', { name: 'Buscar campo de destino' }), {
      target: { value: 'SEV' },
    });
    expect(within(modal).queryByText('Notes')).not.toBeInTheDocument();
    fireEvent.change(within(modal).getByRole('textbox', { name: 'Buscar campo de destino' }), {
      target: { value: '' },
    });

    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar template' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(saveFieldMappingTemplate).toHaveBeenCalledWith(
      {
        name: 'Bugs do projeto A',
        entityType: 'pbi',
        providerId: 'azure_devops',
        scope: 'Project A',
        itemType: 'Bug',
        rules: [
          {
            targetFieldId: 'severity',
            source: { kind: 'core', key: 'title' },
            choices: { Baixa: 'sev-1' },
          },
          { targetFieldId: 'team', source: { kind: 'constant', value: 'blue' } },
          { targetFieldId: 'notes', source: { kind: 'constant', value: 'Importado' } },
        ],
      },
      'tpl-1',
    );
    // Saving closes the modal and the summary reflects the new rules.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(summary(editor, 'Campos do template')).toEqual([
      'Severity← Title · 1 conversão(ões) de valor',
      'Team← Valor fixo: Blue team',
      'Notes← Valor fixo: Importado',
    ]);

    fireEvent.click(within(editor).getByRole('button', { name: 'Editar' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(deleteFieldMappingTemplate).toHaveBeenCalledWith('tpl-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(editor).getByRole('combobox', { name: 'Template salvo' })).toHaveProperty(
      'value',
      '',
    );
    expect(within(editor).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(within(editor).queryByRole('list')).not.toBeInTheDocument();
  });

  it('reports load, save and delete failures in English, retries and cancels', async () => {
    const getFieldMappingTemplates = vi
      .fn()
      .mockRejectedValueOnce('catalog offline')
      .mockResolvedValue([template('tpl-1', { name: 'Defaults' })]);
    const saveFieldMappingTemplate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Name already used'))
      .mockRejectedValueOnce('server down');
    const deleteFieldMappingTemplate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Template in use'))
      .mockRejectedValueOnce('gone');
    const apiClient = {
      getFieldMappingTemplates,
      getPbiFieldCatalog: vi.fn().mockResolvedValue(definitions),
      saveFieldMappingTemplate,
      deleteFieldMappingTemplate,
    } as unknown as ApiClient;
    render(
      <I18nProvider initialLocale="en-US">
        <Harness apiClient={apiClient} initial="tpl-1" />
      </I18nProvider>,
    );
    const editor = screen.getByRole('region', { name: 'Field mapping' });
    expect(within(editor).getByRole('status')).toHaveTextContent('Loading fields...');
    expect(await within(editor).findByRole('alert')).toHaveTextContent('catalog offline');
    fireEvent.click(within(editor).getByRole('button', { name: 'Retry' }));
    const picker = await within(editor).findByRole('combobox', { name: 'Saved template' });
    expect(picker).toHaveProperty('value', 'tpl-1');
    expect(within(editor).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(editor).getByText('Custom field template')).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'No template' })).toBeInTheDocument();
    expect(within(editor).getByText('This template does not fill any field.')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'New template' }));
    const created = screen.getByRole('dialog', { name: 'New field template' });
    fireEvent.click(within(created).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(within(editor).getByRole('button', { name: 'Edit' }));
    const modal = screen.getByRole('dialog', { name: 'Edit field template' });
    expect(within(modal).getByRole('textbox', { name: 'Template name' })).toHaveProperty(
      'value',
      'Defaults',
    );
    expect(
      within(modal).getByRole('textbox', { name: 'Find destination field' }),
    ).toBeInTheDocument();

    // English labels for fixed values and conversions.
    fireEvent.change(within(modal).getByRole('combobox', { name: /^Team/ }), {
      target: { value: 'constant' },
    });
    expect(within(modal).getAllByRole('option', { name: 'Leave unchanged' }).length).toBe(4);
    const value = within(modal).getByRole('combobox', { name: 'Value' });
    expect(within(value).getByRole('option', { name: 'Select' })).toBeInTheDocument();
    expect(within(modal).getAllByRole('option', { name: 'Fixed value' }).length).toBe(4);
    fireEvent.change(within(modal).getByRole('combobox', { name: /^Severity/ }), {
      target: { value: 'core::status' },
    });
    fireEvent.change(within(modal).getByRole('combobox', { name: /^Labels/ }), {
      target: { value: 'core::title' },
    });
    expect(within(modal).getAllByText('Convert source values')).toHaveLength(2);
    const drafts = within(modal).getAllByRole('textbox', { name: 'New source value' });
    expect(drafts[0]).toHaveAttribute('placeholder', 'Source value');
    fireEvent.change(drafts[0]!, { target: { value: 'High' } });
    fireEvent.change(drafts[1]!, { target: { value: 'ui' } });
    for (const add of within(modal).getAllByRole('button', { name: 'Add value' })) {
      fireEvent.click(add);
    }
    expect(within(modal).getAllByRole('textbox', { name: 'Source value' })).toHaveLength(2);
    const select = within(modal).getByRole('combobox', { name: 'Target value' });
    expect(within(select).getByRole('option', { name: 'Select' })).toBeInTheDocument();
    expect(within(modal).getByRole('textbox', { name: 'Target value' })).toHaveAttribute(
      'placeholder',
      'Destination ID or value',
    );
    expect(within(modal).getAllByRole('button', { name: 'Remove' })).toHaveLength(2);

    // Failures keep the modal open with the error.
    const save = within(modal).getByRole('button', { name: 'Save template' });
    fireEvent.click(save);
    expect(await within(modal).findByRole('alert')).toHaveTextContent('Name already used');
    fireEvent.click(save);
    await waitFor(() => expect(within(modal).getByRole('alert')).toHaveTextContent('server down'));
    fireEvent.click(within(modal).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(within(modal).getByRole('alert')).toHaveTextContent('Template in use'),
    );
    fireEvent.click(within(modal).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(within(modal).getByRole('alert')).toHaveTextContent('gone'));

    // Cancel discards the changes and keeps the template selected.
    fireEvent.click(within(modal).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(editor).getByRole('combobox', { name: 'Saved template' })).toHaveProperty(
      'value',
      'tpl-1',
    );
    expect(within(editor).getByText('This template does not fill any field.')).toBeInTheDocument();
  });

  it('describes every kind of rule in the summary', async () => {
    const apiClient = {
      getFieldMappingTemplates: vi.fn().mockResolvedValue([
        template('tpl-1', {
          name: 'Resumo',
          rules: [
            { targetFieldId: 'severity', source: { kind: 'constant', value: 'sev-1' } },
            { targetFieldId: 'notes', source: { kind: 'constant', value: 'Imported' } },
            { targetFieldId: 'gone', source: { kind: 'constant' } },
            {
              targetFieldId: 'labels',
              source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.X' },
              choices: { a: 'b' },
            },
            { targetFieldId: 'team', source: { kind: 'core', key: 'title' } },
          ],
        }),
      ]),
      getPbiFieldCatalog: vi.fn().mockResolvedValue(definitions),
    } as unknown as ApiClient;
    render(
      <I18nProvider initialLocale="en-US">
        <Harness apiClient={apiClient} initial="tpl-1" />
      </I18nProvider>,
    );
    const editor = screen.getByRole('region', { name: 'Field mapping' });
    await within(editor).findByRole('list', { name: 'Template fields' });
    expect(summary(editor, 'Template fields')).toEqual([
      'Severity← Fixed value: Critical',
      'Notes← Fixed value: Imported',
      'gone← Fixed value: —',
      'Labels← azure_devops · Custom.X · 1 value conversion(s)',
      'Team← Title',
    ]);
  });

  it('creates a template in a modal and ignores catalogs that arrive after unmounting', async () => {
    let finish!: (fields: FieldDefinition[]) => void;
    const apiClient = {
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getTestCaseFieldCatalog: vi.fn(
        () =>
          new Promise<FieldDefinition[]>((resolve) => {
            finish = resolve;
          }),
      ),
      saveFieldMappingTemplate: vi.fn(async (input: FieldMappingTemplateInput) => saved(input)),
    } as unknown as ApiClient;
    const onSelected = vi.fn();
    const { unmount } = render(
      <FieldMappingEditor
        apiClient={apiClient}
        entityType="test_case"
        providerId="jira"
        scope=""
        itemType=""
        sources={[]}
        selectedId=""
        onSelected={onSelected}
      />,
    );
    expect(apiClient.getTestCaseFieldCatalog).toHaveBeenCalledWith('jira');
    await act(async () => finish([]));
    const editor = screen.getByRole('region', { name: 'Mapeamento de campos' });
    expect(within(editor).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Novo template' }));
    const modal = screen.getByRole('dialog', { name: 'Novo template de campos' });
    expect(within(modal).queryByRole('button', { name: 'Excluir' })).not.toBeInTheDocument();
    const save = within(modal).getByRole('button', { name: 'Salvar template' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(within(modal).getByRole('textbox', { name: 'Nome do template' }), {
      target: { value: '  Casos Jira  ' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(onSelected).toHaveBeenCalledWith('tpl-saved'));
    expect(apiClient.saveFieldMappingTemplate).toHaveBeenCalledWith(
      {
        name: 'Casos Jira',
        entityType: 'test_case',
        providerId: 'jira',
        scope: '',
        itemType: '',
        rules: [],
      },
      undefined,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    unmount();

    // A catalog that resolves after unmounting does not update anything.
    let late!: (fields: FieldDefinition[]) => void;
    const lateClient = {
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getTestCaseFieldCatalog: vi.fn(
        () =>
          new Promise<FieldDefinition[]>((resolve) => {
            late = resolve;
          }),
      ),
    } as unknown as ApiClient;
    const second = render(
      <FieldMappingEditor
        apiClient={lateClient}
        entityType="test_case"
        providerId="jira"
        scope=""
        itemType=""
        sources={[]}
        selectedId=""
        onSelected={vi.fn()}
      />,
    );
    second.unmount();
    await act(async () => late(definitions));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();

    // Neither does a failure after unmounting.
    let fail!: (cause: unknown) => void;
    const failingClient = {
      getFieldMappingTemplates: vi.fn().mockResolvedValue([]),
      getTestCaseFieldCatalog: vi.fn(
        () =>
          new Promise<FieldDefinition[]>((_resolve, reject) => {
            fail = reject;
          }),
      ),
    } as unknown as ApiClient;
    const third = render(
      <FieldMappingEditor
        apiClient={failingClient}
        entityType="test_case"
        providerId="jira"
        scope=""
        itemType=""
        sources={[]}
        selectedId=""
        onSelected={vi.fn()}
      />,
    );
    third.unmount();
    await act(async () => fail(new Error('late')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries a failed catalog and switches between saved templates with empty fixed values', async () => {
    const templates = [
      template('tpl-1', { name: 'Padrão' }),
      template('tpl-2', {
        name: 'Valores fixos',
        rules: [
          { targetFieldId: 'team', source: { kind: 'constant' } },
          { targetFieldId: 'notes', source: { kind: 'constant' } },
        ],
      }),
    ];
    const apiClient = {
      getFieldMappingTemplates: vi.fn().mockResolvedValue(templates),
      getPbiFieldCatalog: vi
        .fn()
        .mockRejectedValueOnce(new Error('Catálogo indisponível'))
        .mockResolvedValue(definitions),
    } as unknown as ApiClient;
    render(<Harness apiClient={apiClient} initial="tpl-1" />);
    const editor = screen.getByRole('region', { name: 'Mapeamento de campos' });
    expect(await within(editor).findByRole('alert')).toHaveTextContent('Catálogo indisponível');
    fireEvent.click(within(editor).getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await within(editor).findByText('Este template não preenche nenhum campo.'),
    ).toBeInTheDocument();

    fireEvent.change(within(editor).getByRole('combobox', { name: 'Template salvo' }), {
      target: { value: 'tpl-2' },
    });
    expect(summary(editor, 'Campos do template')).toEqual([
      'Team← Valor fixo: —',
      'Notes← Valor fixo: —',
    ]);
    fireEvent.click(within(editor).getByRole('button', { name: 'Editar' }));
    const modal = screen.getByRole('dialog', { name: 'Editar template de campos' });
    expect(within(modal).getByRole('textbox', { name: 'Nome do template' })).toHaveProperty(
      'value',
      'Valores fixos',
    );
    // Fixed values that were never filled in start empty.
    expect(within(modal).getByRole('combobox', { name: 'Valor' })).toHaveProperty('value', '');
    expect(within(modal).getByRole('textbox', { name: 'Valor' })).toHaveProperty('value', '');
  });
});
