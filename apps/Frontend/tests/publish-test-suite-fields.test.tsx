import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PublishTestSuiteModal } from '../src/features/testplans/PublishTestSuiteModal.js';
import type {
  FieldDefinition,
  FieldMappingTemplate,
  FieldMappingTemplateInput,
} from '../src/features/field-mapping/types.js';
import type { ApiClient, TestSuiteDto } from '../src/lib/api-client.js';
import type { PbiItem, PbiLink } from '../src/features/pbi/pbi-types.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const suite = { id: 'suite-1', name: 'Regression' } as TestSuiteDto;

const template: FieldMappingTemplate = {
  id: 'tpl-1',
  workspaceId: 'ws',
  name: 'Casos Acme',
  entityType: 'test_case',
  providerId: 'azure_devops',
  scope: '',
  itemType: 'Test Case',
  createdAt: '',
  updatedAt: '',
  rules: [
    { targetFieldId: 'Custom.Flow', source: { kind: 'constant', value: 'Principal' } },
    { targetFieldId: 'Custom.Area', source: { kind: 'core', key: 'description' } },
    { targetFieldId: 'Custom.Kind', source: { kind: 'core', key: 'title' } },
    { targetFieldId: 'Custom.Gone', source: { kind: 'constant' } },
  ],
};

const catalog: FieldDefinition[] = [
  {
    id: 'Custom.Flow',
    name: 'Fluxo do usuário',
    type: 'single_select',
    options: [
      { id: 'Principal', name: 'Principal' },
      { id: 'Exceção', name: 'Exceção' },
    ],
  },
  { id: 'Custom.Area', name: 'Área', type: 'text' },
  { id: 'Custom.Kind', name: 'Tipo', type: 'single_select', options: [{ id: 'UI', name: 'UI' }] },
];

/** The board: two Azure DevOps items, one from Trello and one only in ADK. */
const boardItems: PbiItem[] = [
  boardItem('p1', 'Cores', 'Product Backlog Item', [['azure_devops', '50059']]),
  boardItem('p2', 'Ajustar API', 'Task', [['azure_devops', '60']]),
  boardItem('p3', 'Cartão do Trello', '', [['trello', 'abc']]),
  boardItem('p4', 'Só no ADK', '', []),
];

function boardItem(
  id: string,
  title: string,
  type: string,
  links: [PbiLink['providerId'], string][],
): PbiItem {
  return {
    id,
    workspaceId: 'ws',
    parentId: null,
    kind: 'pbi',
    title,
    description: '',
    status: 'New',
    position: 0,
    sourceData: type ? { type } : {},
    links: links.map(([providerId, externalId]) => ({
      id: id + '-' + providerId,
      providerId,
      externalId,
      externalUrl: null,
      boardId: null,
      syncedAt: '',
    })),
    createdAt: '',
    updatedAt: '',
    partial: true,
  };
}

function client(templates: FieldMappingTemplate[] = [template]) {
  return {
    getTestSuiteFieldSources: vi.fn().mockResolvedValue([]),
    getTestSuiteProviders: vi
      .fn()
      .mockResolvedValue([{ id: 'azure_devops', name: 'Azure DevOps', configured: true }]),
    getRemoteTestPlans: vi.fn().mockResolvedValue([{ id: '7', name: 'Regression plan' }]),
    getRemoteTestSuites: vi.fn().mockResolvedValue([]),
    getFieldMappingTemplates: vi.fn().mockResolvedValue(templates),
    getTestCaseFieldCatalog: vi.fn().mockResolvedValue(catalog),
    previewTestSuiteFields: vi.fn().mockResolvedValue({ count: 1, previews: [] }),
    getPbiItems: vi.fn().mockResolvedValue(boardItems),
    saveFieldMappingTemplate: vi.fn(async (input: FieldMappingTemplateInput, id?: string) => ({
      ...template,
      ...input,
      id: id ?? 'tpl-new',
    })),
  };
}

