import { describe, expect, it } from 'vitest';
import {
  PrismaAgentWorkflowRepository,
  type PrismaAgentWorkflowClient,
} from '../src/modules/agents/adapters/prisma-agent-workflow-repository.js';
import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflow,
} from '../src/modules/agents/domain/agent-workflow.js';

const updatedAt = new Date('2026-01-01T00:00:00.000Z');

/** A prisma double that hands back whatever definition the test stored for the workspace. */
function clientFor(definition: unknown): {
  readonly client: PrismaAgentWorkflowClient;
  readonly saved: { current: unknown };
} {
  const saved = { current: definition };
  return {
    saved,
    client: {
      agentWorkflowRecord: {
        findUnique: async () => ({ definition: saved.current, updatedAt }),
        upsert: async (args) => {
          saved.current = args.create.definition;
          return { definition: saved.current, updatedAt };
        },
      },
    },
  };
}

const read = async (definition: unknown): Promise<AgentWorkflow> =>
  new PrismaAgentWorkflowRepository(clientFor(definition).client).findByWorkspace('workspace');

const validWorkflow = {
  enabled: true,
  autonomy: 'supervised',
  finalReview: false,
  uncertaintyBehavior: 'assume',
  issueCreationBehavior: 'allow',
  defaultAction: 'deny',
  steps: [{ id: 'step-a', name: 'Plan', instructions: 'plan it', reviewRequired: true }],
  rules: [],
};

