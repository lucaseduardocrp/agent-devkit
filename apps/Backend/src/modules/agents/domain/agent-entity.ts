import { ApplicationError } from '../../../shared/errors.js';

export type AgentRole = 'QA' | 'DOCUMENTATION' | 'REFACTOR' | 'CUSTOM';

export interface AgentProps {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentAgentId?: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly role: AgentRole;
  readonly instructions: string;
  readonly model?: string | null;
  readonly temperature?: number | null;
  readonly isDefault?: boolean;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export function slugify(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent'
  );
}

export class CustomAgent {
  public readonly id: string;
  public readonly workspaceId: string;
  public readonly parentAgentId: string | null;
  public readonly name: string;
  public readonly slug: string;
  public readonly description: string;
  public readonly role: AgentRole;
  public readonly instructions: string;
  public readonly model?: string;
  public readonly temperature: number;
  public readonly isDefault: boolean;
  public readonly createdAt: Date;
  public readonly updatedAt: Date;

  public constructor(props: AgentProps) {
    if (!props.id?.trim()) {
      throw new ApplicationError('INVALID_AGENT', 'Agent id is required.', 400);
    }
    if (!props.workspaceId?.trim()) {
      throw new ApplicationError('INVALID_AGENT', 'Workspace id is required.', 400);
    }
    if (!props.name?.trim()) {
      throw new ApplicationError('INVALID_AGENT', 'Agent name is required.', 400);
    }
    if (!props.instructions?.trim()) {
      throw new ApplicationError('INVALID_AGENT', 'Agent instructions are required.', 400);
    }

    const temp = props.temperature ?? 0.2;
    if (temp < 0 || temp > 2.0) {
      throw new ApplicationError('INVALID_AGENT', 'Temperature must be between 0.0 and 2.0.', 400);
    }

    this.id = props.id;
    this.workspaceId = props.workspaceId;
    this.parentAgentId = props.parentAgentId ?? null;
    this.name = props.name.trim();
    this.slug = props.slug?.trim() ? slugify(props.slug) : slugify(props.name);
    this.description = props.description?.trim() || '';
    this.role = props.role || 'CUSTOM';
    this.instructions = props.instructions.trim();
    this.model = props.model?.trim() || undefined;
    this.temperature = temp;
    this.isDefault = Boolean(props.isDefault);
    this.createdAt = props.createdAt ?? new Date();
    this.updatedAt = props.updatedAt ?? new Date();
  }

  public toJSON() {
    return {
      id: this.id,
      workspaceId: this.workspaceId,
      parentAgentId: this.parentAgentId,
      name: this.name,
      slug: this.slug,
      description: this.description,
      role: this.role,
      instructions: this.instructions,
      model: this.model,
      temperature: this.temperature,
      isDefault: this.isDefault,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
