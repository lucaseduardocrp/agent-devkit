import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import type { AgentWorkflowDto } from '../src/features/agents/agent-types.js';
import { ApiClient } from '../src/lib/api-client.js';

const emptyWorkflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};

const oneStep: AgentWorkflowDto = {
  ...emptyWorkflow,
  steps: [{ id: 's1', name: 'Only', instructions: 'Go' }],
};

let client: ApiClient;

beforeEach(() => {
  client = new ApiClient();
  vi.spyOn(client, 'getAgents').mockResolvedValue([]);
  vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
  vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue(emptyWorkflow);
  vi.spyOn(client, 'getPbiProviders').mockResolvedValue([]);
  vi.spyOn(client, 'getTestManagementProviders').mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openWorkflow() {
  const view = render(
    <AgentsView apiClient={client} activeWorkspaceId="ws-1" section="workflow" />,
  );
  await view.findByTestId('workflow-panel');
  await waitFor(() => expect(client.getAgentWorkflow).toHaveBeenCalled());
  await waitFor(() => expect(view.queryByTestId('workflow-board')).not.toBeNull());
  return view;
}

/** jsdom has no PointerEvent, so a click on a canvas node is a mouse event carrying the pointer name. */
function openCanvasNode(id: string) {
  const target = screen.getByTestId(`workflow-node-${id}`);
  for (const type of ['pointerdown', 'pointerup'])
    fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true }));
}

const save = (view: Awaited<ReturnType<typeof openWorkflow>>) =>
  fireEvent.click(view.getByTestId('workflow-save-button'));

describe('AgentsView workflow saving', () => {
  it('refuses to save an enabled workflow with no step or rule', async () => {
    const view = await openWorkflow();
    // Any edit unlocks the save button; a delay node leaves the workflow without steps.
    fireEvent.click(view.getByTestId('workflow-add-delay'));
    save(view);
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Adicione pelo menos uma etapa para ativar o workflow.',
    );
  });

  it('refuses a step without a name or instructions', async () => {
    const view = await openWorkflow();
    fireEvent.click(view.getByTestId('workflow-add-step'));
    save(view);
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Cada etapa precisa de um nome e de instruções.',
    );
  });

  it('refuses a rule without a name', async () => {
    const view = await openWorkflow();
    fireEvent.click(view.getByTestId('workflow-add-rule'));
    fireEvent.click(screen.getByTestId('workflow-rule-node-1'));
    fireEvent.change(within(screen.getByTestId('workflow-inspector')).getByLabelText('Nome'), {
      target: { value: ' ' },
    });
    save(view);
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Informe o nome da regra e uma ação para limitar provedores.',
    );
  });

  it('saves the edited workflow, and explains a failed save', async () => {
    vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue(oneStep);
    const saveWorkflow = vi
      .spyOn(client, 'saveAgentWorkflow')
      .mockRejectedValueOnce('boom')
      .mockRejectedValueOnce(new Error('Quota reached'))
      .mockImplementation(async (workflow) => workflow);
    const view = await openWorkflow();
    openCanvasNode('s1');
    fireEvent.change(
      within(screen.getByTestId('workflow-inspector')).getByLabelText('Nome da etapa'),
      { target: { value: 'Only one' } },
    );
    save(view);
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível salvar o workflow.');
    save(view);
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Quota reached'));
    save(view);
    expect(await view.findByRole('status')).toHaveTextContent('Workflow salvo.');
    expect(saveWorkflow.mock.calls[2]![0].steps[0]!.name).toBe('Only one');
  });
});

describe('AgentsView workflow access', () => {
  it('reaches the workflow from the tab bar', async () => {
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    expect(view.getByTestId('tab-workflow').className).not.toContain('font-semibold');
    fireEvent.click(view.getByTestId('tab-workflow'));
    expect(view.getByTestId('tab-workflow').className).toContain('font-semibold');
    expect(await view.findByTestId('workflow-board')).toBeInTheDocument();
  });

  it('tells a member without edit access why the workflow is read-only', async () => {
    const view = render(
      <AgentsView apiClient={client} activeWorkspaceId="ws-1" section="workflow" isReadOnly />,
    );
    expect(await view.findByText(/permissão/i)).toBeInTheDocument();
  });

  it('refuses a rule that limits providers without naming an action', async () => {
    const view = await openWorkflow();
    fireEvent.click(view.getByTestId('workflow-add-rule'));
    fireEvent.click(screen.getByTestId('workflow-rule-node-1'));
    const inspector = () => within(screen.getByTestId('workflow-inspector'));
    fireEvent.change(inspector().getByLabelText('Ação MCP'), { target: { value: 'e2e_run' } });
    fireEvent.change(inspector().getByPlaceholderText('Todos os provedores'), {
      target: { value: 'github' },
    });
    fireEvent.change(inspector().getByLabelText('Ação MCP'), { target: { value: '' } });
    save(view);
    expect(await view.findByRole('alert')).toHaveTextContent(
      'Informe o nome da regra e uma ação para limitar provedores.',
    );
  });
});

describe('AgentsView workflow loading', () => {
  it('shows why the workflow could not load and loads it again on retry', async () => {
    vi.spyOn(client, 'getAgentWorkflow')
      .mockRejectedValueOnce(new Error('Server down'))
      .mockRejectedValueOnce('down')
      .mockResolvedValueOnce(oneStep);
    const view = render(
      <AgentsView apiClient={client} activeWorkspaceId="ws-1" section="workflow" />,
    );
    expect(await view.findByRole('alert')).toHaveTextContent('Server down');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Não foi possível carregar o workflow.'),
    );
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    expect(view.getByTestId('workflow-node-s1')).toBeInTheDocument();
  });
});
