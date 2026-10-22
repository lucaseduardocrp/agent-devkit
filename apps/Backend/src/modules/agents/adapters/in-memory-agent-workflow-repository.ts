import { EMPTY_AGENT_WORKFLOW, type AgentWorkflow } from '../domain/agent-workflow.js';
import type { AgentWorkflowRepository } from '../application/agent-workflow-repository.js';

export class InMemoryAgentWorkflowRepository implements AgentWorkflowRepository {
  private readonly workflows = new Map<string, AgentWorkflow>();

  public async findByWorkspace(workspaceId: string): Promise<AgentWorkflow> {
    return structuredClone(this.workflows.get(workspaceId) ?? EMPTY_AGENT_WORKFLOW);
  }

  public async save(workspaceId: string, workflow: AgentWorkflow): Promise<AgentWorkflow> {
    const saved = { ...structuredClone(workflow), updatedAt: new Date().toISOString() };
    this.workflows.set(workspaceId, saved);
    return structuredClone(saved);
  }
}
