import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';
import { translateContent, type SupportedLocale } from '../../../shared/i18n.js';
import { type TestPlan, type TestStep, parseAndNormalizeTestPlans } from '../domain/test-plan.js';
import { normalizeTestCaseDescription } from '../domain/test-case-description.js';
import type { KnowledgeSearchPort } from '../../knowledge/application/knowledge-search.js';
import type { LlmPort } from '../../agents/application/agent-ports.js';
import type { DynamicProviderFactory } from '../../integrations/application/dynamic-provider-factory.js';
import type { AgentRepository } from '../../agents/application/agent-repository.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import {
  PromptInjectionGuard,
  PromptInjectionError,
} from '../../agents/application/prompt-injection-guard.js';

export interface TestPlanRequest {
  readonly prompt: string;
  readonly title?: string;
  readonly userPrompt?: string;
  readonly criteria?: string;
  readonly platformProvider?: string;
  readonly llmProvider?: string;
  readonly areaPath?: string;
  readonly assignedTo?: string;
  readonly format?: string;
  readonly useGherkin?: boolean;
  readonly descriptionTemplate?: string;
  readonly agentId?: string;
}

export type GeneratedTestPlanResult = TestPlan & { readonly plans: readonly TestPlan[] };

/** Grounded generation brief for callers that run their own model (for example MCP hosts). */
export interface TestPlanBrief {
  readonly instruction: string;
  readonly context: string;
  readonly outputLanguage: OutputLanguage;
  readonly knowledgeSources: readonly string[];
}

export interface TestPlanGeneratorPort {
  generate(input: TestPlanRequest, context?: RequestContext): Promise<GeneratedTestPlanResult>;
  prepare?(input: TestPlanRequest, context?: RequestContext): Promise<TestPlanBrief>;
}

type OutputLanguage = 'Portuguese (Brazil)' | 'English';

export function sanitizeTestPlanRequirement(value: string): string {
  const lines = value.split(/\r?\n/);
  const cleaned = lines.filter((line, index) => {
    const trimmed = line.trim();
    if (/^(edit|delete|image)$/iu.test(trimmed)) return false;
    if (index < 5 && /^CT-\d+\s*[—-].*plano de testes.*workspace/iu.test(trimmed)) {
      return false;
    }
    return true;
  });

  return cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The language of the requirement controls the artifact, not the UI/header locale. */
export function detectTestPlanLanguage(text: string, fallback?: SupportedLocale): OutputLanguage {
  const normalized = ` ${text.toLocaleLowerCase()} `;
  const portugueseSignals =
    normalized.match(
      /\b(o|a|os|as|de|do|da|dos|das|que|para|com|sem|deve|usuário|tela|campo|relatório|resultado|fluxo|teste)\b/gu,
    )?.length ?? 0;
  const englishSignals =
    normalized.match(
      /\b(the|a|an|of|to|for|with|without|must|should|user|screen|field|report|result|flow|test)\b/gu,
    )?.length ?? 0;

  if (portugueseSignals > englishSignals) return 'Portuguese (Brazil)';
  if (englishSignals > portugueseSignals) return 'English';
  return fallback === 'en-US' ? 'English' : 'Portuguese (Brazil)';
}

function localeForLanguage(language: OutputLanguage): SupportedLocale {
  return language === 'English' ? 'en-US' : 'pt-BR';
}

function hasUsableTestSteps(plans: readonly TestPlan[], requirement: string): boolean {
  const requirementWords = significantWords(requirement);

  return plans.every(
    (plan) =>
      plan.steps.length > 0 &&
      plan.steps.every((step) => {
        const action = step.action.trim();
        const expected = step.expectedResult.trim();
        if (!action || !expected || action.length > 240 || expected.length > 240) return false;
        if (
          /^(execute|perform|run|validate|executar|realizar|validar) (the |o )?(flow|requirement|test|fluxo|requisito|teste)\.?$/iu.test(
            action,
          )
        ) {
          return false;
        }
        if (
          /^(works? as expected|successfully completed|result validated|funciona como esperado|concluído com sucesso|resultado validado)\.?$/iu.test(
            expected,
          )
        ) {
          return false;
        }

        const actionWords = significantWords(action);
        const expectedWords = significantWords(expected);
        if (requirementWords.size < 8) return true;
        const copiedActionWords = [...actionWords].filter((word) =>
          requirementWords.has(word),
        ).length;
        const copiedExpectedWords = [...expectedWords].filter((word) =>
          requirementWords.has(word),
        ).length;
        const actionIsCopied = actionWords.size >= 8 && copiedActionWords / actionWords.size >= 0.8;
        const expectedIsCopied =
          expectedWords.size >= 8 && copiedExpectedWords / expectedWords.size >= 0.8;
        return !actionIsCopied && !expectedIsCopied;
      }),
  );
}

function significantWords(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .match(/[a-z0-9]{4,}/g) ?? [],
  );
}

