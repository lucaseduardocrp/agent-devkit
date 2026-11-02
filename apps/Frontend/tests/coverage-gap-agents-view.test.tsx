import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import { ApiClient } from '../src/lib/api-client.js';

const agent = (id: string, name: string, extra: Partial<CustomAgentDto> = {}): CustomAgentDto => ({
  id,
  workspaceId: 'ws-1',
  name,
  slug: id,
  description: `${name} description`,
  instructions: '# Do it',
  role: 'QA',
  model: 'gemini-2.5-flash',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...extra,
});

const agents = [
  agent('agent-hub', 'Hub Agent', {
    source: { kind: 'hub-agent', name: 'qa-test-designer', version: '1.0.0', revision: 'r' },
    skills: [
      { name: 'test-design', description: '', version: '1.0.0', revision: 'a' },
      { name: 'edge-hunter', description: '', version: '1.0.0', revision: 'b' },
    ],
  }),
  agent('agent-plugin', 'Plugin Agent', {
    source: {
      kind: 'hub-plugin',
      plugin: 'jira-qa',
      name: 'jira-reviewer',
      version: '2.0.0',
      revision: 'r',
    },
    skills: [],
  }),
];

const emptyWorkflow: AgentWorkflowDto = {
  enabled: false,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};

let client: ApiClient;

