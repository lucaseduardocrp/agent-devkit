import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthService } from '../../modules/identity/application/auth-service.js';
import type { UserEntity } from '../../modules/identity/application/auth-repository.js';
import type { WorkspaceService } from '../../modules/workspaces/application/workspace-service.js';
import type { WorkspaceRole } from '../../modules/workspaces/domain/workspace-entity.js';
import type {
  ModuleOperation,
  PermissionModule,
} from '../../modules/workspaces/domain/permissions.js';
import { requireModuleAccess } from './module-policy.js';
import { ApplicationError } from '../../shared/errors.js';
import type { RequestContext } from '../../shared/context.js';
import { resolveLocale } from '../../shared/i18n.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserEntity;
      context?: RequestContext;
    }
  }
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length === 2 && parts[0]?.toLowerCase() === 'bearer' && parts[1]) {
    return parts[1];
  }

  return null;
}

export function createAuthContextResolver(
  authService: AuthService,
  workspaceService?: WorkspaceService,
): (request: Request, response: Response) => Promise<RequestContext> {
  return async (request: Request, response: Response): Promise<RequestContext> => {
    const requestId =
      typeof response.locals.requestId === 'string'
        ? response.locals.requestId
        : typeof response.getHeader('x-request-id') === 'string'
          ? (response.getHeader('x-request-id') as string)
          : 'unknown';

    const locale = resolveLocale(request.header('x-locale') ?? request.header('accept-language'));

    const token = extractBearerToken(request.header('authorization'));
    if (token) {
      const authenticated = await authService.authenticate(token);
      if (authenticated) {
        const { user } = authenticated;
        request.user = user;
        const requestedWorkspaceId = request.header('x-workspace-id');

        let workspaceId: string | undefined;
        let memberRole: WorkspaceRole | undefined;
        let memberPermissions = undefined;
        let access = undefined;

        if (workspaceService) {
          const membership = requestedWorkspaceId
            ? await workspaceService.getWorkspace(requestedWorkspaceId, user.id)
            : await workspaceService.ensureDefaultWorkspace({
                id: user.id,
                name: user.name,
                email: user.email,
              });
          workspaceId = membership.workspace.id;
          memberRole = membership.member.role;
          memberPermissions = membership.member.permissions;
          access = membership.access;
        }

        const context: RequestContext = {
          requestId,
          actorId: user.id,
          actorName: user.name,
          actorEmail: user.email,
          ownerId: workspaceId ?? user.id,
          workspaceId,
          memberRole,
          memberPermissions,
          access,
          locale,
          tokenKind: authenticated.kind,
          tokenScope: authenticated.scope,
        };
        request.context = context;
        return context;
      }
    }

    const legacyOwnerId = request.header('x-owner-id');
    if (legacyOwnerId) {
      const context: RequestContext = {
        requestId,
        actorId: legacyOwnerId,
        ownerId: legacyOwnerId,
        locale,
      };
      request.context = context;
      return context;
    }

    const fallbackContext: RequestContext = { requestId, locale };
    request.context = fallbackContext;
    return fallbackContext;
  };
}

export function requireAuth(request: Request, _response: Response, next: NextFunction): void {
  if (!request.user && !request.context?.ownerId) {
    next(new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401));
    return;
  }
  next();
}

export function requireWorkspace(request: Request, _response: Response, next: NextFunction): void {
  if (!request.context?.workspaceId) {
    next(new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400));
    return;
  }
  next();
}

export function requireWorkspaceRole(allowedRoles: readonly WorkspaceRole[]): RequestHandler {
  return (request, _response, next) => {
    const role = request.context?.memberRole;
    if (!role) {
      next(new ApplicationError('FORBIDDEN', 'Workspace membership required.', 403));
      return;
    }

    if (role === 'ADMIN' || allowedRoles.includes(role)) {
      next();
      return;
    }

    next(
      new ApplicationError(
        'FORBIDDEN',
        `Acesso negado. Esta ação requer permissão: ${allowedRoles.join(', ')}.`,
        403,
      ),
    );
  };
}

/** Route-level guard for routers that can be mounted outside createApp's module policy. */
export function requireModulePermission(
  module: PermissionModule,
  operation: ModuleOperation,
): RequestHandler {
  return (request, _response, next) => {
    if (!request.context?.memberRole) {
      next(new ApplicationError('FORBIDDEN', 'Workspace membership required.', 403));
      return;
    }
    try {
      requireModuleAccess(request.context, [{ module, operation }]);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createAuthMiddleware(authService: AuthService): RequestHandler {
  return async (request, _response, next) => {
    const token = extractBearerToken(request.header('authorization'));
    if (token) {
      try {
        const user = await authService.authenticateToken(token);
        if (user) {
          request.user = user;
        }
      } catch (error) {
        next(error);
        return;
      }
    }
    next();
  };
}