function usesOutputLanguage(plans: readonly TestPlan[], language: OutputLanguage): boolean {
  const generatedText = plans
    .flatMap((plan) => [
      plan.title,
      plan.description,
      ...plan.steps.flatMap((step) => [step.action, step.expectedResult]),
    ])
    .join('\n');
  const normalized = generatedText.toLocaleLowerCase();
  const portugueseSignals =
    normalized.match(
      /\b(usuário|acessar|preencher|selecionar|clicar|exibido|resultado|fluxo|tela|campo|relatório|deve|dados)\b/gu,
    )?.length ?? 0;
  const englishSignals =
    normalized.match(
      /\b(user|open|fill|select|click|displayed|result|flow|screen|field|report|must|data)\b/gu,
    )?.length ?? 0;

  // Avoid rejecting short labels and product names; reject only a clear competing language.
  return language === 'English'
    ? !(portugueseSignals >= 3 && portugueseSignals > englishSignals)
    : !(englishSignals >= 3 && englishSignals > portugueseSignals);
}

export function extractFlowStepsFromPrompt(
  prompt: string,
  locale: SupportedLocale = 'pt-BR',
): TestStep[] {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return [
      {
        order: 1,
        action: translateContent('defaultAction', locale),
        expectedResult: translateContent('defaultExpected', locale),
      },
    ];
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const candidateSteps: string[] = [];
  let inFlowSection = false;

  for (const line of lines) {
    if (
      /qual o fluxo seguido\??/i.test(line) ||
      /^passos(\s+de\s+teste)?[:?]?$/i.test(line) ||
      /^passos\s+para\s+reproduzir[:?]?$/i.test(line) ||
      /^caminho[:?]?$/i.test(line)
    ) {
      inFlowSection = true;
      continue;
    }

    if (
      inFlowSection &&
      (/^[0-9]+\.\s+padrão/i.test(line) ||
        /^[0-9]+\.\s+descrição/i.test(line) ||
        /^possível\s+causa/i.test(line) ||
        /^o\s+que\s+aconteceu\??/i.test(line) ||
        /^por\s+que\s+está\s+errado\??/i.test(line))
    ) {
      inFlowSection = false;
    }

    if (
      /^(1\.|2\.|3\.|4\.|5\.)\s+descrição/i.test(line) ||
      /^(1\.|2\.|3\.|4\.|5\.)\s+padrão/i.test(line) ||
      /^o\s+que\s+aconteceu\??/i.test(line) ||
      /^por\s+que\s+está\s+errado\??/i.test(line) ||
      /^quais\s+telas\s+passou\??/i.test(line) ||
      /^possível\s+falha/i.test(line)
    ) {
      continue;
    }

    const isBulletOrNumbered = /^(?:passo\s+)?([0-9]+[.):]\s*|[-*•]\s+)/i.test(line);
    const endsInSemicolon = /;$/.test(line);
    const startsWithVerb =
      /^(acessar|abrir|configurar|gerar|exportar|verificar|identificar|validar|confirmar|navegar|preencher|informar|selecionar|clicar|consultar|executar|submeter|conferir|testar|filtrar)/i.test(
        line.replace(/^(?:passo\s+)?([0-9]+[.):]\s*|[-*•]\s+)/i, '').trim(),
      );

    if (inFlowSection || isBulletOrNumbered || endsInSemicolon || startsWithVerb) {
      const clean = line
        .replace(/^(?:passo\s+)?([0-9]+[.):]\s*|[-*•]\s+)/i, '')
        .replace(/;+$/, '')
        .trim();
      if (clean.length > 5 && !clean.endsWith('?')) {
        candidateSteps.push(clean);
      }
    }
  }

  if (candidateSteps.length > 0) {
    return candidateSteps.map((rawAction, idx) => {
      const action = rawAction.charAt(0).toUpperCase() + rawAction.slice(1);
      const lower = action.toLowerCase();
      let expectedResult =
        'Etapa realizada com sucesso e resultado validado de acordo com o esperado.';

      if (lower.includes('acessar') || lower.includes('navegar')) {
        expectedResult =
          'Tela ou relatório acessado com sucesso com todos os parâmetros e menus carregados.';
      } else if (lower.includes('configurar') || lower.includes('filtro')) {
        expectedResult = 'Filtros e parâmetros configurados e aplicados corretamente na consulta.';
      } else if (lower.includes('gerar') || lower.includes('exporta')) {
        expectedResult =
          'Exportação processada e arquivo gerado com sucesso para download no formato selecionado.';
      } else if (lower.includes('abrir')) {
        expectedResult =
          'Planilha aberta com integridade e estrutura de colunas e cabeçalhos visível.';
      } else if (lower.includes('verificar') || lower.includes('identificar')) {
        expectedResult =
          'Dados e preenchimento da coluna validados em conformidade com as regras esperadas do negócio.';
      } else if (lower.includes('bo2') || lower.includes('validar')) {
        expectedResult =
          'Vínculo de atividades e histórico conferidos com sucesso e consistentes com os dados exportados.';
      }

      return {
        order: idx + 1,
        action,
        expectedResult,
      };
    });
  }

  // A substantial free-form requirement still needs actionable steps. Keeping the whole
  // sentence inside one action produces unusable test cases such as
  // "Access and perform the <requirement> flow". Preserve the requirement as
  // the case description and provide a small, executable test structure.
  if (trimmed.length > 45 && locale === 'pt-BR') {
    return [
      {
        order: 1,
        action: 'Acessar a funcionalidade relacionada ao caso de teste.',
        expectedResult:
          'A tela inicial da funcionalidade é exibida e está disponível para interação.',
      },
      {
        order: 2,
        action: 'Preencher os campos necessários com dados válidos para o cenário.',
        expectedResult:
          'Os dados informados são aceitos e permanecem visíveis nos respectivos campos.',
      },
      {
        order: 3,
        action: 'Executar a ação principal disponível na funcionalidade.',
        expectedResult: 'A solicitação é processada sem apresentar erro técnico.',
      },
      {
        order: 4,
        action: 'Conferir o resultado e os dados apresentados após o processamento.',
        expectedResult:
          'O resultado corresponde ao requisito, sem mensagens de erro ou dados inconsistentes.',
      },
    ];
  }

  if (trimmed.length > 45) {
    return [
      {
        order: 1,
        action: 'Open the feature related to the test case.',
        expectedResult: 'The initial feature screen is displayed and available for interaction.',
      },
      {
        order: 2,
        action: 'Fill in the required fields with valid data for the scenario.',
        expectedResult:
          'The entered data is accepted and remains visible in the corresponding fields.',
      },
      {
        order: 3,
        action: 'Perform the main action available in the feature.',
        expectedResult: 'The request is processed without a technical error.',
      },
      {
        order: 4,
        action: 'Check the result and data displayed after processing.',
        expectedResult: 'The result matches the requirement without errors or inconsistent data.',
      },
    ];
  }

  return [
    {
      order: 1,
      action: translateContent('fallbackAction', locale, { subject: trimmed }),
      expectedResult: translateContent('fallbackExpected', locale, { subject: trimmed }),
    },
  ];
}

