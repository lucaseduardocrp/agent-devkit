import { describe, expect, it, vi } from 'vitest';
import {
  addNode,
  applyGraph,
  canConnect,
  connectNodes,
  countApprovalGates,
  defaultGraph,
  deriveSteps,
  disconnectEdge,
  DEFAULT_TRIGGER,
  edgeMidpoint,
  edgePath,
  findChainTail,
  findNode,
  inputPort,
  moveNode,
  newWorkflowId,
  nextNodePosition,
  nodeSize,
  normalizeGraph,
  outputPort,
  removeNode,
  snapToGrid,
  WORKFLOW_TRIGGER_NODE_ID,
  wouldCreateCycle,
  type WorkflowGraph,
} from '../src/features/agents/workflow-graph.js';
import type { AgentWorkflowDto, AgentWorkflowStepDto } from '../src/features/agents/agent-types.js';

const step = (id: string, extra: Partial<AgentWorkflowStepDto> = {}): AgentWorkflowStepDto => ({
  id,
  name: id,
  instructions: 'do it',
  ...extra,
});

const workflowOf = (
  steps: readonly AgentWorkflowStepDto[],
  canvas?: AgentWorkflowDto['canvas'],
): AgentWorkflowDto => ({
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps,
  rules: [],
  ...(canvas ? { canvas } : {}),
});

