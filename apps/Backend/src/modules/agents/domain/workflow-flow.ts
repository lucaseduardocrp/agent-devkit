import {
  AGENT_WORKFLOW_MAX_DELAY_MINUTES,
  AGENT_WORKFLOW_TRIGGER_NODE_ID,
  type AgentWorkflowCanvas,
  type AgentWorkflowCanvasNode,
  type AgentWorkflowConditionConfig,
} from './agent-workflow.js';

/** Kinds the plain ordered step list cannot express, so a canvas holding one has to be walked. */
const FLOW_ONLY_KINDS: ReadonlySet<string> = new Set(['action', 'condition', 'delay']);

/** Whether the run has to walk the canvas node by node instead of running `steps` in order. */
export function canvasNeedsFlowRunner(canvas: AgentWorkflowCanvas | undefined): boolean {
  return canvas?.nodes.some((node) => FLOW_ONLY_KINDS.has(node.kind)) === true;
}

export function flowNode(
  canvas: AgentWorkflowCanvas,
  nodeId: string,
): AgentWorkflowCanvasNode | undefined {
  return canvas.nodes.find((node) => node.id === nodeId);
}

/**
 * The node the flow continues by. Only a condition leaves through a named port, so every other node
 * follows the edge that has none.
 */
export function flowNext(
  canvas: AgentWorkflowCanvas,
  nodeId: string,
  port?: 'true' | 'false',
): string | undefined {
  return canvas.edges.find(
    (edge) =>
      edge.from === nodeId && (port === undefined ? !edge.fromPort : edge.fromPort === port),
  )?.to;
}

/** Where a run starts: the node wired after the trigger. */
export function flowStart(canvas: AgentWorkflowCanvas): string | undefined {
  const trigger =
    flowNode(canvas, AGENT_WORKFLOW_TRIGGER_NODE_ID) ??
    canvas.nodes.find((node) => node.kind === 'trigger');
  return trigger && flowNext(canvas, trigger.id);
}

/** How long a delay node holds the run, clamped to what the runner may wait out in process. */
export function delayMinutes(node: AgentWorkflowCanvasNode): number {
  return Math.min(Math.max(node.delay?.minutes ?? 0, 0), AGENT_WORKFLOW_MAX_DELAY_MINUTES);
}

/**
 * Whether the result before a condition node satisfies it. Text comparisons ignore case, because
 * the value is matched against prose an agent wrote.
 */
export function matchesCondition(config: AgentWorkflowConditionConfig, output: string): boolean {
  switch (config.operator) {
    case 'contains':
      return output.toLowerCase().includes(config.value.toLowerCase());
    case 'not-contains':
      return !output.toLowerCase().includes(config.value.toLowerCase());
    case 'matches':
      return new RegExp(config.value, 'i').test(output);
  }
}
