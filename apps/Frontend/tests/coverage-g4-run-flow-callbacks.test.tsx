import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentWorkflowCanvas } from '../src/features/agents/AgentWorkflowCanvas.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { AgentRun } from '../src/features/issues/issue-types.js';

type CanvasProps = Parameters<typeof AgentWorkflowCanvas>[0];

const captured: { props?: CanvasProps } = {};

// The real canvas never calls its edit callbacks while read-only, so the run view's no-op
// handlers are exercised through the props it hands to the canvas.
vi.mock('../src/features/agents/AgentWorkflowCanvas.js', () => ({
  AgentWorkflowCanvas: (props: CanvasProps) => {
    captured.props = props;
    return <div data-testid="stub-canvas" />;
  },
}));

const { AgentRunFlowModal } = await import('../src/features/agents/AgentRunFlowModal.js');

const agent: CustomAgentDto = {
  id: 'agent-1',
  workspaceId: 'workspace',
  parentAgentId: null,
  name: 'PO',
  slug: 'po',
  description: '',
  instructions: '',
  role: 'CUSTOM',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [{ id: 's1', name: 'Triage', instructions: 'Triage it.' }],
  rules: [],
};

const run: AgentRun = {
  id: 'run-1',
  issueId: 'issue-1',
  agentId: agent.id,
  status: 'running',
  mode: 'host',
  attempt: 1,
  output: null,
  error: null,
  provider: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  costMicros: null,
  createdAt: '2026-01-01',
  startedAt: '2026-01-01',
  finishedAt: null,
};

describe('AgentRunFlowModal canvas wiring', () => {
  it('hands the canvas read-only handlers that change nothing', () => {
    render(
      <AgentRunFlowModal
        agent={agent}
        runs={[run]}
        issues={[]}
        agents={[agent]}
        workflow={workflow}
        onClose={vi.fn()}
      />,
    );
    const props = captured.props!;
    expect(props.isReadOnly).toBe(true);
    expect(props.onOpenNode('s1')).toBeUndefined();
    expect(props.onMoveNode('s1', 1, 2)).toBeUndefined();
    expect(props.onRemoveNode('s1')).toBeUndefined();
    expect(props.onConnect('s1', 's1')).toBeUndefined();
    expect(props.onDisconnect('edge')).toBeUndefined();
  });
});