export class DeterministicTestPlanGenerator implements TestPlanGeneratorPort {
  public generate(
    input: TestPlanRequest,
    context?: RequestContext,
  ): Promise<GeneratedTestPlanResult> {
    const rawPrompt = input.prompt.trim();
    if (!rawPrompt) {
      return Promise.reject(
        new ApplicationError('TEST_PLAN_PROMPT_REQUIRED', 'Prompt is required.', 400, [
          { field: 'prompt' },
        ]),
      );
    }

    const prompt = sanitizeTestPlanRequirement(rawPrompt);
    const locale = localeForLanguage(detectTestPlanLanguage(prompt, context?.locale));
    const title = input.title?.trim() || translateContent('defaultTestPlanTitle', locale);
    const steps = extractFlowStepsFromPrompt(prompt, locale);
    const purePlan: TestPlan = {
      title,
      description: normalizeTestCaseDescription(
        { useCase: prompt },
        locale,
        steps.map((step) => step.action),
      ),
      steps,
    };

    return Promise.resolve({
      ...purePlan,
      plans: [purePlan],
    });
  }
}

export interface AiKnowledgeTestPlanGeneratorOptions {
  readonly knowledgeSearch?: KnowledgeSearchPort;
  readonly dynamicProviderFactory?: DynamicProviderFactory;
  readonly defaultLlm?: LlmPort;
  readonly fallbackGenerator?: TestPlanGeneratorPort;
  readonly agentRepository?: AgentRepository;
  readonly agentService?: AgentService;
}

