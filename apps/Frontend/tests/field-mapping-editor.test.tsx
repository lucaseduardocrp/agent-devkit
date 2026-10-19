import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FieldMappingEditor } from '../src/features/field-mapping/FieldMappingEditor.js';
import type { FieldMappingTemplate } from '../src/features/field-mapping/types.js';
import type { ApiClient } from '../src/lib/api-client.js';

describe('FieldMappingEditor', () => {
  it('saves a template that converts an imported value to a destination option', async () => {
    const save = vi.fn(
      async (
        input: Omit<FieldMappingTemplate, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'>,
      ) => ({
        ...input,
        id: 'template-1',
        workspaceId: 'ws',
        createdAt: '',
        updatedAt: '',
      }),
    );
    const apiClient = {
      getFieldMappingTemplates: vi.fn(async () => []),
      getPbiFieldCatalog: vi.fn(async () => [
        {
          id: 'classification',
          name: 'Classification',
          type: 'single_select',
          options: [{ id: 'urgent', name: 'Urgent' }],
        },
      ]),
      saveFieldMappingTemplate: save,
    } as unknown as ApiClient;
    const selected = vi.fn();
    render(
      <FieldMappingEditor
        apiClient={apiClient}
        entityType="pbi"
        providerId="trello"
        scope="board-1"
        itemType=""
        selectedId=""
        onSelected={selected}
        sources={[
          {
            value: 'custom:azure_devops:Custom.Classification',
            label: 'Azure classification',
            source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Classification' },
          },
        ]}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /New template|Novo template/ }));
    await screen.findByText('Classification');
    fireEvent.change(screen.getByLabelText(/Template name|Nome do template/), {
      target: { value: 'Azure to Trello' },
    });
    fireEvent.change(screen.getByLabelText(/Classification/), {
      target: { value: 'custom:azure_devops:Custom.Classification' },
    });
    fireEvent.change(screen.getByLabelText(/New source value|Novo valor de origem/), {
      target: { value: 'Critical' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add value|Adicionar valor/ }));
    fireEvent.change(screen.getByLabelText(/Target value|Valor de destino/), {
      target: { value: 'urgent' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save template|Salvar template/ }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Azure to Trello',
          providerId: 'trello',
          scope: 'board-1',
          rules: [
            {
              targetFieldId: 'classification',
              source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Classification' },
              choices: { Critical: 'urgent' },
            },
          ],
        }),
        undefined,
      ),
    );
    expect(selected).toHaveBeenCalledWith('template-1');
  });
});
