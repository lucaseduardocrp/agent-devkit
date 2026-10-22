import type { AgentWorkflow } from '../domain/agent-workflow.js';

export interface AgentWorkflowRepository {
  findByWorkspace(workspaceId: string): Promise<AgentWorkflow>;
  save(workspaceId: string, workflow: AgentWorkflow): Promise<AgentWorkflow>;
}