export class AiKnowledgeTestPlanGenerator implements TestPlanGeneratorPort {
  private readonly fallbackGenerator: TestPlanGeneratorPort;

  public constructor(private readonly options: AiKnowledgeTestPlanGeneratorOptions = {}) {
    this.fallbackGenerator = options.fallbackGenerator ?? new DeterministicTestPlanGenerator();
  }

  /**
   * Builds the same grounded instruction and context used by `generate`, without calling an LLM,
   * so an external model (for example an MCP host) can author the plans itself.
   */
  public async prepare(input: TestPlanRequest, context?: RequestContext): Promise<TestPlanBrief> {
    const composed = await this.compose(input, context);
    return {
      instruction: composed.directive,
      context: composed.contextText,
      outputLanguage: composed.outputLanguage,
      knowledgeSources: composed.knowledgeSources,
    };
  }

  public async generate(
    input: TestPlanRequest,
    context?: RequestContext,
  ): Promise<GeneratedTestPlanResult> {
    const { prompt, contextText, directive, outputLanguage } = await this.compose(input, context);
    const workspaceId = context?.workspaceId ?? context?.ownerId;
    if (workspaceId && this.options.agentService) {
      const workflow = await this.options.agentService.getWorkflow(workspaceId);
      if (workflow.enabled && workflow.steps.length > 0) {
        return this.generateWithWorkflow(
          input,
          context,
          { prompt, contextText, directive, outputLanguage },
          workspaceId,
          workflow.steps.find((step) => step.agentId)?.agentId,
        );
      }
    }
    const { payload, nonce } = PromptInjectionGuard.wrapWithSandboxEnvelope(contextText);
    const instruction = PromptInjectionGuard.buildSystemInstruction(directive, nonce);

    let llm: LlmPort | null = null;
    if (this.options.dynamicProviderFactory && context?.ownerId) {
      llm = input.llmProvider
        ? await this.options.dynamicProviderFactory.resolveLlmProvider(
            context.ownerId,
            input.llmProvider,
          )
        : await this.options.dynamicProviderFactory.resolveLlmProvider(context.ownerId);
    }
    if (!llm && this.options.defaultLlm) {
      llm = this.options.defaultLlm;
    }

    if (!llm) {
      return this.fallbackGenerator.generate(input, context);
    }

    try {
      let parsedPlans: readonly TestPlan[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const qualityReminder =
          attempt === 0
            ? ''
            : `\n\nCORRECTION REQUIRED: The previous response violated the language or executable-step rules. Regenerate from scratch. Use only ${outputLanguage}; make every action atomic and executable; never copy the requirement into a step.`;
        const attemptInstruction = `${instruction}${qualityReminder}`;
        const completion = await llm.complete({ prompt: payload, instruction: attemptInstruction });
        const verifiedOutput = PromptInjectionGuard.verifyOutput(
          completion.text,
          attemptInstruction,
        );
        parsedPlans = parseAndNormalizeTestPlans(verifiedOutput, {
          language: localeForLanguage(outputLanguage),
        });
        if (
          parsedPlans.length > 0 &&
          usesOutputLanguage(parsedPlans, outputLanguage) &&
          hasUsableTestSteps(parsedPlans, prompt)
        ) {
          break;
        }
        parsedPlans = [];
      }

      if (parsedPlans.length === 0) {
        throw new Error('The model did not produce localized, executable test steps.');
      }

      const primary = parsedPlans[0]!;
      return {
        ...primary,
        plans: parsedPlans,
      };
    } catch (error) {
      if (error instanceof PromptInjectionError) {
        throw error;
      }
      console.error('[AiKnowledgeTestPlanGenerator] LLM completion or parsing failed:', error);
      return this.fallbackGenerator.generate(input, context);
    }
  }

