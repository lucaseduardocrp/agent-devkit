import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentRunFlowModal } from '../src/features/agents/AgentRunFlowModal.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';

const agent: CustomAgentDto = {
  id: 'a1',
  workspaceId: 'ws',
  name: 'Agente QA',
  slug: 'qa',
  description: 'Descricao do agente',
  instructions: '',
  role: 'QA',
  temperature: 0,
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
  steps: [
    { id: 's1', name: 'Passo 1', instructions: 'a' },
    { id: 's2', name: 'Passo 2', instructions: 'b' },
    { id: 's3', name: 'Passo 3', instructions: 'c' },
  ],
  rules: [],
};

const issue: Issue = {
  id: 'issue-1',
  workspaceId: 'ws',
  number: 7,
  title: 'Corrigir',
  description: '',
  status: 'todo',
  priority: 'low',
  assigneeAgentId: null,
  assigneeUserId: null,
  createdBy: 'u',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

function makeRun(id: string, patch: Partial<AgentRun>): AgentRun {
  return {
    id,
    issueId: 'issue-1',
    agentId: 'a1',
    status: 'running',
    mode: 'server',
    attempt: 1,
    output: null,
    error: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costMicros: null,
    createdAt: '2026-01-01',
    startedAt: null,
    finishedAt: null,
    ...patch,
  };
}

const steps = [
  { id: 's1', name: 'Passo 1' },
  { id: 's2', name: 'Passo 2' },
  { id: 's3', name: 'Passo 3' },
];

function renderModal(runs: AgentRun[], initialRunId?: string | null, onClose = vi.fn()) {
  return render(
    <AgentRunFlowModal
      agent={agent}
      runs={runs}
      issues={[issue]}
      agents={[agent]}
      workflow={workflow}
      initialRunId={initialRunId}
      onClose={onClose}
    />,
  );
}

describe('AgentRunFlowModal', () => {
  it('renders nothing without an agent', () => {
    render(
      <AgentRunFlowModal
        agent={null}
        runs={[]}
        issues={[]}
        agents={[]}
        workflow={workflow}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('agent-run-flow')).toBeNull();
  });

  it('explains when the agent has no active run', () => {
    const onClose = vi.fn();
    renderModal([], null, onClose);
    expect(screen.getByText('Descricao do agente')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Fechar'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the details of a single run without tabs', () => {
    const run = makeRun('r1', {
      mode: 'host',
      model: 'gpt-x',
      workflowState: {
        autonomy: 'balanced',
        steps,
        currentStepIndex: 1,
        results: [{ stepId: 's1', name: 'Passo 1', output: 'Saida 1' }],
        question: 'Posso continuar?',
      },
    });
    renderModal([run]);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('#7 Corrigir')).toBeTruthy();
    expect(screen.getByTestId('run-flow-current-step').textContent).toContain('Passo 2');
    expect(screen.getByText('Posso continuar?')).toBeTruthy();
    expect(screen.getByText('Saida 1')).toBeTruthy();
    expect(screen.getByText(/gpt-x/)).toBeTruthy();
  });

  it('switches between runs and marks waiting, queued and unknown-issue runs', () => {
    const waiting = makeRun('r1', {
      status: 'waiting_review',
      workflowState: { autonomy: 'balanced', steps, currentStepIndex: 0, results: [] },
    });
    const queued = makeRun('r2', {
      status: 'queued',
      issueId: 'abcdefghijkl',
      workflowState: { autonomy: 'balanced', steps, currentStepIndex: 2, results: [] },
    });
    const noState = makeRun('r3', { status: 'queued', workflowState: null });
    renderModal([waiting, queued, noState], 'r2');
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByText('#abcdefgh').length).toBeGreaterThan(0);
    fireEvent.click(tabs[0]!);
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('run-flow-current-step').textContent).toContain('Passo 1');
    fireEvent.click(screen.getAllByRole('tab')[2]!);
    expect(screen.queryByTestId('run-flow-current-step')).toBeNull();
  });
});
