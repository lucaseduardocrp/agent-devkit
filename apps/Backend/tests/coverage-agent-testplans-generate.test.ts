import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiKnowledgeTestPlanGenerator,
  DeterministicTestPlanGenerator,
  extractFlowStepsFromPrompt,
} from '../src/modules/testplans/application/generate-test-plan.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import type { AgentRepository } from '../src/modules/agents/application/agent-repository.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';

const requirement =
  'The report screen must display every employee dismissal record filtered between start and end dates.';

const llmReturning = (steps: { action: string; expected: string }[]) => {
  const complete = vi.fn().mockResolvedValue({
    provider: 'mock',
    text: JSON.stringify([{ title: 'Report filter', description: 'Report filter', steps }]),
  });
  const llm: LlmPort = { provider: 'mock', complete, stream: async function* () {} };
  return { complete, llm };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractFlowStepsFromPrompt free-form English requirements', () => {
  it('returns an executable English test structure for long requirements', () => {
    const steps = extractFlowStepsFromPrompt(
      'The monthly payroll summary must list every employee hired this year',
      'en-US',
    );
    expect(steps.map((step) => step.order)).toEqual([1, 2, 3, 4]);
    expect(steps[0]).toEqual({
      order: 1,
      action: 'Open the feature related to the test case.',
      expectedResult: 'The initial feature screen is displayed and available for interaction.',
    });
    expect(steps[3]?.action).toBe('Check the result and data displayed after processing.');
  });

  it('drops questions and fragments and keeps the generic expectation for other actions', () => {
    const steps = extractFlowStepsFromPrompt(
      '- Clicar no botão salvar\n- Salvou?\n- Ok;\n- Isso funciona mesmo?',
    );
    expect(steps).toEqual([
      {
        order: 1,
        action: 'Clicar no botão salvar',
        expectedResult:
          'Etapa realizada com sucesso e resultado validado de acordo com o esperado.',
      },
    ]);
  });
});

describe('AiKnowledgeTestPlanGenerator rejects unusable model steps', () => {
  const fallback = () => new DeterministicTestPlanGenerator().generate({ prompt: requirement });

  it.each([
    ['generic actions', [{ action: 'Execute the test.', expected: 'The report is displayed.' }]],
    [
      'generic expected results',
      [{ action: 'Open the report screen.', expected: 'Works as expected.' }],
    ],
    [
      'oversized actions',
      [{ action: `Open the report ${'x'.repeat(250)}`, expected: 'The report is displayed.' }],
    ],
    [
      'actions copied from the requirement',
      [
        {
          action:
            'Report screen must display every employee dismissal record filtered between dates',
          expected: 'The report is displayed.',
        },
      ],
    ],
    [
      'expected results copied from the requirement',
      [
        {
          action: 'Open the report screen.',
          expected:
            'Report screen must display every employee dismissal record filtered between dates',
        },
      ],
    ],
  ])('retries once and falls back after %s', async (_label, steps) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { complete, llm } = llmReturning(steps);
    const generator = new AiKnowledgeTestPlanGenerator({ defaultLlm: llm });

    const result = await generator.generate({ prompt: requirement });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result).toEqual(await fallback());
    expect(error).toHaveBeenCalledWith(
      '[AiKnowledgeTestPlanGenerator] LLM completion or parsing failed:',
      expect.objectContaining({
        message: 'The model did not produce localized, executable test steps.',
      }),
    );
  });

  it('accepts concise steps that only reuse a few requirement words', async () => {
    const { complete, llm } = llmReturning([
      {
        action: 'Open the employee report screen and choose the dismissal filter options available',
        expected:
          'The filtered list shows only matching people with their names and current status',
      },
    ]);
    const result = await new AiKnowledgeTestPlanGenerator({ defaultLlm: llm }).generate({
      prompt: requirement,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(result.title).toBe('Report filter');
  });
});

