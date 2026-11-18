import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import { ApiClient } from '../src/lib/api-client.js';
import { FULL_ACCESS, PermissionsProvider } from '../src/features/workspaces/permissions.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';
import type { AgentWorkflowDto } from '../src/features/agents/agent-types.js';

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
  canvas: {
    nodes: [
      {
        id: 'notify',
        kind: 'action',
        x: 0,
        y: 0,
        action: { toolset: 'notifications', toolName: 'notifications_send' },
      },
    ],
    edges: [],
  },
};

const member = (userId: string, name: string, withUser = true): WorkspaceMember => ({
  id: `m-${userId}`,
  workspaceId: 'ws-1',
  userId,
  role: 'MEMBER',
  permissions: {},
  createdAt: '',
  ...(withUser ? { user: { id: userId, name, email: `${name}@example.com` } } : {}),
});

describe('AgentsView workflow notification options', () => {
  let client: ApiClient;
  let getChannels: MockInstance<ApiClient['getNotificationChannels']>;
  let getMembers: MockInstance<ApiClient['getWorkspaceMembers']>;

  beforeEach(() => {
    client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'getIssues').mockResolvedValue([]);
    vi.spyOn(client, 'getAgentRuns').mockResolvedValue([]);
    vi.spyOn(client, 'streamRunEvents').mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue(workflow);
    vi.spyOn(client, 'getPbiProviders').mockResolvedValue([]);
    vi.spyOn(client, 'getTestManagementProviders').mockResolvedValue([]);
    getChannels = vi
      .spyOn(client, 'getNotificationChannels')
      .mockResolvedValue([{ id: 'email', label: 'E-mail', available: true }]);
    getMembers = vi
      .spyOn(client, 'getWorkspaceMembers')
      .mockResolvedValue([member('u1', 'Ana'), member('u2', 'Ghost', false)]);
  });

  const openNode = async (view: ReturnType<typeof render>) => {
    fireEvent.click(view.getByTestId('tab-workflow'));
    const target = await view.findByTestId('workflow-node-notify');
    const gesture = (type: string) =>
      fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true }));
    gesture('pointerdown');
    gesture('pointerup');
    return view.findByTestId('notification-action-editor');
  };

  it('does not load anything until the workflow is opened', async () => {
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    await view.findByText('Nenhum agente encontrado');
    expect(getChannels).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('tab-workflow'));
    await waitFor(() => expect(getChannels).toHaveBeenCalled());
    expect(getMembers).toHaveBeenCalledWith('ws-1');
  });

  it('offers the channels and the members with a name to the notification node', async () => {
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    await openNode(view);
    expect(await view.findByTestId('channel-email')).toBeInTheDocument();
    fireEvent.focus(view.getByRole('combobox', { name: 'Pessoas a avisar' }));
    expect(await view.findByRole('option', { name: /Ana/ })).toBeInTheDocument();
    expect(view.queryByRole('option', { name: /Ghost/ })).toBeNull();
  });

  it('says so when they cannot be loaded', async () => {
    getChannels.mockRejectedValue(new Error('403'));
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    const editor = await openNode(view);
    await waitFor(() => expect(view.getByRole('status')).toHaveTextContent('Integrações'));
    expect(editor).toBeInTheDocument();
  });

  it('does not even try without access to Integrations', async () => {
    const view = render(
      <PermissionsProvider
        access={{ ...FULL_ACCESS, modules: { ...FULL_ACCESS.modules, integrations: 'none' } }}
      >
        <AgentsView apiClient={client} activeWorkspaceId="ws-1" />
      </PermissionsProvider>,
    );
    await openNode(view);
    expect(getChannels).not.toHaveBeenCalled();
    expect(getMembers).not.toHaveBeenCalled();
  });

  it('ignores the answer when the workflow was closed before it came', async () => {
    let finish!: (value: never[]) => void;
    getChannels.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const view = render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" />);
    fireEvent.click(view.getByTestId('tab-workflow'));
    await waitFor(() => expect(getChannels).toHaveBeenCalled());
    fireEvent.click(view.getByTestId('tab-catalog'));
    finish([]);
    await view.findByText('Nenhum agente encontrado');
  });
});
