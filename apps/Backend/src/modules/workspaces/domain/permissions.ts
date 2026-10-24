import type { WorkspacePermissions, WorkspaceRole } from './workspace-entity.js';

/** Product areas whose content is governed by permission groups. */
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
  'integrationTests',
  'loadTests',
  'integrations',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

/**
 * Cumulative access levels: `edit` includes `view`, and `delete` includes both. Without at
 * least `view` the module is hidden from the member.
 */
export const MODULE_ACCESS_LEVELS = ['none', 'view', 'edit', 'delete'] as const;
export type ModuleAccess = (typeof MODULE_ACCESS_LEVELS)[number];
export type ModuleOperation = Exclude<ModuleAccess, 'none'>;
export type ModuleAccessMap = Partial<Record<PermissionModule, ModuleAccess>>;

/** Actions on the workspace itself; they stay on the member, not on groups. */
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
export type WorkspaceAccess = Readonly<Record<WorkspacePermissionKey, boolean>>;

export interface EffectiveAccess {
  readonly modules: Readonly<Record<PermissionModule, ModuleAccess>>;
  readonly workspace: WorkspaceAccess;
}

export function rank(access: ModuleAccess | undefined): number {
  return access ? MODULE_ACCESS_LEVELS.indexOf(access) : 0;
}

export function allows(access: ModuleAccess | undefined, operation: ModuleOperation): boolean {
  return rank(access) >= rank(operation);
}

/** Keeps only known modules and levels, so stored JSON can never widen access. */
export function normalizeModuleAccess(raw: unknown): ModuleAccessMap {
  if (!raw || typeof raw !== 'object') return {};
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(
    PERMISSION_MODULES.flatMap((module) => {
      const level = source[module];
      return MODULE_ACCESS_LEVELS.includes(level as ModuleAccess) && level !== 'none'
        ? [[module, level as ModuleAccess]]
        : [];
    }),
  );
}

export function uniformModuleAccess(level: ModuleAccess): Record<PermissionModule, ModuleAccess> {
  return Object.fromEntries(PERMISSION_MODULES.map((module) => [module, level])) as Record<
    PermissionModule,
    ModuleAccess
  >;
}

/** A member in several groups gets the highest level any of them grants per module. */
export function mergeModuleAccess(
  maps: readonly ModuleAccessMap[],
): Record<PermissionModule, ModuleAccess> {
  const merged = uniformModuleAccess('none');
  for (const map of maps)
    for (const module of PERMISSION_MODULES) {
      const level = map[module];
      if (rank(level) > rank(merged[module])) merged[module] = level!;
    }
  return merged;
}

export function resolveWorkspaceAccess(
  role: WorkspaceRole,
  permissions: WorkspacePermissions,
): WorkspaceAccess {
  const admin = role === 'ADMIN';
  // Members created before workspace permissions existed only had canManageMembers.
  const legacyMembers = permissions.canManageMembers === true;
  return {
    editWorkspace: admin || permissions.editWorkspace === true,
    deleteWorkspace: admin || permissions.deleteWorkspace === true,
    addMembers: admin || legacyMembers || permissions.addMembers === true,
    removeMembers: admin || legacyMembers || permissions.removeMembers === true,
    manageRoles: admin || legacyMembers || permissions.manageRoles === true,
    manageGroups: admin || permissions.manageGroups === true,
    manageCosts: admin || permissions.manageCosts === true,
  };
}

export function resolveEffectiveAccess(
  role: WorkspaceRole,
  permissions: WorkspacePermissions,
  groups: readonly { readonly modules: ModuleAccessMap }[],
): EffectiveAccess {
  return {
    modules:
      role === 'ADMIN'
        ? uniformModuleAccess('delete')
        : mergeModuleAccess(groups.map((group) => group.modules)),
    workspace: resolveWorkspaceAccess(role, permissions),
  };
}
