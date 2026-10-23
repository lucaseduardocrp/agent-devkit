import type { AgentRepository } from '../application/agent-repository.js';
import {
  CustomAgent,
  parseAgentSource,
  type AgentProps,
  type AgentRole,
} from '../domain/agent-entity.js';

/** AgentSource as Prisma stores it: a JSON object of strings. */
type JsonSource = { readonly [key: string]: string | undefined };

interface RawAgentRecord {
  id: string;
  workspaceId: string;
  parentAgentId?: string | null;
  name: string;
  slug: string;
  description: string;
  role: string;
  instructions: string;
  model: string | null;
  temperature: number | null;
  isDefault: boolean;
  source?: unknown;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentDelegate {
  upsert(arguments_: {
    where: { id: string };
    create: {
      id: string;
      workspaceId: string;
      parentAgentId?: string | null;
      name: string;
      slug: string;
      description: string;
      role: AgentRole;
      instructions: string;
      model?: string | null;
      temperature?: number | null;
      isDefault?: boolean;
      source?: JsonSource;
    };
    update: {
      name: string;
      parentAgentId?: string | null;
      slug: string;
      description: string;
      role: AgentRole;
      instructions: string;
      model?: string | null;
      temperature?: number | null;
      isDefault?: boolean;
      source?: JsonSource;
      updatedAt?: Date;
    };
  }): Promise<RawAgentRecord>;

  findUnique(arguments_: {
    where: { id?: string; workspaceId_slug?: { workspaceId: string; slug: string } };
  }): Promise<RawAgentRecord | null>;

  findMany(arguments_: {
    where: { workspaceId: string; role?: AgentRole };
    orderBy?: { createdAt: 'asc' | 'desc' };
  }): Promise<readonly RawAgentRecord[]>;

  delete(arguments_: { where: { id: string } }): Promise<RawAgentRecord>;
}

export interface PrismaAgentClient {
  agentRecord: AgentDelegate;
}

export class PrismaAgentRepository implements AgentRepository {
  public constructor(private readonly client: PrismaAgentClient) {}

  private mapToDomain(record: RawAgentRecord): CustomAgent {
    const props: AgentProps = {
      id: record.id,
      workspaceId: record.workspaceId,
      parentAgentId: record.parentAgentId,
      name: record.name,
      slug: record.slug,
      description: record.description,
      role: record.role as AgentRole,
      instructions: record.instructions,
      model: record.model,
      temperature: record.temperature,
      isDefault: record.isDefault,
      source: parseAgentSource(record.source),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    return new CustomAgent(props);
  }

  public async save(agent: CustomAgent): Promise<CustomAgent> {
    const record = await this.client.agentRecord.upsert({
      where: { id: agent.id },
      create: {
        id: agent.id,
        workspaceId: agent.workspaceId,
        parentAgentId: agent.parentAgentId,
        name: agent.name,
        slug: agent.slug,
        description: agent.description,
        role: agent.role,
        instructions: agent.instructions,
        model: agent.model ?? null,
        temperature: agent.temperature,
        isDefault: agent.isDefault,
        ...(agent.source ? { source: { ...agent.source } } : {}),
      },
      update: {
        name: agent.name,
        parentAgentId: agent.parentAgentId,
        slug: agent.slug,
        description: agent.description,
        role: agent.role,
        instructions: agent.instructions,
        model: agent.model ?? null,
        temperature: agent.temperature,
        isDefault: agent.isDefault,
        ...(agent.source ? { source: { ...agent.source } } : {}),
        updatedAt: new Date(),
      },
    });

    return this.mapToDomain(record);
  }

  public async findById(id: string, workspaceId?: string): Promise<CustomAgent | null> {
    const record = await this.client.agentRecord.findUnique({
      where: { id },
    });

    if (!record) {
      return null;
    }

    if (workspaceId && record.workspaceId !== workspaceId) {
      return null;
    }

    return this.mapToDomain(record);
  }

  public async findBySlug(workspaceId: string, slug: string): Promise<CustomAgent | null> {
    const record = await this.client.agentRecord.findUnique({
      where: {
        workspaceId_slug: { workspaceId, slug },
      },
    });

    if (!record) {
      return null;
    }

    return this.mapToDomain(record);
  }

  public async listByWorkspace(
    workspaceId: string,
    role?: AgentRole,
  ): Promise<readonly CustomAgent[]> {
    const records = await this.client.agentRecord.findMany({
      where: {
        workspaceId,
        ...(role ? { role } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((r) => this.mapToDomain(r));
  }

  public async delete(id: string, workspaceId: string): Promise<boolean> {
    const existing = await this.findById(id, workspaceId);
    if (!existing) {
      return false;
    }

    await this.client.agentRecord.delete({ where: { id } });
    return true;
  }
}
