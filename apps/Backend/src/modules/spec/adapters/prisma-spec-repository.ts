import type { Specification, SpecTemplate } from '../domain/specification.js';
import type { SpecRepository } from '../application/spec-service.js';

interface RecordShape {
  id: string;
  workspaceId: string;
  templateId?: string | null;
  agentId?: string | null;
  parentId?: string | null;
  name?: string;
  title?: string;
  sections: unknown;
  messages?: unknown;
  attachments?: unknown;
  createdAt: Date;
  updatedAt: Date;
}
interface Delegate {
  upsert(args: unknown): Promise<RecordShape>;
  findMany(args: unknown): Promise<readonly RecordShape[]>;
  findFirst(args: unknown): Promise<RecordShape | null>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}
export interface PrismaSpecClient {
  specTemplateRecord: Delegate;
  specificationRecord: Delegate;
}

export class PrismaSpecRepository implements SpecRepository {
  public constructor(private readonly client: PrismaSpecClient) {}
  private mapTemplate(record: RecordShape): SpecTemplate {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      name: record.name!,
      sections: record.sections as SpecTemplate['sections'],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
  private mapSpecification(record: RecordShape): Specification {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      templateId: record.templateId ?? undefined,
      agentId: record.agentId ?? undefined,
      parentId: record.parentId ?? undefined,
      title: record.title!,
      sections: record.sections as Specification['sections'],
      messages: (record.messages ?? []) as Specification['messages'],
      attachments: (record.attachments ?? []) as Specification['attachments'],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
  public async saveTemplate(value: SpecTemplate) {
    return this.mapTemplate(
      await this.client.specTemplateRecord.upsert({
        where: { id: value.id },
        create: {
          ...value,
          createdAt: new Date(value.createdAt),
          updatedAt: new Date(value.updatedAt),
        },
        update: {
          name: value.name,
          sections: value.sections,
          updatedAt: new Date(value.updatedAt),
        },
      }),
    );
  }
  public async listTemplates(workspaceId: string) {
    return (
      await this.client.specTemplateRecord.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
      })
    ).map((x) => this.mapTemplate(x));
  }
  public async findTemplate(id: string, workspaceId: string) {
    const value = await this.client.specTemplateRecord.findFirst({ where: { id, workspaceId } });
    return value ? this.mapTemplate(value) : null;
  }
  public async deleteTemplate(id: string, workspaceId: string) {
    const result = await this.client.specTemplateRecord.deleteMany({ where: { id, workspaceId } });
    return result.count > 0;
  }
  public async saveSpecification(value: Specification) {
    return this.mapSpecification(
      await this.client.specificationRecord.upsert({
        where: { id: value.id },
        create: {
          ...value,
          templateId: value.templateId ?? null,
          agentId: value.agentId ?? null,
          parentId: value.parentId ?? null,
          createdAt: new Date(value.createdAt),
          updatedAt: new Date(value.updatedAt),
        },
        update: {
          templateId: value.templateId ?? null,
          agentId: value.agentId ?? null,
          parentId: value.parentId ?? null,
          title: value.title,
          sections: value.sections,
          messages: value.messages,
          attachments: value.attachments ?? [],
          updatedAt: new Date(value.updatedAt),
        },
      }),
    );
  }
  public async listSpecifications(workspaceId: string) {
    return (
      await this.client.specificationRecord.findMany({
        where: { workspaceId },
        orderBy: { updatedAt: 'desc' },
      })
    ).map((x) => this.mapSpecification(x));
  }
  public async findSpecification(id: string, workspaceId: string) {
    const value = await this.client.specificationRecord.findFirst({ where: { id, workspaceId } });
    return value ? this.mapSpecification(value) : null;
  }
  public async deleteSpecification(id: string, workspaceId: string) {
    const result = await this.client.specificationRecord.deleteMany({ where: { id, workspaceId } });
    return result.count > 0;
  }
}
