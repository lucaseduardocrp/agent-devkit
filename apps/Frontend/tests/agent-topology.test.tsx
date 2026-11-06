import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';
const emptyWorkflow: AgentWorkflowDto = {  enabled: true,  autonomy: 'balanced',  finalReview: true,  uncertaintyBehavior: 'ask',  issueCreationBehavior: 'ask',  defaultAction: 'allow',  steps: [],  rules: [],};

const parent: CustomAgentDto = {
  id: 'parent',
  workspaceId: 'workspace',
  parentAgentId: null,
  name: 'QA Lead',
  slug: 'qa-lead',
  description: 'Coordinates QA',
  instructions: 'Review tests',
  role: 'QA',
  temperature: 0.2,
  isSystem: false,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const child: CustomAgentDto = {
  ...parent,
  id: 'child',
  parentAgentId: 'parent',
  name: 'BDD Agent',
  slug: 'bdd-agent',
};
const issue: Issue = {
  id: 'issue-1',
  workspaceId: 'workspace',
  number: 42,
  title: 'Write scenarios',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  assigneeAgentId: 'child',
  assigneeUserId: null,
  createdBy: 'user',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const run: AgentRun = {
  id: 'run-1',
  issueId: issue.id,
  agentId: child.id,
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

describe('AgentTopology', () => {
  it('shows configured hierarchy and actual active issue runs separately', () => {
    const onRefresh = vi.fn();
    const view = render(
      <AgentTopology
        agents={[parent, child]}
        issues={[issue]}
        runs={[run]}
        isLoading={false}
        error={null}
        onRefresh={onRefresh}
        workflow={emptyWorkflow}
      />,
    );

    expect(view.getByTestId('parent-edge-child')).toBeInTheDocument();
    expect(view.getByTestId('run-edge-run-1')).toBeInTheDocument();
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('#42 Write scenarios');
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('Modelo do cliente');
    expect(view.getByRole('button', { name: 'QA Lead: Parado' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'BDD Agent: Rodando' })).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'BDD Agent: Rodando' }));
    expect(view.getByTestId('agent-run-flow')).toHaveTextContent('1 execuções ativas');
    fireEvent.click(view.getByRole('button', { name: 'Atualizar' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('excludes finished runs and shows queued status', () => {
    const view = render(
      <AgentTopology
        agents={[parent, child]}
        issues={[issue]}
        runs={[
          { ...run, status: 'succeeded' },
          { ...run, id: 'run-2', status: 'queued' },
        ]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        workflow={emptyWorkflow}
      />,
    );
    expect(view.queryByTestId('run-edge-run-1')).not.toBeInTheDocument();
    expect(view.getByTestId('run-edge-run-2')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'BDD Agent: Na fila' })).toBeInTheDocument();
  });

  it('shows loading, empty and retry states', () => {
    const onRefresh = vi.fn();
    const view = render(
      <AgentTopology
        agents={[]}
        issues={[]}
        runs={[]}
        isLoading={true}
        error={null}
        onRefresh={onRefresh}
        workflow={emptyWorkflow}
      />,
    );
    expect(view.getAllByTestId('skeleton-card')).toHaveLength(2);
    view.rerender(
      <AgentTopology
        agents={[]}
        issues={[]}
        runs={[]}
        isLoading={false}
        error="Network error"
        onRefresh={onRefresh}
        workflow={emptyWorkflow}
      />,
    );
    expect(view.getByText('Crie um agente para começar o mapa.')).toBeInTheDocument();
    expect(view.getByRole('alert')).toHaveTextContent('Network error');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('does not invite members who cannot create agents to create one', () => {
    const view = render(
      <AgentTopology
        agents={[]}
        issues={[]}
        runs={[]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        workflow={emptyWorkflow}
        canCreateAgents={false}
      />,
    );
    expect(view.getByText('Nenhum agente cadastrado')).toBeInTheDocument();
    expect(view.queryByText('Crie um agente para começar o mapa.')).not.toBeInTheDocument();
  });

  it('opens the workflow of a run from its task and marks the current step', () => {
    const withWorkflow: AgentRun = {
      ...run,
      workflowState: {
        autonomy: 'balanced',
        steps: [
          { id: 's1', name: 'Triage' },
          { id: 's2', name: 'Implement', reviewRequired: true },
          { id: 's3', name: 'Review' },
        ],
        currentStepIndex: 1,
        results: [{ stepId: 's1', name: 'Triage', output: 'Looks fine' }],
      },
    };
    const view = render(
      <AgentTopology
        agents={[parent, child]}
        issues={[issue]}
        runs={[withWorkflow]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        workflow={{
          ...emptyWorkflow,
          steps: [
            { id: 's1', name: 'Triage', instructions: '', reviewRequired: false },
            { id: 's2', name: 'Implement', instructions: '', reviewRequired: true },
            { id: 's3', name: 'Review', instructions: '', reviewRequired: false },
          ],
        }}
      />,
    );
    expect(view.getByTestId('topology-agent-task-child')).toHaveTextContent('#42 Write scenarios');
    fireEvent.click(view.getByTestId('topology-run-run-1'));
    expect(view.getByTestId('workflow-node-state-s1')).toHaveAttribute('data-state', 'done');
    expect(view.getByTestId('workflow-node-state-s2')).toHaveAttribute('data-state', 'current');
    expect(view.queryByTestId('workflow-node-state-s3')).toBeNull();
    expect(view.getByTestId('workflow-node-s3')).toBeInTheDocument();
    expect(view.getByTestId('run-flow-current-step')).toHaveTextContent('Implement');
    expect(view.getByText('Looks fine')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Fechar' }));
    expect(view.queryByTestId('agent-run-flow')).not.toBeInTheDocument();
  });

  it('shows an agent without active runs in the modal', () => {
    const view = render(
      <AgentTopology
        agents={[parent]}
        issues={[]}
        runs={[]}
        isLoading={false}
        error={null}
        onRefresh={vi.fn()}
        workflow={emptyWorkflow}
      />,
    );
    fireEvent.click(view.getByTestId('topology-agent-parent'));
    expect(view.getByRole('status')).toHaveTextContent('Nenhuma execução ativa');
  });
});
