import { fireEvent, render, waitFor, within } from '@testing-library/react';
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

describe('AgentsView workflow editor', () => {
  it('builds, validates, reorders and saves steps and module rules', async () => {
    const save = vi
      .spyOn(client, 'saveAgentWorkflow')
      .mockImplementation(async (workflow) => workflow)
      .mockRejectedValueOnce('boom');
    const view = await openWorkflow();
    const panel = view.getByTestId('workflow-panel');
    await within(panel).findByText('Adicione pelo menos uma etapa para ativar o workflow.');

    // Enabling without steps or rules is rejected.
    fireEvent.click(view.getByTestId('workflow-enabled-toggle'));
    expect(view.getByTestId('workflow-enabled-toggle')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Adicione pelo menos uma etapa para ativar o workflow.',
    );

    // Global controls.
    fireEvent.change(within(panel).getByLabelText('Autonomia do agente'), {
      target: { value: 'autonomous' },
    });
    fireEvent.change(within(panel).getByLabelText('Quando faltar informação'), {
      target: { value: 'assume' },
    });
    fireEvent.change(within(panel).getByLabelText('Criação de Issues por agentes MCP'), {
      target: { value: 'allow' },
    });
    fireEvent.change(within(panel).getByLabelText('Ações não configuradas'), {
      target: { value: 'deny' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Obrigatória' }));
    expect(within(panel).getByRole('button', { name: 'Opcional' })).toBeInTheDocument();

    // Steps: an incomplete step is rejected.
    fireEvent.click(within(panel).getByRole('button', { name: /Adicionar etapa/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /Adicionar etapa/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Cada etapa precisa de um nome e de instruções.',
    );

    const names = () => within(panel).getAllByLabelText<HTMLInputElement>('Nome da etapa');
    fireEvent.change(names()[0]!, { target: { value: 'Analysis' } });
    fireEvent.change(names()[1]!, { target: { value: 'Review' } });
    const instructions = within(panel).getAllByLabelText('Instruções da etapa');
    fireEvent.change(instructions[0]!, { target: { value: 'Analyse it' } });
    fireEvent.change(instructions[1]!, { target: { value: 'Review it' } });
    const agentSelects = within(panel).getAllByLabelText('Agente responsável');
    fireEvent.change(agentSelects[0]!, { target: { value: 'agent-hub' } });
    fireEvent.change(agentSelects[0]!, { target: { value: '' } });
    fireEvent.change(agentSelects[1]!, { target: { value: 'agent-plugin' } });
    fireEvent.click(
      within(panel).getAllByRole('button', {
        name: 'Pedir minha aprovação antes da próxima etapa',
      })[1]!,
    );

    expect(within(panel).getByRole('button', { name: 'Mover etapa 1 para cima' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(panel).getByRole('button', { name: 'Mover etapa 2 para baixo' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Mover etapa 2 para cima' }));
    expect(names().map((input) => input.value)).toEqual(['Review', 'Analysis']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Mover etapa 1 para baixo' }));
    expect(names().map((input) => input.value)).toEqual(['Analysis', 'Review']);

    // A third step is added then removed.
    fireEvent.click(within(panel).getByRole('button', { name: /Adicionar etapa/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Remover etapa 3' }));
    expect(names()).toHaveLength(2);

    // Rules.
    fireEvent.click(within(panel).getByRole('button', { name: /Adicionar regra/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /Adicionar regra/ }));
    const ruleNames = () => within(panel).getAllByLabelText<HTMLInputElement>('Nome');
    fireEvent.change(ruleNames()[0]!, { target: { value: ' ' } });
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Informe o nome da regra e uma ação para limitar provedores.',
    );
    fireEvent.change(ruleNames()[0]!, { target: { value: 'Deploy guard' } });
    expect(ruleNames().map((input) => input.value)).toEqual(['Deploy guard', 'Regra 2']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Remover regra Regra 2' }));
    expect(ruleNames().map((input) => input.value)).toEqual(['Deploy guard']);
    fireEvent.change(within(panel).getByLabelText('Módulo'), { target: { value: 'e2e' } });
    const providers = within(panel).getByPlaceholderText('Todos os provedores');
    expect(providers).toHaveProperty('disabled', true);
    fireEvent.change(within(panel).getByLabelText('Ação MCP'), { target: { value: ' e2e_run ' } });
    expect(providers).toHaveProperty('disabled', false);
    fireEvent.change(providers, { target: { value: 'azure-devops, azure-devops, testrail' } });
    expect((providers as HTMLInputElement).value).toBe('azure-devops, testrail');
    const options = Array.from(
      document.querySelectorAll('datalist[id^="workflow-providers-"] option'),
    ).map((option) => option.getAttribute('value'));
    expect(options).toEqual(['azure-devops', 'testrail']);
    expect(
      document.querySelectorAll('datalist[id^="workflow-actions-"] option').length,
    ).toBeGreaterThan(0);

    fireEvent.click(
      within(panel).getByRole('button', { name: 'Pedir aprovação antes de cada ação' }),
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Permitida' }));
    expect(within(panel).getByRole('button', { name: 'Bloqueada' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(panel).getByRole('button', { name: 'Bloqueada' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Permitida' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Abrir Issue para cada alteração' }));

    // Limiting providers needs an action.
    fireEvent.change(within(panel).getByLabelText('Ação MCP'), { target: { value: ' ' } });
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Informe o nome da regra e uma ação para limitar provedores.',
    );
    fireEvent.change(within(panel).getByLabelText('Ação MCP'), { target: { value: 'e2e_run' } });
    fireEvent.change(providers, { target: { value: ' , ' } });
    expect((providers as HTMLInputElement).value).toBe('');

    // The first save fails without an explanation; the second succeeds.
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Não foi possível salvar o workflow.',
    );
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
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
  });

  it('builds ids without crypto.randomUUID', async () => {
    vi.spyOn(client, 'saveAgentWorkflow').mockImplementation(async (workflow) => workflow);
    vi.stubGlobal('crypto', {});
    try {
      const view = await openWorkflow();
      const panel = view.getByTestId('workflow-panel');
      await within(panel).findByText('Adicione pelo menos uma etapa para ativar o workflow.');
      fireEvent.click(within(panel).getByRole('button', { name: /Adicionar etapa/ }));
      fireEvent.click(within(panel).getByRole('button', { name: /Adicionar regra/ }));
      fireEvent.change(within(panel).getByLabelText('Nome da etapa'), { target: { value: 'A' } });
      fireEvent.change(within(panel).getByLabelText('Instruções da etapa'), {
        target: { value: 'B' },
      });
      fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
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
    expect(await within(panel).findByDisplayValue('Only')).toBeInTheDocument();
    expect(within(panel).queryByRole('alert')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: /Salvar workflow/ }));
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
    expect(await within(panel).findByDisplayValue('Only')).toHaveProperty('disabled', true);
    expect(view.getByTestId('workflow-enabled-toggle')).toHaveProperty('disabled', true);
    expect(within(panel).getByRole('button', { name: 'Bloqueada' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(panel).queryByRole('button', { name: /Salvar workflow/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /Adicionar regra/ })).toBeNull();
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
