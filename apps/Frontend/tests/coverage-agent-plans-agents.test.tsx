import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityProvider, useActivities } from '../src/features/activities/ActivityCenter.js';
import { AgentModal } from '../src/features/agents/AgentModal.js';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import type { CustomAgentDto } from '../src/features/agents/agent-types.js';
import { ApiClient, type UserIntegrationDto } from '../src/lib/api-client.js';

const geminiModel = {
  providerId: 'gemini',
  providerLabel: 'Google Gemini',
  model: 'gemini-2.5-flash',
} as const;

const qaAgent: CustomAgentDto = {
  id: 'agent-qa',
  workspaceId: 'ws-1',
  name: 'QA Engineer',
  slug: 'qa-engineer',
  description: 'Specialized QA agent',
  instructions: '# QA Guidelines',
  role: 'QA',
  model: 'gemini-2.5-flash',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const docAgent: CustomAgentDto = {
  ...qaAgent,
  id: 'agent-doc',
  name: 'Doc Specialist',
  slug: 'doc-specialist',
  role: 'DOCUMENTATION',
};

function integration(
  providerId: string,
  settings: Record<string, unknown>,
  isEnabled = true,
): UserIntegrationDto {
  return {
    id: `integration-${providerId}`,
    category: 'LLM',
    providerId,
    isEnabled,
    settings,
    hasSecret: true,
    maskedSecret: '••••',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('AgentModal extra paths', () => {
  it('loads an agent without a model and saves the chosen parent agent', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { model: _model, ...withoutModel } = qaAgent;
    const view = render(
      <AgentModal
        isOpen
        onClose={vi.fn()}
        onSave={onSave}
        initialData={withoutModel as CustomAgentDto}
        agents={[qaAgent, docAgent]}
        availableLlmModels={[geminiModel]}
      />,
    );
    expect(view.getByLabelText<HTMLSelectElement>('Modelo LLM').value).toBe('');
    fireEvent.change(view.getByLabelText('Agente principal'), { target: { value: 'agent-doc' } });
    fireEvent.click(view.getByRole('button', { name: 'Atualizar Agente' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ model: '', parentAgentId: 'agent-doc' }),
      ),
    );
  });

  it('applies a template without a model when its model has no active integration', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(<AgentModal isOpen onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(view.getByText('Especialista em QA & BDD'));
    expect(view.getByLabelText<HTMLSelectElement>('Modelo LLM').value).toBe('');
    fireEvent.click(view.getByRole('button', { name: 'Criar Agente' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ role: 'QA', model: '' })),
    );
  });

  it('refuses a model whose integration was deactivated while the form was open', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const props = { isOpen: true, onClose: vi.fn(), onSave };
    const view = render(<AgentModal {...props} availableLlmModels={[geminiModel]} />);
    fireEvent.change(document.getElementById('agent-name')!, { target: { value: 'Writer' } });
    fireEvent.change(document.getElementById('agent-instructions')!, {
      target: { value: 'Write docs' },
    });
    fireEvent.change(view.getByLabelText('Modelo LLM'), {
      target: { value: 'gemini-2.5-flash' },
    });
    view.rerender(<AgentModal {...props} availableLlmModels={[]} />);
    fireEvent.click(view.getByRole('button', { name: 'Criar Agente' }));
    expect(
      await view.findByText('Selecione um modelo de uma integração de IA ativa.'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

function ActivityTitles() {
  const { activities } = useActivities();
  return (
    <ul data-testid="activity-titles">
      {activities.map((activity) => (
        <li key={activity.id}>{activity.title}</li>
      ))}
    </ul>
  );
}

describe('AgentsView extra paths', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([qaAgent]);
    vi.spyOn(client, 'getIssues').mockResolvedValue([]);
    vi.spyOn(client, 'getAgentRuns').mockResolvedValue([]);
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'executeAgent').mockResolvedValue({
      content: 'Done',
      agent: { id: 'agent-qa', name: 'QA Engineer', role: 'QA' },
      chunksUsed: 0,
      provider: 'Gemini',
    });
  });

  it('lists unknown providers by id, skips integrations without a model and sends the chosen provider', async () => {
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([
      integration('gemini', { model: 'gemini-2.5-flash' }),
      integration('mistral', { model: '  ' }),
      integration('ollama', {}),
    ]);
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    await waitFor(() => expect(view.getByTestId('agent-card-qa-engineer')).toBeInTheDocument());
    fireEvent.click(view.getByTestId('tab-playground'));
    const providers = view.getByTestId('playground-llm-select');
    expect(within(providers).getByRole('option', { name: 'mistral' })).toBeInTheDocument();
    expect(within(providers).getByRole('option', { name: 'Ollama' })).toBeInTheDocument();
    fireEvent.change(providers, { target: { value: 'mistral' } });

    fireEvent.change(view.getByTestId('playground-prompt-input'), {
      target: { value: 'Run it' },
    });
    fireEvent.click(view.getByTestId('playground-execute-button'));
    await waitFor(() =>
      expect(client.executeAgent).toHaveBeenCalledWith('agent-qa', {
        prompt: 'Run it',
        useKnowledge: true,
        llmProvider: 'mistral',
      }),
    );
  });

  it('executes without a provider and names a selected agent that left the list', async () => {
    vi.spyOn(client, 'getAgents').mockResolvedValueOnce([qaAgent]).mockResolvedValue([docAgent]);
    const view = render(
      <ActivityProvider>
        <AgentsView apiClient={client} activeWorkspaceId="ws-1" />
        <ActivityTitles />
      </ActivityProvider>,
    );
    await waitFor(() => expect(view.getByTestId('agent-card-qa-engineer')).toBeInTheDocument());
    // The map reloads the agents; the selected QA agent is no longer among them.
    fireEvent.click(view.getByTestId('tab-map'));
    await waitFor(() =>
      expect(view.getByTestId('topology-agent-agent-doc')).toBeInTheDocument(),
    );
    fireEvent.click(view.getByTestId('tab-playground'));
    fireEvent.change(view.getByTestId('playground-prompt-input'), {
      target: { value: 'Run it' },
    });
    fireEvent.click(view.getByTestId('playground-execute-button'));
    await waitFor(() =>
      expect(client.executeAgent).toHaveBeenCalledWith('agent-qa', {
        prompt: 'Run it',
        useKnowledge: true,
      }),
    );
    expect(view.getByTestId('activity-titles').textContent).toBe('Agente  trabalhando');
  });

  it('shows map load failures and treats an unexpected agent payload as empty', async () => {
    vi.spyOn(client, 'getAgents')
      .mockResolvedValueOnce([qaAgent])
      .mockRejectedValueOnce(new Error('Map offline'))
      .mockRejectedValueOnce('boom')
      .mockResolvedValueOnce({ unexpected: true } as never);
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    await waitFor(() => expect(view.getByTestId('agent-card-qa-engineer')).toBeInTheDocument());
    fireEvent.click(view.getByTestId('tab-map'));
    expect(await view.findByText(/Map offline/)).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Atualizar' }));
    expect(await view.findByText(/Não foi possível carregar o mapa\./)).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() =>
      expect(view.queryByTestId('topology-agent-agent-qa')).not.toBeInTheDocument(),
    );
    expect(client.getAgents).toHaveBeenCalledTimes(4);
  });

  it('does not load the map without an active workspace', () => {
    const view = render(<AgentsView apiClient={client} activeWorkspaceId={null} />);
    fireEvent.click(view.getByTestId('tab-map'));
    expect(client.getAgents).not.toHaveBeenCalled();
    expect(client.getIssues).not.toHaveBeenCalled();
  });
});
