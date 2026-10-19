export type WorkspaceRole = 'ADMIN' | 'MEMBER' | 'INTEGRATOR' | 'VIEWER';

/** Product areas governed by permission groups (mirrors the backend list). */
export const PERMISSION_MODULES = [
  'issues',
  'pbis',
  'agents',
  'brain',
  'design',
  'specs',
  'releaseNotes',
  'testplans',
  'e2e',
  'integrations',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/** Cumulative: `edit` includes `view`, `delete` includes both. */
export const MODULE_ACCESS_LEVELS = ['none', 'view', 'edit', 'delete'] as const;
export type ModuleAccess = (typeof MODULE_ACCESS_LEVELS)[number];
export type ModuleOperation = Exclude<ModuleAccess, 'none'>;
export type ModuleAccessMap = Partial<Record<PermissionModule, ModuleAccess>>;

/** Actions on the workspace itself, granted per member. ADMIN members have all of them. */
export const WORKSPACE_PERMISSION_KEYS = [
  'editWorkspace',
  'deleteWorkspace',
  'addMembers',
  'removeMembers',
  'manageRoles',
  'manageGroups',
  'manageCosts',
] as const;
export type WorkspacePermissionKey = (typeof WORKSPACE_PERMISSION_KEYS)[number];

export type WorkspacePermissions = Partial<Record<WorkspacePermissionKey, boolean>> & {
  /** @deprecated Replaced by the `integrations` module of permission groups. */
  canManageIntegrations?: boolean;
  /** @deprecated Read by the API as addMembers, removeMembers and manageRoles. */
  canManageMembers?: boolean;
};

export interface EffectiveAccess {
  modules: Record<PermissionModule, ModuleAccess>;
  workspace: Record<WorkspacePermissionKey, boolean>;
}

export interface PermissionGroup {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  modules: ModuleAccessMap;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  permissions: WorkspacePermissions;
  createdAt: string;
  /** Permission groups of the member (returned when listing members). */
  groupIds?: string[];
  user?: {
    id: string;
    name: string;
    email: string;
  };
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
}

export interface UserWorkspaceMembership {
  workspace: Workspace;
  member: WorkspaceMember;
  /** Effective permissions of the current user in this workspace. */
  access?: EffectiveAccess;
}

export function getRoleBadgeClass(role: WorkspaceRole): string {
  switch (role) {
    case 'ADMIN':
      return 'bg-purple-500/10 text-purple-400 border-purple-500/20';
    case 'INTEGRATOR':
      return 'bg-blue-500/10 text-blue-400 border-blue-500/20';
    case 'VIEWER':
      return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
    case 'MEMBER':
    default:
      return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20';
  }
}

export function getAssigneeDisplayName(
  member?: WorkspaceMember | null,
  unassignedLabel = '',
): string {
  if (!member) return unassignedLabel;
  if (member.user?.name) return member.user.name;
  if (member.user?.email) return member.user.email;
  return member.role;
}
