import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  accessForContext,
  modulePolicy,
  moduleRequirements,
} from '../src/adapters/http/module-policy.js';
import {
  allows,
  mergeModuleAccess,
  normalizeModuleAccess,
  rank,
  resolveEffectiveAccess,
  resolveWorkspaceAccess,
} from '../src/modules/workspaces/domain/permissions.js';

describe('permissions domain', () => {
  it('treats access levels as cumulative', () => {
    expect(rank(undefined)).toBe(0);
    expect(allows('delete', 'edit')).toBe(true);
    expect(allows('edit', 'view')).toBe(true);
    expect(allows('view', 'edit')).toBe(false);
    expect(allows(undefined, 'view')).toBe(false);
  });

  it('normalizes stored maps and merges groups by highest level', () => {
    expect(normalizeModuleAccess(null)).toEqual({});
    expect(normalizeModuleAccess('x')).toEqual({});
    expect(
      normalizeModuleAccess({ pbis: 'edit', brain: 'none', agents: 'admin', other: 'view' }),
    ).toEqual({ pbis: 'edit' });
    const merged = mergeModuleAccess([{ pbis: 'view', brain: 'delete' }, { pbis: 'edit' }, {}]);
    expect(merged).toMatchObject({ pbis: 'edit', brain: 'delete', agents: 'none' });
  });

  it('resolves workspace permissions, including the legacy canManageMembers flag', () => {
    expect(resolveWorkspaceAccess('ADMIN', {})).toMatchObject({ manageGroups: true });
    expect(resolveWorkspaceAccess('MEMBER', { canManageMembers: true })).toMatchObject({
      addMembers: true,
      removeMembers: true,
      manageRoles: true,
      manageGroups: false,
    });
    expect(resolveWorkspaceAccess('VIEWER', { manageCosts: true }).manageCosts).toBe(true);
    expect(resolveEffectiveAccess('ADMIN', {}, []).modules.integrations).toBe('delete');
  });
});

describe('module policy', () => {
  it('maps requests to module operations', () => {
    expect(moduleRequirements('GET', '/pbi/items/1')).toEqual([
      { module: 'pbis', operation: 'view' },
    ]);
    expect(moduleRequirements('PATCH', '/issues/1')).toEqual([
      { module: 'issues', operation: 'edit' },
    ]);
    expect(moduleRequirements('DELETE', '/TestPlan/1')).toEqual([
      { module: 'testplans', operation: 'delete' },
    ]);
    expect(moduleRequirements('HEAD', '/e2e/creations')).toEqual([
      { module: 'e2e', operation: 'view' },
    ]);
    expect(moduleRequirements('OPTIONS', '/design/projects')).toEqual([
      { module: 'design', operation: 'view' },
    ]);
    expect(moduleRequirements('GET', '/integrations')).toEqual([]);
    expect(moduleRequirements('PUT', '/integrations/LLM/x')).toEqual([
      { module: 'integrations', operation: 'edit' },
    ]);
    expect(moduleRequirements('GET', '/agents')).toEqual([]);
    expect(moduleRequirements('GET', '/agents/a1')).toEqual([
      { module: 'agents', operation: 'view' },
    ]);
    expect(moduleRequirements('POST', '/agents')).toEqual([
      { module: 'agents', operation: 'edit' },
    ]);
    expect(moduleRequirements('PATCH', '/inbox/1')).toEqual([
      { module: 'issues', operation: 'view' },
    ]);
    expect(moduleRequirements('PUT', '/costs/rates')).toEqual([
      { module: 'issues', operation: 'view' },
    ]);
    expect(moduleRequirements('POST', '/agents/default/brain-query')).toEqual([
      { module: 'brain', operation: 'view' },
    ]);
    expect(moduleRequirements('POST', '/TestPlan/csv')).toEqual([
      { module: 'testplans', operation: 'view' },
    ]);
    expect(moduleRequirements('DELETE', '/spec/specifications/1/messages')).toEqual([
      { module: 'specs', operation: 'edit' },
    ]);
    expect(moduleRequirements('POST', '/spec/from-knowledge')).toHaveLength(2);
    expect(moduleRequirements('POST', '/spec/specifications/1/knowledge')).toContainEqual({
      module: 'brain',
      operation: 'edit',
    });
    expect(moduleRequirements('POST', '/pbi/items/1/issues')).toContainEqual({
      module: 'issues',
      operation: 'edit',
    });
    expect(moduleRequirements('GET', '/workspaces')).toEqual([]);
    expect(moduleRequirements('GET', '/pbis-other')).toEqual([]);
  });

  it('falls back to the former role defaults for contexts without resolved access', () => {
    expect(accessForContext(undefined)).toBeUndefined();
    expect(accessForContext({ requestId: 'r' })).toBeUndefined();
    expect(
      accessForContext({ requestId: 'r', memberRole: 'INTEGRATOR' })?.modules.integrations,
    ).toBe('delete');
    expect(accessForContext({ requestId: 'r', memberRole: 'MEMBER' })?.modules.integrations).toBe(
      'view',
    );
    expect(accessForContext({ requestId: 'r', memberRole: 'VIEWER' })?.modules.pbis).toBe('view');
    expect(
      accessForContext({
        requestId: 'r',
        memberRole: 'VIEWER',
        memberPermissions: { manageCosts: true },
      })?.workspace.manageCosts,
    ).toBe(true);
  });

  it('rejects requests the member groups do not allow', () => {
    const next = vi.fn();
    const context = {
      requestId: 'r',
      memberRole: 'MEMBER' as const,
      access: resolveEffectiveAccess('MEMBER', {}, [{ modules: { pbis: 'view' } }]),
    };
    modulePolicy(
      { method: 'GET', path: '/pbi', context } as unknown as Request,
      {} as Response,
      next,
    );
    expect(next).toHaveBeenLastCalledWith();
    modulePolicy(
      { method: 'POST', path: '/pbi/items', context } as unknown as Request,
      {} as Response,
      next,
    );
    expect(next).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: 'MODULE_PERMISSION_DENIED',
        statusCode: 403,
        messageParams: { module: 'pbis', operation: 'edit' },
      }),
    );
  });
});