describe('PrismaAgentWorkflowRepository', () => {
  it('returns the empty workflow when the workspace has no record', async () => {
    const repository = new PrismaAgentWorkflowRepository({
      agentWorkflowRecord: {
        findUnique: async () => null,
        upsert: async () => ({ definition: {}, updatedAt }),
      },
    });
    expect(await repository.findByWorkspace('workspace')).toEqual(EMPTY_AGENT_WORKFLOW);
  });

  it('reads a stored workflow with its own settings', async () => {
    const workflow = await read(validWorkflow);
    expect(workflow).toMatchObject({
      enabled: true,
      autonomy: 'supervised',
      finalReview: false,
      uncertaintyBehavior: 'assume',
      issueCreationBehavior: 'allow',
      defaultAction: 'deny',
      updatedAt: updatedAt.toISOString(),
    });
    expect(workflow.steps).toHaveLength(1);
  });

  it('falls back to the balanced defaults for settings it does not recognise', async () => {
    const workflow = await read({ ...validWorkflow, autonomy: 'nope', defaultAction: 'nope' });
    expect(workflow).toMatchObject({
      autonomy: 'balanced',
      defaultAction: 'allow',
    });
  });

  it('discards a definition that is not a workflow at all', async () => {
    const empty = { ...EMPTY_AGENT_WORKFLOW, updatedAt: updatedAt.toISOString() };
    expect(await read(null)).toEqual(empty);
    expect(await read({ enabled: 'yes', steps: [] })).toEqual(empty);
    expect(await read({ enabled: true, steps: 'none' })).toEqual(empty);
  });

  it('drops the steps that are missing or have the wrong shape', async () => {
    const workflow = await read({
      ...validWorkflow,
      steps: [
        null,
        { id: 1, name: 'x', instructions: 'y' },
        { id: 'a', name: 2, instructions: 'y' },
        { id: 'a', name: 'x', instructions: 3 },
        { id: 'a', name: 'x', instructions: 'y', reviewRequired: 'yes' },
        { id: 'a', name: 'x', instructions: 'y', agentId: 4 },
        { id: 'good', name: 'x', instructions: 'y', agentId: 'agent-1' },
      ],
    });
    expect(workflow.steps.map((step) => step.id)).toEqual(['good']);
  });

  it('reads a workflow whose rules are missing as one without rules', async () => {
    expect((await read({ ...validWorkflow, rules: 'none' })).rules).toEqual([]);
  });

  it('keeps the rules it can read and drops the ones it cannot', async () => {
    const workflow = await read({
      ...validWorkflow,
      rules: [
        null,
        { id: 1, name: 'x', toolset: 'pbi', effect: 'allow' },
        { id: 'a', name: 2, toolset: 'pbi', effect: 'allow' },
        { id: 'a', name: 'x', toolset: 'nope', effect: 'allow' },
        { id: 'a', name: 'x', toolset: 'pbi', effect: 'maybe' },
        { id: 'a', name: 'x', toolset: 'pbi', effect: 'allow', toolName: 5 },
        { id: 'a', name: 'x', toolset: 'pbi', effect: 'allow', createIssueForAction: 'yes' },
        { id: 'a', name: 'x', toolset: 'pbi', effect: 'allow', requireApproval: 'yes' },
        { id: 'a', name: 'x', toolset: 'pbi', effect: 'allow', allowedProviders: 'github' },
        { id: 'a', name: 'x', toolset: 'pbi', effect: 'allow', allowedProviders: [6] },
        {
          id: 'full',
          name: 'Full',
          toolset: 'issues',
          effect: 'deny',
          toolName: 'delete_issue',
          allowedProviders: ['github'],
          createIssueForAction: true,
          requireApproval: true,
        },
        { id: 'bare', name: 'Bare', toolset: 'pbi', effect: 'allow' },
      ],
    });

    expect(workflow.rules).toEqual([
      {
        id: 'full',
        name: 'Full',
        toolset: 'issues',
        effect: 'deny',
        toolName: 'delete_issue',
        allowedProviders: ['github'],
        createIssueForAction: true,
        requireApproval: true,
      },
      { id: 'bare', name: 'Bare', toolset: 'pbi', effect: 'allow' },
    ]);
  });

  it('reads the saved canvas back, with the configuration of every node kind', async () => {
    const canvas = {
      nodes: [
        {
          id: 'start',
          kind: 'trigger',
          x: 0,
          y: 0,
          trigger: { kind: 'schedule', cron: '0 9 * * 1' },
        },
        { id: 'step-a', kind: 'step', x: 300, y: 160 },
        { id: 'gate', kind: 'approval', x: 600, y: 160 },
        {
          id: 'act',
          kind: 'action',
          x: 900,
          y: 160,
          action: { toolset: 'pbi', toolName: 'create_pbi_item', provider: 'azure_devops' },
        },
        {
          id: 'cond',
          kind: 'condition',
          x: 1200,
          y: 160,
          condition: { operator: 'contains', value: 'done' },
        },
        { id: 'wait', kind: 'delay', x: 1500, y: 160, delay: { minutes: 5 } },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'step-a' },
        { id: 'e2', from: 'cond', fromPort: 'true', to: 'wait' },
      ],
    };
    expect((await read({ ...validWorkflow, canvas })).canvas).toEqual(canvas);
  });

  it('migrates the start node of an older canvas into the trigger node', async () => {
    const stored = await read({
      ...validWorkflow,
      canvas: { nodes: [{ id: 'start', kind: 'start', x: 0, y: 0 }], edges: [] },
    });
    expect(stored.canvas!.nodes).toEqual([{ id: 'start', kind: 'trigger', x: 0, y: 0 }]);
  });

  it('listens to the product events it recognises and ignores the rest', async () => {
    const stored = await read({
      ...validWorkflow,
      canvas: {
        nodes: [
          {
            id: 'start',
            kind: 'trigger',
            x: 0,
            y: 0,
            trigger: { kind: 'product-event', events: ['pbi.created', 'nope'] },
          },
        ],
        edges: [],
      },
    });
    expect(stored.canvas!.nodes[0]!.trigger).toEqual({
      kind: 'product-event',
      events: ['pbi.created'],
    });
  });

  it('drops a configuration bag that does not match its node, keeping the node', async () => {
    const nodes = [
      { id: 'start', kind: 'trigger', x: 0, y: 0, trigger: { kind: 'nope' } },
      { id: 'a', kind: 'action', x: 0, y: 0, action: { toolset: 'nope' } },
      { id: 'b', kind: 'action', x: 0, y: 0, action: 'nope' },
      { id: 'c', kind: 'condition', x: 0, y: 0, condition: { operator: 'nope', value: 'x' } },
      { id: 'd', kind: 'condition', x: 0, y: 0, condition: { operator: 'contains', value: 1 } },
      { id: 'e', kind: 'delay', x: 0, y: 0, delay: { minutes: -1 } },
      { id: 'f', kind: 'delay', x: 0, y: 0, delay: { minutes: 'soon' } },
      { id: 'g', kind: 'trigger', x: 0, y: 0, trigger: null },
    ];
    const plain = { id: 'lean', kind: 'action', x: 0, y: 0, action: { toolset: 'issues' } };
    const stored = await read({ ...validWorkflow, canvas: { nodes, edges: [] } });
    expect(stored.canvas!.nodes.map((node) => node.id)).toEqual([
      'start',
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    for (const node of stored.canvas!.nodes) {
      expect(node.trigger ?? node.action ?? node.condition ?? node.delay).toBeUndefined();
    }

    // An action that names only its module keeps that module and nothing else.
    const lean = await read({ ...validWorkflow, canvas: { nodes: [plain], edges: [] } });
    expect(lean.canvas!.nodes[0]!.action).toEqual({ toolset: 'issues' });
  });

  it('keeps an edge port only when it names one of the two condition outputs', async () => {
    const stored = await read({
      ...validWorkflow,
      canvas: {
        nodes: [{ id: 'start', kind: 'trigger', x: 0, y: 0 }],
        edges: [
          { id: 'e1', from: 'a', to: 'b', fromPort: 'true' },
          { id: 'e2', from: 'a', to: 'c', fromPort: 'maybe' },
        ],
      },
    });
    expect(stored.canvas!.edges).toEqual([
      { id: 'e1', from: 'a', to: 'b', fromPort: 'true' },
      { id: 'e2', from: 'a', to: 'c' },
    ]);
  });

  it('drops a canvas it cannot trust, so the editor lays the flow out again', async () => {
    const cases: unknown[] = [
      undefined,
      'nope',
      { nodes: 'nope', edges: [] },
      { nodes: [], edges: 'nope' },
      { nodes: [null], edges: [] },
      { nodes: [{ id: 1, kind: 'step', x: 0, y: 0 }], edges: [] },
      { nodes: [{ id: 'a', kind: 'nope', x: 0, y: 0 }], edges: [] },
      { nodes: [{ id: 'a', kind: 'step', x: 0, y: 0 }], edges: [{ id: 'e', from: 'a' }] },
      { nodes: [{ id: 'a', kind: 'step', x: 'left', y: 0 }], edges: [] },
      { nodes: [{ id: 'a', kind: 'step', x: Number.NaN, y: 0 }], edges: [] },
      { nodes: [{ id: 'a', kind: 'step', x: 0, y: 'top' }], edges: [] },
      { nodes: [{ id: 'a', kind: 'step', x: 0, y: Number.POSITIVE_INFINITY }], edges: [] },
      { nodes: [], edges: [null] },
      { nodes: [], edges: [{ id: 1, from: 'a', to: 'b' }] },
      { nodes: [], edges: [{ id: 'e', from: 2, to: 'b' }] },
      { nodes: [], edges: [{ id: 'e', from: 'a', to: 3 }] },
    ];
    for (const canvas of cases) {
      expect((await read({ ...validWorkflow, canvas })).canvas).toBeUndefined();
    }
  });

  it('saves a workflow and reads back what was stored', async () => {
    const { client, saved } = clientFor(undefined);
    const repository = new PrismaAgentWorkflowRepository(client);
    const result = await repository.save('workspace', {
      ...EMPTY_AGENT_WORKFLOW,
      enabled: true,
      steps: [{ id: 'step-a', name: 'Plan', instructions: 'plan it' }],
      canvas: { nodes: [{ id: 'start', kind: 'trigger', x: 0, y: 0 }], edges: [] },
    });

    expect(saved.current).toMatchObject({ enabled: true });
    expect(result.canvas).toEqual({
      nodes: [{ id: 'start', kind: 'trigger', x: 0, y: 0 }],
      edges: [],
    });
    expect(result.updatedAt).toBe(updatedAt.toISOString());
  });
});
