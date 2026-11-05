import { describe, expect, it, vi } from 'vitest';
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

function setup(canvas: AgentWorkflowCanvas, steps: readonly AgentWorkflowStep[]) {
  const workflow: AgentWorkflow = {
    ...EMPTY_AGENT_WORKFLOW,
    enabled: true,
    finalReview: false,
    steps,
    canvas,
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
});
