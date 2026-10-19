import type { AgentRepository } from '../application/agent-repository.js';
import type { CustomAgent } from '../domain/agent-entity.js';
import { type AgentRole } from '../domain/agent-entity.js';

export class InMemoryAgentRepository implements AgentRepository {
  private readonly agents = new Map<string, CustomAgent>();

  public save(agent: CustomAgent): Promise<CustomAgent> {
    this.agents.set(agent.id, agent);
    return Promise.resolve(agent);
  }

  public findById(id: string, workspaceId?: string): Promise<CustomAgent | null> {
    const agent = this.agents.get(id);
    if (!agent) {
      return Promise.resolve(null);
    }
    if (workspaceId && agent.workspaceId !== workspaceId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(agent);
  }

  public findBySlug(workspaceId: string, slug: string): Promise<CustomAgent | null> {
    for (const agent of this.agents.values()) {
      if (agent.workspaceId === workspaceId && agent.slug === slug) {
        return Promise.resolve(agent);
      }
    }
    return Promise.resolve(null);
  }

  public listByWorkspace(workspaceId: string, role?: AgentRole): Promise<readonly CustomAgent[]> {
    const results: CustomAgent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.workspaceId === workspaceId) {
        if (!role || agent.role === role) {
          results.push(agent);
        }
      }
    }
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(results);
  }

  public delete(id: string, workspaceId: string): Promise<boolean> {
    const agent = this.agents.get(id);
    if (!agent || agent.workspaceId !== workspaceId) {
      return Promise.resolve(false);
    }
    this.agents.delete(id);
    return Promise.resolve(true);
  }
}
