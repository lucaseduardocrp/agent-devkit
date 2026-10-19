import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  createAuthContextResolver,
  createAuthMiddleware,
  extractBearerToken,
  requireAuth,
} from '../src/adapters/http/auth-middleware.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import {
  resolveEffectiveAccess,
  type ModuleAccessMap,
} from '../src/modules/workspaces/domain/permissions.js';

describe('auth middleware unit tests', () => {
  it('extracts Bearer tokens correctly and ignores malformed headers', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic xyz')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer token123 extra')).toBeNull();
    expect(extractBearerToken('Bearer   my-token   ')).toBe('my-token');
    expect(extractBearerToken('bearer my-token')).toBe('my-token');
  });

  it('validates requireAuth correctly', () => {
    const nextSuccess = vi.fn();
    const reqAuthed = { user: { id: 'u1' } } as unknown as Request;
    requireAuth(reqAuthed, {} as Response, nextSuccess);
    expect(nextSuccess).toHaveBeenCalledWith();

    const reqContextAuthed = { context: { ownerId: 'u1' } } as unknown as Request;
    requireAuth(reqContextAuthed, {} as Response, nextSuccess);
    expect(nextSuccess).toHaveBeenCalledWith();

    const nextFailure = vi.fn();
    const reqUnauthed = {} as unknown as Request;
    requireAuth(reqUnauthed, {} as Response, nextFailure);
    expect(nextFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
        statusCode: 401,
      }),
    );
  });

  it('runs createAuthMiddleware attaching user or propagating error', async () => {
    const authRepo = new InMemoryAuthRepository();
    const authService = new AuthService(authRepo);
    const { token, user } = await authService.register({
      email: 'mw@example.com',
      password: 'Password123!',
      name: 'MW',
    });

    const middleware = createAuthMiddleware(authService);

    // With valid token
    const reqValid = {
      header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined),
    } as unknown as Request;
    const next1 = vi.fn();
    await middleware(reqValid, {} as Response, next1);
    expect(reqValid.user?.id).toBe(user.id);
    expect(next1).toHaveBeenCalledWith();

    // With no header
    const reqNoHeader = {
      header: () => undefined,
    } as unknown as Request;
    const next2 = vi.fn();
    await middleware(reqNoHeader, {} as Response, next2);
    expect(next2).toHaveBeenCalledWith();

    // When authenticateToken throws
    vi.spyOn(authService, 'authenticateToken').mockRejectedValueOnce(new Error('DB Failed'));
    const nextError = vi.fn();
    await middleware(reqValid, {} as Response, nextError);
    expect(nextError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('resolves request context across all requestId sources and authentication modes', async () => {
    const authRepo = new InMemoryAuthRepository();
    const authService = new AuthService(authRepo);
    const resolver = createAuthContextResolver(authService);

    const { token, user } = await authService.register({
      email: 'resolver@example.com',
      password: 'Password123!',
      name: 'Resolver',
    });

    // 1. Bearer token authenticated with response.locals.requestId
    const reqAuthed = {
      header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined),
    } as unknown as Request;
    const resWithLocals = {
      locals: { requestId: 'req-locals-1' },
      getHeader: () => undefined,
    } as unknown as Response;
    const context1 = await resolver(reqAuthed, resWithLocals);
    expect(context1.requestId).toBe('req-locals-1');
    expect(context1.ownerId).toBe(user.id);

    // 2. Bearer token authenticated with response header fallback
    const resWithHeader = {
      locals: {},
      getHeader: (name: string) => (name === 'x-request-id' ? 'req-header-2' : undefined),
    } as unknown as Response;
    const context2 = await resolver(reqAuthed, resWithHeader);
    expect(context2.requestId).toBe('req-header-2');
    expect(context2.ownerId).toBe(user.id);

    // 3. Unknown requestId fallback with legacy x-owner-id
    const reqLegacy = {
      header: (name: string) => (name === 'x-owner-id' ? 'legacy-owner' : undefined),
    } as unknown as Request;
    const resEmpty = {
      locals: {},
      getHeader: () => undefined,
    } as unknown as Response;
    const context3 = await resolver(reqLegacy, resEmpty);
    expect(context3.requestId).toBe('unknown');
    expect(context3.ownerId).toBe('legacy-owner');

    // 4. Fallback unauthenticated context
    const reqAnonymous = {
      header: () => undefined,
    } as unknown as Request;
    const context4 = await resolver(reqAnonymous, resEmpty);
    expect(context4.requestId).toBe('unknown');
    expect(context4.ownerId).toBeUndefined();
  });

  it('resolves workspace context and enforces RBAC guards', async () => {
    const authRepo = new InMemoryAuthRepository();
    const authService = new AuthService(authRepo);
    const { WorkspaceService } =
      await import('../src/modules/workspaces/application/workspace-service.js');
    const { InMemoryWorkspaceRepository } =
      await import('../src/modules/workspaces/adapters/in-memory-workspace-repository.js');
    const wsRepo = new InMemoryWorkspaceRepository();
    const wsService = new WorkspaceService(wsRepo, authRepo);

    const { requireWorkspace, requireWorkspaceRole, requireModulePermission } =
      await import('../src/adapters/http/auth-middleware.js');

    const resolver = createAuthContextResolver(authService, wsService);

    const { token } = await authService.register({
      email: 'ws-mw@example.com',
      password: 'Password123!',
      name: 'WS MW',
    });

    // 1. Without x-workspace-id header (auto-provisions default workspace)
    const reqDefault = {
      header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined),
    } as unknown as Request;
    const res = {
      locals: { requestId: 'req-1' },
      getHeader: () => undefined,
    } as unknown as Response;
    const ctxDefault = await resolver(reqDefault, res);
    expect(ctxDefault.workspaceId).toBeDefined();
    expect(ctxDefault.memberRole).toBe('ADMIN');

    // 2. With specific x-workspace-id
    const targetWsId = ctxDefault.workspaceId as string;
    const reqSpecific = {
      header: (name: string) => {
        if (name === 'authorization') return `Bearer ${token}`;
        if (name === 'x-workspace-id') return targetWsId;
        return undefined;
      },
    } as unknown as Request;
    const ctxSpecific = await resolver(reqSpecific, res);
    expect(ctxSpecific.workspaceId).toBe(targetWsId);

    // 3. requireWorkspace guard
    const nextSuccess = vi.fn();
    requireWorkspace({ context: { workspaceId: 'ws-1' } } as unknown as Request, res, nextSuccess);
    expect(nextSuccess).toHaveBeenCalledWith();

    const nextFail = vi.fn();
    requireWorkspace({ context: {} } as unknown as Request, res, nextFail);
    expect(nextFail).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKSPACE_REQUIRED' }));

    // 4. requireWorkspaceRole guard
    const adminGuard = requireWorkspaceRole(['INTEGRATOR']);
    const nextAdmin = vi.fn();
    adminGuard({ context: { memberRole: 'ADMIN' } } as unknown as Request, res, nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith();

    const nextRoleMatch = vi.fn();
    adminGuard({ context: { memberRole: 'INTEGRATOR' } } as unknown as Request, res, nextRoleMatch);
    expect(nextRoleMatch).toHaveBeenCalledWith();

    const nextNoRole = vi.fn();
    adminGuard({ context: {} } as unknown as Request, res, nextNoRole);
    expect(nextNoRole).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));

    const nextRoleMismatch = vi.fn();
    adminGuard({ context: { memberRole: 'VIEWER' } } as unknown as Request, res, nextRoleMismatch);
    expect(nextRoleMismatch).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));

    // 5. requireModulePermission guard
    expect(ctxDefault.access?.modules.brain).toBe('delete');
    const brainEditGuard = requireModulePermission('brain', 'edit');
    const withGroups = (modules: ModuleAccessMap) =>
      ({
        context: {
          memberRole: 'MEMBER',
          access: resolveEffectiveAccess('MEMBER', {}, [{ modules }]),
        },
      }) as unknown as Request;

    // Admin bypass
    const nextAdminPerm = vi.fn();
    brainEditGuard({ context: { memberRole: 'ADMIN' } } as unknown as Request, res, nextAdminPerm);
    expect(nextAdminPerm).toHaveBeenCalledWith();

    // Missing role
    const nextMissingRole = vi.fn();
    brainEditGuard({ context: {} } as unknown as Request, res, nextMissingRole);
    expect(nextMissingRole).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));

    // Legacy role-only context: VIEWER keeps its read-only default
    const nextViewer = vi.fn();
    brainEditGuard({ context: { memberRole: 'VIEWER' } } as unknown as Request, res, nextViewer);
    expect(nextViewer).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MODULE_PERMISSION_DENIED' }),
    );

    // No group grants the module
    const nextNone = vi.fn();
    brainEditGuard(withGroups({}), res, nextNone);
    expect(nextNone).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MODULE_PERMISSION_DENIED',
        messageParams: { module: 'brain', operation: 'edit' },
      }),
    );

    // View only when edit is required
    const nextViewOnly = vi.fn();
    brainEditGuard(withGroups({ brain: 'view' }), res, nextViewOnly);
    expect(nextViewOnly).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MODULE_PERMISSION_DENIED' }),
    );

    // Edit (and delete, which includes it) are allowed
    const nextAllowed = vi.fn();
    brainEditGuard(withGroups({ brain: 'edit' }), res, nextAllowed);
    brainEditGuard(withGroups({ brain: 'delete' }), res, nextAllowed);
    expect(nextAllowed).toHaveBeenCalledTimes(2);
    expect(nextAllowed).toHaveBeenCalledWith();
  });
});
