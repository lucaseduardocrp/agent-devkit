import { describe, expect, it, vi } from 'vitest';
import { AGENT_WORKFLOW_QUESTION_MARKER } from '../src/modules/agents/domain/agent-workflow.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflow,
  type AgentWorkflowCanvas,
  type AgentWorkflowStep,
} from '../src/modules/agents/domain/agent-workflow.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';

const step = (id: string, name: string): AgentWorkflowStep => ({
  id,
  name,
  instructions: `Execute ${name}.`,
});

function setup(
  canvas: AgentWorkflowCanvas,
  steps: readonly AgentWorkflowStep[],
  overrides: Partial<AgentWorkflow> = {},
) {
  const workflow: AgentWorkflow = {
    ...EMPTY_AGENT_WORKFLOW,
    enabled: true,
    finalReview: false,
    steps,
    canvas,
    ...overrides,
  };
  const issues = new InMemoryIssueStore();
  const store = new InMemoryRunStore();
  const executeWorkflowStep = vi
    .fn()
    .mockImplementation((_workspaceId: string, _agentId: string, target: AgentWorkflowStep) => ({
      result: `Resultado de ${target.name}`,
      agent: { id: agentId },
      provider: 'OpenAI',
      model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
  const agents = {
    getAgent: vi.fn().mockResolvedValue({ id: agentId, name: 'Agent A' }),
    getWorkflow: vi.fn().mockResolvedValue(workflow),
    executeWorkflowStep,
  } as unknown as AgentService;
  const runs = new RunService(store, issues, agents);
  const start = async () => {
    const issue = await issues.create(workspaceId, 'user-a', {
      title: 'Ship the flow',
      assigneeAgentId: agentId,
    });
    return { issue, run: await runs.create(issue.id, context) };
  };
  return { issues, runs, executeWorkflowStep, start };
}

/** Which steps the agent was asked to run, in order. */
const ranSteps = (executeWorkflowStep: ReturnType<typeof vi.fn>): string[] =>
  executeWorkflowStep.mock.calls.map((call) => (call[2] as AgentWorkflowStep).id);

describe('workflow flow runner', () => {
  it('takes the branch a condition holds and leaves the other one unrun', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          {
            id: 'gate',
            kind: 'condition',
            x: 2,
            y: 0,
            condition: { operator: 'contains', value: 'triagem' },
          },
          { id: 'fix', kind: 'step', x: 3, y: 0 },
          { id: 'reject', kind: 'step', x: 3, y: 1 },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'gate' },
          { id: 'e3', from: 'gate', fromPort: 'true', to: 'fix' },
          { id: 'e4', from: 'gate', fromPort: 'false', to: 'reject' },
        ],
      },
      [step('triage', 'Triagem'), step('fix', 'Correção'), step('reject', 'Recusa')],
    );

    const { run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('succeeded'),
    );

    expect(ranSteps(executeWorkflowStep)).toEqual(['triage', 'fix']);
    const finished = await runs.get(workspaceId, run.id);
    expect(finished.output).toContain('Resultado de Correção');
    expect(finished.output).not.toContain('Resultado de Recusa');
    expect(finished.output).toContain('A comparação foi atendida.');
  });

  it('follows the false branch when the comparison does not hold', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          {
            id: 'gate',
            kind: 'condition',
            x: 2,
            y: 0,
            condition: { operator: 'contains', value: 'bloqueado' },
          },
          { id: 'fix', kind: 'step', x: 3, y: 0 },
          { id: 'reject', kind: 'step', x: 3, y: 1 },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'gate' },
          { id: 'e3', from: 'gate', fromPort: 'true', to: 'fix' },
          { id: 'e4', from: 'gate', fromPort: 'false', to: 'reject' },
        ],
      },
      [step('triage', 'Triagem'), step('fix', 'Correção'), step('reject', 'Recusa')],
    );

    const { run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('succeeded'),
    );

    expect(ranSteps(executeWorkflowStep)).toEqual(['triage', 'reject']);
    expect((await runs.get(workspaceId, run.id)).output).toContain(
      'A comparação não foi atendida.',
    );
  });

  it('publishes the previous result on the issue when an action node asks for a comment', async () => {
    const { issues, runs, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          {
            id: 'tell',
            kind: 'action',
            x: 2,
            y: 0,
            action: { toolset: 'issues', toolName: 'issues_comment' },
          },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'tell' },
        ],
      },
      [step('triage', 'Triagem')],
    );

    const { issue, run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('succeeded'),
    );

    expect((await issues.comments(issue.id)).map((comment) => comment.body)).toContain(
      'Resultado de Triagem',
    );
  });

  it('fails the run when an action node names a tool only an MCP client can call', async () => {
    const { runs, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          {
            id: 'push',
            kind: 'action',
            x: 1,
            y: 0,
            action: { toolset: 'pbi', toolName: 'pbi_create' },
          },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'push' }],
      },
      [],
    );

    const { run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('failed'),
    );
    expect((await runs.get(workspaceId, run.id)).error).toContain('pbi_create');
  });

  it('stops at an approval node and runs the rest once the user approves', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          { id: 'gate', kind: 'approval', x: 2, y: 0 },
          { id: 'ship', kind: 'step', x: 3, y: 0 },
          { id: 'wait', kind: 'delay', x: 4, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'gate' },
          { id: 'e3', from: 'gate', to: 'ship' },
          { id: 'e4', from: 'ship', to: 'wait' },
        ],
      },
      [step('triage', 'Triagem'), step('ship', 'Entrega')],
    );

    const { run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('waiting_review'),
    );
    expect(ranSteps(executeWorkflowStep)).toEqual(['triage']);

    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('succeeded'),
    );
    expect(ranSteps(executeWorkflowStep)).toEqual(['triage', 'ship']);
    expect((await runs.get(workspaceId, run.id)).output).toContain('Aguardando 0 min');
  });

  const finish = async (
    runs: RunService,
    runId: string,
    status: 'succeeded' | 'failed' | 'waiting_review' | 'cancelled',
  ) => vi.waitFor(async () => expect((await runs.get(workspaceId, runId)).status).toBe(status));

  it('fails a run whose agent steps loop back on themselves forever', async () => {
    const { runs, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'a', kind: 'step', x: 1, y: 0 },
          {
            id: 'gate',
            kind: 'condition',
            x: 2,
            y: 0,
            condition: { operator: 'contains', value: 'resultado' },
          },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'a' },
          { id: 'e2', from: 'a', to: 'gate' },
          { id: 'e3', from: 'gate', fromPort: 'true', to: 'a' },
        ],
      },
      [step('a', 'A')],
    );
    const { run } = await start();
    await finish(runs, run.id, 'failed');
    expect((await runs.get(workspaceId, run.id)).error).toContain('too many nodes');
  });

  it('fails a run whose flow nodes loop back on themselves forever', async () => {
    const { runs, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'pause', kind: 'delay', x: 1, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'pause' },
          { id: 'e2', from: 'pause', to: 'pause' },
        ],
      },
      [],
    );
    const { run } = await start();
    await finish(runs, run.id, 'failed');
    expect((await runs.get(workspaceId, run.id)).error).toContain('too many nodes');
  });

  it('ends the flow at an edge into nothing and skips steps that were deleted', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'gone', kind: 'step', x: 1, y: 0 },
          { id: 'again', kind: 'trigger', x: 2, y: 0 },
          { id: 'real', kind: 'step', x: 3, y: 0 },
          { id: 'wait', kind: 'delay', x: 4, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'gone' },
          { id: 'e2', from: 'gone', to: 'again' },
          { id: 'e3', from: 'again', to: 'real' },
          { id: 'e4', from: 'real', to: 'wait' },
          { id: 'e5', from: 'wait', to: 'ghost' },
        ],
      },
      [step('real', 'Real')],
    );
    const { run } = await start();
    await finish(runs, run.id, 'succeeded');
    expect(ranSteps(executeWorkflowStep)).toEqual(['real']);
  });

  it('gives up a delay as soon as the run is cancelled', async () => {
    const { runs, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'pause', kind: 'delay', x: 1, y: 0, delay: { minutes: 30 } },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'pause' }],
      },
      [],
    );
    const { run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).output).toContain('Aguardando 30 min'),
    );
    await runs.cancel(workspaceId, run.id);
    await finish(runs, run.id, 'cancelled');
  });

  it('fails the run when a condition or action node is not configured', async () => {
    const broken: AgentWorkflowCanvas['nodes'][number][] = [
      { id: 'bad', kind: 'condition', x: 1, y: 0 },
      {
        id: 'bad',
        kind: 'condition',
        x: 1,
        y: 0,
        condition: { operator: 'matches', value: '(' },
      },
      { id: 'bad', kind: 'action', x: 1, y: 0 },
    ];
    for (const node of broken) {
      const { runs, start } = setup(
        {
          nodes: [{ id: 'start', kind: 'trigger', x: 0, y: 0 }, node],
          edges: [{ id: 'e1', from: 'start', to: 'bad' }],
        },
        [],
      );
      const { run } = await start();
      await finish(runs, run.id, 'failed');
    }
  });

  it('comments a fallback text when there is no earlier result to publish', async () => {
    const { issues, runs, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          {
            id: 'tell',
            kind: 'action',
            x: 1,
            y: 0,
            action: { toolset: 'issues', toolName: 'issues_comment' },
          },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'tell' }],
      },
      [],
    );
    const { issue, run } = await start();
    await finish(runs, run.id, 'succeeded');
    expect((await issues.comments(issue.id)).map((comment) => comment.body)).toContain(
      'A etapa anterior não produziu resultado.',
    );
  });

  it('does not pause twice when a supervised step is followed by an approval node', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          { id: 'gate', kind: 'approval', x: 2, y: 0 },
          { id: 'ship', kind: 'step', x: 3, y: 0 },
          { id: 'wait', kind: 'delay', x: 4, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'gate' },
          { id: 'e3', from: 'gate', to: 'ship' },
          { id: 'e4', from: 'ship', to: 'wait' },
        ],
      },
      [step('triage', 'Triagem'), step('ship', 'Entrega')],
      { autonomy: 'supervised' },
    );
    const { run } = await start();
    await finish(runs, run.id, 'waiting_review');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await vi.waitFor(() => expect(ranSteps(executeWorkflowStep)).toEqual(['triage', 'ship']));
    await finish(runs, run.id, 'waiting_review');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'approve' });
    await finish(runs, run.id, 'succeeded');
  });

  it('re-runs the step under review when the user asks for a revision at an approval node', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          { id: 'gate', kind: 'approval', x: 2, y: 0 },
          { id: 'wait', kind: 'delay', x: 3, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'gate' },
          { id: 'e3', from: 'gate', to: 'wait' },
        ],
      },
      [step('triage', 'Triagem')],
    );
    const { run } = await start();
    await finish(runs, run.id, 'waiting_review');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'Refaça.' });
    await vi.waitFor(() => expect(ranSteps(executeWorkflowStep)).toHaveLength(2));
    expect(ranSteps(executeWorkflowStep)).toEqual(['triage', 'triage']);
  });

  it('accepts a revision requested before any step has produced a result', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'gate', kind: 'approval', x: 1, y: 0 },
          { id: 'triage', kind: 'step', x: 2, y: 0 },
          { id: 'wait', kind: 'delay', x: 3, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'gate' },
          { id: 'e2', from: 'gate', to: 'triage' },
          { id: 'e3', from: 'triage', to: 'wait' },
        ],
      },
      [step('triage', 'Triagem')],
    );
    const { run } = await start();
    await finish(runs, run.id, 'waiting_review');
    await runs.continueWorkflow(workspaceId, run.id, { action: 'revise', answer: 'Antes.' });
    await vi.waitFor(() => expect(ranSteps(executeWorkflowStep)).toEqual(['triage']));
  });

  it('resumes a canvas run at the node it asked its question from', async () => {
    const { runs, executeWorkflowStep, start } = setup(
      {
        nodes: [
          { id: 'start', kind: 'trigger', x: 0, y: 0 },
          { id: 'triage', kind: 'step', x: 1, y: 0 },
          { id: 'wait', kind: 'delay', x: 2, y: 0, delay: { minutes: 0 } },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'triage' },
          { id: 'e2', from: 'triage', to: 'wait' },
        ],
      },
      [step('triage', 'Triagem')],
    );
    executeWorkflowStep.mockImplementationOnce(() => ({
      result: `${AGENT_WORKFLOW_QUESTION_MARKER}Qual ambiente?`,
      agent: { id: agentId },
      provider: 'OpenAI',
      model: 'model-a',
    }));
    const { run } = await start();
    await vi.waitFor(async () =>
      expect((await runs.get(workspaceId, run.id)).status).toBe('waiting_input'),
    );
    await runs.continueWorkflow(workspaceId, run.id, { action: 'answer', answer: 'staging' });
    await finish(runs, run.id, 'succeeded');
    expect(ranSteps(executeWorkflowStep)).toEqual(['triage', 'triage']);
  });
});
