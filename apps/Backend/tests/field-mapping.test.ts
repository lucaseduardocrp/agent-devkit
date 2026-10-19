import { describe, expect, it } from 'vitest';
import {
  InMemoryFieldMappingStore,
  mergeImportedFields,
  resolveFieldMapping,
  type FieldMappingTemplate,
} from '../src/modules/field-mapping/field-mapping.js';

const template: FieldMappingTemplate = {
  id: 'template',
  workspaceId: 'one',
  name: 'Azure to Trello',
  entityType: 'pbi',
  providerId: 'trello',
  scope: 'board',
  itemType: '',
  createdAt: new Date(),
  updatedAt: new Date(),
  rules: [
    {
      targetFieldId: 'classification',
      source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Classification' },
      choices: { Critical: 'red' },
    },
    {
      targetFieldId: 'hours',
      source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Hours' },
      required: true,
    },
    { targetFieldId: 'approved', source: { kind: 'constant', value: true } },
  ],
};

const fields = [
  {
    id: 'classification',
    name: 'Classification',
    type: 'single_select' as const,
    options: [{ id: 'red', name: 'Urgent' }],
  },
  { id: 'hours', name: 'Hours', type: 'number' as const },
  { id: 'approved', name: 'Approved', type: 'boolean' as const },
];

describe('custom field mapping', () => {
  it('preserves values from each imported provider and converts selections and numbers for another destination', () => {
    const sourceData = mergeImportedFields(
      {
        customFields: {
          azure_devops: { 'Custom.Classification': 'Critical', 'Custom.Hours': '2.5' },
        },
      },
      { customFields: { trello: { classification: 'old' } } },
      'trello',
    );
    expect(sourceData.customFields).toEqual({
      azure_devops: { 'Custom.Classification': 'Critical', 'Custom.Hours': '2.5' },
      trello: { classification: 'old' },
    });
    expect(
      resolveFieldMapping({ title: 'Case', description: '', sourceData }, template, fields),
    ).toEqual({
      classification: 'red',
      hours: 2.5,
      approved: true,
    });
  });

  it('fails before publishing if a required value or destination option is unavailable', () => {
    expect(() =>
      resolveFieldMapping({ title: '', description: '', sourceData: {} }, template, fields),
    ).toThrowError(/Missing value for Hours/);
    expect(() =>
      resolveFieldMapping(
        {
          title: '',
          description: '',
          sourceData: {
            customFields: {
              azure_devops: {
                'Custom.Classification': 'Other',
                'Custom.Hours': 2,
              },
            },
          },
        },
        template,
        fields,
      ),
    ).toThrowError(/Unknown option for Classification/);
    expect(() =>
      resolveFieldMapping(
        {
          title: '',
          description: '',
          sourceData: {
            customFields: {
              azure_devops: {
                'Custom.Classification': 'Critical',
                'Custom.Hours': 2,
              },
            },
          },
        },
        template,
        fields.filter((field) => field.id !== 'hours'),
      ),
    ).toThrowError(/unavailable/);
  });

  it('keeps templates isolated by workspace', async () => {
    const store = new InMemoryFieldMappingStore();
    const saved = await store.save('one', null, template);
    expect(await store.get('two', saved.id)).toBeNull();
    expect(await store.list('two')).toEqual([]);
    expect(await store.delete('two', saved.id)).toBe(false);
    expect(await store.get('one', saved.id)).toEqual(saved);
  });
});
