import type {
  AgentWorkflowDto,
  AgentWorkflowStepDto,
  AgentWorkflowToolset,
} from './agent-types.js';

/** The node every flow starts from. It is the trigger, and it cannot be removed. */
export const WORKFLOW_TRIGGER_NODE_ID = 'start';

export type WorkflowNodeKind =
  'trigger' | 'step' | 'approval' | 'action' | 'condition' | 'delay' | 'rule';

/** What makes the workflow run. */
export type WorkflowTriggerKind = 'issue-assigned' | 'product-event' | 'schedule';

/** The product events a `product-event` trigger can listen to. */
export type WorkflowProductEvent =
  'pbi.created' | 'pbi.moved' | 'spec.published' | 'issue.commented';

export const WORKFLOW_PRODUCT_EVENTS: readonly WorkflowProductEvent[] = [
  'pbi.created',
  'pbi.moved',
  'spec.published',
  'issue.commented',
];

/** How a condition node compares the previous result. */
export type WorkflowConditionOperator = 'contains' | 'not-contains' | 'matches';

export const WORKFLOW_CONDITION_OPERATORS: readonly WorkflowConditionOperator[] = [
  'contains',
  'not-contains',
  'matches',
];

/** The two outputs of a condition node; every other node has a single, unnamed output. */
export type WorkflowPort = 'true' | 'false';

export interface WorkflowTriggerConfig {
  readonly kind: WorkflowTriggerKind;
  /** Only for `product-event`; an empty list listens to nothing. */
  readonly events?: readonly WorkflowProductEvent[];
  /** Only for `schedule`: a 5-field cron expression. */
  readonly cron?: string;
}

export interface WorkflowActionConfig {
  readonly toolset: AgentWorkflowToolset;
  /** The exact MCP action. Without one the node has nothing to run. */
  readonly toolName?: string;
  /** Integration provider to run the action against, when the action takes one. */
  readonly provider?: string;
  /** Who to tell and what to say, for the `notifications_send` action. Kept as it was saved. */
  readonly notification?: {
    readonly channels: readonly string[];
    readonly userIds: readonly string[];
    readonly roles: readonly ('assignee' | 'proofreader')[];
    readonly subject: string;
    readonly message: string;
  };
}

export interface WorkflowConditionConfig {
  readonly operator: WorkflowConditionOperator;
  /** What the previous result is compared against. */
  readonly value: string;
}

export interface WorkflowDelayConfig {
  readonly minutes: number;
}

