import { Router, type Request } from 'express';
import { z } from 'zod';
import type { WorkspaceService } from '../../modules/workspaces/application/workspace-service.js';
import {
  MODULE_ACCESS_LEVELS,
  type PermissionModule,
  type WorkspacePermissionKey,
} from '../../modules/workspaces/domain/permissions.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireAuth } from './auth-middleware.js';
import { ApplicationError } from '../../shared/errors.js';
import { parseBody } from './validation.js';

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Nome do workspace é obrigatório.').max(100),
  slug: z.string().trim().min(1).max(100).optional(),
});

const renameWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Nome do workspace é obrigatório.').max(100),
});

const roleSchema = z.enum(['ADMIN', 'MEMBER', 'INTEGRATOR', 'VIEWER']);

// Unknown keys (such as the legacy canManageMembers) are stripped.
const flag = z.boolean().optional();
const permissionsSchema = z.object({
  editWorkspace: flag,
  deleteWorkspace: flag,
  addMembers: flag,
  removeMembers: flag,
  manageRoles: flag,
  manageGroups: flag,
  manageCosts: flag,
} satisfies Record<WorkspacePermissionKey, typeof flag>);

const groupIdsSchema = z.array(z.string().trim().min(1).max(100)).max(100);

const addMemberSchema = z.object({
  email: z.string().trim().email('E-mail inválido.'),
  role: roleSchema,
  permissions: permissionsSchema.optional(),
  groupIds: groupIdsSchema.optional(),
});

const updateMemberSchema = z.object({
  role: roleSchema.optional(),
  permissions: permissionsSchema.optional(),
  groupIds: groupIdsSchema.optional(),
});

const level = z.enum(MODULE_ACCESS_LEVELS).optional();
const modulesSchema = z.object({
  issues: level,
  pbis: level,
  agents: level,
  brain: level,
  design: level,
  specs: level,
  releaseNotes: level,
  testplans: level,
  e2e: level,
  integrations: level,
} satisfies Record<PermissionModule, typeof level>);

const groupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  modules: modulesSchema.optional(),
  memberIds: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
});

export function requireUserId(request: Request): string {
  const userId = request.context?.actorId;
  if (!userId) {
    throw new ApplicationError('UNAUTHORIZED', 'Usuário não autenticado.', 401);
  }
  return userId;
}

export function createWorkspacesRouter(
  workspaceService: WorkspaceService,
  contextResolver: RequestContextResolver,
  auditedDelete?: (id: string, remove: () => Promise<void>) => Promise<void>,
): Router {
  const router = Router();

  router.use('/workspaces', async (request, response, next) => {
    try {
      request.context = await contextResolver(request, response);
      next();
    } catch (error) {
      next(error);
    }
  });

  router.post('/workspaces', requireAuth, async (request, response, next) => {
    try {
      const payload = parseBody(createWorkspaceSchema, request);
      const userId = requireUserId(request);
      const result = await workspaceService.createWorkspace(
        userId,
        payload.name,
        payload.slug,
        request.context?.locale,
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/workspaces', requireAuth, async (request, response, next) => {
    try {
      const userId = requireUserId(request);
      const workspaces = await workspaceService.listUserWorkspaces(userId);
      response.status(200).json(workspaces);
    } catch (error) {
      next(error);
    }
  });

  router.get('/workspaces/:id', requireAuth, async (request, response, next) => {
    try {
      const userId = requireUserId(request);
      const workspaceId = request.params['id'] as string;
      const result = await workspaceService.getWorkspace(workspaceId, userId);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/workspaces/:id', requireAuth, async (request, response, next) => {
    try {
      const payload = parseBody(renameWorkspaceSchema, request);
      const workspace = await workspaceService.renameWorkspace(
        request.params['id'] as string,
        requireUserId(request),
        payload.name,
      );
      response.status(200).json(workspace);
    } catch (error) {
      next(error);
    }
  });

  router.get('/workspaces/:id/members', requireAuth, async (request, response, next) => {
    try {
      const userId = requireUserId(request);
      const workspaceId = request.params['id'] as string;
      const members = await workspaceService.listMembers(workspaceId, userId);
      response.status(200).json(members);
    } catch (error) {
      next(error);
    }
  });

  router.post('/workspaces/:id/members', requireAuth, async (request, response, next) => {
    try {
      const payload = parseBody(addMemberSchema, request);
      const userId = requireUserId(request);
      const workspaceId = request.params['id'] as string;
      const member = await workspaceService.addMemberByEmail(
        workspaceId,
        userId,
        payload.email,
        payload.role,
        payload.permissions,
        payload.groupIds,
      );
      response.status(201).json(member);
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    '/workspaces/:id/members/:memberId',
    requireAuth,
    async (request, response, next) => {
      try {
        const payload = parseBody(updateMemberSchema, request);
        const userId = requireUserId(request);
        const workspaceId = request.params['id'] as string;
        const memberId = request.params['memberId'] as string;
        const member = await workspaceService.updateMember(
          workspaceId,
          userId,
          memberId,
          payload.role,
          payload.permissions,
          payload.groupIds,
        );
        response.status(200).json(member);
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/workspaces/:id/members/:memberId',
    requireAuth,
    async (request, response, next) => {
      try {
        const userId = requireUserId(request);
        const workspaceId = request.params['id'] as string;
        const memberId = request.params['memberId'] as string;
        await workspaceService.removeMember(workspaceId, userId, memberId);
        response.status(200).json({ success: true });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/workspaces/:id/groups', requireAuth, async (request, response, next) => {
    try {
      response
        .status(200)
        .json(
          await workspaceService.listGroups(request.params['id'] as string, requireUserId(request)),
        );
    } catch (error) {
      next(error);
    }
  });

  router.post('/workspaces/:id/groups', requireAuth, async (request, response, next) => {
    try {
      const payload = parseBody(groupSchema, request);
      response
        .status(201)
        .json(
          await workspaceService.createGroup(
            request.params['id'] as string,
            requireUserId(request),
            payload,
          ),
        );
    } catch (error) {
      next(error);
    }
  });

  router.patch('/workspaces/:id/groups/:groupId', requireAuth, async (request, response, next) => {
    try {
      const payload = parseBody(groupSchema.partial(), request);
      response
        .status(200)
        .json(
          await workspaceService.updateGroup(
            request.params['id'] as string,
            requireUserId(request),
            request.params['groupId'] as string,
            payload,
          ),
        );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/workspaces/:id/groups/:groupId', requireAuth, async (request, response, next) => {
    try {
      await workspaceService.deleteGroup(
        request.params['id'] as string,
        requireUserId(request),
        request.params['groupId'] as string,
      );
      response.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/workspaces/:id', requireAuth, async (request, response, next) => {
    try {
      const userId = requireUserId(request);
      const workspaceId = request.params['id'] as string;
      await workspaceService.deleteWorkspace(workspaceId, userId, auditedDelete);
      response.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
