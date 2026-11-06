export interface AgentWorkflowStep {
  readonly id: string;
  readonly name: string;
  /** Uses the agent selected for the request when omitted. */
  readonly agentId?: string;
  readonly instructions: string;
  /** Pause an Issue run after this step, regardless of the workspace autonomy mode. */
  readonly reviewRequired?: boolean;
}

export type AgentWorkflowAutonomy = 'supervised' | 'balanced' | 'autonomous';

export type AgentWorkflowToolset =
  | 'all'
  | 'agents'
  | 'integrations'
  | 'brain'
  | 'issues'
  | 'pbi'
  | 'spec'
  | 'testplans'
  | 'design'
  | 'e2e'
  | 'releasenotes'
  | 'integrationtests'
  | 'loadtests'
  | 'audit'
  | 'workspaces';

export interface AgentWorkflowRule {
  readonly id: string;
  readonly name: string;
  readonly toolset: AgentWorkflowToolset;
  /** Exact MCP tool name. Omit to apply the rule to the whole module. */
  readonly toolName?: string;
  readonly effect: 'allow' | 'deny';
  /** Provider IDs allowed for this exact action. An empty list blocks every provider. */
  readonly allowedProviders?: readonly string[];
  /** Creates a tracking Issue before each write action that matches this rule. */
  readonly createIssueForAction?: boolean;
  /** Ask the connected MCP client to obtain human approval before a matching write action. */
  readonly requireApproval?: boolean;
}

/** What makes the workflow run. `start` is the name the trigger node had before it had a kind. */
export type AgentWorkflowTriggerKind = 'issue-assigned' | 'product-event' | 'schedule';

/** The product events a `product-event` trigger listens to. */
export type AgentWorkflowProductEvent =
  'pbi.created' | 'pbi.moved' | 'spec.published' | 'issue.commented';

export interface AgentWorkflowTriggerConfig {
  readonly kind: AgentWorkflowTriggerKind;
  readonly events?: readonly AgentWorkflowProductEvent[];
  /** A 5-field cron expression; only for `schedule`. */
  readonly cron?: string;
}

/** One MCP action of a module, run by the flow without going through an agent. */
export interface AgentWorkflowActionConfig {
  readonly toolset: AgentWorkflowToolset;
  readonly toolName?: string;
  readonly provider?: string;
}

export type AgentWorkflowConditionOperator = 'contains' | 'not-contains' | 'matches';

/** How a condition node compares the result of the node before it. */
export interface AgentWorkflowConditionConfig {
  readonly operator: AgentWorkflowConditionOperator;
  readonly value: string;
}

export interface AgentWorkflowDelayConfig {
  readonly minutes: number;
}

export type AgentWorkflowNodeKind =
  'trigger' | 'step' | 'approval' | 'action' | 'condition' | 'delay' | 'rule';

/**
 * A node of the hand-arranged flow canvas. The canvas is what the editor saves and what the runner
 * walks; `steps` stays beside it as the plain, ordered list every older reader still understands.
 */
export interface AgentWorkflowCanvasNode {
  readonly id: string;
  readonly kind: AgentWorkflowNodeKind;
  readonly x: number;
  readonly y: number;
  readonly trigger?: AgentWorkflowTriggerConfig;
  readonly action?: AgentWorkflowActionConfig;
  readonly condition?: AgentWorkflowConditionConfig;
  readonly delay?: AgentWorkflowDelayConfig;
}

/** A connection between two canvas nodes. */
export interface AgentWorkflowCanvasEdge {
  readonly id: string;
  readonly from: string;
  /** Which output of `from` the edge leaves by; only condition nodes have named outputs. */
  readonly fromPort?: 'true' | 'false';
  readonly to: string;
}

/** The id the trigger node always has, so the runner can find where the flow starts. */
export const AGENT_WORKFLOW_TRIGGER_NODE_ID = 'start';

/** A delay cannot be longer than this, because the runner waits it out in process. */
export const AGENT_WORKFLOW_MAX_DELAY_MINUTES = 60;

/** The layout the editor saved, so the flow reopens exactly as it was arranged. */
export interface AgentWorkflowCanvas {
  readonly nodes: readonly AgentWorkflowCanvasNode[];
  readonly edges: readonly AgentWorkflowCanvasEdge[];
}

export const AGENT_WORKFLOW_QUESTION_MARKER = '[[ADK_QUESTION]]';

export interface AgentWorkflow {
  readonly enabled: boolean;
  readonly autonomy: AgentWorkflowAutonomy;
  readonly finalReview: boolean;
  readonly uncertaintyBehavior: 'ask' | 'assume';
  readonly issueCreationBehavior: 'ask' | 'allow';
  readonly defaultAction: 'allow' | 'deny';
  readonly steps: readonly AgentWorkflowStep[];
  readonly rules: readonly AgentWorkflowRule[];
  /** Absent on workflows saved before the canvas existed; the editor then lays them out. */
  readonly canvas?: AgentWorkflowCanvas;
  readonly updatedAt?: string;
}

export const EMPTY_AGENT_WORKFLOW: AgentWorkflow = {
  enabled: false,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};
