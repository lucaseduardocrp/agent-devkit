import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type {
  FieldMappingInput,
  FieldMappingStore,
  FieldMappingTemplate,
  FieldMappingRule,
} from './field-mapping.js';
import { ApplicationError } from '../../shared/errors.js';

export class PrismaFieldMappingStore implements FieldMappingStore {
  constructor(private readonly prisma: PrismaClient) {}

  private fromRow(
    row: Awaited<ReturnType<PrismaClient['fieldMappingTemplateRecord']['findFirstOrThrow']>>,
  ): FieldMappingTemplate {
    return {
      ...row,
      entityType: row.entityType as FieldMappingTemplate['entityType'],
      rules: row.rules as unknown as FieldMappingRule[],
    };
  }

  async list(workspaceId: string): Promise<FieldMappingTemplate[]> {
    const rows = await this.prisma.fieldMappingTemplateRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => this.fromRow(row));
  }

  async get(workspaceId: string, id: string): Promise<FieldMappingTemplate | null> {
    const row = await this.prisma.fieldMappingTemplateRecord.findFirst({
      where: { workspaceId, id },
    });
    return row ? this.fromRow(row) : null;
  }

  async save(
    workspaceId: string,
    id: string | null,
    input: FieldMappingInput,
  ): Promise<FieldMappingTemplate> {
    if (id && !(await this.get(workspaceId, id)))
      throw new ApplicationError(
        'FIELD_MAPPING_NOT_FOUND',
        'Field mapping template not found.',
        404,
      );
    const data = { ...input, rules: input.rules as unknown as Prisma.InputJsonValue };
    const row = id
      ? await this.prisma.fieldMappingTemplateRecord.update({ where: { id }, data })
      : await this.prisma.fieldMappingTemplateRecord.create({ data: { ...data, workspaceId } });
    return this.fromRow(row);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const result = await this.prisma.fieldMappingTemplateRecord.deleteMany({
      where: { workspaceId, id },
    });
    return result.count > 0;
  }
}