describe('workflow-graph ids and geometry', () => {
  it('uses randomUUID when the platform offers one', () => {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('1-2-3-4-5');
    expect(newWorkflowId('step')).toBe('1-2-3-4-5');
    spy.mockRestore();
  });

  it('falls back to a generated id without randomUUID', () => {
    const spy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue(undefined as unknown as `${string}-${string}-${string}-${string}-${string}`);
    expect(newWorkflowId('step')).toMatch(/^step-\d+-/);
    spy.mockRestore();
  });

  it('snaps positions to the canvas grid', () => {
    expect(snapToGrid(11)).toBe(8);
    expect(snapToGrid(13)).toBe(16);
  });

  it('places the ports on the sides of a node', () => {
    const node = { id: 'a', kind: 'step' as const, x: 100, y: 200 };
    const size = nodeSize('step');
    expect(outputPort(node)).toEqual({ x: 100 + size.width, y: 200 + size.height / 2 });
    expect(inputPort(node)).toEqual({ x: 100, y: 200 + size.height / 2 });
  });

  it('draws a horizontal bezier between two points, with a floor on the curve', () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 400, y: 0 })).toBe('M 0 0 C 200 0, 200 0, 400 0');
    expect(edgePath({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe('M 0 0 C 40 0, -30 0, 10 0');
    expect(edgeMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});

describe('workflow-graph layout', () => {
  it('lays an unarranged workflow out as one row, with a node for each approval', () => {
    const graph = defaultGraph([step('a', { reviewRequired: true }), step('b')]);
    expect(graph.nodes.map((node) => node.kind)).toEqual(['trigger', 'step', 'approval', 'step']);
    expect(graph.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      'start>a',
      'a>approval-a',
      'approval-a>b',
    ]);
    expect(findNode(graph, 'a')!.x).toBeLessThan(findNode(graph, 'b')!.x);
    expect(findNode(graph, 'missing')).toBeUndefined();
  });

  it('builds the default layout for a workflow with no canvas and for an empty one', () => {
    expect(normalizeGraph(workflowOf([step('a')])).edges).toHaveLength(1);
    expect(normalizeGraph(workflowOf([step('a')], { nodes: [], edges: [] })).edges).toHaveLength(1);
  });

  it('repairs a stored canvas against the steps it belongs to', () => {
    const stored = {
      nodes: [
        { id: 'a', kind: 'step' as const, x: 300, y: 100 },
        { id: 'a', kind: 'step' as const, x: 999, y: 999 },
        { id: 'gone', kind: 'step' as const, x: 400, y: 100 },
        { id: 'not-the-start', kind: 'trigger' as const, x: 0, y: 0, trigger: DEFAULT_TRIGGER },
        { id: 'approve', kind: 'approval' as const, x: 500, y: 100 },
        { kind: 'step', x: 1 } as never,
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'approve' },
        { id: 'e1-again', from: 'a', to: 'approve' },
        { id: 'e2', from: 'a', to: 'gone' },
        { id: 'e3', from: 'a', to: 'a' },
        { from: 'a' } as never,
      ],
    };
    const graph = normalizeGraph(workflowOf([step('a'), step('b')], stored));

    expect(graph.nodes.map((node) => node.id)).toEqual([
      WORKFLOW_TRIGGER_NODE_ID,
      'a',
      'approve',
      'b',
    ]);
    expect(findNode(graph, 'a')).toEqual({ id: 'a', kind: 'step', x: 300, y: 100 });
    expect(graph.edges.map((edge) => edge.id)).toEqual(['e1']);
  });

  it('migrates the start node of an older canvas into the trigger node', () => {
    const graph = normalizeGraph(
      workflowOf([], {
        nodes: [{ id: WORKFLOW_TRIGGER_NODE_ID, kind: 'start', x: 10, y: 20 }],
        edges: [],
      }),
    );
    expect(graph.nodes).toEqual([
      { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 10, y: 20, trigger: DEFAULT_TRIGGER },
    ]);
  });

  it('skips empty entries in a stored canvas', () => {
    const graph = normalizeGraph(
      workflowOf([], {
        nodes: [
          null as never,
          { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0, trigger: DEFAULT_TRIGGER },
        ],
        edges: [null as never],
      }),
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toEqual([]);
  });

  it('falls back to the defaults when a node carries no configuration bag', () => {
    const graph = normalizeGraph(
      workflowOf([], {
        nodes: [
          { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0, trigger: null },
          { id: 'act', kind: 'action', x: 0, y: 0, action: null },
          { id: 'cond', kind: 'condition', x: 0, y: 0, condition: null },
          { id: 'wait', kind: 'delay', x: 0, y: 0, delay: null },
        ],
        edges: [],
      }),
    );
    expect(graph.nodes.map((entry) => entry.kind)).toEqual([
      'trigger',
      'action',
      'condition',
      'delay',
    ]);
    expect(findNode(graph, 'act')).toMatchObject({ action: { toolset: 'pbi' } });
    expect(findNode(graph, 'wait')).toMatchObject({ delay: { minutes: 5 } });
  });

  it('drops a canvas whose nodes are not an array', () => {
    const graph = normalizeGraph(workflowOf([step('a')], { nodes: 'nope', edges: [] } as never));
    expect(graph.nodes.map((node) => node.id)).toEqual([WORKFLOW_TRIGGER_NODE_ID, 'a']);
  });

  it('ignores stored edges that are not an array', () => {
    const graph = normalizeGraph(
      workflowOf([], {
        nodes: [
          { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0, trigger: DEFAULT_TRIGGER },
        ],
        edges: 'nope',
      } as never),
    );
    expect(graph.edges).toEqual([]);
  });

  it('places a new node to the right of everything already on the canvas', () => {
    const graph = defaultGraph([step('a')]);
    const position = nextNodePosition(graph, 'approval');
    expect(position.x).toBeGreaterThan(findNode(graph, 'a')!.x);
    expect(addNode(graph, 'new', 'approval').nodes.at(-1)).toEqual({
      id: 'new',
      kind: 'approval',
      ...position,
    });
  });
});

describe('workflow-graph editing', () => {
  const base: WorkflowGraph = defaultGraph([step('a'), step('b')]);

  it('moves a node onto the grid and never off the canvas', () => {
    const moved = moveNode(base, 'a', -40, 103);
    expect(findNode(moved, 'a')).toMatchObject({ x: 0, y: 104 });
    expect(findNode(moved, 'b')).toEqual(findNode(base, 'b'));
  });

  it('connects two nodes and refuses the connections the runner cannot execute', () => {
    expect(canConnect(base, 'a', WORKFLOW_TRIGGER_NODE_ID)).toBe(false);
    expect(canConnect(base, 'a', 'b')).toBe(false);
    expect(canConnect(base, 'b', 'a')).toBe(false);
    expect(canConnect(base, WORKFLOW_TRIGGER_NODE_ID, 'b')).toBe(true);

    const connected = connectNodes(base, WORKFLOW_TRIGGER_NODE_ID, 'b');
    expect(connected.edges).toHaveLength(base.edges.length + 1);
    expect(connectNodes(connected, 'b', 'a')).toBe(connected);
  });

  it('reports a cycle for a node that reaches itself', () => {
    expect(wouldCreateCycle(base, 'a', 'a')).toBe(true);
    expect(
      wouldCreateCycle(
        { nodes: base.nodes, edges: [...base.edges, { id: 'x', from: 'b', to: 'a' }] },
        'a',
        'b',
      ),
    ).toBe(true);
    // Two paths reaching the same node: the walk visits it once and still finds no loop.
    const diamond: WorkflowGraph = {
      nodes: [...base.nodes, { id: 'c', kind: 'step', x: 0, y: 0 }],
      edges: [
        { id: 'e1', from: 'a', to: 'b' },
        { id: 'e2', from: 'a', to: 'c' },
        { id: 'e3', from: 'b', to: 'c' },
      ],
    };
    expect(wouldCreateCycle(diamond, WORKFLOW_TRIGGER_NODE_ID, 'a')).toBe(false);
  });

  it('removes a connection and a node with everything wired to it', () => {
    expect(disconnectEdge(base, 'edge-a-b').edges.map((edge) => edge.id)).toEqual(['edge-start-a']);
    const withoutA = removeNode(base, 'a');
    expect(findNode(withoutA, 'a')).toBeUndefined();
    expect(withoutA.edges).toEqual([]);
    expect(removeNode(base, WORKFLOW_TRIGGER_NODE_ID)).toBe(base);
  });

  it('finds the open end of the flow, and nothing when it branches', () => {
    expect(findChainTail(base)).toBe('b');
    expect(findChainTail(connectNodes(base, WORKFLOW_TRIGGER_NODE_ID, 'b'))).toBe('b');
    const branched = {
      nodes: [...base.nodes, { id: 'c', kind: 'step' as const, x: 0, y: 0 }],
      edges: base.edges,
    };
    expect(findChainTail(connectNodes(branched, WORKFLOW_TRIGGER_NODE_ID, 'c'))).toBeNull();
  });
});

describe('workflow-graph derivation', () => {
  it('orders the steps along the connections and gates the ones feeding an approval', () => {
    const steps = [step('a'), step('b', { reviewRequired: true })];
    const graph: WorkflowGraph = {
      nodes: [
        { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0, trigger: DEFAULT_TRIGGER },
        { id: 'a', kind: 'step', x: 0, y: 0 },
        { id: 'b', kind: 'step', x: 0, y: 0 },
        { id: 'gate', kind: 'approval', x: 0, y: 0 },
      ],
      edges: [
        { id: 'e1', from: WORKFLOW_TRIGGER_NODE_ID, to: 'b' },
        { id: 'e2', from: 'b', to: 'gate' },
        { id: 'e3', from: 'gate', to: 'a' },
      ],
    };
    expect(deriveSteps(graph, steps)).toEqual([
      { id: 'b', name: 'b', instructions: 'do it', reviewRequired: true },
      { id: 'a', name: 'a', instructions: 'do it', reviewRequired: false },
    ]);
  });

  it('keeps a step the connections never reach, at the end and without a gate', () => {
    const steps = [step('a'), step('loose', { reviewRequired: true })];
    const graph: WorkflowGraph = {
      nodes: [
        { id: WORKFLOW_TRIGGER_NODE_ID, kind: 'trigger', x: 0, y: 0, trigger: DEFAULT_TRIGGER },
        { id: 'a', kind: 'step', x: 0, y: 0 },
        { id: 'loose', kind: 'step', x: 0, y: 0 },
      ],
      edges: [{ id: 'e1', from: WORKFLOW_TRIGGER_NODE_ID, to: 'a' }],
    };
    expect(deriveSteps(graph, steps).map((entry) => entry.id)).toEqual(['a', 'loose']);
    expect(deriveSteps(graph, steps)[1]!.reviewRequired).toBe(false);
  });

  it('walks a branch only once', () => {
    const graph = connectNodes(defaultGraph([step('a'), step('b')]), WORKFLOW_TRIGGER_NODE_ID, 'b');
    expect(deriveSteps(graph, [step('a'), step('b')]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('writes the derived steps and the layout back onto the workflow', () => {
    const workflow = workflowOf([step('a'), step('b')]);
    const graph = defaultGraph(workflow.steps);
    const next = applyGraph(workflow, graph);
    expect(next.canvas).toEqual({ nodes: graph.nodes, edges: graph.edges });
    expect(next.steps.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('counts the steps that pause the run', () => {
    expect(countApprovalGates([step('a', { reviewRequired: true }), step('b')])).toBe(1);
  });
});
