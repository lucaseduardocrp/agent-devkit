import type {
  EffectiveAccess,
  PermissionGroupEntity,
  WorkspaceEntity,
  WorkspaceMemberEntity,
  WorkspacePermissions,
  WorkspaceRole,
} from '../domain/workspace-entity.js';
import type { ModuleAccessMap } from '../domain/permissions.js';

export interface CreatePermissionGroupInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly modules: ModuleAccessMap;
  readonly memberIds: readonly string[];
}

export interface UpdatePermissionGroupInput {
  readonly name?: string;
  readonly description?: string;
  readonly modules?: ModuleAccessMap;
  readonly memberIds?: readonly string[];
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
}

export interface CreateWorkspaceMemberInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly permissions?: WorkspacePermissions;
}

export interface UpdateWorkspaceMemberInput {
  readonly role?: WorkspaceRole;
  readonly permissions?: WorkspacePermissions;
}

export interface UserWorkspaceMembership {
  readonly workspace: WorkspaceEntity;
  readonly member: WorkspaceMemberEntity;
  /** Effective permissions of the member; filled in by WorkspaceService. */
  readonly access?: EffectiveAccess;
}

export interface WorkspaceRepository {
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceEntity>;
  findById(id: string): Promise<WorkspaceEntity | null>;
  findBySlug(slug: string): Promise<WorkspaceEntity | null>;
  listUserWorkspaces(userId: string): Promise<readonly UserWorkspaceMembership[]>;
  addMember(input: CreateWorkspaceMemberInput): Promise<WorkspaceMemberEntity>;
  findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberEntity | null>;
  findMemberById(memberId: string): Promise<WorkspaceMemberEntity | null>;
  listMembers(workspaceId: string): Promise<readonly WorkspaceMemberEntity[]>;
  updateMember(memberId: string, input: UpdateWorkspaceMemberInput): Promise<WorkspaceMemberEntity>;
  deleteMember(memberId: string): Promise<void>;
  countAdmins(workspaceId: string): Promise<number>;
  deleteWorkspace(id: string): Promise<void>;
  renameWorkspace(id: string, name: string): Promise<WorkspaceEntity>;
  listGroups(workspaceId: string): Promise<readonly PermissionGroupEntity[]>;
  findGroup(groupId: string): Promise<PermissionGroupEntity | null>;
  createGroup(input: CreatePermissionGroupInput): Promise<PermissionGroupEntity>;
  updateGroup(groupId: string, input: UpdatePermissionGroupInput): Promise<PermissionGroupEntity>;
  deleteGroup(groupId: string): Promise<void>;
  /** Replaces the groups of one member with exactly `groupIds`. */
  setMemberGroups(
    workspaceId: string,
    memberId: string,
    groupIds: readonly string[],
  ): Promise<void>;
}
