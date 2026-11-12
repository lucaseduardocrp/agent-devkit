import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FieldMappingEditor } from '../src/features/field-mapping/FieldMappingEditor.js';
import type {
  FieldDefinition,
  FieldMappingTemplate,
  FieldValue,
} from '../src/features/field-mapping/types.js';
import type { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const definitions: FieldDefinition[] = [
  {
    id: 'priority',
    name: 'Priority',
    type: 'single_select',
    options: [
      { id: 'p1', name: 'High' },
      { id: 'p2', name: 'Low' },
    ],
  },
  { id: 'blocked', name: 'Blocked', type: 'boolean', required: true },
  { id: 'points', name: 'Points', type: 'number' },
  { id: 'due', name: 'Due date', type: 'date' },
  { id: 'notes', name: 'Notes', type: 'text' },
];

const template: FieldMappingTemplate = {
  id: 't1',
  workspaceId: 'ws',
  name: 'Standard',
  entityType: 'test_case',
  providerId: 'azure_devops',
  scope: '',
  itemType: '',
  createdAt: '',
  updatedAt: '',
  rules: [
    { targetFieldId: 'priority', source: { kind: 'constant', value: 'p2' } },
    { targetFieldId: 'blocked', source: { kind: 'core', key: 'blocked' } },
    { targetFieldId: 'points', source: { kind: 'constant', value: 3 }, required: true },
    { targetFieldId: 'due', source: { kind: 'custom', providerId: 'azure_devops', key: 'Due' } },
    { targetFieldId: 'notes', source: { kind: 'constant' } },
    { targetFieldId: 'unknown-field', source: { kind: 'core', key: 'x' } },
  ],
};

function client(templates: FieldMappingTemplate[] = [template]) {
  return {
    getFieldMappingTemplates: vi.fn(async () => templates),
    getTestCaseFieldCatalog: vi.fn(async () => definitions),
    getPbiFieldCatalog: vi.fn(async () => definitions),
  } as unknown as ApiClient;
}

function renderEditor(
  values: Record<string, FieldValue> | undefined,
  onValuesChange: ((values: Record<string, FieldValue>) => void) | undefined,
  locale?: 'en-US',
) {
  const ui = (
    <FieldMappingEditor
      apiClient={client()}
      entityType="test_case"
      providerId="azure_devops"
      scope=""
      itemType=""
      selectedId="t1"
      onSelected={vi.fn()}
      sources={[
        {
          value: 'custom:azure_devops:Due',
          label: 'Due at the provider',
          source: { kind: 'custom', providerId: 'azure_devops', key: 'Due' },
        },
      ]}
      {...(values ? { values } : {})}
      {...(onValuesChange ? { onValuesChange } : {})}
    />
  );
  return render(locale ? <I18nProvider initialLocale={locale}>{ui}</I18nProvider> : ui);
}

describe('FieldMappingEditor value inputs', () => {
  it('shows an input for every template field typed by the destination field', async () => {
    const onValuesChange = vi.fn();
    renderEditor({ points: 8, notes: null }, onValuesChange);

    const priority = (await screen.findByLabelText(/Priority/)) as HTMLSelectElement;
    // Constant sources start from their fixed value.
    expect(priority.value).toBe('p2');
    expect(
      within(priority)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Selecione', 'High', 'Low']);

    const blocked = screen.getByLabelText(/Blocked/) as HTMLSelectElement;
    expect(blocked.value).toBe('');
    expect(within(blocked).getByRole('option', { name: /Usar origem/ })).toBeTruthy();
    expect(within(blocked).getByRole('option', { name: 'Sim' })).toBeTruthy();
    expect(screen.getAllByTitle('Obrigatório')).toHaveLength(2);

    const points = screen.getByLabelText(/Points/) as HTMLInputElement;
    expect(points.type).toBe('number');
    expect(points.value).toBe('8');
    expect((screen.getByLabelText(/Due date/) as HTMLInputElement).type).toBe('date');
    expect((screen.getByLabelText(/Due date/) as HTMLInputElement).placeholder).toBe(
      'Usar origem: Due at the provider',
    );
    const notes = screen.getByLabelText(/Notes/) as HTMLInputElement;
    expect(notes.type).toBe('text');
    expect(notes.value).toBe('');
    const unknown = screen.getByLabelText(/unknown-field/) as HTMLInputElement;
    expect(unknown.type).toBe('text');
    expect(unknown.placeholder).toBe('Usar origem: x');
  });

  it('writes typed values and drops cleared values that follow the case', async () => {
    const onValuesChange = vi.fn();
    renderEditor({ due: '2026-01-01', priority: 'p1' }, onValuesChange);

    fireEvent.change(await screen.findByLabelText(/Blocked/), { target: { value: 'true' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({
      due: '2026-01-01',
      priority: 'p1',
      blocked: 'true',
    });

    fireEvent.change(screen.getByLabelText(/Due date/), { target: { value: '' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({ priority: 'p1' });

    // A fixed value stays in the payload even when emptied, so it overrides the template.
    fireEvent.change(screen.getByLabelText(/Priority/), { target: { value: '' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({ due: '2026-01-01', priority: '' });

    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: 'hello' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({
      due: '2026-01-01',
      priority: 'p1',
      notes: 'hello',
    });
  });

  it('works without initial values and in English', async () => {
    const onValuesChange = vi.fn();
    renderEditor(undefined, onValuesChange, 'en-US');
    const blocked = (await screen.findByLabelText(/Blocked/)) as HTMLSelectElement;
    expect(within(blocked).getByRole('option', { name: 'Yes' })).toBeTruthy();
    expect(within(blocked).getByRole('option', { name: 'No' })).toBeTruthy();
    expect(screen.getAllByTitle('Required').length).toBeGreaterThan(0);
    expect(screen.getByLabelText(/Due date/).getAttribute('placeholder')).toBe(
      'Use source: Due at the provider',
    );
    expect(
      within(screen.getByLabelText(/Priority/)).getByRole('option', { name: 'Select' }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Points/), { target: { value: '5' } });
    expect(onValuesChange).toHaveBeenLastCalledWith({ points: '5' });
  });

  it('keeps the read-only summary when no value handler is given', async () => {
    renderEditor(undefined, undefined);
    expect(await screen.findByRole('list', { name: 'Campos do template' })).toBeTruthy();
  });
});

describe('FieldMappingEditor null and fixed boolean values', () => {
  it('treats null values as empty and lets fixed booleans start from the fixed value', async () => {
    const custom: FieldMappingTemplate = {
      ...template,
      rules: [
        { targetFieldId: 'priority', source: { kind: 'core', key: 'priority' } },
        { targetFieldId: 'blocked', source: { kind: 'constant', value: true } },
      ],
    };
    render(
      <FieldMappingEditor
        apiClient={client([custom])}
        entityType="pbi"
        providerId="trello"
        scope=""
        itemType=""
        selectedId="t1"
        onSelected={vi.fn()}
        sources={[]}
        values={{ priority: null }}
        onValuesChange={vi.fn()}
      />,
    );
    const priority = (await screen.findByLabelText(/Priority/)) as HTMLSelectElement;
    expect(priority.value).toBe('');
    expect(within(priority).getByRole('option', { name: 'Usar origem: priority' })).toBeTruthy();
    const blocked = screen.getByLabelText(/Blocked/) as HTMLSelectElement;
    expect(blocked.value).toBe('true');
    expect(within(blocked).getByRole('option', { name: 'Selecione' })).toBeTruthy();
  });

  it('shows an empty select for a boolean whose stored value is null', async () => {
    const custom: FieldMappingTemplate = {
      ...template,
      rules: [{ targetFieldId: 'blocked', source: { kind: 'core', key: 'blocked' } }],
    };
    render(
      <FieldMappingEditor
        apiClient={client([custom])}
        entityType="test_case"
        providerId="azure_devops"
        scope=""
        itemType=""
        selectedId="t1"
        onSelected={vi.fn()}
        sources={[]}
        values={{ blocked: null }}
        onValuesChange={vi.fn()}
      />,
    );
    expect(((await screen.findByLabelText(/Blocked/)) as HTMLSelectElement).value).toBe('');
  });
});

describe('FieldMappingEditor English fixed boolean', () => {
  it('labels the empty choice of a fixed boolean in English', async () => {
    const custom: FieldMappingTemplate = {
      ...template,
      rules: [{ targetFieldId: 'blocked', source: { kind: 'constant', value: false } }],
    };
    render(
      <I18nProvider initialLocale="en-US">
        <FieldMappingEditor
          apiClient={client([custom])}
          entityType="test_case"
          providerId="azure_devops"
          scope=""
          itemType=""
          selectedId="t1"
          onSelected={vi.fn()}
          sources={[]}
          onValuesChange={vi.fn()}
        />
      </I18nProvider>,
    );
    const blocked = (await screen.findByLabelText(/Blocked/)) as HTMLSelectElement;
    expect(within(blocked).getByRole('option', { name: 'Select' })).toBeTruthy();
    expect(blocked.value).toBe('false');
  });
});