beforeEach(() => {
  client = new ApiClient();
  vi.spyOn(client, 'getAgents').mockResolvedValue(agents);
  vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
  vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue(emptyWorkflow);
  vi.spyOn(client, 'getPbiProviders').mockResolvedValue([
    { providerId: 'azure-devops', settings: {} },
  ] as never);
  vi.spyOn(client, 'getTestManagementProviders').mockResolvedValue([
    { id: 'azure-devops', configured: true },
    { id: 'testrail', configured: true },
    { id: 'xray', configured: false },
  ] as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openWorkflow(isReadOnly = false) {
  const view = render(
    <AgentsView apiClient={client} activeWorkspaceId="ws-1" isReadOnly={isReadOnly} />,
  );
  fireEvent.click(view.getByTestId('tab-workflow'));
  await view.findByTestId('workflow-panel');
  await waitFor(() => expect(client.getAgentWorkflow).toHaveBeenCalled());
  return view;
}

/** The board opens a node's fields in a modal, so they live outside the panel. */
function inspector() {
  return screen.getByTestId('workflow-inspector');
}

function openNode(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
  return inspector();
}

function closeInspector() {
  fireEvent.click(within(inspector()).getByRole('button', { name: 'Fechar' }));
}

function fillStep(testId: string, name: string, instructions: string) {
  const pane = openNode(testId);
  fireEvent.change(within(pane).getByLabelText('Nome da etapa'), { target: { value: name } });
  fireEvent.change(within(pane).getByLabelText('Instruções da etapa'), {
    target: { value: instructions },
  });
  return pane;
}

const providerField = () => within(inspector()).getByPlaceholderText('Todos os provedores');

describe('AgentsView workflow editor', () => {
  it('builds, validates and saves steps and module rules', async () => {
    const save = vi
      .spyOn(client, 'saveAgentWorkflow')
      .mockImplementation(async (workflow) => workflow)
      .mockRejectedValueOnce('boom');
    const view = await openWorkflow();
    const panel = view.getByTestId('workflow-panel');

    // Enabling without steps or rules is rejected.
    fireEvent.click(view.getByTestId('workflow-enabled-toggle'));
    expect(view.getByTestId('workflow-enabled-toggle')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(view.getByTestId('workflow-save-button'));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Adicione pelo menos uma etapa para ativar o workflow.',
    );

    // The controls of the whole workflow sit on the setup node.
    const setup = openNode('workflow-settings-node');
    fireEvent.change(within(setup).getByLabelText('Autonomia do agente'), {
      target: { value: 'autonomous' },
    });
    fireEvent.change(within(inspector()).getByLabelText('Quando faltar informação'), {
      target: { value: 'assume' },
    });
    fireEvent.change(within(inspector()).getByLabelText('Criação de Issues por agentes MCP'), {
      target: { value: 'allow' },
    });
    fireEvent.change(within(inspector()).getByLabelText('Ações não configuradas'), {
      target: { value: 'deny' },
    });
    fireEvent.click(
      within(inspector()).getByRole('switch', { name: 'Exigir aprovação do resultado final' }),
    );
    closeInspector();

    // Steps: an incomplete step is rejected.
    fireEvent.click(within(panel).getByTestId('workflow-add-step'));
    fireEvent.click(within(panel).getByTestId('workflow-add-step'));
    fireEvent.click(view.getByTestId('workflow-save-button'));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Cada etapa precisa de um nome e de instruções.',
    );

    const first = fillStep('workflow-step-node-1', 'Analysis', 'Analyse it');
    fireEvent.change(within(first).getByLabelText('Agente responsável'), {
      target: { value: 'agent-hub' },
    });
    fireEvent.change(within(inspector()).getByLabelText('Agente responsável'), {
      target: { value: '' },
    });
    closeInspector();
    const second = fillStep('workflow-step-node-2', 'Review', 'Review it');
    fireEvent.change(within(second).getByLabelText('Agente responsável'), {
      target: { value: 'agent-plugin' },
    });
    fireEvent.click(
      within(inspector()).getByRole('switch', {
        name: 'Pedir minha aprovação antes da próxima etapa',
      }),
    );
    closeInspector();

    // A third step is added, then removed from its own node.
    fireEvent.click(within(panel).getByTestId('workflow-add-step'));
    openNode('workflow-step-node-3');
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Remover etapa 3' }));
    expect(within(panel).queryByTestId('workflow-step-node-3')).toBeNull();

    // Rules.
    fireEvent.click(within(panel).getByTestId('workflow-add-rule'));
    fireEvent.click(within(panel).getByTestId('workflow-add-rule'));
    const rule = openNode('workflow-rule-node-1');
    fireEvent.change(within(rule).getByLabelText('Nome'), { target: { value: ' ' } });
    closeInspector();
    fireEvent.click(view.getByTestId('workflow-save-button'));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Informe o nome da regra e uma ação para limitar provedores.',
    );

    openNode('workflow-rule-node-1');
    fireEvent.change(within(inspector()).getByLabelText('Nome'), {
      target: { value: 'Deploy guard' },
    });
    fireEvent.change(within(inspector()).getByLabelText('Módulo'), { target: { value: 'e2e' } });
    expect(providerField()).toHaveProperty('disabled', true);
    fireEvent.change(within(inspector()).getByLabelText('Ação MCP'), {
      target: { value: ' e2e_run ' },
    });
    expect(providerField()).toHaveProperty('disabled', false);
    fireEvent.change(providerField(), {
      target: { value: 'azure-devops, azure-devops, testrail' },
    });
    expect((providerField() as HTMLInputElement).value).toBe('azure-devops, testrail');
    const options = Array.from(
      document.querySelectorAll('datalist[id^="workflow-providers-"] option'),
    ).map((option) => option.getAttribute('value'));
    expect(options).toEqual(['azure-devops', 'testrail']);
    expect(
      document.querySelectorAll('datalist[id^="workflow-actions-"] option').length,
    ).toBeGreaterThan(0);
    fireEvent.change(providerField(), { target: { value: ' , ' } });
    expect((providerField() as HTMLInputElement).value).toBe('');
    fireEvent.click(
      within(inspector()).getByRole('switch', { name: 'Pedir aprovação antes de cada ação' }),
    );
    fireEvent.click(
      within(inspector()).getByRole('switch', { name: 'Abrir Issue para cada alteração' }),
    );
    fireEvent.click(within(inspector()).getByRole('switch', { name: 'Bloquear ação' }));
    closeInspector();
    openNode('workflow-rule-node-2');
    fireEvent.click(within(inspector()).getByRole('button', { name: 'Remover regra Regra 2' }));
    expect(within(panel).queryByTestId('workflow-rule-node-2')).toBeNull();

    // The first save fails without an explanation; the second succeeds.
    fireEvent.click(view.getByTestId('workflow-save-button'));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Não foi possível salvar o workflow.',
    );
    fireEvent.click(view.getByTestId('workflow-save-button'));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Workflow salvo.');

    const saved = save.mock.calls[1]![0];
    expect(saved).toMatchObject({
      enabled: true,
      autonomy: 'autonomous',
      uncertaintyBehavior: 'assume',
      issueCreationBehavior: 'allow',
      defaultAction: 'deny',
      finalReview: false,
    });
    expect(saved.steps.map((step) => [step.name, step.agentId, step.reviewRequired])).toEqual([
      ['Analysis', undefined, false],
      ['Review', 'agent-plugin', true],
    ]);
    expect(saved.rules[0]!.allowedProviders).toBeUndefined();
    expect(saved.rules).toEqual([
      expect.objectContaining({
        name: 'Deploy guard',
        toolset: 'e2e',
        toolName: 'e2e_run',
        effect: 'deny',
        requireApproval: true,
        createIssueForAction: true,
      }),
    ]);
  }, 20_000);

  it('builds ids without crypto.randomUUID', async () => {
    vi.spyOn(client, 'saveAgentWorkflow').mockImplementation(async (workflow) => workflow);
    vi.stubGlobal('crypto', {});
    try {
      const view = await openWorkflow();
      const panel = view.getByTestId('workflow-panel');
      fireEvent.click(within(panel).getByTestId('workflow-add-step'));
      fireEvent.click(within(panel).getByTestId('workflow-add-rule'));
      fillStep('workflow-step-node-1', 'A', 'B');
      closeInspector();
      fireEvent.click(view.getByTestId('workflow-save-button'));
      await within(panel).findByRole('status');
      const saved = vi.mocked(client.saveAgentWorkflow).mock.calls[0]![0];
      expect(saved.steps[0]!.id).toMatch(/^step-/);
      expect(saved.rules[0]!.id).toMatch(/^rule-/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports load failures with a retry and API errors on save', async () => {
    vi.spyOn(client, 'getAgentWorkflow')
      .mockRejectedValueOnce('down')
      .mockResolvedValueOnce({
        ...emptyWorkflow,
        steps: [{ id: 's1', name: 'Only', instructions: 'Go' }],
      });
    vi.spyOn(client, 'getPbiProviders').mockRejectedValue(new Error('no pbi'));
    vi.spyOn(client, 'getTestManagementProviders').mockRejectedValue(new Error('no tm'));
    vi.spyOn(client, 'saveAgentWorkflow').mockRejectedValue(new Error('Quota reached'));
    const view = await openWorkflow();
    const panel = view.getByTestId('workflow-panel');
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Não foi possível carregar o workflow.',
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(within(panel).queryByRole('alert')).toBeNull());
    openNode('workflow-step-node-1');
    const name = within(inspector()).getByLabelText('Nome da etapa') as HTMLInputElement;
    expect(name.value).toBe('Only');
    fireEvent.change(name, { target: { value: 'Only one' } });
    closeInspector();
    fireEvent.click(view.getByTestId('workflow-save-button'));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Quota reached');
  });

  it('is read-only for members without edit access', async () => {
    vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue({
      ...emptyWorkflow,
      enabled: true,
      steps: [{ id: 's1', name: 'Only', instructions: 'Go', reviewRequired: true }],
      rules: [{ id: 'r1', name: 'Block', toolset: 'pbi', effect: 'deny' }],
    });
    const view = await openWorkflow(true);
    const panel = view.getByTestId('workflow-panel');
    expect(view.getByTestId('workflow-enabled-toggle')).toHaveProperty('disabled', true);
    expect(view.getByTestId('workflow-save-button')).toHaveProperty('disabled', true);
    expect(within(panel).getByTestId('workflow-add-step')).toHaveProperty('disabled', true);
    expect(within(panel).getByTestId('workflow-add-rule')).toHaveProperty('disabled', true);
    openNode('workflow-step-node-1');
    expect(within(inspector()).getByLabelText('Nome da etapa')).toHaveProperty('disabled', true);
    expect(within(inspector()).getByRole('button', { name: 'Remover etapa 1' })).toHaveProperty(
      'disabled',
      true,
    );
    closeInspector();
    openNode('workflow-rule-node-1');
    expect(within(inspector()).getByRole('switch', { name: 'Bloquear ação' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('highlights each tab when selected', async () => {
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    vi.spyOn(client, 'listHubAgents').mockResolvedValue({
      generatedAt: '',
      agents: [],
      plugins: [],
    });
    fireEvent.click(view.getByTestId('tab-hub'));
    expect(view.getByTestId('tab-hub').className).toContain('font-semibold');
    expect(view.getByTestId('tab-workflow').className).not.toContain('font-semibold');
    expect(await view.findByTestId('hub-panel')).toBeInTheDocument();
  });

  it('starts on the section the navigation set, and follows it when it changes', () => {
    const view = render(
      <AgentsView apiClient={client} activeWorkspaceId="ws-1" section="workflow" />,
    );
    // No section given: the own tab bar is hidden, the sidebar drives navigation instead.
    expect(view.queryByTestId('tab-catalog')).not.toBeInTheDocument();
    expect(view.getByTestId('workflow-panel')).toBeInTheDocument();
    view.rerender(<AgentsView apiClient={client} activeWorkspaceId="ws-1" section="agents" />);
    expect(view.queryByTestId('workflow-panel')).not.toBeInTheDocument();
  });
});

describe('AgentsView catalog extras', () => {
  it('marks hub agents and skill counts, and survives unavailable integrations', async () => {
    vi.spyOn(client, 'getIntegrations').mockRejectedValue(new Error('integrations down'));
    const listHubAgents = vi
      .spyOn(client, 'listHubAgents')
      .mockResolvedValue({ generatedAt: '', agents: [], plugins: [] });
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    const hubBadge = await view.findByText('Hub 1.0.0');
    expect(hubBadge).toHaveAttribute('title', 'qa-test-designer');
    expect(view.getByText('Hub 2.0.0')).toHaveAttribute('title', 'jira-qa/jira-reviewer');
    expect(view.getByText('2 skills').closest('span')).toHaveAttribute(
      'title',
      'test-design, edge-hunter',
    );

    // A hub without skills leaves the skill picker empty.
    fireEvent.click(view.getByTestId('create-agent-button'));
    await waitFor(() => expect(listHubAgents).toHaveBeenCalled());
    expect(await view.findByRole('dialog')).toBeInTheDocument();
  });
});
