import type {
  CreatePermissionGroupInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  UpdatePermissionGroupInput,
  UpdateWorkspaceMemberInput,
  UserWorkspaceMembership,
  WorkspaceRepository,
} from '../application/workspace-repository.js';
import { normalizeModuleAccess } from '../domain/permissions.js';
import type {
  PermissionGroupEntity,
  WorkspaceEntity,
  WorkspaceMemberEntity,
  WorkspacePermissions,
  WorkspaceRole,
} from '../domain/workspace-entity.js';

interface RawWorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RawUserRecord {
  id: string;
  email: string;
  name: string;
}

interface RawMemberWithUser {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  permissions: unknown;
  createdAt: Date;
  updatedAt: Date;
  user?: RawUserRecord;
  workspace?: RawWorkspaceRecord;
}

interface RawGroupRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  modules: unknown;
  createdAt: Date;
  updatedAt: Date;
  members?: readonly { memberId: string }[];
}

const groupInclude = { members: { select: { memberId: true } } } as const;

interface PermissionGroupDelegate {
  findMany(arguments_: {
    where: { workspaceId: string };
    include: typeof groupInclude;
    orderBy: { name: 'asc' };
  }): Promise<readonly RawGroupRecord[]>;
  findUnique(arguments_: {
    where: { id: string };
    include: typeof groupInclude;
  }): Promise<RawGroupRecord | null>;
  create(arguments_: {
    data: {
      workspaceId: string;
      name: string;
      description: string;
      modules: unknown;
      members: { create: { memberId: string }[] };
    };
    include: typeof groupInclude;
  }): Promise<RawGroupRecord>;
  update(arguments_: {
    where: { id: string };
    data: {
      name?: string;
      description?: string;
      modules?: unknown;
      members?: { deleteMany: Record<string, never>; create: { memberId: string }[] };
    };
    include: typeof groupInclude;
  }): Promise<RawGroupRecord>;
  delete(arguments_: { where: { id: string } }): Promise<unknown>;
}

interface PermissionGroupMemberDelegate {
  deleteMany(arguments_: {
    where: { memberId: string; group: { workspaceId: string } };
  }): Promise<unknown>;
  createMany(arguments_: {
    data: { groupId: string; memberId: string }[];
    skipDuplicates: boolean;
  }): Promise<unknown>;
}

interface WorkspaceDelegate {
  create(arguments_: { data: CreateWorkspaceInput }): Promise<RawWorkspaceRecord>;
  update(arguments_: {
    where: { id: string };
    data: { name: string };
  }): Promise<RawWorkspaceRecord>;
  findUnique(arguments_: {
    where: { id?: string; slug?: string };
  }): Promise<RawWorkspaceRecord | null>;
  delete(arguments_: { where: { id: string } }): Promise<RawWorkspaceRecord>;
}

interface WorkspaceMemberDelegate {
  create(arguments_: {
    data: {
      workspaceId: string;
      userId: string;
      role: WorkspaceRole;
      permissions?: unknown;
    };
    include?: { user?: boolean; workspace?: boolean };
  }): Promise<RawMemberWithUser>;
  findUnique(arguments_: {
    where: {
      id?: string;
      workspaceId_userId?: { workspaceId: string; userId: string };
    };
    include?: { user?: boolean; workspace?: boolean };
  }): Promise<RawMemberWithUser | null>;
  findMany(arguments_: {
    where: {
      workspaceId?: string;
      userId?: string;
    };
    include?: { user?: boolean; workspace?: boolean };
    orderBy?: Record<string, 'asc' | 'desc'>;
  }): Promise<readonly RawMemberWithUser[]>;
  update(arguments_: {
    where: { id: string };
    data: {
      role?: WorkspaceRole;
      permissions?: unknown;
    };
    include?: { user?: boolean; workspace?: boolean };
  }): Promise<RawMemberWithUser>;
  delete(arguments_: { where: { id: string } }): Promise<{ id: string }>;
  count(arguments_: { where: { workspaceId: string; role?: WorkspaceRole } }): Promise<number>;
}

