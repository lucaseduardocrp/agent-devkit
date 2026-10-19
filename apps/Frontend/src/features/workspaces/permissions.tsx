/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  MODULE_ACCESS_LEVELS,
  PERMISSION_MODULES,
  WORKSPACE_PERMISSION_KEYS,
  type EffectiveAccess,
  type ModuleAccess,
  type ModuleOperation,
  type PermissionModule,
  type UserWorkspaceMembership,
  type WorkspacePermissionKey,
} from './workspace-types.js';

export function allows(access: ModuleAccess | undefined, operation: ModuleOperation): boolean {
  return MODULE_ACCESS_LEVELS.indexOf(access ?? 'none') >= MODULE_ACCESS_LEVELS.indexOf(operation);
}

/**
 * Levels are cumulative, so the checkboxes follow them: checking an operation also checks
 * the ones it includes, and unchecking one removes the operations that depend on it.
 */
export function toggleOperation(
  current: ModuleAccess | undefined,
  operation: ModuleOperation,
): ModuleAccess {
  if (!allows(current, operation)) return operation;
  return MODULE_ACCESS_LEVELS[MODULE_ACCESS_LEVELS.indexOf(operation) - 1]!;
}

function uniform(level: ModuleAccess): Record<PermissionModule, ModuleAccess> {
  return Object.fromEntries(PERMISSION_MODULES.map((module) => [module, level])) as Record<
    PermissionModule,
    ModuleAccess
  >;
}

function workspaceFlags(value: boolean): Record<WorkspacePermissionKey, boolean> {
  return Object.fromEntries(WORKSPACE_PERMISSION_KEYS.map((key) => [key, value])) as Record<
    WorkspacePermissionKey,
    boolean
  >;
}

export const FULL_ACCESS: EffectiveAccess = {
  modules: uniform('delete'),
  workspace: workspaceFlags(true),
};

/**
 * The backend sends the effective access with each membership. A membership without it
 * (older API) gets the defaults its role had before permission groups; with no workspace
 * yet the UI shows everything. The API enforces permissions either way.
 */
export function accessFor(membership: UserWorkspaceMembership | undefined): EffectiveAccess {
  if (!membership) return FULL_ACCESS;
  if (membership.access) return membership.access;
  const { role, permissions } = membership.member;
  if (role === 'ADMIN') return FULL_ACCESS;
  const manageMembers = permissions?.canManageMembers === true;
  return {
    modules:
      role === 'VIEWER'
        ? { ...uniform('view'), integrations: 'none' }
        : {
            ...uniform('delete'),
            integrations:
              role === 'INTEGRATOR' || permissions?.canManageIntegrations ? 'delete' : 'view',
          },
    workspace: {
      ...workspaceFlags(false),
      ...Object.fromEntries(
        WORKSPACE_PERMISSION_KEYS.map((key) => [key, permissions?.[key] === true]),
      ),
      addMembers: manageMembers || permissions?.addMembers === true,
      removeMembers: manageMembers || permissions?.removeMembers === true,
      manageRoles: manageMembers || permissions?.manageRoles === true,
    },
  };
}

const PermissionsContext = createContext<EffectiveAccess>(FULL_ACCESS);

export function PermissionsProvider({
  access,
  children,
}: {
  access: EffectiveAccess;
  children: ReactNode;
}) {
  return <PermissionsContext.Provider value={access}>{children}</PermissionsContext.Provider>;
}

export interface Permissions {
  readonly access: EffectiveAccess;
  /** Whether the member may perform `operation` (default `view`) in `module`. */
  readonly can: (module: PermissionModule, operation?: ModuleOperation) => boolean;
  readonly canWorkspace: (permission: WorkspacePermissionKey) => boolean;
}

export function usePermissions(): Permissions {
  const access = useContext(PermissionsContext);
  return useMemo(
    () => ({
      access,
      can: (module, operation = 'view') => allows(access.modules[module], operation),
      canWorkspace: (permission) => access.workspace[permission],
    }),
    [access],
  );
}
