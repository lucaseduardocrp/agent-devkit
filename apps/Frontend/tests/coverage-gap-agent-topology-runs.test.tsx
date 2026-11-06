import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};
const agent: CustomAgentDto = {
  id: 'ag',
  workspaceId: 'ws',
  parentAgentId: null,
  name: 'QA Lead',
  slug: 'qa-lead',
  description: '',
  instructions: '',
  role: 'QA',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const issue: Issue = {
  id: 'i1',
  workspaceId: 'ws',
  number: 42,
  title: 'Write scenarios',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  assigneeAgentId: 'ag',
  assigneeUserId: null,
  createdBy: 'user',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const run = (id: string): AgentRun => ({
  id,
  issueId: 'i1',
  agentId: 'ag',
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
});

describe('AgentTopology several runs', () => {
  it('counts the extra runs of an agent next to its first task', () => {
    render(
      <AgentTopology
        agents={[agent]}
        issues={[issue]}
        runs={[run('r1'), run('r2'), run('r3')]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        workflow={workflow}
      />,
    );
    expect(screen.getByTestId('topology-agent-task-ag').textContent).toContain('+2');
  });
});
