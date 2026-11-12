import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import { ApiClient } from '../src/lib/api-client.js';
import type {
  AgentWorkflowDto,
  CustomAgentDto,
  HubAgentCatalogDto,
} from '../src/features/agents/agent-types.js';

const idleWorkflow: AgentWorkflowDto = {
  enabled: false,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};

const validStep = { id: 's1', name: 'Plan', instructions: 'Plan the work' };

const agent: CustomAgentDto = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  name: 'Hub QA',
  slug: 'hub-qa',
  description: 'Installed from the hub',
  instructions: '# Guidelines',
  role: 'QA',
  model: 'gemini-2.5-flash',
  temperature: 0.2,
  isSystem: false,
  source: { kind: 'hub-agent', name: 'qa-designer', version: '1.2.0', revision: 'r' },
  skills: [{ name: 'test-design', description: 'd', version: '1.0.0', revision: 'r' }],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const hubCatalog: HubAgentCatalogDto = {
  generatedAt: '2026-10-23T12:00:00Z',
  agents: [
    {
      name: 'qa-designer',
      description: 'Designs tests',
      overview: '',
      category: 'qa',
      role: 'QA',
      tags: [],
      toolsets: [],
      author: 'ADK',
      version: '1.0.0',
      license: 'MIT',
      tier: 'official',
      status: 'available',
    },
  ],
  plugins: [],
};

