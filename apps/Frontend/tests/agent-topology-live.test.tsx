import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTopology } from '../src/features/agents/AgentTopology.js';
import type { AgentWorkflowDto, CustomAgentDto } from '../src/features/agents/agent-types.js';
import type { AgentRun, Issue } from '../src/features/issues/issue-types.js';
import type { LiveStatus } from '../src/features/agents/use-run-stream.js';

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [
    { id: 's1', name: 'Triage', instructions: 'Triage it.' },
    { id: 's2', name: 'Summary', instructions: 'Summarise it.' },
  ],
  rules: [],
};

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
const issue: Issue = {
  id: 'issue-1',
  workspaceId: 'workspace',
  number: 95,
  title: 'Approve exchanges',
  description: '',
  status: 'in_progress',
  priority: 'medium',
  assigneeAgentId: agent.id,
  assigneeUserId: null,
  createdBy: 'user',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const run: AgentRun = {
  id: 'run-1',
  issueId: issue.id,
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
const steps = workflow.steps.map(({ id, name }) => ({ id, name }));

function topology(
  runs: readonly AgentRun[],
  options: { liveStatus?: LiveStatus; isLoading?: boolean } = {},
) {
  return (
    <AgentTopology
      agents={[agent]}
      issues={[issue]}
      runs={runs}
      isLoading={options.isLoading ?? false}
      error={null}
      onRefresh={vi.fn()}
      workflow={workflow}
      {...(options.liveStatus ? { liveStatus: options.liveStatus } : {})}
    />
  );
}

describe('AgentTopology live status', () => {
  it('shows whether the map follows the runs live', () => {
    const view = render(topology([], { liveStatus: 'live' }));
    expect(view.getByTestId('topology-live')).toHaveTextContent('Ao vivo');
    view.rerender(topology([], { liveStatus: 'connecting' }));
    expect(view.getByTestId('topology-live')).toHaveTextContent('Conectando…');
    view.rerender(topology([], { liveStatus: 'offline' }));
    expect(view.getByTestId('topology-live')).toHaveTextContent('Reconectando…');
  });

  it('shows no live status when the map can only poll', () => {
    const view = render(topology([]));
    expect(view.queryByTestId('topology-live')).not.toBeInTheDocument();
  });
});

describe('AgentTopology arrivals', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const queued = { ...run, id: 'run-new', status: 'queued' as const, startedAt: null };

  it('announces and highlights a task that reaches the queue while live, then calms down', () => {
    const view = render(topology([], { liveStatus: 'live' }));
    view.rerender(topology([queued], { liveStatus: 'live' }));

    expect(view.getByTestId('topology-announcement')).toHaveTextContent(
      'Nova tarefa para PO: #95 Approve exchanges',
    );
    expect(view.getByTestId('topology-run-run-new').className).toContain('ring-emerald-400');

    act(() => void vi.advanceTimersByTime(4_000));
    expect(view.getByTestId('topology-run-run-new').className).not.toContain('ring-emerald-400');
  });

  it('still announces a task for an agent the map does not list', () => {
    const view = render(topology([], { liveStatus: 'live' }));
    view.rerender(topology([{ ...queued, agentId: 'ghost' }], { liveStatus: 'live' }));
    expect(view.getByTestId('topology-announcement')).toHaveTextContent(
      'Nova tarefa para : #95 Approve exchanges',
    );
  });

  it('does not treat what a load brings as an arrival', () => {
    const view = render(topology([], { liveStatus: 'live', isLoading: true }));
    view.rerender(topology([queued], { liveStatus: 'live', isLoading: false }));
    expect(view.getByTestId('topology-announcement').textContent).toBe('');
    expect(view.getByTestId('topology-run-run-new').className).not.toContain('ring-emerald-400');
  });

  it('only counts arrivals while the stream is live', () => {
    const view = render(topology([], { liveStatus: 'offline' }));
    view.rerender(topology([queued], { liveStatus: 'offline' }));
    expect(view.getByTestId('topology-announcement').textContent).toBe('');

    // Going live is not an arrival either: the first view after reconnecting is a load.
    const other = render(topology([], { liveStatus: 'connecting' }));
    other.rerender(topology([queued], { liveStatus: 'live' }));
    expect(other.getAllByTestId('topology-announcement').at(-1)!.textContent).toBe('');
  });

  it('ignores a run that starts running or one that was already on the map', () => {
    const view = render(topology([queued], { liveStatus: 'live' }));
    view.rerender(topology([{ ...queued, status: 'running' }], { liveStatus: 'live' }));
    view.rerender(topology([{ ...queued, status: 'running' }, { ...run }], { liveStatus: 'live' }));
    expect(view.getByTestId('topology-announcement').textContent).toBe('');
  });
});

describe('AgentTopology run progress', () => {
  it('shows the step a running run is on, and the model otherwise', () => {
    const onStep = (currentStepIndex: number): AgentRun => ({
      ...run,
      workflowState: { autonomy: 'balanced', steps, currentStepIndex, results: [] },
    });
    const view = render(topology([onStep(1)]));
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('PO · Summary');

    // A queued run has not started a step; a run without workflow shows its model.
    view.rerender(topology([{ ...onStep(1), status: 'queued' }]));
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('Modelo do cliente');
    view.rerender(topology([run]));
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('Modelo do cliente');
  });

  it('follows the current node of a flow, which may not be a named step', () => {
    const flow = (currentNodeId?: string): AgentRun => ({
      ...run,
      workflowState: {
        autonomy: 'balanced',
        steps,
        currentStepIndex: 0,
        results: [],
        canvas: { nodes: [{ id: 's1' }, { id: 'cond' }] },
        ...(currentNodeId ? { currentNodeId } : {}),
      },
    });
    const view = render(topology([flow('s2')]));
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('PO · Summary');
    view.rerender(topology([flow('cond')]));
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('Modelo do cliente');
    // Between nodes the flow names no step.
    view.rerender(topology([flow()]));
    expect(view.getByTestId('topology-run-run-1')).toHaveTextContent('Modelo do cliente');
  });
});

describe('run flow of a flow', () => {
  // The run flow opens in a modal, which renders outside the container of the view.
  const stateOf = (_view: ReturnType<typeof render>, id: string) =>
    document.querySelector(`[data-testid="workflow-node-state-${id}"]`)?.getAttribute('data-state');

  const flowRun = (patch: Partial<NonNullable<AgentRun['workflowState']>>): AgentRun => ({
    ...run,
    workflowState: {
      autonomy: 'balanced',
      steps,
      currentStepIndex: 0,
      canvas: { nodes: [{ id: 's1' }, { id: 's2' }] },
      results: [],
      ...patch,
    },
  });

  it('marks what the run recorded as done and the node it is on as current', () => {
    const view = render(
      topology([
        flowRun({
          currentNodeId: 's2',
          results: [{ stepId: 's1', name: 'Triage', output: 'ok' }],
        }),
      ]),
    );
    fireEvent.click(view.getByTestId('topology-run-run-1'));
    expect(stateOf(view, 's1')).toBe('done');
    expect(stateOf(view, 's2')).toBe('current');
  });

  it('does not say a queued run is running its first step', () => {
    const view = render(
      topology([{ ...flowRun({ currentNodeId: 's1' }), status: 'queued', startedAt: null }]),
    );
    fireEvent.click(view.getByTestId('topology-run-run-1'));
    expect(document.querySelector('[data-testid="run-flow-current-step"]')).toBeNull();
    expect(stateOf(view, 's1')).toBeUndefined();
  });

  it('keeps a node waiting for the user marked as such, and shows none as current between nodes', () => {
    const view = render(
      topology([
        {
          ...flowRun({ currentNodeId: 's2', results: [{ stepId: 's1', name: 'T', output: '' }] }),
          status: 'waiting_review',
        },
      ]),
    );
    fireEvent.click(view.getByTestId('topology-run-run-1'));
    expect(stateOf(view, 's2')).toBe('waiting');
    view.unmount();

    const between = render(
      topology([flowRun({ results: [{ stepId: 's1', name: 'Triage', output: 'ok' }] })]),
    );
    fireEvent.click(between.getByTestId('topology-run-run-1'));
    expect(stateOf(between, 's1')).toBe('done');
    expect(stateOf(between, 's2')).toBeUndefined();
  });
});

describe('open the issue of a run', () => {
  const withAction = (onOpenIssue?: (issueId: string) => void) => (
    <AgentTopology
      agents={[agent]}
      issues={[issue]}
      runs={[run]}
      isLoading={false}
      error={null}
      onRefresh={vi.fn()}
      workflow={workflow}
      {...(onOpenIssue ? { onOpenIssue } : {})}
    />
  );

  it('takes the user to the issue of the run that is open', () => {
    const open = vi.fn();
    const view = render(withAction(open));
    fireEvent.click(view.getByTestId('topology-run-run-1'));
    fireEvent.click(document.querySelector('[data-testid="run-flow-open-issue"]')!);
    expect(open).toHaveBeenCalledWith('issue-1');
    expect(document.querySelector('[data-testid="run-flow-open-issue"]')).toHaveTextContent(
      'Abrir issue',
    );
  });

  it('offers no link when it cannot take the user anywhere', () => {
    const view = render(withAction());
    fireEvent.click(view.getByTestId('topology-run-run-1'));
    expect(document.querySelector('[data-testid="run-flow-open-issue"]')).toBeNull();
  });
});
