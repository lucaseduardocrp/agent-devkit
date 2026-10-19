import { randomUUID } from 'node:crypto';
import type {
  CreatePermissionGroupInput,
  CreateWorkspaceInput,
  CreateWorkspaceMemberInput,
  UpdatePermissionGroupInput,
  UpdateWorkspaceMemberInput,
  UserWorkspaceMembership,
  WorkspaceRepository,
} from '../application/workspace-repository.js';
import type {
  PermissionGroupEntity,
  WorkspaceEntity,
  WorkspaceMemberEntity,
  WorkspaceMemberUser,
} from '../domain/workspace-entity.js';

export class InMemoryWorkspaceRepository implements WorkspaceRepository {
  private readonly workspaces = new Map<string, WorkspaceEntity>();
  private readonly members = new Map<string, WorkspaceMemberEntity>();
  private readonly users = new Map<string, WorkspaceMemberUser>();
  private readonly groups = new Map<string, PermissionGroupEntity>();

  public registerUser(user: WorkspaceMemberUser): void {
    this.users.set(user.id, user);
  }

  public async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceEntity> {
    const existingSlug = await this.findBySlug(input.slug);
    if (existingSlug) {
      throw new Error(`Workspace with slug "${input.slug}" already exists.`);
    }

    const now = new Date();
    const entity: WorkspaceEntity = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      ownerId: input.ownerId,
      createdAt: now,
      updatedAt: now,
    };

    this.workspaces.set(entity.id, entity);
    return entity;
  }

  public findById(id: string): Promise<WorkspaceEntity | null> {
    return Promise.resolve(this.workspaces.get(id) ?? null);
  }

  public findBySlug(slug: string): Promise<WorkspaceEntity | null> {
    for (const ws of this.workspaces.values()) {
      if (ws.slug === slug) {
        return Promise.resolve(ws);
      }
    }
    return Promise.resolve(null);
  }

  public listUserWorkspaces(userId: string): Promise<readonly UserWorkspaceMembership[]> {
    const result: UserWorkspaceMembership[] = [];
    for (const member of this.members.values()) {
      if (member.userId === userId) {
        const workspace = this.workspaces.get(member.workspaceId);
        if (workspace) {
          result.push({ workspace, member });
        }
      }
    }
    return Promise.resolve(result.sort((a, b) => a.workspace.name.localeCompare(b.workspace.name)));
  }

  public async addMember(input: CreateWorkspaceMemberInput): Promise<WorkspaceMemberEntity> {
    const existing = await this.findMember(input.workspaceId, input.userId);
    if (existing) {
      throw new Error('User is already a member of this workspace.');
    }

    const now = new Date();
    const user = this.users.get(input.userId);
    const member: WorkspaceMemberEntity = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role,
      permissions: input.permissions ?? {},
      createdAt: now,
      updatedAt: now,
      user,
    };

    this.members.set(member.id, member);
    return member;
  }

  public findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberEntity | null> {
    for (const member of this.members.values()) {
      if (member.workspaceId === workspaceId && member.userId === userId) {
        return Promise.resolve({
          ...member,
          user: member.user ?? this.users.get(member.userId),
        });
      }
    }
    return Promise.resolve(null);
  }

  public findMemberById(memberId: string): Promise<WorkspaceMemberEntity | null> {
    const member = this.members.get(memberId);
    if (!member) return Promise.resolve(null);
    return Promise.resolve({
      ...member,
      user: member.user ?? this.users.get(member.userId),
    });
  }

  public listMembers(workspaceId: string): Promise<readonly WorkspaceMemberEntity[]> {
    const list: WorkspaceMemberEntity[] = [];
    for (const member of this.members.values()) {
      if (member.workspaceId === workspaceId) {
        list.push({
          ...member,
          user: member.user ?? this.users.get(member.userId),
        });
      }
    }
    return Promise.resolve(list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()));
  }

  public updateMember(
    memberId: string,
    input: UpdateWorkspaceMemberInput,
  ): Promise<WorkspaceMemberEntity> {
    const existing = this.members.get(memberId);
    if (!existing) {
      return Promise.reject(new Error('Member not found.'));
    }

    const updated: WorkspaceMemberEntity = {
      ...existing,
      role: input.role ?? existing.role,
      permissions: input.permissions ?? existing.permissions,
      updatedAt: new Date(),
      user: existing.user ?? this.users.get(existing.userId),
    };

    this.members.set(memberId, updated);
    return Promise.resolve(updated);
  }

  public deleteMember(memberId: string): Promise<void> {
    this.members.delete(memberId);
    for (const group of this.groups.values())
      if (group.memberIds.includes(memberId))
        this.groups.set(group.id, {
          ...group,
          memberIds: group.memberIds.filter((id) => id !== memberId),
        });
    return Promise.resolve();
  }

  public countAdmins(workspaceId: string): Promise<number> {
    let count = 0;
    for (const member of this.members.values()) {
      if (member.workspaceId === workspaceId && member.role === 'ADMIN') {
        count++;
      }
    }
    return Promise.resolve(count);
  }

  public deleteWorkspace(id: string): Promise<void> {
    this.workspaces.delete(id);
    for (const [memberId, member] of this.members.entries()) {
      if (member.workspaceId === id) {
        this.members.delete(memberId);
      }
    }
    for (const [groupId, group] of this.groups.entries())
      if (group.workspaceId === id) this.groups.delete(groupId);
    return Promise.resolve();
  }

  public renameWorkspace(id: string, name: string): Promise<WorkspaceEntity> {
    const existing = this.workspaces.get(id);
    if (!existing) return Promise.reject(new Error('Workspace not found.'));
    const updated = { ...existing, name, updatedAt: new Date() };
    this.workspaces.set(id, updated);
    return Promise.resolve(updated);
  }

  public listGroups(workspaceId: string): Promise<readonly PermissionGroupEntity[]> {
    return Promise.resolve(
      [...this.groups.values()]
        .filter((group) => group.workspaceId === workspaceId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  public findGroup(groupId: string): Promise<PermissionGroupEntity | null> {
    return Promise.resolve(this.groups.get(groupId) ?? null);
  }

  public createGroup(input: CreatePermissionGroupInput): Promise<PermissionGroupEntity> {
    const now = new Date();
    const group: PermissionGroupEntity = {
      id: randomUUID(),
      ...input,
      memberIds: [...new Set(input.memberIds)],
      createdAt: now,
      updatedAt: now,
    };
    this.groups.set(group.id, group);
    return Promise.resolve(group);
  }

  public updateGroup(
    groupId: string,
    input: UpdatePermissionGroupInput,
  ): Promise<PermissionGroupEntity> {
    const existing = this.groups.get(groupId);
    if (!existing) return Promise.reject(new Error('Group not found.'));
    const updated: PermissionGroupEntity = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      modules: input.modules ?? existing.modules,
      memberIds: input.memberIds ? [...new Set(input.memberIds)] : existing.memberIds,
      updatedAt: new Date(),
    };
    this.groups.set(groupId, updated);
    return Promise.resolve(updated);
  }

  public deleteGroup(groupId: string): Promise<void> {
    this.groups.delete(groupId);
    return Promise.resolve();
  }

  public setMemberGroups(
    workspaceId: string,
    memberId: string,
    groupIds: readonly string[],
  ): Promise<void> {
    for (const group of this.groups.values()) {
      if (group.workspaceId !== workspaceId) continue;
      const others = group.memberIds.filter((id) => id !== memberId);
      this.groups.set(group.id, {
        ...group,
        memberIds: groupIds.includes(group.id) ? [...others, memberId] : others,
      });
    }
    return Promise.resolve();
  }
}