interface WorkflowNodeBase {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** A node on the canvas, positioned by its top-left corner in canvas coordinates. */
export type WorkflowNode =
  | (WorkflowNodeBase & { readonly kind: 'trigger'; readonly trigger: WorkflowTriggerConfig })
  | (WorkflowNodeBase & { readonly kind: 'step' })
  | (WorkflowNodeBase & { readonly kind: 'approval' })
  /** A module rule: its id is the rule's id; it sits on the canvas but takes no connections. */
  | (WorkflowNodeBase & { readonly kind: 'rule' })
  | (WorkflowNodeBase & { readonly kind: 'action'; readonly action: WorkflowActionConfig })
  | (WorkflowNodeBase & {
      readonly kind: 'condition';
      readonly condition: WorkflowConditionConfig;
    })
  | (WorkflowNodeBase & { readonly kind: 'delay'; readonly delay: WorkflowDelayConfig });

/** The nodes whose inspector edits a configuration bag rather than a step record. */
export type WorkflowConfigurableNode = Extract<
  WorkflowNode,
  { kind: 'action' } | { kind: 'condition' } | { kind: 'delay' }
>;

export interface WorkflowEdge {
  readonly id: string;
  readonly from: string;
  /** Which output of `from` the edge leaves by. Only condition nodes have named outputs. */
  readonly fromPort?: WorkflowPort;
  readonly to: string;
}

export interface WorkflowGraph {
  readonly nodes: readonly WorkflowNode[];
  readonly edges: readonly WorkflowEdge[];
}

export interface WorkflowPoint {
  readonly x: number;
  readonly y: number;
}

/** Node footprints, so ports and the generated layout agree with what the canvas renders. */
export const NODE_SIZES: Record<
  WorkflowNodeKind,
  { readonly width: number; readonly height: number }
> = {
  trigger: { width: 216, height: 112 },
  step: { width: 232, height: 112 },
  approval: { width: 200, height: 96 },
  action: { width: 232, height: 112 },
  condition: { width: 212, height: 112 },
  delay: { width: 196, height: 96 },
  rule: { width: 216, height: 96 },
};

/** The node kinds the palette can drop on the canvas; the trigger is always there already. */
export const ADDABLE_NODE_KINDS: readonly Exclude<WorkflowNodeKind, 'trigger'>[] = [
  'step',
  'approval',
  'action',
  'condition',
  'delay',
  'rule',
];

/** Nodes snap to this grid while dragging, the way the dotted background suggests. */
export const GRID_SIZE = 8;
/** Horizontal gap between two nodes of the generated layout. */
export const COLUMN_GAP = 88;
/** Where the generated layout puts its first row. */
export const LAYOUT_ORIGIN: WorkflowPoint = { x: 48, y: 160 };
/** A delay cannot be longer than this, because the runner waits it out in process. */
export const MAX_DELAY_MINUTES = 60;

export const DEFAULT_TRIGGER: WorkflowTriggerConfig = { kind: 'issue-assigned' };
export const DEFAULT_ACTION: WorkflowActionConfig = { toolset: 'pbi' };
/** What the palette's notification node starts as: the notifications module's one action. */
export const NOTIFICATION_ACTION: WorkflowActionConfig = {
  toolset: 'notifications',
  toolName: 'notifications_send',
};

/** Whether an action node tells people, which the canvas shows as a notification node. */
export function isNotificationAction(action: WorkflowActionConfig): boolean {
  return action.toolset === 'notifications' && action.toolName === 'notifications_send';
}
export const DEFAULT_CONDITION: WorkflowConditionConfig = { operator: 'contains', value: '' };
export const DEFAULT_DELAY: WorkflowDelayConfig = { minutes: 5 };

export function newWorkflowId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export function nodeSize(kind: WorkflowNodeKind): {
  readonly width: number;
  readonly height: number;
} {
  return NODE_SIZES[kind];
}

export interface WorkflowViewport {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * The viewport that shows every node at once: as large as fits (never above 100%, never below
 * `minZoom`), centred in the surface. Null while the surface or the graph has no size to fit.
 */
export function fitViewport(
  nodes: readonly WorkflowNode[],
  surface: { readonly width: number; readonly height: number },
  { padding, minZoom }: { readonly padding: number; readonly minZoom: number },
): WorkflowViewport | null {
  if (nodes.length === 0 || surface.width <= 0 || surface.height <= 0) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + nodeSize(node.kind).width));
  const bottom = Math.max(...nodes.map((node) => node.y + nodeSize(node.kind).height));
  // Rounded down, like the zoom buttons round: the label and the layout use the same number.
  const zoom = Math.max(
    minZoom,
    Math.floor(
      Math.min(
        1,
        (surface.width - padding * 2) / (right - left),
        (surface.height - padding * 2) / (bottom - top),
      ) * 100,
    ) / 100,
  );
  return {
    zoom,
    x: (surface.width - (right - left) * zoom) / 2 - left * zoom,
    y: (surface.height - (bottom - top) * zoom) / 2 - top * zoom,
  };
}

/** The outputs a node offers: a condition has a true and a false one, everything else has one. */
export function nodePorts(node: WorkflowNode): readonly (WorkflowPort | undefined)[] {
  if (node.kind === 'rule') return [];
  return node.kind === 'condition' ? ['true', 'false'] : [undefined];
}

/** Where a connection leaves from. A condition's two outputs sit above and below its centre. */
export function outputPort(node: WorkflowNode, port?: WorkflowPort): WorkflowPoint {
  const size = nodeSize(node.kind);
  if (node.kind !== 'condition') return { x: node.x + size.width, y: node.y + size.height / 2 };
  return {
    x: node.x + size.width,
    y: node.y + (port === 'false' ? (size.height * 2) / 3 : size.height / 3),
  };
}

