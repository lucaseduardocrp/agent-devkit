import crypto from 'node:crypto';
import { ApplicationError } from '../../../shared/errors.js';
import type { SupportedLocale } from '../../../shared/i18n.js';
import type { E2eArtifactStore } from '../../e2e/application/artifact-store.js';
import { fileOwner, syncItemFilesSafely } from '../../shared/attachment-files.js';
import type {
  SpecMessage,
  Specification,
  SpecTemplate,
  SpecTemplateSection,
} from '../domain/specification.js';

export interface SpecRepository {
  saveTemplate(template: SpecTemplate): Promise<SpecTemplate>;
  listTemplates(workspaceId: string): Promise<readonly SpecTemplate[]>;
  findTemplate(id: string, workspaceId: string): Promise<SpecTemplate | null>;
  deleteTemplate(id: string, workspaceId: string): Promise<boolean>;
  saveSpecification(specification: Specification): Promise<Specification>;
  listSpecifications(workspaceId: string): Promise<readonly Specification[]>;
  findSpecification(id: string, workspaceId: string): Promise<Specification | null>;
  deleteSpecification(id: string, workspaceId: string): Promise<boolean>;
}

export interface SpecCollaborator {
  reply(input: {
    workspaceId: string;
    agentId: string;
    conversation: readonly SpecMessage[];
    specification: Specification;
    locale?: SupportedLocale;
  }): Promise<{
    content: string;
    title?: string;
    sections?: readonly { templateSectionId: string; content: string }[];
  }>;
}

export class InMemorySpecRepository implements SpecRepository {
  private readonly templates = new Map<string, SpecTemplate>();
  private readonly specifications = new Map<string, Specification>();
  public saveTemplate(value: SpecTemplate) {
    this.templates.set(value.id, value);
    return Promise.resolve(value);
  }
  public listTemplates(workspaceId: string) {
    return Promise.resolve(
      [...this.templates.values()].filter((x) => x.workspaceId === workspaceId),
    );
  }
  public findTemplate(id: string, workspaceId: string) {
    const value = this.templates.get(id);
    return Promise.resolve(value?.workspaceId === workspaceId ? value : null);
  }
  public deleteTemplate(id: string, workspaceId: string) {
    const value = this.templates.get(id);
    if (!value || value.workspaceId !== workspaceId) return Promise.resolve(false);
    this.templates.delete(id);
    for (const [specificationId, specification] of this.specifications) {
      if (specification.workspaceId === workspaceId && specification.templateId === id) {
        this.specifications.set(specificationId, { ...specification, templateId: undefined });
      }
    }
    return Promise.resolve(true);
  }
  public saveSpecification(value: Specification) {
    this.specifications.set(value.id, value);
    return Promise.resolve(value);
  }
  public listSpecifications(workspaceId: string) {
    return Promise.resolve(
      [...this.specifications.values()].filter((x) => x.workspaceId === workspaceId),
    );
  }
  public findSpecification(id: string, workspaceId: string) {
    const value = this.specifications.get(id);
    return Promise.resolve(value?.workspaceId === workspaceId ? value : null);
  }
  public deleteSpecification(id: string, workspaceId: string) {
    const value = this.specifications.get(id);
    if (!value || value.workspaceId !== workspaceId) return Promise.resolve(false);
    const descendants = (parentId: string): void => {
      for (const child of this.specifications.values()) {
        if (child.parentId === parentId) {
          descendants(child.id);
          this.specifications.delete(child.id);
        }
      }
    };
    descendants(id);
    return Promise.resolve(this.specifications.delete(id));
  }
}

const now = () => new Date().toISOString();

/** What of a specification can reference stored files. */
const specFiles = (spec: Specification | null | undefined) =>
  spec && { sections: spec.sections, attachments: spec.attachments };

/** Keeps exactly the stored files a saved specification references; `next` is null on delete. */
export function syncSpecFiles(
  files: E2eArtifactStore | undefined,
  workspaceId: string,
  previous: Specification | null | undefined,
  next: Specification | null,
): Promise<void> {
  return syncItemFilesSafely(
    files,
    workspaceId,
    fileOwner('spec', (next ?? previous)!.id),
    specFiles(previous),
    specFiles(next),
  );
}

export class SpecService {
  public constructor(
    private readonly repository: SpecRepository,
    private readonly collaborator?: SpecCollaborator,
    private readonly files?: E2eArtifactStore,
  ) {}

