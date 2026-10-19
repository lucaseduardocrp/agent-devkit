import type { EffectiveAccess, ModuleAccessMap } from './permissions.js';

export type WorkspaceRole = 'ADMIN' | 'MEMBER' | 'INTEGRATOR' | 'VIEWER';

/** @deprecated Module access comes from permission groups; kept for stored members. */
export interface ModulePermissions {
  readonly brain?: 'read' | 'write' | 'none';
  readonly connect?: 'read' | 'write' | 'none';
  readonly testplans?: 'read' | 'write' | 'none';
  readonly pipelines?: 'read' | 'write' | 'none';
  readonly settings?: 'read' | 'write' | 'none';
}

/** Workspace-level permissions stored on the member. ADMIN members implicitly have all. */
export interface WorkspacePermissions {
  readonly editWorkspace?: boolean;
  readonly deleteWorkspace?: boolean;
  readonly addMembers?: boolean;
  readonly removeMembers?: boolean;
  readonly manageRoles?: boolean;
  readonly manageGroups?: boolean;
  readonly manageCosts?: boolean;
  /** @deprecated Replaced by the `integrations` module of permission groups. */
  readonly canManageIntegrations?: boolean;
  /** @deprecated Read as addMembers, removeMembers and manageRoles. */
  readonly canManageMembers?: boolean;
  /** @deprecated Replaced by permission groups. */
  readonly modules?: ModulePermissions;
}

export interface PermissionGroupEntity {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  readonly modules: ModuleAccessMap;
  /** Workspace member IDs (not user IDs) in the group. */
  readonly memberIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type { EffectiveAccess };

export interface WorkspaceEntity {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WorkspaceMemberUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface WorkspaceMemberEntity {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly permissions: WorkspacePermissions;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly user?: WorkspaceMemberUser;
  /** Permission groups of the member; filled in by WorkspaceService when listing. */
  readonly groupIds?: readonly string[];
}