/** Where a connection arrives: the left edge, vertically centred. */
export function inputPort(node: WorkflowNode): WorkflowPoint {
  const size = nodeSize(node.kind);
  return { x: node.x, y: node.y + size.height / 2 };
}

/** A horizontal bezier, so connections read like the ones of a flow editor. */
export function edgePath(from: WorkflowPoint, to: WorkflowPoint): string {
  const distance = Math.max(Math.abs(to.x - from.x) / 2, 40);
  return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
}

export function edgeMidpoint(from: WorkflowPoint, to: WorkflowPoint): WorkflowPoint {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

export function findNode(graph: WorkflowGraph, id: string): WorkflowNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

/** A node of the given kind, carrying the defaults of its configuration. */
export function createNode(
  id: string,
  kind: WorkflowNodeKind,
  position: WorkflowPoint,
  action: WorkflowActionConfig = DEFAULT_ACTION,
): WorkflowNode {
  const base = { id, x: position.x, y: position.y };
  switch (kind) {
    case 'trigger':
      return { ...base, kind, trigger: DEFAULT_TRIGGER };
    case 'action':
      return { ...base, kind, action };
    case 'condition':
      return { ...base, kind, condition: DEFAULT_CONDITION };
    case 'delay':
      return { ...base, kind, delay: DEFAULT_DELAY };
    default:
      return { ...base, kind };
  }
}

function triggerNode(): WorkflowNode {
  return createNode(WORKFLOW_TRIGGER_NODE_ID, 'trigger', LAYOUT_ORIGIN);
}

/**
 * The layout used by a workflow that has never been arranged by hand: a single row of steps, with
 * an approval node after every step that asked for a review.
 */
export function defaultGraph(steps: readonly AgentWorkflowStepDto[]): WorkflowGraph {
  const nodes: WorkflowNode[] = [triggerNode()];
  const edges: WorkflowEdge[] = [];
  let x = LAYOUT_ORIGIN.x + NODE_SIZES.trigger.width + COLUMN_GAP;
  let previousId = WORKFLOW_TRIGGER_NODE_ID;

  const chain = (node: WorkflowNode) => {
    nodes.push(node);
    edges.push({ id: `edge-${previousId}-${node.id}`, from: previousId, to: node.id });
    previousId = node.id;
    x += nodeSize(node.kind).width + COLUMN_GAP;
  };

  for (const step of steps) {
    chain(createNode(step.id, 'step', { x, y: LAYOUT_ORIGIN.y }));
    if (step.reviewRequired) {
      chain(
        createNode(`approval-${step.id}`, 'approval', {
          x,
          y: LAYOUT_ORIGIN.y + (NODE_SIZES.step.height - NODE_SIZES.approval.height) / 2,
        }),
      );
    }
  }

  return { nodes, edges };
}

const nodeKinds: readonly WorkflowNodeKind[] = [
  'trigger',
  'step',
  'approval',
  'action',
  'condition',
  'delay',
  'rule',
];

/**
 * A stored node, repaired into one of the known kinds. Canvases saved before the trigger and
 * action nodes existed call the first node `start` and carry no configuration, so the missing
 * parts are filled with the defaults rather than dropping the node.
 */
function readNode(value: unknown): WorkflowNode | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'] === 'start' ? 'trigger' : raw['kind'];
  if (
    typeof raw['id'] !== 'string' ||
    typeof kind !== 'string' ||
    !nodeKinds.includes(kind as WorkflowNodeKind) ||
    typeof raw['x'] !== 'number' ||
    !Number.isFinite(raw['x']) ||
    typeof raw['y'] !== 'number' ||
    !Number.isFinite(raw['y'])
  )
    return null;

  const node = createNode(raw['id'], kind as WorkflowNodeKind, { x: raw['x'], y: raw['y'] });
  if (node.kind === 'trigger' && isTriggerConfig(raw['trigger']))
    return { ...node, trigger: raw['trigger'] };
  if (node.kind === 'action' && isActionConfig(raw['action']))
    return { ...node, action: raw['action'] };
  if (node.kind === 'condition' && isConditionConfig(raw['condition']))
    return { ...node, condition: raw['condition'] };
  if (node.kind === 'delay' && isDelayConfig(raw['delay'])) return { ...node, delay: raw['delay'] };
  return node;
}

