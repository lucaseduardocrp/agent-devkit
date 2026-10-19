import { ApplicationError } from '../../shared/errors.js';

export type FieldValue = string | number | boolean | readonly string[] | null;
export type FieldType =
  'text' | 'number' | 'date' | 'boolean' | 'single_select' | 'multi_select' | 'iteration';

export interface FieldDefinition {
  id: string;
  name: string;
  type: FieldType;
  required?: boolean;
  readOnly?: boolean;
  options?: readonly { id: string; name: string }[];
}

export interface FieldSource {
  kind: 'core' | 'custom' | 'constant';
  /** title, description, status, or a test case metadata key. */
  key?: string;
  providerId?: string;
  value?: FieldValue;
}

export interface FieldMappingRule {
  targetFieldId: string;
  source: FieldSource;
  /** Explicit option mapping takes precedence over matching option names. */
  choices?: Record<string, string>;
  required?: boolean;
}

export interface FieldMappingTemplate {
  id: string;
  workspaceId: string;
  name: string;
  entityType: 'pbi' | 'test_case';
  providerId: string;
  /** Project, board, or GitHub Project identity. Empty means every destination. */
  scope: string;
  /** Work item or issue type. Empty means every type. */
  itemType: string;
  rules: readonly FieldMappingRule[];
  createdAt: Date;
  updatedAt: Date;
}

export type FieldMappingInput = Pick<
  FieldMappingTemplate,
  'name' | 'entityType' | 'providerId' | 'scope' | 'itemType' | 'rules'
>;

export interface FieldMappingStore {
  list(workspaceId: string): Promise<FieldMappingTemplate[]>;
  get(workspaceId: string, id: string): Promise<FieldMappingTemplate | null>;
  save(
    workspaceId: string,
    id: string | null,
    input: FieldMappingInput,
  ): Promise<FieldMappingTemplate>;
  delete(workspaceId: string, id: string): Promise<boolean>;
}

