export type FieldValue = string | number | boolean | string[] | null;
export interface FieldDefinition {
  id: string;
  name: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'single_select' | 'multi_select' | 'iteration';
  required?: boolean;
  readOnly?: boolean;
  options?: { id: string; name: string }[];
}
export interface FieldSource {
  kind: 'core' | 'custom' | 'constant';
  key?: string;
  providerId?: string;
  value?: FieldValue;
}
export interface FieldMappingRule {
  targetFieldId: string;
  source: FieldSource;
  choices?: Record<string, string>;
  required?: boolean;
}
export interface FieldMappingTemplateInput {
  name: string;
  entityType: 'pbi' | 'test_case';
  providerId: string;
  scope: string;
  itemType: string;
  rules: FieldMappingRule[];
}
export interface FieldMappingTemplate extends FieldMappingTemplateInput {
  id: string;
  workspaceId: string;
  createdAt: string;
  updatedAt: string;
}
