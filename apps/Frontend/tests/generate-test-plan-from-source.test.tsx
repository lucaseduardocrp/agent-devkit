import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActivityCenter, ActivityProvider } from '../src/features/activities/ActivityCenter.js';
import { GenerateTestPlanFromSource } from '../src/features/testplans/GenerateTestPlanFromSource.js';
import { ApiClient } from '../src/lib/api-client.js';

describe('GenerateTestPlanFromSource', () => {
  it('configures the suite and agent, then reports the generation as an activity', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getTestSuites').mockResolvedValue([
      {
        id: 'suite-1',
        workspaceId: 'workspace-1',
        name: 'Checkout',
        createdAt: '',
        updatedAt: '',
      },
    ]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([
      {
        id: 'agent-1',
        workspaceId: 'workspace-1',
        name: 'QA Writer',
        slug: 'qa-writer',
        description: '',
        instructions: '',
        role: 'QA',
        model: 'test-model',
        temperature: 0.2,
        isSystem: false,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    let resolveGeneration!: (value: { plans: []; csv: string }) => void;
    const generation = new Promise<{ plans: []; csv: string }>((resolve) => {
      resolveGeneration = resolve;
    });
    const generate = vi.spyOn(client, 'generateTestPlan').mockReturnValue(generation);
    const view = render(
      <ActivityProvider>
        <GenerateTestPlanFromSource
          apiClient={client}
          title="Checkout document"
          content="Checkout requirements"
          sourceType="brain"
          sourceId="doc-1"
        />
        <ActivityCenter />
      </ActivityProvider>,
    );

    fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));
    await waitFor(() => expect(view.getByRole('dialog')).toBeInTheDocument());
    fireEvent.change(view.getByLabelText('Test suite'), { target: { value: 'suite-1' } });
    fireEvent.change(view.getByLabelText('Selecionar agente de IA para geração de testes'), {
      target: { value: 'agent-1' },
    });
    const generateButton = view.getAllByRole('button', { name: 'Gerar testes' })[1];
    if (!generateButton) throw new Error('Generate button was not rendered.');
    fireEvent.click(generateButton);

    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith(
        'Checkout requirements',
        expect.objectContaining({ suiteId: 'suite-1', agentId: 'agent-1', sourceId: 'doc-1' }),
      ),
    );
    fireEvent.click(view.getByRole('button', { name: 'Abrir central de atividades' }));
    expect(view.getByText('Criando testes a partir de "Checkout document"')).toBeInTheDocument();

    resolveGeneration({ plans: [], csv: '' });
    await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
  });
});