export interface PrismaWorkspacesClient {
  readonly workspaceRecord: WorkspaceDelegate;
  readonly workspaceMemberRecord: WorkspaceMemberDelegate;
  readonly permissionGroupRecord: PermissionGroupDelegate;
  readonly permissionGroupMemberRecord: PermissionGroupMemberDelegate;
  $transaction<T>(operation: (client: PrismaWorkspacesClient) => Promise<T>): Promise<T>;
  readonly knowledgeChunkRecord?: {
    deleteMany(arguments_: { where: { ownerId: string } }): Promise<unknown>;
  };
  readonly knowledgeRelationRecord?: {
    deleteMany(arguments_: { where: { ownerId: string } }): Promise<unknown>;
  };
  readonly integrationRecord?: {
    deleteMany(arguments_: { where: { ownerId: string } }): Promise<unknown>;
  };
  readonly auditEventRecord?: {
    deleteMany(arguments_: { where: { workspaceId: string } }): Promise<unknown>;
  };
}

export class PrismaWorkspaceRepository implements WorkspaceRepository {
  public constructor(private readonly client: PrismaWorkspacesClient) {}

  private mapPermissions(raw: unknown): WorkspacePermissions {
    if (typeof raw === 'object' && raw !== null) {
      return raw;
    }
    return {};
  }

