import crypto from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';
import type { DynamicProviderFactory } from '../../integrations/application/dynamic-provider-factory.js';
import type { KnowledgeSearchPort } from '../../knowledge/application/knowledge-search.js';
import type { LlmImage, LlmPort } from './agent-ports.js';
import type { AgentRepository } from './agent-repository.js';
import { CustomAgent, type AgentRole, slugify } from '../domain/agent-entity.js';
import { PromptInjectionGuard } from './prompt-injection-guard.js';

export interface CreateAgentInput {
  readonly parentAgentId?: string | null;
  readonly name: string;
  readonly slug?: string;
  readonly description?: string;
  readonly role?: AgentRole;
  readonly instructions: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly isDefault?: boolean;
}

export interface UpdateAgentInput {
  readonly parentAgentId?: string | null;
  readonly name?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly role?: AgentRole;
  readonly instructions?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly isDefault?: boolean;
}

export interface ExecuteAgentInput {
  readonly prompt: string;
  readonly includeKnowledge?: boolean;
  readonly knowledgeQuery?: string;
  readonly llmProvider?: string;
  readonly images?: readonly LlmImage[];
  readonly knowledgeOnly?: boolean;
}

export interface ExecuteAgentResult {
  readonly result: string;
  readonly agent: ReturnType<CustomAgent['toJSON']>;
  readonly provider: string;
  readonly model?: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface AgentServiceOptions {
  readonly agentRepository: AgentRepository;
  readonly dynamicProviderFactory?: DynamicProviderFactory;
  readonly defaultLlm?: LlmPort;
  readonly knowledgeSearch?: KnowledgeSearchPort;
}

export class AgentService {
  private readonly agentRepository: AgentRepository;
  private readonly dynamicProviderFactory?: DynamicProviderFactory;
  private readonly defaultLlm?: LlmPort;
  private readonly knowledgeSearch?: KnowledgeSearchPort;

  public constructor(options: AgentServiceOptions) {
    this.agentRepository = options.agentRepository;
    this.dynamicProviderFactory = options.dynamicProviderFactory;
    this.defaultLlm = options.defaultLlm;
    this.knowledgeSearch = options.knowledgeSearch;
  }

  public async createAgent(workspaceId: string, input: CreateAgentInput): Promise<CustomAgent> {
    if (!workspaceId?.trim()) {
      throw new ApplicationError('WORKSPACE_ID_REQUIRED', 'Workspace id is required.', 400, [
        { field: 'workspaceId' },
      ]);
    }
    if (!input.name?.trim()) {
      throw new ApplicationError('AGENT_NAME_REQUIRED', 'Agent name is required.', 400, [
        { field: 'name' },
      ]);
    }
    if (!input.instructions?.trim()) {
      throw new ApplicationError(
        'AGENT_INSTRUCTIONS_REQUIRED',
        'Agent instructions are required.',
        400,
        [{ field: 'instructions' }],
      );
    }

    // Validate prompt injection on agent instructions
    PromptInjectionGuard.validatePrompt(input.instructions);

    if (input.parentAgentId) await this.getAgent(workspaceId, input.parentAgentId);

    const baseSlug = input.slug?.trim() ? slugify(input.slug) : slugify(input.name);
    let finalSlug = baseSlug;
    let counter = 1;

    while (await this.agentRepository.findBySlug(workspaceId, finalSlug)) {
      finalSlug = `${baseSlug}-${counter++}`;
    }

    const agent = new CustomAgent({
      id: crypto.randomUUID(),
      workspaceId,
      parentAgentId: input.parentAgentId,
      name: input.name.trim(),
      slug: finalSlug,
      description: input.description?.trim() || '',
      role: input.role || 'CUSTOM',
      instructions: input.instructions.trim(),
      model: input.model?.trim() || null,
      temperature: input.temperature ?? 0.2,
      isDefault: Boolean(input.isDefault),
    });

    return this.agentRepository.save(agent);
  }