function isTriggerConfig(value: unknown): value is WorkflowTriggerConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  return (
    config['kind'] === 'issue-assigned' ||
    config['kind'] === 'product-event' ||
    config['kind'] === 'schedule'
  );
}

function isActionConfig(value: unknown): value is WorkflowActionConfig {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Record<string, unknown>)['toolset'] === 'string';
}

function isConditionConfig(value: unknown): value is WorkflowConditionConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Record<string, unknown>;
  return (
    WORKFLOW_CONDITION_OPERATORS.includes(config['operator'] as WorkflowConditionOperator) &&
    typeof config['value'] === 'string'
  );
}

function isDelayConfig(value: unknown): value is WorkflowDelayConfig {
  if (!value || typeof value !== 'object') return false;
  const minutes = (value as Record<string, unknown>)['minutes'];
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0;
}

function readEdge(value: unknown): WorkflowEdge | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw['id'] !== 'string' ||
    typeof raw['from'] !== 'string' ||
    typeof raw['to'] !== 'string'
  )
    return null;
  const port = raw['fromPort'];
  return {
    id: raw['id'],
    from: raw['from'],
    to: raw['to'],
    ...(port === 'true' || port === 'false' ? { fromPort: port } : {}),
  };
}

/**
 * The canvas of a stored workflow, repaired against its steps: a step added elsewhere gets a node,
 * a step that is gone loses its node, and connections to nodes that no longer exist are dropped.
 */
function normalizeFlow(workflow: AgentWorkflowDto): WorkflowGraph {
  const steps = workflow.steps;
  const stored = workflow.canvas;
  if (!stored || !Array.isArray(stored.nodes) || stored.nodes.length === 0) {
    return defaultGraph(steps);
  }

  const stepIds = new Set(steps.map((step) => step.id));
  const ruleIds = new Set(workflow.rules.map((rule) => rule.id));
  const seen = new Set<string>();
  const nodes: WorkflowNode[] = [];
  for (const candidate of stored.nodes) {
    const node = readNode(candidate);
    if (!node || seen.has(node.id)) continue;
    if (node.kind === 'step' && !stepIds.has(node.id)) continue;
    if (node.kind === 'rule' && !ruleIds.has(node.id)) continue;
    if (node.kind === 'trigger' && node.id !== WORKFLOW_TRIGGER_NODE_ID) continue;
    seen.add(node.id);
    nodes.push(node);
  }

  if (!seen.has(WORKFLOW_TRIGGER_NODE_ID)) {
    nodes.unshift(triggerNode());
    seen.add(WORKFLOW_TRIGGER_NODE_ID);
  }

  let nextX = nodes.reduce(
    (furthest, node) => Math.max(furthest, node.x + nodeSize(node.kind).width + COLUMN_GAP),
    LAYOUT_ORIGIN.x,
  );
  for (const step of steps) {
    if (seen.has(step.id)) continue;
    seen.add(step.id);
    nodes.push(createNode(step.id, 'step', { x: nextX, y: LAYOUT_ORIGIN.y }));
    nextX += NODE_SIZES.step.width + COLUMN_GAP;
  }

  const pairs = new Set<string>();
  const edges: WorkflowEdge[] = [];
  for (const candidate of Array.isArray(stored.edges) ? stored.edges : []) {
    const edge = readEdge(candidate);
    if (!edge) continue;
    const pair = `${edge.from}:${edge.fromPort ?? ''}>${edge.to}`;
    if (edge.from === edge.to || !seen.has(edge.from) || !seen.has(edge.to) || pairs.has(pair))
      continue;
    pairs.add(pair);
    edges.push(edge);
  }

  return { nodes, edges };
}

