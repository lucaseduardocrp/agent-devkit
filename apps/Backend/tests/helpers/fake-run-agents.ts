import { vi } from 'vitest';
import type { AgentService } from '../../src/modules/agents/application/agent-service.js';
import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflow,
} from '../../src/modules/agents/domain/agent-workflow.js';

type Execute = (...args: unknown[]) => Promise<object>;

/**
 * Agent service double for RunService. Without an enabled workflow, a run executes as a single
 * workflow step with the assigned agent, so `executeWorkflowStep` delegates to `executeAgent`
 * (called with `workspaceId, agentId, input, context, signal`).
 */
export function fakeRunAgents(
  executeAgent: ReturnType<typeof vi.fn>,
  options: { agent?: object; workflow?: Partial<AgentWorkflow> } = {},
) {
  return {
    getAgent: vi.fn().mockResolvedValue(options.agent ?? { id: 'agent-a', name: 'Agent' }),
    getWorkflow: vi.fn().mockResolvedValue({ ...EMPTY_AGENT_WORKFLOW, ...options.workflow }),
    executeAgent,
    executeWorkflowStep: vi.fn(
      async (
        workspaceId: string,
        agentId: string,
        _step: unknown,
        _stepNumber: number,
        _stepCount: number,
        input: unknown,
        _uncertainty: unknown,
        context: unknown,
        signal: AbortSignal,
      ) => ({
        agent: { id: agentId },
        ...(await (executeAgent as Execute)(workspaceId, agentId, input, context, signal)),
      }),
    ),
  } as unknown as AgentService & {
    getAgent: ReturnType<typeof vi.fn>;
    getWorkflow: ReturnType<typeof vi.fn>;
    executeWorkflowStep: ReturnType<typeof vi.fn>;
  };
}
