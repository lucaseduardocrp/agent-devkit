import crypto from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import type { LlmImage } from '../../agents/application/agent-ports.js';

export type DesignRepositoryProvider = 'github' | 'azure';
export interface DesignFile {
  readonly name: string;
  readonly language: string;
  readonly content: string;
}
export interface DesignMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
  readonly images?: readonly LlmImage[];
}
export interface DesignProject {
  readonly id: string;
  readonly provider: DesignRepositoryProvider;
  readonly title: string;
  readonly agentId: string;
  readonly files: readonly DesignFile[];
  readonly messages: readonly DesignMessage[];
  readonly updatedAt: string;
}
export interface DesignSystem {
  readonly id: string;
  readonly name: string;
  readonly content: string;
  readonly updatedAt: string;
}
export interface DesignRemoteStore {
  configuredProviders(workspaceId: string): Promise<readonly DesignRepositoryProvider[]>;
  list(workspaceId: string, provider: DesignRepositoryProvider): Promise<readonly DesignProject[]>;
  find(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    id: string,
  ): Promise<DesignProject | null>;
  save(workspaceId: string, project: DesignProject): Promise<DesignProject>;
  delete(workspaceId: string, provider: DesignRepositoryProvider, id: string): Promise<boolean>;
  listDesignSystems(
    workspaceId: string,
    provider: DesignRepositoryProvider,
  ): Promise<readonly DesignSystem[]>;
  saveDesignSystem(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    system: DesignSystem,
  ): Promise<DesignSystem>;
  deleteDesignSystem(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    id: string,
  ): Promise<boolean>;
}

const generationInstruction = `Você é um engenheiro de frontend criando um protótipo executável. Responda SOMENTE com JSON válido no formato {"summary":"resumo curto","files":[{"name":"index.html","language":"html","content":"..."}]}. Inclua sempre index.html, styles.css e script.js. Pode incluir componentes .jsx quando útil. Não use markdown nem cercas de código. O protótipo deve ser responsivo, acessível e funcionar sem dependências externas.`;

export function isSafeDesignFileName(name: string): boolean {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  return (
    normalized.length > 0 &&
    normalized.length <= 160 &&
    !segments.includes('..') &&
    segments[0]?.toLowerCase() !== '.design'
  );
}

function parseFiles(raw: string): { summary: string; files: readonly DesignFile[] } {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch {
    throw new ApplicationError(
      'INVALID_AGENT_RESPONSE',
      'O agente não retornou um protótipo válido.',
      502,
    );
  }
  const data = value as { summary?: unknown; files?: unknown };
  if (!Array.isArray(data.files))
    throw new ApplicationError(
      'INVALID_AGENT_RESPONSE',
      'O agente não retornou arquivos válidos.',
      502,
    );
  const files = data.files.flatMap((file) => {
    if (!file || typeof file !== 'object') return [];
    const item = file as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.content !== 'string') return [];
    const name = item.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (
      !isSafeDesignFileName(name) ||
      item.content.length > 500_000 ||
      (typeof item.language === 'string' && item.language.length > 40)
    )
      return [];
    return [
      {
        name,
        language: typeof item.language === 'string' ? item.language : 'text',
        content: item.content,
      },
    ];
  });
  if (files.length === 0 || files.length > 30)
    throw new ApplicationError(
      'INVALID_AGENT_RESPONSE',
      'O agente retornou uma quantidade inválida de arquivos.',
      502,
    );
  if (!files.some((file) => file.name === 'index.html'))
    throw new ApplicationError(
      'INVALID_AGENT_RESPONSE',
      'O protótipo precisa conter index.html.',
      502,
    );
  return {
    summary: typeof data.summary === 'string' ? data.summary : 'Protótipo atualizado.',
    files,
  };
}