function targetsOf(graph: WorkflowGraph, id: string): string[] {
  return graph.edges.filter((edge) => edge.from === id).map((edge) => edge.to);
}

/** True when connecting `from` to `to` would close a loop, which the runner cannot execute. */
export function wouldCreateCycle(graph: WorkflowGraph, from: string, to: string): boolean {
  if (from === to) return true;
  const stack = [to];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...targetsOf(graph, current));
  }
  return false;
}

/** Whether a connection leaving `from` by `port` can be added to the graph. */
export function canConnect(
  graph: WorkflowGraph,
  from: string,
  to: string,
  port?: WorkflowPort,
): boolean {
  if (to === WORKFLOW_TRIGGER_NODE_ID) return false;
  if (graph.edges.some((edge) => edge.from === from && edge.fromPort === port && edge.to === to))
    return false;
  return !wouldCreateCycle(graph, from, to);
}

export function connectNodes(
  graph: WorkflowGraph,
  from: string,
  to: string,
  port?: WorkflowPort,
): WorkflowGraph {
  if (!canConnect(graph, from, to, port)) return graph;
  return {
    nodes: graph.nodes,
    edges: [
      ...graph.edges,
      { id: newWorkflowId('edge'), from, to, ...(port ? { fromPort: port } : {}) },
    ],
  };
}

export function disconnectEdge(graph: WorkflowGraph, edgeId: string): WorkflowGraph {
  return { nodes: graph.nodes, edges: graph.edges.filter((edge) => edge.id !== edgeId) };
}

export function moveNode(graph: WorkflowGraph, id: string, x: number, y: number): WorkflowGraph {
  return {
    nodes: graph.nodes.map((node) =>
      node.id === id
        ? { ...node, x: Math.max(0, snapToGrid(x)), y: Math.max(0, snapToGrid(y)) }
        : node,
    ),
    edges: graph.edges,
  };
}

/** Replaces a node with an edited copy of itself, keeping its place in the graph. */
export function updateNode(graph: WorkflowGraph, next: WorkflowNode): WorkflowGraph {
  return {
    nodes: graph.nodes.map((node) => (node.id === next.id ? next : node)),
    edges: graph.edges,
  };
}

/** Removes a node and every connection touching it. The trigger node cannot be removed. */
export function removeNode(graph: WorkflowGraph, id: string): WorkflowGraph {
  if (id === WORKFLOW_TRIGGER_NODE_ID) return graph;
  return {
    nodes: graph.nodes.filter((node) => node.id !== id),
    edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id),
  };
}

/** Rules sit on their own row under the flow, so they never overlap its steps. */
const RULE_ROW_Y = LAYOUT_ORIGIN.y + 232;

function nextRulePosition(graph: WorkflowGraph): WorkflowPoint {
  const x = graph.nodes
    .filter((node) => node.kind === 'rule')
    .reduce(
      (furthest, node) => Math.max(furthest, node.x + NODE_SIZES.rule.width + COLUMN_GAP / 2),
      LAYOUT_ORIGIN.x,
    );
  return { x, y: RULE_ROW_Y };
}

/** The canvas of a stored workflow, repaired against its steps and its module rules. */
export function normalizeGraph(workflow: AgentWorkflowDto): WorkflowGraph {
  let graph = normalizeFlow(workflow);
  for (const rule of workflow.rules) {
    if (graph.nodes.some((node) => node.id === rule.id)) continue;
    graph = {
      nodes: [...graph.nodes, createNode(rule.id, 'rule', nextRulePosition(graph))],
      edges: graph.edges,
    };
  }
  return graph;
}

/** A free spot for a new node: to the right of everything already placed. */
export function nextNodePosition(graph: WorkflowGraph, kind: WorkflowNodeKind): WorkflowPoint {
  if (kind === 'rule') return nextRulePosition(graph);
  const x = graph.nodes.reduce(
    (furthest, node) => Math.max(furthest, node.x + nodeSize(node.kind).width + COLUMN_GAP),
    LAYOUT_ORIGIN.x,
  );
  return { x, y: LAYOUT_ORIGIN.y + (NODE_SIZES.step.height - nodeSize(kind).height) / 2 };
}