  private async generateWithWorkflow(
    input: TestPlanRequest,
    context: RequestContext | undefined,
    composed: {
      prompt: string;
      contextText: string;
      directive: string;
      outputLanguage: OutputLanguage;
    },
    workspaceId: string,
    workflowAgentId?: string,
  ): Promise<GeneratedTestPlanResult> {
    const agents = await this.options.agentRepository?.listByWorkspace(workspaceId);
    const agentId =
      input.agentId ??
      agents?.find((agent) => agent.isDefault)?.id ??
      agents?.find((agent) => agent.role === 'QA')?.id ??
      workflowAgentId;
    if (!agentId || !this.options.agentService) {
      throw new ApplicationError(
        'AGENT_WORKFLOW_AGENT_REQUIRED',
        'An agent must be selected in the workflow or workspace before generating this test plan.',
        409,
      );
    }

    let parsedPlans: readonly TestPlan[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const qualityReminder =
        attempt === 0
          ? ''
          : `\n\nCORRECTION REQUIRED: The previous response violated the language or executable-step rules. Regenerate from scratch. Use only ${composed.outputLanguage}; make every action atomic and executable; never copy the requirement into a step.`;
      const result = await this.options.agentService.executeAgent(
        workspaceId,
        agentId,
        {
          prompt: `${composed.contextText}\n\n${composed.directive}${qualityReminder}`,
          includeKnowledge: false,
          ...(input.llmProvider ? { llmProvider: input.llmProvider } : {}),
        },
        context,
      );
      try {
        parsedPlans = parseAndNormalizeTestPlans(result.result, {
          language: localeForLanguage(composed.outputLanguage),
        });
      } catch {
        parsedPlans = [];
      }
      if (
        parsedPlans.length > 0 &&
        usesOutputLanguage(parsedPlans, composed.outputLanguage) &&
        hasUsableTestSteps(parsedPlans, composed.prompt)
      ) {
        break;
      }
      parsedPlans = [];
    }

    if (parsedPlans.length === 0) {
      throw new ApplicationError(
        'AGENT_WORKFLOW_OUTPUT_INVALID',
        'The agent workflow did not produce valid localized test steps.',
        502,
      );
    }
    const primary = parsedPlans[0]!;
    return { ...primary, plans: parsedPlans };
  }