function open(api: ReturnType<typeof client>, onPublish = vi.fn()) {
  render(
    <PublishTestSuiteModal
      apiClient={api as unknown as ApiClient}
      suite={suite}
      onClose={vi.fn()}
      onPublish={onPublish}
      onPublished={vi.fn()}
    />,
  );
  return screen.getByRole('dialog');
}

describe('PublishTestSuiteModal field values', () => {
  it('fills the template fields last and publishes the typed values', async () => {
    const api = client();
    api.previewTestSuiteFields.mockResolvedValue({
      count: 1,
      previews: [{ title: 'Login', values: { 'Custom.Flow': 'Principal', Tags: ['a', 'b'] } }],
    });
    const onPublish = vi.fn().mockResolvedValue({ remoteUrl: 'https://example.com' });
    const dialog = open(api, onPublish);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    const plan = await within(dialog).findByLabelText('Test Plan de destino');
    const region = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    // The template comes after the destination fields.
    expect(plan.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'new' } });

    fireEvent.change(await within(region).findByRole('combobox', { name: 'Template salvo' }), {
      target: { value: 'tpl-1' },
    });
    expect(api.previewTestSuiteFields).toHaveBeenLastCalledWith(
      'suite-1',
      'azure_devops',
      'tpl-1',
      undefined,
    );
    expect(
      await within(dialog).findByText('Login: Custom.Flow=Principal · Tags=a, b'),
    ).toBeInTheDocument();
    // Every template field gets an input, starting from the template value.
    const flow = within(region).getByRole('combobox', { name: /Fluxo do usuário/ });
    expect(flow).toHaveProperty('value', 'Principal');
    const area = within(region).getByRole('textbox', { name: /Área/ });
    expect(area).toHaveAttribute('placeholder', 'Usar origem: Description');
    const kind = within(region).getByRole('combobox', { name: /Tipo/ });
    expect(within(kind).getAllByRole('option')[0]).toHaveTextContent('Usar origem: Title');
    // A field missing from the catalog falls back to its id and free text.
    expect(within(region).getByRole('textbox', { name: /Custom\.Gone/ })).toHaveProperty(
      'value',
      '',
    );
    expect(within(region).queryByRole('list')).not.toBeInTheDocument();

    fireEvent.change(flow, { target: { value: 'Exceção' } });
    fireEvent.change(area, { target: { value: 'Web' } });
    fireEvent.change(area, { target: { value: '' } });
    fireEvent.change(kind, { target: { value: 'UI' } });
    expect(flow).toHaveProperty('value', 'Exceção');
    expect(within(dialog).getByRole('button', { name: 'Publicar suite' })).toHaveProperty(
      'disabled',
      true,
    );
    // The preview waits for the typing to settle.
    await waitFor(() =>
      expect(api.previewTestSuiteFields).toHaveBeenLastCalledWith(
        'suite-1',
        'azure_devops',
        'tpl-1',
        { 'Custom.Flow': 'Exceção', 'Custom.Kind': 'UI' },
      ),
    );
    expect(api.previewTestSuiteFields).toHaveBeenCalledTimes(2);

    const publish = within(dialog).getByRole('button', { name: 'Publicar suite' });
    await waitFor(() => expect(publish).toHaveProperty('disabled', false));
    fireEvent.click(publish);
    await waitFor(() =>
      expect(onPublish).toHaveBeenCalledWith({
        providerId: 'azure_devops',
        templateId: 'tpl-1',
        fieldValues: { 'Custom.Flow': 'Exceção', 'Custom.Kind': 'UI' },
        suiteKind: 'static',
      }),
    );
  });

  it('clears the typed values when the template changes or is saved again', async () => {
    const api = client();
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    const region = await within(dialog).findByRole('region', { name: 'Mapeamento de campos' });
    const picker = await within(region).findByRole('combobox', { name: 'Template salvo' });
    fireEvent.change(picker, { target: { value: 'tpl-1' } });
    const flow = () => within(region).getByRole('combobox', { name: /Fluxo do usuário/ });
    // Choosing "Selecione" keeps an empty fixed value instead of the template one.
    fireEvent.change(flow(), { target: { value: '' } });
    expect(flow()).toHaveProperty('value', '');

    fireEvent.change(picker, { target: { value: '' } });
    fireEvent.change(picker, { target: { value: 'tpl-1' } });
    expect(flow()).toHaveProperty('value', 'Principal');

    fireEvent.change(flow(), { target: { value: 'Exceção' } });
    fireEvent.click(within(region).getByRole('button', { name: 'Editar' }));
    const modal = screen.getByRole('dialog', { name: 'Editar template de campos' });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar template' }));
    await waitFor(() => expect(flow()).toHaveProperty('value', 'Principal'));
    await waitFor(() =>
      expect(api.previewTestSuiteFields).toHaveBeenLastCalledWith(
        'suite-1',
        'azure_devops',
        'tpl-1',
        undefined,
      ),
    );
  });

  it('labels the inputs in English and reports preview failures', async () => {
    const api = client([
      {
        ...template,
        rules: [
          { targetFieldId: 'Custom.Flow', source: { kind: 'constant' } },
          { targetFieldId: 'Custom.Area', source: { kind: 'core', key: 'description' } },
        ],
      },
    ]);
    api.previewTestSuiteFields
      .mockRejectedValueOnce(new Error('Missing value for Fluxo do usuário.'))
      .mockRejectedValueOnce('provider offline');
    render(
      <I18nProvider initialLocale="en-US">
        <PublishTestSuiteModal
          apiClient={api as unknown as ApiClient}
          suite={suite}
          onClose={vi.fn()}
          onPublish={vi.fn()}
          onPublished={vi.fn()}
        />
      </I18nProvider>,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Provider'), {
      target: { value: 'azure_devops' },
    });
    const region = await within(dialog).findByRole('region', { name: 'Field mapping' });
    fireEvent.change(await within(region).findByRole('combobox', { name: 'Saved template' }), {
      target: { value: 'tpl-1' },
    });
    const flow = within(region).getByRole('combobox', { name: /Fluxo do usuário/ });
    // A fixed value that was never filled in starts empty.
    expect(flow).toHaveProperty('value', '');
    expect(within(flow).getAllByRole('option')[0]).toHaveTextContent('Select');
    expect(within(region).getByRole('textbox', { name: /Área/ })).toHaveAttribute(
      'placeholder',
      'Use source: Description',
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Missing value for Fluxo do usuário.',
    );
    fireEvent.change(flow, { target: { value: 'Principal' } });
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('provider offline'),
    );
    expect(within(dialog).getByRole('button', { name: 'Publish suite' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('PublishTestSuiteModal suite kind', () => {
  const choose = async (dialog: HTMLElement, label: string, option: string) => {
    fireEvent.focus(await within(dialog).findByRole('combobox', { name: label }));
    fireEvent.click(within(dialog).getByRole('option', { name: new RegExp(option) }));
  };

  it('explains each field in a tooltip next to its label', async () => {
    const dialog = open(client());
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    const hint = within(dialog).getByText(/cada test case recebe um vínculo "Tests"/);
    // The text is the icon's description, shown only on hover or focus.
    expect(hint).toHaveAttribute('role', 'tooltip');
    expect(hint.className).toContain('sr-only');
    const icon = within(hint.parentElement!).getByRole('button', { name: 'Mais informações' });
    expect(icon).toHaveAttribute('aria-describedby', hint.id);
    fireEvent.mouseEnter(hint.parentElement!);
    expect(hint.className).not.toContain('sr-only');
    fireEvent.mouseLeave(hint.parentElement!);
    fireEvent.focus(icon);
    expect(hint.className).not.toContain('sr-only');
    fireEvent.keyDown(icon, { key: 'Escape' });
    expect(hint.className).toContain('sr-only');

    fireEvent.change(within(dialog).getByLabelText('Tipo da suite'), {
      target: { value: 'requirement' },
    });
    expect(within(dialog).getByText(/O Azure cria uma suite por work item/)).toHaveAttribute(
      'role',
      'tooltip',
    );
  });

  it('creates Requirement Based Suites for the board items chosen', async () => {
    const api = client();
    api.getRemoteTestSuites.mockResolvedValue([
      { id: '11', name: 'Root', suiteType: 'staticTestSuite' },
    ]);
    const onPublish = vi.fn().mockResolvedValue({ remoteUrl: 'https://example.com' });
    const dialog = open(api, onPublish);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    const publish = within(dialog).getByRole('button', { name: 'Publicar suite' });
    fireEvent.change(within(dialog).getByLabelText('Tipo da suite'), {
      target: { value: 'requirement' },
    });
    expect(publish).toHaveProperty('disabled', true);

    // Only the items of the chosen provider's board are offered.
    fireEvent.focus(await within(dialog).findByRole('combobox', { name: 'Work items vinculados' }));
    expect(
      within(within(dialog).getByRole('listbox'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['#50059 · CoresProduct Backlog Item · New', '#60 · Ajustar APITask · New']);
    fireEvent.click(within(dialog).getByRole('option', { name: /#50059/ }));
    fireEvent.click(within(dialog).getByRole('option', { name: /#60/ }));
    expect(within(dialog).getByRole('option', { name: /#60/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(publish).toHaveProperty('disabled', false);
    // A chosen item can be removed from its chip.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover #60 · Ajustar API' }));
    expect(within(dialog).queryByRole('button', { name: /Remover #60/ })).toBeNull();

    // Inside an existing static suite, the requirement suite takes the item's name.
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    fireEvent.change(await within(dialog).findByLabelText('Suite de destino'), {
      target: { value: '11' },
    });
    fireEvent.change(within(dialog).getByLabelText('Onde adicionar os casos'), {
      target: { value: 'child' },
    });
    expect(within(dialog).queryByLabelText('Nome da nova suite')).toBeNull();
    fireEvent.click(publish);
    await waitFor(() =>
      expect(onPublish).toHaveBeenCalledWith({
        providerId: 'azure_devops',
        suiteKind: 'requirement',
        workItemIds: ['50059'],
        remotePlanId: '7',
        remoteParentSuiteId: '11',
      }),
    );
    expect(api.getPbiItems).toHaveBeenCalledOnce();
  });

  it('links cases added straight into a suite to optional work items', async () => {
    const api = client();
    api.getRemoteTestSuites.mockResolvedValue([
      { id: '11', name: 'Root', suiteType: 'staticTestSuite' },
    ]);
    const onPublish = vi.fn().mockResolvedValue({ remoteUrl: 'https://example.com' });
    const dialog = open(api, onPublish);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    fireEvent.change(within(dialog).getByLabelText('Destino'), { target: { value: 'existing' } });
    fireEvent.change(await within(dialog).findByLabelText('Test Plan de destino'), {
      target: { value: '7' },
    });
    fireEvent.change(await within(dialog).findByLabelText('Suite de destino'), {
      target: { value: '11' },
    });
    // Adding to an existing suite creates none: there is no kind to choose.
    expect(within(dialog).queryByLabelText('Tipo da suite')).toBeNull();
    // The search finds an item by its title, and Enter picks it.
    const search = await within(dialog).findByRole('combobox', {
      name: 'Work items vinculados (opcional)',
    });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: 'api' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await choose(dialog, 'Work items vinculados (opcional)', '#50059');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publicar suite' }));
    await waitFor(() =>
      expect(onPublish).toHaveBeenCalledWith({
        providerId: 'azure_devops',
        workItemIds: ['60', '50059'],
        remotePlanId: '7',
        remoteSuiteId: '11',
      }),
    );
  });

  it('tells when the board has no items of the provider', async () => {
    const api = client();
    api.getPbiItems.mockResolvedValue(boardItems.slice(2));
    const dialog = open(api);
    fireEvent.change(await within(dialog).findByLabelText('Provedor'), {
      target: { value: 'azure_devops' },
    });
    expect(
      await within(dialog).findByText(
        'Ainda não há itens do Azure DevOps em PBIs. Faça o pull do board na tela de PBIs.',
      ),
    ).toBeInTheDocument();
  });
});
