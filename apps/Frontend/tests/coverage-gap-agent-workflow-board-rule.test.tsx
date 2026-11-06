import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describeWorkflowNode } from '../src/features/agents/AgentWorkflowBoard.js';
import { createNode } from '../src/features/agents/workflow-graph.js';
import { describe, expect, it, vi } from 'vitest';
import { AgentsView } from '../src/features/agents/AgentsView.js';
import type { AgentWorkflowDto } from '../src/features/agents/agent-types.js';
import { ApiClient } from '../src/lib/api-client.js';

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [{ id: 's1', name: 'Only', instructions: 'Go' }],
  rules: [
    { id: 'r1', name: 'Regra A', toolset: 'pbi', effect: 'deny' },
    { id: 'r2', name: '', toolset: 'pbi', effect: 'allow' },
  ],
};

describe('AgentWorkflowBoard rule nodes', () => {
  it('removes a rule node from the canvas together with its rule', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAgents').mockResolvedValue([]);
    vi.spyOn(client, 'getIntegrations').mockResolvedValue([]);
    vi.spyOn(client, 'getAgentWorkflow').mockResolvedValue(workflow);
    vi.spyOn(client, 'getPbiProviders').mockResolvedValue([]);
    render(<AgentsView apiClient={client} activeWorkspaceId="ws-1" section="workflow" />);
    await waitFor(() => expect(screen.queryByTestId('workflow-node-r1')).not.toBeNull());
    fireEvent.click(screen.getByTestId('workflow-node-remove-r1'));
    await waitFor(() => expect(screen.queryByTestId('workflow-node-r1')).toBeNull());
    expect(screen.getByTestId('workflow-node-s1')).toBeTruthy();
    expect(screen.getByTestId('workflow-node-r2').textContent).toContain('Regra');
  });
});

describe('describeWorkflowNode', () => {
  it('describes a rule node whose rule is missing with an empty subtitle', () => {
    const view = describeWorkflowNode(
      createNode('ghost', 'rule', { x: 0, y: 0 }),
      [],
      [],
      [],
      (key: string) => key,
    );
    expect(view.subtitle).toBe('');
    expect(view.title).toBe('agents.workflowRule');
  });
});