  public async saveTemplate(
    workspaceId: string,
    input: { id?: string; name: string; sections: readonly SpecTemplateSection[] },
  ): Promise<SpecTemplate> {
    const existing = input.id ? await this.repository.findTemplate(input.id, workspaceId) : null;
    const timestamp = now();
    return this.repository.saveTemplate({
      id: existing?.id ?? crypto.randomUUID(),
      workspaceId,
      name: input.name,
      sections: input.sections,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }
  public listTemplates(workspaceId: string) {
    return this.repository.listTemplates(workspaceId);
  }

  public async deleteTemplate(workspaceId: string, id: string): Promise<void> {
    if (!(await this.repository.deleteTemplate(id, workspaceId))) {
      throw new ApplicationError('SPEC_TEMPLATE_NOT_FOUND', 'Template não encontrado.', 404);
    }
  }

  public async saveSpecification(
    workspaceId: string,
    input: {
      id?: string;
      templateId?: string;
      agentId?: string;
      parentId?: string;
      title: string;
      sections: Specification['sections'];
      attachments?: Specification['attachments'];
    },
  ): Promise<Specification> {
    const existing = input.id
      ? await this.repository.findSpecification(input.id, workspaceId)
      : null;
    if (input.parentId) {
      if (input.parentId === input.id) {
        throw new ApplicationError(
          'INVALID_SPEC_PARENT',
          'Uma especificação não pode ser pai de si mesma.',
          400,
        );
      }
      let parent = await this.repository.findSpecification(input.parentId, workspaceId);
      if (!parent) {
        throw new ApplicationError(
          'SPEC_PARENT_NOT_FOUND',
          'Especificação pai não encontrada.',
          404,
        );
      }
      while (parent.parentId) {
        if (parent.parentId === input.id) {
          throw new ApplicationError(
            'INVALID_SPEC_PARENT',
            'A hierarquia de especificações não pode conter ciclos.',
            400,
          );
        }
        const ancestor = await this.repository.findSpecification(parent.parentId, workspaceId);
        if (!ancestor) break;
        parent = ancestor;
      }
    }
    const timestamp = now();
    const saved = await this.repository.saveSpecification({
      id: existing?.id ?? crypto.randomUUID(),
      workspaceId,
      templateId: input.templateId,
      agentId: input.agentId,
      parentId: input.parentId,
      title: input.title,
      sections: input.sections,
      messages: existing?.messages ?? [],
      attachments: input.attachments ?? existing?.attachments ?? [],
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    // Rewriting a section (by hand or applying an agent proposal) drops the images it removed.
    await syncSpecFiles(this.files, workspaceId, existing, saved);
    return saved;
  }
  public listSpecifications(workspaceId: string) {
    return this.repository.listSpecifications(workspaceId);
  }
  public async getSpecification(workspaceId: string, id: string): Promise<Specification> {
    const value = await this.repository.findSpecification(id, workspaceId);
    if (!value) throw new ApplicationError('SPEC_NOT_FOUND', 'Especificação não encontrada.', 404);
    return value;
  }
  public async deleteSpecification(workspaceId: string, id: string): Promise<void> {
    // Child specifications are deleted with their parent, and so are their files.
    const all = this.files ? await this.repository.listSpecifications(workspaceId) : [];
    const removed = all.filter((spec) => spec.id === id);
    for (let index = 0; index < removed.length; index++)
      removed.push(...all.filter((spec) => spec.parentId === removed[index]!.id));
    if (!(await this.repository.deleteSpecification(id, workspaceId))) {
      throw new ApplicationError('SPEC_NOT_FOUND', 'Especificação não encontrada.', 404);
    }
    for (const spec of removed) await syncSpecFiles(this.files, workspaceId, spec, null);
  }

  public async saveHostChatReply(
    workspaceId: string,
    id: string,
    input: { userMessage: string; assistantMessage: string },
  ): Promise<Specification> {
    const specification = await this.getSpecification(workspaceId, id);
    const timestamp = now();
    return this.repository.saveSpecification({
      ...specification,
      messages: [
        ...specification.messages,
        { id: crypto.randomUUID(), role: 'user', content: input.userMessage, createdAt: timestamp },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: input.assistantMessage,
          createdAt: timestamp,
        },
      ],
      updatedAt: timestamp,
    });
  }

  public async chat(
    workspaceId: string,
    id: string,
    agentId: string,
    content: string,
    locale?: SupportedLocale,
  ): Promise<Specification> {
    if (!this.collaborator)
      throw new ApplicationError(
        'SPEC_COLLABORATOR_UNAVAILABLE',
        'Colaborador de especificação indisponível.',
        503,
      );
    const specification = await this.getSpecification(workspaceId, id);
    const userMessage: SpecMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: now(),
    };
    const conversation = [...specification.messages, userMessage];
    const answer = await this.collaborator.reply({
      workspaceId,
      agentId,
      conversation,
      specification,
      locale,
    });
    const assistantMessage: SpecMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: answer.content,
      createdAt: now(),
    };
    const saved = await this.repository.saveSpecification({
      ...specification,
      agentId,
      messages: [...conversation, assistantMessage],
      updatedAt: now(),
    });
    const answerTitle = answer.title?.trim();
    const proposedTitle =
      answerTitle && answerTitle !== specification.title.trim() ? answerTitle : undefined;
    const currentSections = new Map(
      specification.sections.map((section) => [section.templateSectionId, section.content.trim()]),
    );
    const proposedSections = (answer.sections ?? []).filter((section) => {
      const content = section.content.trim();
      const currentContent = currentSections.get(section.templateSectionId);
      return currentContent !== undefined && content.length > 0 && content !== currentContent;
    });
    return proposedTitle || proposedSections.length > 0
      ? {
          ...saved,
          proposal: { title: proposedTitle, sections: proposedSections },
        }
      : saved;
  }
}
