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