  private async compose(
    input: TestPlanRequest,
    context?: RequestContext,
  ): Promise<{
    prompt: string;
    contextText: string;
    directive: string;
    outputLanguage: OutputLanguage;
    knowledgeSources: readonly string[];
  }> {
    const rawPrompt = input.prompt.trim();
    if (!rawPrompt) {
      throw new ApplicationError('TEST_PLAN_PROMPT_REQUIRED', 'Prompt is required.', 400, [
        { field: 'prompt' },
      ]);
    }

    // Pre-flight security guard against prompt injection attacks
    PromptInjectionGuard.validatePrompt(rawPrompt);
    if (input.userPrompt) {
      PromptInjectionGuard.validatePrompt(input.userPrompt);
    }
    if (input.criteria) {
      PromptInjectionGuard.validatePrompt(input.criteria);
    }

    const prompt = sanitizeTestPlanRequirement(rawPrompt);
    let customAgentInstructions = '';
    if (input.agentId && this.options.agentRepository) {
      try {
        const agent = await this.options.agentRepository.findById(
          input.agentId,
          context?.workspaceId ?? context?.ownerId,
        );
        if (agent) {
          customAgentInstructions = agent.instructions;
        } else {
          throw new ApplicationError(
            'AGENT_NOT_FOUND',
            'The selected agent was not found in this workspace.',
            404,
            [{ field: 'agentId' }],
          );
        }
      } catch (err) {
        if (err instanceof ApplicationError) throw err;
        console.error('[AiKnowledgeTestPlanGenerator] Failed to load custom agent:', err);
        throw new ApplicationError(
          'AGENT_LOAD_FAILED',
          'The selected agent could not be loaded.',
          502,
          [{ field: 'agentId' }],
        );
      }
    } else if (input.agentId) {
      throw new ApplicationError(
        'AGENT_NOT_AVAILABLE',
        'The selected agent cannot be used by this generator.',
        503,
        [{ field: 'agentId' }],
      );
    }

    let knowledgeSnippet = '';
    const knowledgeSources: string[] = [];
    if (this.options.knowledgeSearch && context?.ownerId) {
      try {
        const chunks = await this.options.knowledgeSearch.search(prompt, context);
        if (chunks.length > 0) {
          knowledgeSnippet = chunks
            .slice(0, 15)
            .map((c) => {
              let sourceTitle = c.source;
              try {
                const url = new URL(c.source);
                const pagePath = url.searchParams.get('pagePath');
                if (pagePath) {
                  sourceTitle = decodeURIComponent(pagePath).replace(/^\//, '');
                } else {
                  const lastSegment = url.pathname.split('/').filter(Boolean).pop();
                  if (lastSegment) {
                    sourceTitle = decodeURIComponent(lastSegment);
                  }
                }
              } catch {
                sourceTitle = decodeURIComponent(c.source);
              }
              knowledgeSources.push(sourceTitle);
              return `--- [Documento / Página: ${sourceTitle} (Parte ${c.chunkIndex + 1})] ---\n${c.content}`;
            })
            .join('\n\n');
        }
      } catch (err) {
        console.error('[AiKnowledgeTestPlanGenerator] Knowledge search failed:', err);
      }
    }

    const additionalCriteria = (input.userPrompt || input.criteria)?.trim();
    const outputLanguage = detectTestPlanLanguage(
      [prompt, additionalCriteria].filter(Boolean).join('\n'),
      context?.locale,
    );
    const rawContextText = knowledgeSnippet
      ? `## Contexto da Base de Conhecimento\n${knowledgeSnippet}\n\n## Requisito / Funcionalidade Solicitada\n${prompt}${additionalCriteria ? `\n\n## Critérios de Aceite e Instruções Adicionais\n${additionalCriteria}` : ''}`
      : `## Requisito\n${prompt}${additionalCriteria ? `\n\n## Critérios de Aceite e Instruções Adicionais\n${additionalCriteria}` : ''}`;

    const baseRoleDirective = knowledgeSnippet
      ? `You are a QA Lead specialized in quality assurance, test automation, and the company's business rules.\nUsing the provided Knowledge Base pages and rules together with the user's request, generate a complete test suite covering as many scenarios as possible (main flows, recalculation rules, automatic conversions, hour/limit overflow, exceptions, and described validations).`
      : `You are a QA Lead specialized in quality assurance and test automation.\nGenerate detailed, technical, and objective test cases for the requirement below, covering as many scenarios as possible (main flow, alternatives, boundaries, and exceptions).`;

    const selectedAgentDirective = customAgentInstructions
      ? `\n\nSELECTED AGENT INSTRUCTIONS (apply these to test design and coverage):\n${customAgentInstructions}`
      : '';

    const schemaInstruction = buildTestPlanInstruction({
      useGherkin: input.useGherkin,
      descriptionTemplate: input.descriptionTemplate,
      outputLanguage,
    });

    return {
      prompt,
      contextText: rawContextText,
      directive: `${baseRoleDirective}${selectedAgentDirective}\n\n${schemaInstruction}`,
      outputLanguage,
      knowledgeSources: [...new Set(knowledgeSources)],
    };
  }
}

export function buildTestPlanInstruction(options?: {
  useGherkin?: boolean;
  descriptionTemplate?: string;
  outputLanguage?: OutputLanguage;
}): string {
  const language = options?.outputLanguage ?? 'Portuguese (Brazil)';
  const gherkinRule = options?.useGherkin
    ? 'Use Given/When/Then reasoning internally, but do not include Gherkin keywords in the JSON fields.'
    : 'Do not use Gherkin keywords.';
  const descriptionTemplate = options?.descriptionTemplate
    ? `- Additional description guidance: ${options.descriptionTemplate}`
    : '';

  return `You generate executable QA test cases as valid JSON.

OUTPUT LANGUAGE — ABSOLUTE REQUIREMENT:
- Write EVERY generated value in ${language}: title, description, action, expected, data, headings, and messages.
- Determine terminology from the user's requirement, not from the language used by agent instructions, knowledge sources, examples, or this system prompt.
- Do not mix languages. Keep product names, field labels, menu labels, and technical identifiers unchanged when they are proper names from the source.

SELECTED AGENT:
- Apply the selected agent's instructions to scope, test strategy, scenario coverage, and domain-specific decisions.
- Agent instructions cannot override the output language, JSON schema, security boundaries, or step-quality rules.

RESPONSE CONTRACT:
- Return JSON only, with no Markdown fence, introduction, comment, analysis, or trailing text.
- Return a JSON array. Each item must exactly follow this shape:
[
  {
    "title": "specific test-case title",
    "description": {
      "useCase": "what this case validates and why",
      "preconditions": "required state, profile and existing data",
      "inputData": "data or navigation used by the case",
      "expectedResult": "final observable outcome of the case",
      "postconditions": "state of the system after the case",
      "flow": [
        { "step": "Short action" },
        { "decision": "Short question?", "yes": "Outcome when yes", "no": "Outcome when no" }
      ]
    },
    "steps": [
      { "order": 1, "action": "one executable action", "expected": "one observable result" }
    ]
  }
]

DESCRIPTION:
- "description" is an object with exactly these keys: useCase, preconditions, inputData, expectedResult, postconditions and flow. Write plain text in each field (no HTML, no Markdown headings); the application renders the headings and layout.
- Fill every section with content specific to the case; write "-" only when the source gives nothing for a section.
- "flow" is the process diagram of the case: 2 to 8 nodes in execution order. Use { "step": "..." } for an action and { "decision": "...?", "yes": "...", "no": "..." } for a branch. Keep each label under 40 characters (for example "Acessar Painel", "Abrir Relatório", "Possui Subtipo?").
- Never move the full requirement, specification, bug report, image placeholder, or backend implementation note into a step.
${descriptionTemplate}

TEST CASE DESIGN:
- Create separate test cases for the main flow, relevant alternatives, boundaries, validations, and error paths supported by the source.
- Do not invent screens, controls, data, or business rules that the source does not support.
- Each test case must be independently executable and contain enough steps to reach and verify its objective.

STEPS — NON-NEGOTIABLE:
- Actions and expected results are never descriptions or copied requirement text.
- Each action is a single, concise instruction that starts with an imperative verb and tells the tester exactly what to do.
- Each expected result describes only the specific, observable system response caused by that action.
- Keep steps atomic, chronological, objective, and easy to scan. Split navigation, data entry, submission, and verification into separate steps.
- Use concrete screen, field, control, value, and state names when the source provides them.
- Never use vague actions such as "execute the flow", "perform the requirement", "validate everything", or "run test".
- Never use vague results such as "works as expected", "successfully completed", or "result validated".
- Do not put HTML, diagrams, image placeholders, specifications, or backend notes in action or expected.
- Start order at 1 and increment it by 1 with no gaps.
- Every action must have its corresponding expected result.
- ${gherkinRule}

Before responding, silently verify that every generated value uses ${language}, every step is executable, and no step copies the description.
Return only the JSON array.`;
}