describe('AiKnowledgeTestPlanGenerator provider and agent selection', () => {
  it('resolves the requested LLM provider for the workspace', async () => {
    const { llm } = llmReturning([
      { action: 'Open the report screen.', expected: 'The report is displayed.' },
    ]);
    const resolveLlmProvider = vi.fn().mockResolvedValue(llm);
    const generator = new AiKnowledgeTestPlanGenerator({
      dynamicProviderFactory: { resolveLlmProvider } as unknown as DynamicProviderFactory,
    });

    const result = await generator.generate(
      { prompt: requirement, llmProvider: 'gemini' },
      { requestId: 'r', ownerId: 'owner-1' },
    );

    expect(resolveLlmProvider).toHaveBeenCalledWith('owner-1', 'gemini');
    expect(result.plans).toHaveLength(1);
  });

  it('prepares a grounded brief in the requirement language without calling a model', async () => {
    const brief = await new AiKnowledgeTestPlanGenerator().prepare({ prompt: requirement });
    expect(brief.outputLanguage).toBe('English');
    expect(brief.knowledgeSources).toEqual([]);
    expect(brief.context).toContain('dismissal record');
    expect(brief.instruction).toContain('English');
  });

  it('fails when the selected agent does not exist in the workspace', async () => {
    const findById = vi.fn().mockResolvedValue(null);
    const generator = new AiKnowledgeTestPlanGenerator({
      agentRepository: { findById } as unknown as AgentRepository,
    });
    await expect(
      generator.prepare(
        { prompt: requirement, agentId: 'agent-1' },
        { requestId: 'r', ownerId: 'owner-1' },
      ),
    ).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
      statusCode: 404,
      details: [{ field: 'agentId' }],
    });
    expect(findById).toHaveBeenCalledWith('agent-1', 'owner-1');
  });

  it('fails when an agent is selected but the generator cannot load agents', async () => {
    const complete = vi.fn();
    const generator = new AiKnowledgeTestPlanGenerator({
      defaultLlm: { provider: 'mock', complete, stream: async function* () {} },
    });
    await expect(
      generator.generate({ prompt: requirement, agentId: 'agent-1' }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AVAILABLE', statusCode: 503 });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('AiKnowledgeTestPlanGenerator with an agent workflow', () => {
  const context = { requestId: 'r', ownerId: 'owner-1', workspaceId: 'ws-1' };
  const validPlan = JSON.stringify([
    {
      title: 'Report filter',
      description: 'Report filter',
      steps: [
        {
          action:
            'Open the employee report screen and choose the dismissal filter options available',
          expected:
            'The filtered list shows only matching people with their names and current status',
        },
      ],
    },
  ]);

  function build(options: {
    answers: string[];
    agents?: { id: string; isDefault?: boolean; role?: string }[];
    stepAgentId?: string;
    enabled?: boolean;
  }) {
    const executeAgent = vi.fn();
    for (const answer of options.answers) executeAgent.mockResolvedValueOnce({ result: answer });
    const getWorkflow = vi.fn().mockResolvedValue({
      enabled: options.enabled ?? true,
      steps: [{ id: 's1', name: 'Plan', instructions: 'x', agentId: options.stepAgentId }],
    });
    const generator = new AiKnowledgeTestPlanGenerator({
      agentService: { getWorkflow, executeAgent } as never,
      agentRepository: {
        findById: vi.fn().mockResolvedValue({ id: 'chosen' }),
        listByWorkspace: vi.fn().mockResolvedValue(options.agents ?? []),
      } as unknown as AgentRepository,
    });
    return { generator, executeAgent };
  }

  it('asks the selected agent and returns the plans it writes', async () => {
    const { generator, executeAgent } = build({ answers: [validPlan] });
    const result = await generator.generate(
      { prompt: requirement, agentId: 'chosen', llmProvider: 'gemini' },
      context,
    );
    expect(result.title).toBe('Report filter');
    expect(result.plans).toHaveLength(1);
    expect(executeAgent).toHaveBeenCalledOnce();
    expect(executeAgent).toHaveBeenCalledWith(
      'ws-1',
      'chosen',
      expect.objectContaining({ includeKnowledge: false, llmProvider: 'gemini' }),
      context,
    );
  });

  it('picks the default agent, then a QA agent, then the one of the workflow', async () => {
    const byDefault = build({
      answers: [validPlan],
      agents: [
        { id: 'qa', role: 'QA' },
        { id: 'main', isDefault: true },
      ],
      stepAgentId: 'step-agent',
    });
    await byDefault.generator.generate({ prompt: requirement }, context);
    expect(byDefault.executeAgent.mock.calls[0]![1]).toBe('main');

    const byRole = build({ answers: [validPlan], agents: [{ id: 'qa', role: 'QA' }] });
    await byRole.generator.generate({ prompt: requirement }, context);
    expect(byRole.executeAgent.mock.calls[0]![1]).toBe('qa');

    const byStep = build({ answers: [validPlan], stepAgentId: 'step-agent' });
    await byStep.generator.generate({ prompt: requirement }, context);
    expect(byStep.executeAgent.mock.calls[0]![1]).toBe('step-agent');
    expect(byStep.executeAgent.mock.calls[0]![2]).not.toHaveProperty('llmProvider');
  });

  it('needs an agent, either chosen or in the workflow', async () => {
    const { generator, executeAgent } = build({ answers: [] });
    await expect(generator.generate({ prompt: requirement }, context)).rejects.toMatchObject({
      code: 'AGENT_WORKFLOW_AGENT_REQUIRED',
      statusCode: 409,
    });
    expect(executeAgent).not.toHaveBeenCalled();
  });

  it('asks again once with a correction when the answer is unusable, then gives up', async () => {
    const generic = JSON.stringify([
      {
        title: 'Report filter',
        description: 'Report filter',
        steps: [{ action: 'Execute the test.', expected: 'The report is displayed.' }],
      },
    ]);
    const retry = build({ answers: [generic, validPlan], stepAgentId: 'a' });
    const result = await retry.generator.generate({ prompt: requirement }, context);
    expect(result.title).toBe('Report filter');
    expect(retry.executeAgent).toHaveBeenCalledTimes(2);
    expect(retry.executeAgent.mock.calls[0]![2].prompt).not.toContain('CORRECTION REQUIRED');
    expect(retry.executeAgent.mock.calls[1]![2].prompt).toContain('CORRECTION REQUIRED');

    const hopeless = build({ answers: [generic, generic], stepAgentId: 'a' });
    await expect(
      hopeless.generator.generate({ prompt: requirement }, context),
    ).rejects.toMatchObject({ code: 'AGENT_WORKFLOW_OUTPUT_INVALID', statusCode: 502 });
    expect(hopeless.executeAgent).toHaveBeenCalledTimes(2);
    // An answer that is not JSON at all is not worth a second try.
    const garbage = build({ answers: ['not json at all'], stepAgentId: 'a' });
    await expect(
      garbage.generator.generate({ prompt: requirement }, context),
    ).rejects.toMatchObject({
      code: 'AGENT_WORKFLOW_OUTPUT_INVALID',
    });
    expect(garbage.executeAgent).toHaveBeenCalledOnce();
  });

  it('uses the normal path when the workflow is off or has no steps', async () => {
    const { llm } = llmReturning([
      { action: 'Open the report screen.', expected: 'The report is displayed.' },
    ]);
    const off = build({ answers: [], enabled: false });
    const generator = new AiKnowledgeTestPlanGenerator({
      defaultLlm: llm,
      agentService: {
        getWorkflow: vi.fn().mockResolvedValue({ enabled: true, steps: [] }),
      } as never,
    });
    expect((await generator.generate({ prompt: requirement }, context)).plans).toHaveLength(1);
    await off.generator.generate({ prompt: requirement }, context).catch(() => undefined);
    expect(off.executeAgent).not.toHaveBeenCalled();
  });
});
