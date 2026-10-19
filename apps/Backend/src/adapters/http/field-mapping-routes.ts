import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { requireModuleAccess } from './module-policy.js';
import { parseBody, parseQuery } from './validation.js';
import type { FieldMappingStore } from '../../modules/field-mapping/field-mapping.js';
import type { RequestContextResolver } from './compatibility-routes.js';

const providerId = z.enum(['azure_devops', 'trello', 'jira', 'github_projects']);
const entityType = z.enum(['pbi', 'test_case']);
const fieldValue = z.union([
  z.string().max(30000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
  z.null(),
]);
const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('core'), key: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal('custom'), providerId, key: z.string().trim().min(1).max(200) }),
  z.object({ kind: z.literal('constant'), value: fieldValue }),
]);
const input = z.object({
  name: z.string().trim().min(1).max(200),
  entityType,
  providerId,
  scope: z.string().trim().max(200).default(''),
  itemType: z.string().trim().max(100).default(''),
  rules: z
    .array(
      z.object({
        targetFieldId: z.string().trim().min(1).max(200),
        source,
        choices: z.record(z.string().max(500), z.string().max(500)).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(200),
});

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}

export function createFieldMappingRouter(
  store: FieldMappingStore,
  contextResolver?: RequestContextResolver,
): Router {
  const router = Router();
  if (contextResolver)
    router.use('/field-mappings', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });
  router.get('/field-mappings', requireAuth, async (request, response, next) => {
    try {
      const query = parseQuery(
        z.object({ entityType, providerId: providerId.optional() }),
        request,
      );
      requireModuleAccess(request.context, [
        { module: query.entityType === 'pbi' ? 'pbis' : 'testplans', operation: 'view' },
      ]);
      response.json({
        templates: (await store.list(workspaceId(request))).filter(
          (item) =>
            item.entityType === query.entityType &&
            (!query.providerId || item.providerId === query.providerId),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/field-mappings', requireAuth, async (request, response, next) => {
    try {
      const data = parseBody(input, request);
      requireModuleAccess(request.context, [
        { module: data.entityType === 'pbi' ? 'pbis' : 'testplans', operation: 'edit' },
      ]);
      response.status(201).json({ template: await store.save(workspaceId(request), null, data) });
    } catch (error) {
      next(error);
    }
  });
  router.put('/field-mappings/:id', requireAuth, async (request, response, next) => {
    try {
      const data = parseBody(input, request);
      const current = await store.get(workspaceId(request), String(request.params['id']));
      if (!current)
        throw new ApplicationError(
          'FIELD_MAPPING_NOT_FOUND',
          'Field mapping template not found.',
          404,
        );
      requireModuleAccess(request.context, [
        { module: current.entityType === 'pbi' ? 'pbis' : 'testplans', operation: 'edit' },
      ]);
      requireModuleAccess(request.context, [
        { module: data.entityType === 'pbi' ? 'pbis' : 'testplans', operation: 'edit' },
      ]);
      response.json({
        template: await store.save(workspaceId(request), String(request.params['id']), data),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/field-mappings/:id', requireAuth, async (request, response, next) => {
    try {
      const id = String(request.params['id']);
      const template = await store.get(workspaceId(request), id);
      if (!template)
        throw new ApplicationError(
          'FIELD_MAPPING_NOT_FOUND',
          'Field mapping template not found.',
          404,
        );
      requireModuleAccess(request.context, [
        { module: template.entityType === 'pbi' ? 'pbis' : 'testplans', operation: 'edit' },
      ]);
      await store.delete(workspaceId(request), id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
}