  public async updateAgent(
    workspaceId: string,
    agentId: string,
    input: UpdateAgentInput,
  ): Promise<CustomAgent> {
    const existing = await this.agentRepository.findById(agentId, workspaceId);
    if (!existing) {
      throw new ApplicationError(
        'AGENT_NOT_FOUND',
        `Agent '${agentId}' not found in workspace.`,
        404,
      );
    }

    if (input.instructions !== undefined) {
      if (!input.instructions.trim()) {
        throw new ApplicationError(
          'AGENT_INSTRUCTIONS_REQUIRED',
          'Agent instructions cannot be empty.',
          400,
          [{ field: 'instructions' }],
        );
      }
      PromptInjectionGuard.validatePrompt(input.instructions);
    }

    if (input.parentAgentId) {
      const visited = new Set([agentId]);
      let parentId: string | null = input.parentAgentId;
      while (parentId) {
        if (visited.has(parentId)) {
          throw new ApplicationError(
            'AGENT_HIERARCHY_CYCLE',
            'Agent hierarchy cannot contain a cycle.',
            400,
          );
        }
        visited.add(parentId);
        parentId = (await this.getAgent(workspaceId, parentId)).parentAgentId;
      }
    }

    let nextSlug = existing.slug;
    if (input.slug !== undefined || input.name !== undefined) {
      const candidateSlug = slugify(input.slug ?? (input.name as string));
      if (candidateSlug !== existing.slug) {
        const found = await this.agentRepository.findBySlug(workspaceId, candidateSlug);
        if (found) {
          throw new ApplicationError(
            'SLUG_CONFLICT',
            `Slug '${candidateSlug}' is already in use.`,
            409,
          );
        }
        nextSlug = candidateSlug;
      }
    }

    const updated = new CustomAgent({
      id: existing.id,
      workspaceId: existing.workspaceId,
      parentAgentId:
        input.parentAgentId !== undefined ? input.parentAgentId : existing.parentAgentId,
      name: input.name !== undefined ? input.name.trim() : existing.name,
      slug: nextSlug,
      description:
        input.description !== undefined ? input.description.trim() : existing.description,
      role: input.role !== undefined ? input.role : existing.role,
      instructions:
        input.instructions !== undefined ? input.instructions.trim() : existing.instructions,
      model: input.model !== undefined ? input.model.trim() || null : existing.model,
      temperature: input.temperature !== undefined ? input.temperature : existing.temperature,
      isDefault: input.isDefault !== undefined ? Boolean(input.isDefault) : existing.isDefault,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    });

    return this.agentRepository.save(updated);
  }

  public async listAgents(workspaceId: string, role?: AgentRole): Promise<readonly CustomAgent[]> {
    return this.agentRepository.listByWorkspace(workspaceId, role);
  }

  public async getAgent(workspaceId: string, agentId: string): Promise<CustomAgent> {
    const agent = await this.agentRepository.findById(agentId, workspaceId);
    if (!agent) {
      throw new ApplicationError(
        'AGENT_NOT_FOUND',
        `Agent '${agentId}' not found in workspace.`,
        404,
      );
    }
    return agent;
  }

  public async deleteAgent(workspaceId: string, agentId: string): Promise<void> {
    await this.getAgent(workspaceId, agentId);
    for (const child of await this.agentRepository.listByWorkspace(workspaceId)) {
      if (child.parentAgentId === agentId) {
        await this.agentRepository.save(
          new CustomAgent({
            ...child,
            parentAgentId: null,
            updatedAt: new Date(),
          }),
        );
      }
    }
    const deleted = await this.agentRepository.delete(agentId, workspaceId);
    if (!deleted) {
      throw new ApplicationError(
        'AGENT_NOT_FOUND',
        `Agent '${agentId}' not found in workspace.`,
        404,
      );
    }
  }

