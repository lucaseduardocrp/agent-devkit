import { distributeProposalSections } from '../application/proposal-sections.js';
import type { RequestContext } from '../../../shared/context.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import type { SpecCollaborator } from '../application/spec-service.js';

type CollaborationReply = Awaited<ReturnType<SpecCollaborator['reply']>>;
type CollaborationInput = Parameters<SpecCollaborator['reply']>[0];

export class AgentSpecCollaborator implements SpecCollaborator {
  public constructor(
    private readonly agents: AgentService,
    private readonly context: (workspaceId: string) => RequestContext = (workspaceId) => ({
      requestId: 'spec-chat',
      ownerId: workspaceId,
      workspaceId,
    }),
  ) {}

  public async reply(input: CollaborationInput): Promise<CollaborationReply> {
    const isEnglish = input.locale === 'en-US';
    const sections = input.specification.sections
      .map(
        (section) =>
          `${section.title}: ${section.content || (isEnglish ? '(not provided)' : '(não preenchido)')}`,
      )
      .join('\n');
    const history = input.conversation
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');
    const sectionContract = JSON.stringify(
      input.specification.sections.map((section) => ({
        templateSectionId: section.templateSectionId,
        title: section.title,
      })),
    );
    const updateFormat =
      '```spec-update\n{"title":"...","sections":[{"templateSectionId":"existing-id","content":"..."}]}\n```';
    const prompt = isEnglish
      ? `You are collaborating on a specification discovery. Ask objective questions, suggest gaps, and connect rules found in the knowledge base. Do not invent dependencies. Use well-structured Markdown in the visible answer. When there is enough information to complete or improve the draft, append exactly one hidden update block in this format:\n${updateFormat}\nDistribute each topic into the matching section; put unmatched topics in the final section. Never put the entire response into a single field when topics match other fields. Only use section IDs from this contract: ${sectionContract}\n\nCurrent specification:\n${sections}\n\nConversation:\n${history}`
      : `Você está colaborando no levantamento de uma especificação. Faça perguntas objetivas, sugira lacunas e relacione regras encontradas na base de conhecimento. Não invente dependências. Use Markdown bem estruturado na resposta visível. Quando houver informação suficiente para concluir ou melhorar o rascunho, acrescente exatamente um bloco oculto de atualização neste formato:\n${updateFormat}\nDistribua cada assunto na seção correspondente; coloque assuntos sem correspondência na última seção. Não agrupe a resposta inteira em um único campo quando houver campos correspondentes aos assuntos. Use apenas IDs de seção deste contrato: ${sectionContract}\n\nEspecificação atual:\n${sections}\n\nConversa:\n${history}`;
    const context = this.context(input.workspaceId);
    const result = await this.agents.executeAgent(
      input.workspaceId,
      input.agentId,
      {
        prompt,
        includeKnowledge: true,
        knowledgeQuery: [
          input.specification.title,
          ...input.specification.sections.map((section) => section.content),
          input.conversation.at(-1)?.content,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      { ...context, locale: input.locale ?? context.locale },
    );
    return parseAgentReply(result.result, input.specification);
  }
}

export function parseAgentReply(
  result: string,
  specification: CollaborationInput['specification'],
): CollaborationReply {
  const match = /```spec-update\s*([\s\S]*?)```/iu.exec(result);
  if (!match)
    return /^#{1,6}\s+/mu.test(result)
      ? {
          content: result,
          sections: distributeProposalSections([{ content: result }], specification.sections),
        }
      : { content: result };

  const content = result.replace(match[0], '').trim();
  try {
    const update = JSON.parse(match[1]!) as unknown;
    if (!update || typeof update !== 'object') return { content };
    const value = update as { title?: unknown; sections?: unknown };
    const sections = Array.isArray(value.sections)
      ? distributeProposalSections(value.sections, specification.sections)
      : undefined;
    return {
      content,
      title: typeof value.title === 'string' ? value.title : undefined,
      sections,
    };
  } catch {
    return { content };
  }
}