export class InMemoryFieldMappingStore implements FieldMappingStore {
  private readonly templates = new Map<string, FieldMappingTemplate>();
  list(workspaceId: string): Promise<FieldMappingTemplate[]> {
    return Promise.resolve(
      [...this.templates.values()].filter((item) => item.workspaceId === workspaceId),
    );
  }
  get(workspaceId: string, id: string): Promise<FieldMappingTemplate | null> {
    const item = this.templates.get(id);
    return Promise.resolve(item?.workspaceId === workspaceId ? item : null);
  }
  async save(
    workspaceId: string,
    id: string | null,
    input: FieldMappingInput,
  ): Promise<FieldMappingTemplate> {
    const current = id ? await this.get(workspaceId, id) : null;
    if (id && !current)
      throw new ApplicationError(
        'FIELD_MAPPING_NOT_FOUND',
        'Field mapping template not found.',
        404,
      );
    const now = new Date();
    const item = {
      ...input,
      workspaceId,
      id: current?.id ?? crypto.randomUUID(),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.templates.set(item.id, item);
    return item;
  }
  async delete(workspaceId: string, id: string): Promise<boolean> {
    if (!(await this.get(workspaceId, id))) return false;
    return this.templates.delete(id);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function sourceFieldValues(
  data: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  return record(record(data.customFields)[providerId]);
}

export function mergeImportedFields(
  previous: Record<string, unknown>,
  incoming: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  const previousFields = record(previous.customFields);
  const incomingFields = record(incoming.customFields);
  return {
    ...previous,
    ...incoming,
    customFields: {
      ...previousFields,
      ...incomingFields,
      ...(Object.hasOwn(incomingFields, providerId)
        ? { [providerId]: record(incomingFields[providerId]) }
        : {}),
    },
  };
}

export interface MappableItem {
  title: string;
  description: string;
  status?: string;
  sourceData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function sourceValue(item: MappableItem, source: FieldSource): unknown {
  if (source.kind === 'constant') return source.value;
  if (source.kind === 'core') {
    if (source.key === 'title' || source.key === 'description' || source.key === 'status')
      return item[source.key];
    return source.key ? (item.metadata?.[source.key] ?? item.sourceData?.[source.key]) : undefined;
  }
  return source.key && source.providerId
    ? sourceFieldValues(item.metadata ?? item.sourceData ?? {}, source.providerId)[source.key]
    : undefined;
}

function mapValue(
  value: unknown,
  definition: FieldDefinition,
  choices: Record<string, string>,
): FieldValue {
  const asText = (entry: unknown): string => {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
      return String(entry);
    throw new ApplicationError(
      'FIELD_MAPPING_INVALID',
      `Invalid value for ${definition.name}.`,
      400,
    );
  };
  if (definition.type === 'multi_select') {
    const values = Array.isArray(value) ? value : [value];
    return values.map((entry) => {
      const selected = choices[asText(entry)] ?? asText(entry);
      if (!definition.options?.length) return selected;
      const option = definition.options.find(
        (candidate) => candidate.id === selected || candidate.name === selected,
      );
      if (!option)
        throw new ApplicationError(
          'FIELD_MAPPING_INVALID',
          `Unknown option for ${definition.name}.`,
          400,
        );
      return option.id;
    });
  }
  if (definition.type === 'single_select' || definition.type === 'iteration') {
    const selected = choices[asText(value)] ?? asText(value);
    if (!definition.options?.length) return selected;
    const option = definition.options?.find(
      (entry) => entry.id === selected || entry.name === selected,
    );
    if (!option)
      throw new ApplicationError(
        'FIELD_MAPPING_INVALID',
        `Unknown option for ${definition.name}.`,
        400,
      );
    return option.id;
  }
  if (definition.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number))
      throw new ApplicationError(
        'FIELD_MAPPING_INVALID',
        `Invalid number for ${definition.name}.`,
        400,
      );
    return number;
  }
  if (definition.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new ApplicationError(
      'FIELD_MAPPING_INVALID',
      `Invalid boolean for ${definition.name}.`,
      400,
    );
  }
  if (definition.type === 'date' && Number.isNaN(Date.parse(asText(value))))
    throw new ApplicationError(
      'FIELD_MAPPING_INVALID',
      `Invalid date for ${definition.name}.`,
      400,
    );
  return asText(value);
}

/** Resolves a template only against fields currently available at the destination. */
/** Fixes the value of template fields with what was filled in when publishing. */
export function withFieldValues(
  template: FieldMappingTemplate,
  values: Readonly<Record<string, FieldValue>> = {},
): FieldMappingTemplate {
  const unknown = Object.keys(values).find(
    (id) => !template.rules.some((rule) => rule.targetFieldId === id),
  );
  if (unknown)
    throw new ApplicationError(
      'FIELD_MAPPING_INVALID',
      `Field ${unknown} is not part of the template.`,
      400,
    );
  return {
    ...template,
    rules: template.rules.map((rule) =>
      Object.hasOwn(values, rule.targetFieldId)
        ? {
            targetFieldId: rule.targetFieldId,
            source: { kind: 'constant', value: values[rule.targetFieldId] },
            ...(rule.required === undefined ? {} : { required: rule.required }),
          }
        : rule,
    ),
  };
}

export function resolveFieldMapping(
  item: MappableItem,
  template: FieldMappingTemplate,
  definitions: readonly FieldDefinition[],
): Record<string, FieldValue> {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const result: Record<string, FieldValue> = {};
  for (const rule of template.rules) {
    const definition = byId.get(rule.targetFieldId);
    if (!definition || definition.readOnly)
      throw new ApplicationError(
        'FIELD_MAPPING_INVALID',
        `Destination field ${rule.targetFieldId} is unavailable or read-only.`,
        400,
      );
    const value = sourceValue(item, rule.source);
    if (value === undefined || value === '' || value === null) {
      if (rule.required || definition.required)
        throw new ApplicationError(
          'FIELD_MAPPING_REQUIRED',
          `Missing value for ${definition.name}.`,
          400,
        );
      continue;
    }
    result[definition.id] = mapValue(value, definition, rule.choices ?? {});
  }
  return result;
}