  public async executeAgent(
    workspaceId: string,
    agentId: string,
    input: ExecuteAgentInput,
    context?: RequestContext,
    signal?: AbortSignal,
  ): Promise<ExecuteAgentResult> {
    const rawPrompt = input.prompt?.trim();
    if (!rawPrompt) {
      throw new ApplicationError(
        'EXECUTION_PROMPT_REQUIRED',
        'Execution prompt is required.',
        400,
        [{ field: 'prompt' }],
      );
    }

    // 1. Pre-flight Prompt Injection Guard Check
    PromptInjectionGuard.validatePrompt(rawPrompt);

    // 2. Fetch Agent
    const agent = await this.getAgent(workspaceId, agentId);

    // 3. Optional Knowledge Injection
    let combinedInput = rawPrompt;
    const allowedKnowledgeSources: string[] = [];
    const searchOwner = context?.ownerId ?? context?.workspaceId ?? workspaceId;
    if (input.includeKnowledge && this.knowledgeSearch && searchOwner) {
      try {
        const searchContext = context?.ownerId
          ? context
          : { ...context, requestId: context?.requestId ?? 'agent-exec', ownerId: searchOwner };
        const chunks = await this.knowledgeSearch.search(
          input.knowledgeQuery?.trim() || rawPrompt,
          searchContext,
        );
        if (chunks.length > 0) {
          const selectedChunks = chunks.slice(0, 10);
          allowedKnowledgeSources.push(...new Set(selectedChunks.map((chunk) => chunk.source)));
          const knowledgeBlock = selectedChunks
            .map((chunk) => `[Fonte existente: ${chunk.source}]\n${chunk.content}`)
            .join('\n\n');
          combinedInput = `Documentação potencialmente relevante (não presuma relação; use uma fonte somente quando ela sustentar diretamente uma afirmação; cite apenas a URL exata informada; não invente links, páginas ou imagens):\n${knowledgeBlock}\n\nSolicitação:\n${rawPrompt}`;
        } else if (input.knowledgeOnly) {
          return {
            result: 'Não encontrei essa informação no Brain.',
            agent: agent.toJSON(),
            provider: 'brain',
          };
        }
      } catch (err) {
        console.error('[AgentService] Knowledge search failed during agent execution:', err);
        if (input.knowledgeOnly) {
          return {
            result: 'Não foi possível consultar o Brain neste momento.',
            agent: agent.toJSON(),
            provider: 'brain',
          };
        }
      }
    }

    // 4. Sandboxing Envelope with Nonce
    const { payload, nonce } = PromptInjectionGuard.wrapWithSandboxEnvelope(combinedInput);

    // 5. System Instruction with Strict Isolation Directive
    const knowledgeOnlyInstruction = input.knowledgeOnly
      ? `${agent.instructions}\n\nREGRA ABSOLUTA: responda exclusivamente com fatos explicitamente presentes na documentação fornecida do Brain. Não use conhecimento geral, suposições ou inferências sem suporte textual. Se não houver evidência suficiente, responda exatamente: "Não encontrei essa informação no Brain." Cite somente as fontes fornecidas.`
      : agent.instructions;
    const systemInstruction = PromptInjectionGuard.buildSystemInstruction(
      knowledgeOnlyInstruction,
      nonce,
    );

    // 6. Resolve LLM Provider
    let llm: LlmPort | null = null;
    if (this.dynamicProviderFactory && context?.ownerId) {
      llm = await this.dynamicProviderFactory.resolveLlmProvider(
        context.ownerId,
        input.llmProvider,
        undefined,
        agent.model,
      );
    }
    if (!llm) {
      llm = this.defaultLlm ?? null;
    }
    if (!llm) {
      throw new ApplicationError(
        'PROVIDER_NOT_AVAILABLE',
        'No LLM provider available to execute agent.',
        503,
      );
    }

    // 7. Complete Request
    let response: Awaited<ReturnType<LlmPort['complete']>>;
    try {
      response = await llm.complete(
        {
          prompt: payload,
          instruction: systemInstruction,
          ...(input.images?.length ? { images: input.images } : {}),
        },
        signal,
      );
    } catch (error) {
      console.error('[AgentService] LLM execution failed:', error);
      throw toLlmApplicationError(error);
    }

    // 8. Output Guard Verification
    const safeOutput = PromptInjectionGuard.verifyOutput(response.text, systemInstruction);
    const groundedOutput = input.includeKnowledge
      ? sanitizeKnowledgeLinks(safeOutput, allowedKnowledgeSources)
      : safeOutput;

    return {
      result: groundedOutput,
      agent: agent.toJSON(),
      provider: response.provider,
      ...(response.model ? { model: response.model } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }
}

export function toLlmApplicationError(error: unknown): ApplicationError {
  const message = error instanceof Error ? error.message : 'LLM execution failed.';
  const status = /HTTP\s+(\d{3})/i.exec(message)?.[1];
  if (status === '429') {
    return new ApplicationError('LLM_RATE_LIMITED', message, 429);
  }
  if (status === '401' || status === '403') {
    return new ApplicationError('LLM_AUTHENTICATION_FAILED', message, 502);
  }
  if (status === '404') {
    return new ApplicationError('LLM_MODEL_UNAVAILABLE', message, 502);
  }
  return new ApplicationError('LLM_EXECUTION_FAILED', message, 502);
}

export function sanitizeKnowledgeLinks(output: string, allowedSources: readonly string[]): string {
  const allowed = new Set(allowedSources);
  return output.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (_match: string, image: string, label: string, url: string) => {
      if (image === '!') return label;
      return allowed.has(url) ? `[${label}](${url})` : label;
    },
  );
}
