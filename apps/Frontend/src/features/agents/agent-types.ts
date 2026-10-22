export type AgentRole = 'QA' | 'DOCUMENTATION' | 'REFACTOR' | 'CUSTOM';

export interface AgentWorkflowStepDto {
  readonly id: string;
  readonly name: string;
  readonly agentId?: string;
  readonly instructions: string;
  readonly reviewRequired?: boolean;
  readonly agent?: {
    readonly id: string;
    readonly name: string;
    readonly role: AgentRole;
    readonly instructions: string;
  };
}

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

export interface AgentWorkflowRuleDto {
  readonly id: string;
  readonly name: string;
  readonly toolset: AgentWorkflowToolset;
  readonly toolName?: string;
  readonly effect: 'allow' | 'deny';
  readonly allowedProviders?: readonly string[];
  readonly createIssueForAction?: boolean;
  readonly requireApproval?: boolean;
}

export interface AgentWorkflowDto {
  readonly enabled: boolean;
  readonly autonomy: 'supervised' | 'balanced' | 'autonomous';
  readonly finalReview: boolean;
  readonly uncertaintyBehavior: 'ask' | 'assume';
  readonly issueCreationBehavior: 'ask' | 'allow';
  readonly defaultAction: 'allow' | 'deny';
  readonly steps: readonly AgentWorkflowStepDto[];
  readonly rules: readonly AgentWorkflowRuleDto[];
  readonly updatedAt?: string;
}

export interface CustomAgentDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentAgentId?: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly instructions: string;
  readonly role: AgentRole;
  readonly model?: string;
  readonly temperature: number;
  readonly isSystem: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAgentDto {
  readonly parentAgentId?: string | null;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly instructions: string;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly temperature?: number;
}

export interface UpdateAgentDto {
  readonly parentAgentId?: string | null;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly temperature?: number;
}

export interface ExecuteAgentDto {
  readonly prompt: string;
  readonly useKnowledge?: boolean;
  readonly llmProvider?: string;
}

export interface ExecuteAgentResponse {
  readonly content: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly role: AgentRole;
  };
  readonly chunksUsed: number;
  readonly provider?: string;
}