export function addNode(
  graph: WorkflowGraph,
  id: string,
  kind: WorkflowNodeKind,
  action?: WorkflowActionConfig,
): WorkflowGraph {
  return {
    nodes: [...graph.nodes, createNode(id, kind, nextNodePosition(graph, kind), action)],
    edges: graph.edges,
  };
}

/**
 * The end of the main chain: the single node the walk from the trigger reaches last. A new node is
 * wired to it, so adding one continues the flow instead of dropping it loose on the canvas. When
 * the flow branches into several open ends there is no single place to continue, so nothing is
 * returned and the new node stays unconnected.
 */
export function findChainTail(graph: WorkflowGraph): string | null {
  const visited = new Set<string>();
  const openEnds: string[] = [];
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const targets = targetsOf(graph, id);
    if (targets.length === 0) openEnds.push(id);
    for (const target of targets) walk(target);
  };
  walk(WORKFLOW_TRIGGER_NODE_ID);
  return openEnds.length === 1 ? openEnds[0]! : null;
}

/**
 * The steps as the runner needs them: in the order the connections walk them from the trigger,
 * with `reviewRequired` set on every step whose output reaches an approval node. Steps the
 * connections never reach keep their place at the end, so an unwired step is not lost.
 */
export function deriveSteps(
  graph: WorkflowGraph,
  steps: readonly AgentWorkflowStepDto[],
): AgentWorkflowStepDto[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const approvals = new Set(
    graph.nodes.filter((node) => node.kind === 'approval').map((node) => node.id),
  );
  const gated = new Set(
    graph.edges.filter((edge) => approvals.has(edge.to)).map((edge) => edge.from),
  );

  const order: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    if (byId.has(id)) order.push(id);
    for (const target of targetsOf(graph, id)) walk(target);
  };
  walk(WORKFLOW_TRIGGER_NODE_ID);
  for (const step of steps) if (!visited.has(step.id)) order.push(step.id);

  return order.map((id) => ({ ...byId.get(id)!, reviewRequired: gated.has(id) }));
}

/** The workflow as the canvas left it: the steps re-ordered and re-gated, plus the saved layout. */
export function applyGraph(workflow: AgentWorkflowDto, graph: WorkflowGraph): AgentWorkflowDto {
  return {
    ...workflow,
    steps: deriveSteps(graph, workflow.steps),
    canvas: { nodes: graph.nodes, edges: graph.edges },
  };
}

/** How many steps pause the run for an approval, for the header summary. */
export function countApprovalGates(steps: readonly AgentWorkflowStepDto[]): number {
  return steps.filter((step) => step.reviewRequired).length;
}

/** What is wrong with a node, so the canvas can mark it and saving can be refused. */
export function nodeProblem(
  node: WorkflowNode,
): 'action' | 'notification' | 'condition' | 'delay' | 'cron' | null {
  if (node.kind === 'action' && !node.action.toolName?.trim()) return 'action';
  // The runner refuses a notification that has no channel or nobody to tell.
  if (node.kind === 'action' && isNotificationAction(node.action)) {
    const config = node.action.notification;
    if (!config || config.channels.length === 0) return 'notification';
    if (config.userIds.length === 0 && config.roles.length === 0) return 'notification';
  }
  if (node.kind === 'condition' && !node.condition.value.trim()) return 'condition';
  if (node.kind === 'delay' && (node.delay.minutes <= 0 || node.delay.minutes > MAX_DELAY_MINUTES))
    return 'delay';
  if (node.kind === 'trigger' && node.trigger.kind === 'schedule' && !node.trigger.cron?.trim())
    return 'cron';
  return null;
}

/** Every node the flow cannot run as configured. */
export function incompleteNodes(graph: WorkflowGraph): readonly WorkflowNode[] {
  return graph.nodes.filter((node) => nodeProblem(node) !== null);
}
