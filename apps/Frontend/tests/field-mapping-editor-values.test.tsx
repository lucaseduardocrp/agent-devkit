import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FieldMappingEditor } from '../src/features/field-mapping/FieldMappingEditor.js';
import type { ApiClient } from '../src/lib/api-client.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const custom = { kind: 'custom', providerId: 'azure_devops', key: 'Custom.A' } as const;

const template = {
  id: 'tpl-1',
  workspaceId: 'ws-1',
  entityType: 'pbi',
  providerId: 'trello',
  name: 'Template',
  createdAt: '',
  updatedAt: '',
  rules: [
    { targetFieldId: 'kind', source: custom },
    { targetFieldId: 'done', source: custom },
    { targetFieldId: 'points', source: { kind: 'constant', value: 3 }, required: true },
    { targetFieldId: 'due', source: custom },
    { targetFieldId: 'note', source: custom },
    { targetFieldId: 'fixedKind', source: { kind: 'constant', value: 'a' } },
    { targetFieldId: 'ghost', source: custom },
    { targetFieldId: 'doneFixed', source: { kind: 'constant' } },
  ],
};

const catalog = [
  { id: 'kind', name: 'Kind', type: 'text', options: [{ id: 'bug', name: 'Bug' }] },
  { id: 'done', name: 'Done', type: 'boolean' },
  { id: 'doneFixed', name: 'Done fixed', type: 'boolean' },
  { id: 'points', name: 'Points', type: 'number' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'note', name: 'Note', type: 'text' },
  { id: 'fixedKind', name: 'Fixed kind', type: 'text', options: [{ id: 'a', name: 'Alpha' }] },
];

// Created once: a new client on every render would reload the templates forever.
const apiClient = {
  getFieldMappingTemplates: vi.fn(async () => [template]),
  getPbiFieldCatalog: vi.fn(async () => catalog),
} as unknown as ApiClient;

function Harness({
  onValues,
  locale,
}: {
  onValues: (values: Record<string, unknown>) => void;
  locale: 'en-US' | 'pt-BR';
}) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  return (
    <I18nProvider initialLocale={locale}>
      <FieldMappingEditor
        apiClient={apiClient}
        entityType="pbi"
        providerId="trello"
        scope=""
        itemType=""
        selectedId="tpl-1"
        onSelected={() => undefined}
        sources={[{ value: 'a', label: 'Source A', source: custom }]}
        values={values}
        onValuesChange={(next) => {
          setValues(next as Record<string, string | number | boolean>);
          onValues(next);
        }}
      />
    </I18nProvider>
  );
}

/** The label wraps its control and carries the field name and id as its title. */
const control = (name: string): HTMLElement => {
  const id = { 'Fixed kind': 'fixedKind', 'Done fixed': 'doneFixed' }[name] ?? name.toLowerCase();
  return screen.getByTitle(`${name} (${id})`).closest('label')!.querySelector('select,input')!;
};

describe('FieldMappingEditor field inputs', () => {
  it.each(['en-US', 'pt-BR'] as const)(
    'gives each template field the control of its type and reports what is typed in %s',
    async (locale) => {
      const onValues = vi.fn();
      render(<Harness onValues={onValues} locale={locale} />);
      await screen.findByTitle('Kind (kind)');

      // Options and booleans are selects; a field filled from the case offers its source.
      fireEvent.change(control('Kind'), { target: { value: 'bug' } });
      expect(onValues).toHaveBeenLastCalledWith({ kind: 'bug' });
      fireEvent.change(control('Kind'), { target: { value: '' } });
      expect(onValues).toHaveBeenLastCalledWith({});
      fireEvent.change(control('Done'), { target: { value: 'true' } });
      expect(onValues).toHaveBeenLastCalledWith({ done: 'true' });

      // Text inputs follow the field type.
      expect(control('Points')).toHaveAttribute('type', 'number');
      expect(control('Due')).toHaveAttribute('type', 'date');
      expect(control('Note')).toHaveAttribute('type', 'text');
      fireEvent.change(control('Note'), { target: { value: 'hello' } });
      expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ note: 'hello' }));

      // A fixed value stays when cleared, and the required marker shows.
      fireEvent.change(control('Fixed kind'), { target: { value: '' } });
      expect(onValues).toHaveBeenLastCalledWith(expect.objectContaining({ fixedKind: '' }));
      expect(
        screen.getAllByTitle(locale === 'pt-BR' ? 'Obrigatório' : 'Required').length,
      ).toBeGreaterThan(0);

      // A fixed boolean with no value yet offers the plain prompt.
      expect((control('Done fixed') as HTMLSelectElement).value).toBe('');

      // A field the destination no longer has keeps its id as its name.
      expect(screen.getByTitle('ghost (ghost)')).toBeInTheDocument();
    },
  );
});
