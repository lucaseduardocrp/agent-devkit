import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PublishTestSuiteModal } from '../src/features/testplans/PublishTestSuiteModal.js';
import type {
  FieldDefinition,
  FieldMappingTemplate,
  FieldMappingTemplateInput,
} from '../src/features/field-mapping/types.js';
import type { ApiClient, TestSuiteDto } from '../src/lib/api-client.js';
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