describe('AgentsView sections, hub, workflow and catalog badges', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'getIssues').mockResolvedValue([]);
    vi.spyOn(client, 'getAgentRuns').mockResolvedValue([]);
    vi.spyOn(client, 'streamRunEvents').mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue(idleWorkflow);
    vi.spyOn(client, 'getPbiProviders').mockResolvedValue([]);
    vi.spyOn(client, 'getTestManagementProviders').mockResolvedValue([]);
    vi.spyOn(client, 'listHubAgents').mockResolvedValue(hubCatalog);
  });

  const renderView = (props: Partial<React.ComponentProps<typeof AgentsView>> = {}) =>
    render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" {...props} />);

  it('follows the section chosen in the navigation and hides the tabs of other submodules', async () => {
    const view = renderView({ section: 'workflow' });
    expect(await view.findByTestId('workflow-panel')).toBeInTheDocument();
    expect(view.queryByTestId('tab-catalog')).toBeNull();

    view.rerender(<AgentsView apiClient={client} activeWorkspaceId="ws-1" section="agents" />);
    expect(await view.findByTestId('catalog-view-panel')).toBeInTheDocument();
    expect(view.getByTestId('tab-hub')).toBeInTheDocument();

    view.rerender(<AgentsView apiClient={client} activeWorkspaceId="ws-1" section="playground" />);
    expect(await view.findByTestId('playground-view-panel')).toBeInTheDocument();
    expect(view.queryByTestId('tab-hub')).toBeNull();
  });

  it('opens the hub, installs an agent and reloads the catalog', async () => {
    const view = renderView();
    await view.findByTestId('catalog-view-panel');
    fireEvent.click(view.getByTestId('tab-hub'));
    vi.spyOn(client, 'installHubAgent').mockResolvedValue([]);
    fireEvent.click(await view.findByTestId('hub-install-qa-designer'));
    await waitFor(() =>
      expect(client.installHubAgent).toHaveBeenCalledWith({ name: 'qa-designer' }),
    );
    await waitFor(() => expect(client.getAgents).toHaveBeenCalledTimes(2));
  });

  it('shows the hub origin and skills of an agent, with the plugin it came from', async () => {
    vi.spyOn(client, 'getAgents').mockResolvedValue([
      agent,
      {
        ...agent,
        id: 'agent-2',
        name: 'Plugin QA',
        slug: 'plugin-qa',
        source: {
          kind: 'hub-plugin',
          name: 'reviewer',
          plugin: 'jira',
          version: '2.0.0',
          revision: 'r',
        },
        skills: [],
      },
    ]);
    const view = renderView();
    expect(await view.findByTitle('qa-designer')).toBeInTheDocument();
    expect(view.getByTitle('jira/reviewer')).toBeInTheDocument();
    expect(view.getByTitle('test-design')).toBeInTheDocument();
  });

  it('keeps the model list empty when the integrations cannot be read', async () => {
    vi.spyOn(client, 'getAgents').mockResolvedValue([agent]);
    vi.spyOn(client, 'getIntegrations').mockRejectedValue(new Error('offline'));
    const view = renderView();
    expect(await view.findByTitle('qa-designer')).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('loads the hub skills for a new agent even when an older API sends none', async () => {
    const view = renderView();
    await view.findByTestId('catalog-view-panel');
    fireEvent.click(view.getByRole('button', { name: /Novo Agente/ }));
    await waitFor(() => expect(client.listHubAgents).toHaveBeenCalled());
    expect(await view.findByRole('dialog')).toBeInTheDocument();
  });

  it('tells the navigation when an agent is sent to the playground', async () => {
    vi.spyOn(client, 'getAgents').mockResolvedValue([agent]);
    const onSelectSection = vi.fn();
    const view = renderView({ onSelectSection });
    fireEvent.click(await view.findByTestId('test-agent-btn-hub-qa'));
    expect(onSelectSection).toHaveBeenCalledWith('playground');
    expect(await view.findByTestId('playground-view-panel')).toBeInTheDocument();
  });

  it('passes the issue opener to the map', async () => {
    const onOpenIssue = vi.fn();
    const view = renderView({ onOpenIssue });
    fireEvent.click(await view.findByTestId('tab-map'));
    await waitFor(() => expect(client.getAgentRuns).toHaveBeenCalled());
    expect(view.getByTestId('tab-map')).toBeInTheDocument();
  });

  describe('workflow tab', () => {
    const openWorkflow = async (props: Partial<React.ComponentProps<typeof AgentsView>> = {}) => {
      const view = renderView(props);
      fireEvent.click(view.getByTestId('tab-workflow'));
      await view.findByTestId('workflow-board');
      return view;
    };
    const enableAndSave = (view: ReturnType<typeof render>) => {
      fireEvent.click(view.getByTestId('workflow-enabled-toggle'));
      fireEvent.click(view.getByTestId('workflow-save-button'));
    };

    it('lists the providers of PBIs and of test management once each', async () => {
      vi.spyOn(client, 'getPbiProviders').mockResolvedValue([
        { providerId: 'azure', settings: {} },
        { providerId: 'github', settings: {} },
      ] as never);
      vi.spyOn(client, 'getTestManagementProviders').mockResolvedValue([
        { id: 'azure', name: 'Azure', configured: true, capabilities: {} },
        { id: 'testrail', name: 'TestRail', configured: false, capabilities: {} },
      ] as never);
      const view = await openWorkflow();
      expect(view.getByTestId('workflow-board')).toBeInTheDocument();
    });

    it('refuses to enable a workflow that has no steps nor rules', async () => {
      const saveSpy = vi.spyOn(client, 'saveAgentWorkflow');
      const view = await openWorkflow();
      enableAndSave(view);
      expect(await view.findByRole('alert')).toHaveTextContent(
        'Adicione pelo menos uma etapa para ativar o workflow.',
      );
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('refuses a step without a name or instructions', async () => {
      vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue({
        ...idleWorkflow,
        steps: [{ id: 's1', name: ' ', instructions: 'x' }],
      });
      const saveSpy = vi.spyOn(client, 'saveAgentWorkflow');
      const view = await openWorkflow();
      enableAndSave(view);
      expect(await view.findByRole('alert')).toHaveTextContent(
        'Cada etapa precisa de um nome e de instruções.',
      );
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('refuses a rule without a name, or one limited to providers without a tool', async () => {
      const saveSpy = vi.spyOn(client, 'saveAgentWorkflow');
      const getWorkflow = vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue({
        ...idleWorkflow,
        steps: [validStep],
        rules: [{ id: 'r1', name: '', toolset: 'pbi', effect: 'allow' }],
      });
      const first = await openWorkflow();
      enableAndSave(first);
      expect(await first.findByRole('alert')).toHaveTextContent(
        'Informe o nome da regra e uma ação para limitar provedores.',
      );
      first.unmount();

      getWorkflow.mockResolvedValue({
        ...idleWorkflow,
        steps: [validStep],
        rules: [
          {
            id: 'r1',
            name: 'Limit',
            toolset: 'pbi',
            effect: 'allow',
            allowedProviders: ['github'],
          },
        ],
      });
      const second = await openWorkflow();
      enableAndSave(second);
      expect(await second.findByRole('alert')).toHaveTextContent(
        'Informe o nome da regra e uma ação para limitar provedores.',
      );
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it('saves a valid workflow and says so', async () => {
      vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue({
        ...idleWorkflow,
        steps: [validStep],
      });
      const saved = { ...idleWorkflow, enabled: true, steps: [validStep] };
      const saveSpy = vi.spyOn(client, 'saveAgentWorkflow').mockResolvedValue(saved);
      const view = await openWorkflow();
      enableAndSave(view);
      expect(await view.findByRole('status')).toHaveTextContent('Workflow salvo.');
      expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    });

    it('reports a failed save, with or without a message', async () => {
      vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue({
        ...idleWorkflow,
        steps: [validStep],
      });
      const saveSpy = vi
        .spyOn(client, 'saveAgentWorkflow')
        .mockRejectedValueOnce(new Error('Conflict'))
        .mockRejectedValueOnce('nope');
      const view = await openWorkflow();
      enableAndSave(view);
      expect(await view.findByRole('alert')).toHaveTextContent('Conflict');
      fireEvent.click(view.getByTestId('workflow-save-button'));
      await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(view.getByRole('alert')).toHaveTextContent('Não foi possível salvar o workflow.'),
      );
    });

    it('reports a workflow that cannot be loaded and retries', async () => {
      const load = vi
        .spyOn(client, 'getAgentWorkflow')
        .mockRejectedValueOnce(new Error('Forbidden'))
        .mockRejectedValueOnce('down')
        .mockResolvedValue(idleWorkflow);
      const view = renderView();
      fireEvent.click(view.getByTestId('tab-workflow'));
      expect(await view.findByRole('alert')).toHaveTextContent('Forbidden');
      fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(view.getByRole('alert')).toHaveTextContent('Não foi possível carregar o workflow.'),
      );
      fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
      await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    });

    it('tells a read-only user that editing needs permission', async () => {
      const view = await openWorkflow({ isReadOnly: true });
      expect(view.getByTestId('workflow-panel')).toHaveTextContent(/permiss/i);
    });
  });
});
