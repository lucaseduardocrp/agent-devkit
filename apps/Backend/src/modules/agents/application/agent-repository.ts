import type { CustomAgent, AgentRole } from '../domain/agent-entity.js';

export interface AgentRepository {
  save(agent: CustomAgent): Promise<CustomAgent>;
  findById(id: string, workspaceId?: string): Promise<CustomAgent | null>;
  findBySlug(workspaceId: string, slug: string): Promise<CustomAgent | null>;
  listByWorkspace(workspaceId: string, role?: AgentRole): Promise<readonly CustomAgent[]>;
  delete(id: string, workspaceId: string): Promise<boolean>;
}
