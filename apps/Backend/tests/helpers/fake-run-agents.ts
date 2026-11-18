import { vi } from 'vitest';
import type { AgentService } from '../../src/modules/agents/application/agent-service.js';
import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflow,
} from '../../src/modules/agents/domain/agent-workflow.js';

/**
 * A fake AgentService for RunService tests. Every workflow step is carried out by `executeAgent`, so
 * a test describes the model once; `getWorkflow` serves the given workflow (no final review by
 * default, so a run goes straight to done).
 */
export function fakeRunAgents(
  executeAgent: ReturnType<typeof vi.fn>,
  workflow: Partial<AgentWorkflow> = {},
  agent: { id: string; name?: string } = { id: 'agent-a', name: 'Agent A' },
) {
  const agents = {
    getAgent: vi.fn().mockResolvedValue(agent),
    getWorkflow: vi
      .fn()
      .mockResolvedValue({ ...EMPTY_AGENT_WORKFLOW, finalReview: false, ...workflow }),
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
        signal: unknown,
      ) => {
        const result = (await (executeAgent as (...args: unknown[]) => Promise<object>)(
          workspaceId,
          agentId,
          input,
          context,
          signal,
        )) as object;
        return { agent: { id: agentId }, ...result };
      },
    ),
  };
  return agents as unknown as AgentService & {
    getAgent: ReturnType<typeof vi.fn>;
    getWorkflow: ReturnType<typeof vi.fn>;
    executeAgent: ReturnType<typeof vi.fn>;
    executeWorkflowStep: ReturnType<typeof vi.fn>;
  };
}
