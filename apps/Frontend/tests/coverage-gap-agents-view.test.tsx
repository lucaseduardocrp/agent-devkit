import { fireEvent, render, waitFor } from '@testing-library/react';
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

describe('AgentsView tabs', () => {
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