export class DesignService {
  public constructor(
    private readonly store: DesignRemoteStore,
    private readonly agents: AgentService,
  ) {}
  public providers(workspaceId: string) {
    return this.store.configuredProviders(workspaceId);
  }
  public list(workspaceId: string, provider: DesignRepositoryProvider) {
    return this.store.list(workspaceId, provider);
  }
  public listDesignSystems(workspaceId: string, provider: DesignRepositoryProvider) {
    return this.store.listDesignSystems(workspaceId, provider);
  }
  public async saveDesignSystem(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    input: { id?: string; name: string; content: string },
  ) {
    const id = input.id?.trim() || `${this.slug(input.name)}-${crypto.randomUUID().slice(0, 8)}`;
    return this.store.saveDesignSystem(workspaceId, provider, {
      id,
      name: input.name.trim(),
      content: input.content,
      updatedAt: new Date().toISOString(),
    });
  }
  public async generateDesignSystem(
    workspaceId: string,
    agentId: string,
    request: string,
    images?: readonly LlmImage[],
    context?: RequestContext,
  ) {
    const response = await this.agents.executeAgent(
      workspaceId,
      agentId,
      {
        prompt: `Crie um Design System visual completo como um único arquivo HTML autocontido, com CSS dentro de <style>. Inclua tokens de cor, tipografia, espaçamento e exemplos de componentes. Responda somente com o HTML, sem markdown. Solicitação: ${request}`,
        ...(images?.length ? { images } : {}),
      },
      context,
    );
    const html = response.result
      .trim()
      .replace(/^```html\s*/i, '')
      .replace(/\s*```$/, '');
    if (!/^<!doctype html>|^<html/i.test(html))
      throw new ApplicationError(
        'INVALID_AGENT_RESPONSE',
        'O agente não retornou HTML válido.',
        502,
      );
    return { content: html };
  }
  public async deleteDesignSystem(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    id: string,
  ) {
    if (!(await this.store.deleteDesignSystem(workspaceId, provider, id)))
      throw new ApplicationError('DESIGN_SYSTEM_NOT_FOUND', 'Design System não encontrado.', 404);
  }
  public async get(workspaceId: string, provider: DesignRepositoryProvider, id: string) {
    const project = await this.store.find(workspaceId, provider, id);
    if (!project)
      throw new ApplicationError(
        'DESIGN_NOT_FOUND',
        'Projeto de Design não encontrado no repositório.',
        404,
      );
    return project;
  }
  public async create(
    workspaceId: string,
    input: {
      title: string;
      agentId?: string;
      prompt: string;
      provider: DesignRepositoryProvider;
      designSystemId?: string;
      images?: readonly LlmImage[];
      /** Files authored by the caller's own model; when present no agent is invoked. */
      files?: readonly DesignFile[];
      summary?: string;
    },
    context?: RequestContext,
  ) {
    const providers = await this.store.configuredProviders(workspaceId);
    if (!providers.includes(input.provider)) {
      throw new ApplicationError(
        'DESIGN_REPOSITORY_NOT_CONFIGURED',
        'Configure o repositório selecionado antes de usar o Design.',
        409,
      );
    }
    let request = input.prompt;
    if (input.designSystemId) {
      const systems = await this.store.listDesignSystems(workspaceId, input.provider);
      const system = systems.find((item) => item.id === input.designSystemId);
      if (!system) {
        throw new ApplicationError(
          'DESIGN_SYSTEM_NOT_FOUND',
          'Design System não encontrado no repositório selecionado.',
          404,
        );
      }
      request += `\n\nUse obrigatoriamente este Design System:\n${system.content}`;
    }
    let result: { summary: string; files: readonly DesignFile[] };
    if (input.files?.length) {
      result = {
        summary: input.summary ?? 'Protótipo criado pelo assistente.',
        files: input.files,
      };
    } else if (input.agentId) {
      result = await this.generate(
        workspaceId,
        input.agentId,
        request,
        [],
        [],
        input.images,
        context,
      );
    } else {
      throw new ApplicationError(
        'DESIGN_AGENT_REQUIRED',
        'An agent or authored prototype files are required.',
        400,
        [{ field: 'agentId' }],
      );
    }
    const now = new Date().toISOString();
    return this.store.save(workspaceId, {
      id: `${this.slug(input.title)}-${crypto.randomUUID().slice(0, 8)}`,
      provider: input.provider,
      title: input.title.trim(),
      agentId: input.agentId ?? '',
      files: result.files,
      messages: [
        { role: 'user', content: request, createdAt: now },
        { role: 'assistant', content: result.summary, createdAt: now },
      ],
      updatedAt: now,
    });
  }
  public async chat(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    id: string,
    content: string,
    agentId: string | undefined,
    images: readonly LlmImage[] | undefined = undefined,
    context?: RequestContext,
  ) {
    const current = await this.get(workspaceId, provider, id);
    const selectedAgent = agentId?.trim() || current.agentId;
    const result = await this.generate(
      workspaceId,
      selectedAgent,
      content,
      current.files,
      current.messages,
      images,
      context,
    );
    const now = new Date().toISOString();
    return this.store.save(workspaceId, {
      ...current,
      agentId: selectedAgent,
      files: result.files,
      messages: [
        ...current.messages,
        { role: 'user', content, ...(images?.length ? { images } : {}), createdAt: now },
        { role: 'assistant', content: result.summary, createdAt: now },
      ],
      updatedAt: now,
    });
  }
  public async updateFiles(
    workspaceId: string,
    provider: DesignRepositoryProvider,
    id: string,
    files: readonly DesignFile[],
  ) {
    const current = await this.get(workspaceId, provider, id);
    return this.store.save(workspaceId, { ...current, files, updatedAt: new Date().toISOString() });
  }
  public async delete(workspaceId: string, provider: DesignRepositoryProvider, id: string) {
    if (!(await this.store.delete(workspaceId, provider, id)))
      throw new ApplicationError(
        'DESIGN_NOT_FOUND',
        'Projeto de Design não encontrado no repositório.',
        404,
      );
  }
  private slug(value: string) {
    return (
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'prototype'
    );
  }
  private async generate(
    workspaceId: string,
    agentId: string,
    request: string,
    files: readonly DesignFile[],
    messages: readonly DesignMessage[],
    images?: readonly LlmImage[],
    context?: RequestContext,
  ) {
    const state = files.length ? `\nArquivos atuais:\n${JSON.stringify(files)}` : '';
    const conversation = messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n')
      .slice(-40_000);
    const history = conversation ? `\nContexto anterior:\n${conversation}` : '';
    const response = await this.agents.executeAgent(
      workspaceId,
      agentId,
      {
        prompt: `${generationInstruction}${history}\n\nSolicitação: ${request}${state}`,
        ...(images?.length ? { images } : {}),
      },
      context,
    );
    return parseFiles(response.result);
  }
}
