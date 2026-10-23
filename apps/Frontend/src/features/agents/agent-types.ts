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
  /** Set for agents installed from the ADK Hub. */
  readonly source?: AgentSourceDto | null;
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

/** Where an agent installed from the ADK Hub came from (hub agent or a plugin's subagent). */
export interface AgentSourceDto {
  readonly kind: 'hub-agent' | 'hub-plugin';
  readonly name: string;
  readonly plugin?: string;
  readonly version: string;
  readonly revision: string;
}

export type HubInstallStatus = 'available' | 'installed' | 'update-available';
export type HubTier = 'official' | 'verified' | 'community';

export interface HubInstallState {
  readonly status: HubInstallStatus;
  readonly installed?: {
    readonly agentId: string;
    readonly name: string;
    readonly version: string;
  };
}

export interface HubAgentDto extends HubInstallState {
  readonly name: string;
  readonly description: string;
  readonly overview: string;
  readonly category: string;
  readonly role: AgentRole;
  readonly temperature?: number;
  readonly tags: readonly string[];
  readonly toolsets: readonly string[];
  readonly author: string;
  readonly version: string;
  readonly license: string;
  readonly tier: HubTier;
}

export interface HubPluginDto {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly version?: string;
  readonly maintainer: string;
  readonly tier: HubTier;
  readonly license: string;
  readonly repo: string;
  readonly sha: string;
  readonly agents: readonly ({ readonly name: string } & HubInstallState)[];
}

/** GET /agents/hub: what the ADK Hub offers this workspace and what it already installed. */
export interface HubAgentCatalogDto {
  readonly generatedAt: string;
  readonly agents: readonly HubAgentDto[];
  readonly plugins: readonly HubPluginDto[];
}
