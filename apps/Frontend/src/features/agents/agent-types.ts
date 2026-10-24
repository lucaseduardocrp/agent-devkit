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
  | 'integrationtests'
  | 'loadtests'
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
  /** ADK Hub skills the agent uses, at the version copied when they were attached. */
  readonly skills?: readonly AgentSkillDto[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentSkillDto {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** sha256 of the copied SKILL.md; differs from the hub's when an update is available. */
  readonly revision: string;
}

/** At most this many skills per agent (the API refuses more). */
export const MAX_AGENT_SKILLS = 10;

export interface CreateAgentDto {
  readonly parentAgentId?: string | null;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly instructions: string;
  readonly role?: AgentRole;
  readonly model?: string;
  readonly temperature?: number;
  /** Hub skill names; the API copies each SKILL.md. */
  readonly skills?: readonly string[];
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
  /** Every skill the agent uses; the ones it already has keep their copy. */
  readonly skills?: readonly string[];
  /** Skills to copy again from the hub, to bring them to its current version. */
  readonly refreshSkills?: readonly string[];
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
  /** Absent from APIs older than agent skills. */
  readonly skills?: readonly HubSkillDto[];
}

/** A hub skill an agent can use. */
export interface HubSkillDto {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tags?: readonly string[];
  readonly version: string;
  readonly author: string;
  readonly tier: 'built-in' | 'official' | 'community';
  /** sha256 of the hub's current SKILL.md. */
  readonly revision: string;
}
