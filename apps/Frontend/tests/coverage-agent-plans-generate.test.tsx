import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import { GenerateTestPlanFromSource } from '../src/features/testplans/GenerateTestPlanFromSource.js';
import { ApiClient } from '../src/lib/api-client.js';

const suite = { id: 'suite-1', workspaceId: 'w', name: 'Checkout', createdAt: '', updatedAt: '' };
const agent = { id: 'agent-1', name: 'QA Writer' } as CustomAgentDto;

function renderGenerator(client: ApiClient) {
  return render(
    <GenerateTestPlanFromSource
      apiClient={client}
      title="Checkout document"
      content="Checkout requirements"
      sourceType="spec"
      sourceId="spec-1"
    />,
  );
}

async function chooseAndGenerate(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));
  const dialog = await view.findByRole('dialog');
  await within(dialog).findByRole('option', { name: 'Checkout' });
  fireEvent.change(within(dialog).getByLabelText('Test suite'), { target: { value: 'suite-1' } });
  fireEvent.change(
    within(dialog).getByLabelText('Selecionar agente de IA para geração de testes'),
    { target: { value: 'agent-1' } },
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Gerar testes' }));
}

describe('GenerateTestPlanFromSource dialog', () => {
  it('reports load failures, explains empty choices and can be cancelled', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getTestSuites')
      .mockRejectedValueOnce(new Error('Suites offline'))
      .mockRejectedValueOnce('offline')
      .mockResolvedValueOnce([]);
    const view = renderGenerator(client);

    fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Suites offline');
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByRole('dialog')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));
    expect(await view.findByRole('alert')).toHaveTextContent('Falha de conexão com o servidor.');
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));

    fireEvent.click(view.getByRole('button', { name: 'Gerar testes' }));
    const dialog = await view.findByRole('dialog');
    expect(
      await within(dialog).findByText('Crie uma test suite antes de gerar os testes.'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText('Nenhum agente disponível. Crie um agente antes de continuar.'),
    ).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
    const generate = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Gerar testes',
    });
    expect(generate.disabled).toBe(true);
  });

  it('shows dismissible success and failure notifications', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getTestSuites').mockResolvedValue([suite]);
    vi.spyOn(client, 'getAgents').mockResolvedValue([agent]);
    const generate = vi
      .spyOn(client, 'generateTestPlan')
      .mockResolvedValueOnce({ plans: [{}, {}], csv: '' } as never)
      .mockRejectedValueOnce(new Error('Model offline'))
      .mockRejectedValueOnce('offline');
    const view = renderGenerator(client);

    await chooseAndGenerate(view);
    const success = await view.findByRole('status');
    expect(success).toHaveTextContent('2 casos de teste gerados');
    expect(generate).toHaveBeenCalledWith('Checkout requirements', {
      title: 'Checkout document',
      sourceType: 'spec',
      sourceId: 'spec-1',
      suiteId: 'suite-1',
      agentId: 'agent-1',
    });
    fireEvent.click(within(success).getByRole('button', { name: 'Fechar notificação' }));
    expect(view.queryByRole('status')).toBeNull();

    await chooseAndGenerate(view);
    const failure = await view.findByRole('alert');
    expect(failure).toHaveTextContent('Model offline');
    fireEvent.click(within(failure).getByRole('button', { name: 'Fechar notificação' }));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());

    await chooseAndGenerate(view);
    expect(await view.findByRole('alert')).toHaveTextContent('Falha de conexão com o servidor.');
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