  private mapWorkspace(raw: RawWorkspaceRecord): WorkspaceEntity {
    return {
      id: raw.id,
      name: raw.name,
      slug: raw.slug,
      ownerId: raw.ownerId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  private mapMember(raw: RawMemberWithUser): WorkspaceMemberEntity {
    return {
      id: raw.id,
      workspaceId: raw.workspaceId,
      userId: raw.userId,
      role: raw.role,
      permissions: this.mapPermissions(raw.permissions),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      user: raw.user
        ? {
            id: raw.user.id,
            email: raw.user.email,
            name: raw.user.name,
          }
        : undefined,
    };
  }

  private mapGroup(raw: RawGroupRecord): PermissionGroupEntity {
    return {
      id: raw.id,
      workspaceId: raw.workspaceId,
      name: raw.name,
      description: raw.description,
      modules: normalizeModuleAccess(raw.modules),
      memberIds: (raw.members ?? []).map((member) => member.memberId),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  public async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceEntity> {
    const raw = await this.client.workspaceRecord.create({
      data: {
        name: input.name,
        slug: input.slug,
        ownerId: input.ownerId,
      },
    });
    return this.mapWorkspace(raw);
  }

  public async findById(id: string): Promise<WorkspaceEntity | null> {
    const raw = await this.client.workspaceRecord.findUnique({ where: { id } });
    return raw ? this.mapWorkspace(raw) : null;
  }

  public async findBySlug(slug: string): Promise<WorkspaceEntity | null> {
    const raw = await this.client.workspaceRecord.findUnique({ where: { slug } });
    return raw ? this.mapWorkspace(raw) : null;
  }

  public async listUserWorkspaces(userId: string): Promise<readonly UserWorkspaceMembership[]> {
    const records = await this.client.workspaceMemberRecord.findMany({
      where: { userId },
      include: { workspace: true, user: true },
      orderBy: { createdAt: 'asc' },
    });

    const results: UserWorkspaceMembership[] = [];
    for (const record of records) {
      if (record.workspace) {
        results.push({
          workspace: this.mapWorkspace(record.workspace),
          member: this.mapMember(record),
        });
      }
    }
    return results;
  }

  public async addMember(input: CreateWorkspaceMemberInput): Promise<WorkspaceMemberEntity> {
    const raw = await this.client.workspaceMemberRecord.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        permissions: input.permissions ?? {},
      },
      include: { user: true },
    });
    return this.mapMember(raw);
  }

  public async findMember(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMemberEntity | null> {
    const raw = await this.client.workspaceMemberRecord.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId },
      },
      include: { user: true },
    });
    return raw ? this.mapMember(raw) : null;
  }

  public async findMemberById(memberId: string): Promise<WorkspaceMemberEntity | null> {
    const raw = await this.client.workspaceMemberRecord.findUnique({
      where: { id: memberId },
      include: { user: true },
    });
    return raw ? this.mapMember(raw) : null;
  }

  public async listMembers(workspaceId: string): Promise<readonly WorkspaceMemberEntity[]> {
    const list = await this.client.workspaceMemberRecord.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return list.map((m) => this.mapMember(m));
  }

  public async updateMember(
    memberId: string,
    input: UpdateWorkspaceMemberInput,
  ): Promise<WorkspaceMemberEntity> {
    const data: { role?: WorkspaceRole; permissions?: unknown } = {};
    if (input.role) data.role = input.role;
    if (input.permissions !== undefined) data.permissions = input.permissions;

    const raw = await this.client.workspaceMemberRecord.update({
      where: { id: memberId },
      data,
      include: { user: true },
    });
    return this.mapMember(raw);
  }

  public async deleteMember(memberId: string): Promise<void> {
    await this.client.workspaceMemberRecord.delete({
      where: { id: memberId },
    });
  }

  public async countAdmins(workspaceId: string): Promise<number> {
    return this.client.workspaceMemberRecord.count({
      where: { workspaceId, role: 'ADMIN' },
    });
  }

  public async deleteWorkspace(id: string): Promise<void> {
    if (this.client.knowledgeChunkRecord) {
      await this.client.knowledgeChunkRecord.deleteMany({ where: { ownerId: id } });
    }
    if (this.client.knowledgeRelationRecord) {
      await this.client.knowledgeRelationRecord.deleteMany({ where: { ownerId: id } });
    }
    if (this.client.integrationRecord) {
      await this.client.integrationRecord.deleteMany({ where: { ownerId: id } });
    }
    await this.client.workspaceRecord.delete({ where: { id } });
    if (this.client.auditEventRecord) {
      await this.client.auditEventRecord.deleteMany({ where: { workspaceId: id } });
    }
  }

  public async renameWorkspace(id: string, name: string): Promise<WorkspaceEntity> {
    return this.mapWorkspace(
      await this.client.workspaceRecord.update({ where: { id }, data: { name } }),
    );
  }

  public async listGroups(workspaceId: string): Promise<readonly PermissionGroupEntity[]> {
    const records = await this.client.permissionGroupRecord.findMany({
      where: { workspaceId },
      include: groupInclude,
      orderBy: { name: 'asc' },
    });
    return records.map((record) => this.mapGroup(record));
  }

  public async findGroup(groupId: string): Promise<PermissionGroupEntity | null> {
    const record = await this.client.permissionGroupRecord.findUnique({
      where: { id: groupId },
      include: groupInclude,
    });
    return record ? this.mapGroup(record) : null;
  }

  public async createGroup(input: CreatePermissionGroupInput): Promise<PermissionGroupEntity> {
    return this.mapGroup(
      await this.client.permissionGroupRecord.create({
        data: {
          workspaceId: input.workspaceId,
          name: input.name,
          description: input.description,
          modules: input.modules,
          members: { create: [...new Set(input.memberIds)].map((memberId) => ({ memberId })) },
        },
        include: groupInclude,
      }),
    );
  }

  public async updateGroup(
    groupId: string,
    input: UpdatePermissionGroupInput,
  ): Promise<PermissionGroupEntity> {
    return this.mapGroup(
      await this.client.permissionGroupRecord.update({
        where: { id: groupId },
        data: {
          name: input.name,
          description: input.description,
          modules: input.modules,
          ...(input.memberIds
            ? {
                members: {
                  deleteMany: {},
                  create: [...new Set(input.memberIds)].map((memberId) => ({ memberId })),
                },
              }
            : {}),
        },
        include: groupInclude,
      }),
    );
  }

  public async deleteGroup(groupId: string): Promise<void> {
    await this.client.permissionGroupRecord.delete({ where: { id: groupId } });
  }

  public async setMemberGroups(
    workspaceId: string,
    memberId: string,
    groupIds: readonly string[],
  ): Promise<void> {
    await this.client.$transaction(async (tx) => {
      await tx.permissionGroupMemberRecord.deleteMany({
        where: { memberId, group: { workspaceId } },
      });
      if (groupIds.length)
        await tx.permissionGroupMemberRecord.createMany({
          data: groupIds.map((groupId) => ({ groupId, memberId })),
          skipDuplicates: true,
        });
    });
  }
}
