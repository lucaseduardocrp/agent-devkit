import type { RequestHandler } from 'express';
import type { RequestContext } from '../../shared/context.js';
import { ApplicationError } from '../../shared/errors.js';
import {
  allows,
  resolveEffectiveAccess,
  uniformModuleAccess,
  type EffectiveAccess,
  type ModuleOperation,
  type PermissionModule,
} from '../../modules/workspaces/domain/permissions.js';
import type { WorkspaceRole } from '../../modules/workspaces/domain/workspace-entity.js';

export interface ModuleRequirement {
  readonly module: PermissionModule;
  readonly operation: ModuleOperation;
}

/**
 * Contexts built by the auth resolver carry the member's effective access. Contexts built
 * elsewhere (internal callers, injected resolvers) may only carry a role; they get the
 * defaults that role had before permission groups existed.
 */
export function accessForContext(context: RequestContext | undefined): EffectiveAccess | undefined {
  if (context?.access) return context.access;
  const role: WorkspaceRole | undefined = context?.memberRole;
  if (!role) return undefined;
  const full = uniformModuleAccess('delete');
  const legacy = {
    ADMIN: full,
    INTEGRATOR: full,
    MEMBER: { ...full, integrations: 'view' as const },
    VIEWER: { ...uniformModuleAccess('view'), integrations: 'none' as const },
  }[role];
  return resolveEffectiveAccess(role, context?.memberPermissions ?? {}, [{ modules: legacy }]);
}

function byMethod(method: string): ModuleOperation {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return 'view';
  return method === 'DELETE' ? 'delete' : 'edit';
}

const prefixes: readonly [RegExp, PermissionModule][] = [
  [/^\/(issues|inbox|dashboard|runs|costs)(\/|$)/, 'issues'],
  [/^\/pbi(\/|$)/, 'pbis'],
  [/^\/agents(\/|$)/, 'agents'],
  [/^\/knowledge(\/|$)/, 'brain'],
  [/^\/design(\/|$)/, 'design'],
  [/^\/spec(\/|$)/, 'specs'],
  [/^\/release-notes(\/|$)/, 'releaseNotes'],
  [/^\/TestPlan(\/|$)/, 'testplans'],
  [/^\/e2e(\/|$)/, 'e2e'],
  [/^\/integrations(\/|$)/, 'integrations'],
];

/**
 * Lists the module permissions a request needs. Reads need `view`, deletions `delete` and
 * every other write `edit`; the exceptions below are reads sent as POST, user-scoped state
 * and flows that touch a second module.
 */
export function moduleRequirements(method: string, path: string): readonly ModuleRequirement[] {
  // Masked integration settings are used by several modules (LLM providers, boards).
  if (/^\/integrations(\/|$)/.test(path) && byMethod(method) === 'view') return [];
  // The agent list feeds agent pickers in other modules (design, E2E, test plans, specs).
  if (path === '/agents' && byMethod(method) === 'view') return [];
  // Read state of the personal inbox does not change shared work items.
  if (/^\/inbox\//.test(path)) return [{ module: 'issues', operation: 'view' }];
  // Budget and rates are governed by the manageCosts workspace permission.
  if (/^\/costs(\/|$)/.test(path)) return [{ module: 'issues', operation: 'view' }];
  if (method === 'POST' && path === '/agents/default/brain-query')
    return [{ module: 'brain', operation: 'view' }];
  if (method === 'POST' && path === '/TestPlan/csv')
    return [{ module: 'testplans', operation: 'view' }];
  if (method === 'DELETE' && /^\/spec\/specifications\/[^/]+\/messages$/.test(path))
    return [{ module: 'specs', operation: 'edit' }];
  if (method === 'POST' && path === '/spec/from-knowledge')
    return [
      { module: 'specs', operation: 'edit' },
      { module: 'brain', operation: 'view' },
    ];
  if (method === 'POST' && /^\/spec\/specifications\/[^/]+\/knowledge$/.test(path))
    return [
      { module: 'specs', operation: 'view' },
      { module: 'brain', operation: 'edit' },
    ];
  if (method === 'POST' && /^\/pbi\/items\/[^/]+\/issues$/.test(path))
    return [
      { module: 'pbis', operation: 'view' },
      { module: 'issues', operation: 'edit' },
    ];
  const match = prefixes.find(([pattern]) => pattern.test(path));
  return match ? [{ module: match[1], operation: byMethod(method) }] : [];
}

export function requireModuleAccess(
  context: RequestContext | undefined,
  requirements: readonly ModuleRequirement[],
): void {
  const access = accessForContext(context);
  if (!access) return;
  const missing = requirements.find(
    (requirement) => !allows(access.modules[requirement.module], requirement.operation),
  );
  if (missing)
    throw new ApplicationError(
      'MODULE_PERMISSION_DENIED',
      `Permission ${missing.operation} on module ${missing.module} is required.`,
      403,
      [{ ...missing }],
      { ...missing },
    );
}

/** Enforces module permissions for every workspace request, before the module routers. */
export const modulePolicy: RequestHandler = (request, _response, next) => {
  try {
    requireModuleAccess(request.context, moduleRequirements(request.method, request.path));
    next();
  } catch (error) {
    next(error);
  }
};
