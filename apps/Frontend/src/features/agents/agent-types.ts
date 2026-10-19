export type AgentRole = 'QA' | 'DOCUMENTATION' | 'REFACTOR' | 'CUSTOM';

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
