import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import { resolveWorkspaceId } from './agents-routes.js';
import { parseBody } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import {
  workItemTypeColors,
  type WorkItemTypeStore,
} from '../../modules/work-item-types/work-item-types.js';

const typeSchema = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  label: z.string().trim().min(1).max(60),
  color: z.union([z.enum(workItemTypeColors), z.string().regex(/^#[0-9a-fA-F]{6}$/)]),
  icon: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,40}$/),
  aliases: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(20).default([]),
});
const bodySchema = z
  .object({ types: z.array(typeSchema).max(40) })
  .refine((value) => new Set(value.types.map((type) => type.key)).size === value.types.length, {
    message: 'Type keys must be unique.',
    path: ['types'],
  });

export function createWorkItemTypesRouter(
  store: WorkItemTypeStore,
  resolveContext: RequestContextResolver,
): Router {
  const router = Router();
  router.use('/work-item-types', async (req, res, next) => {
    try {
      req.context = await resolveContext(req, res);
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get('/work-item-types', requireAuth, async (req, res, next) => {
    try {
      res.json({ types: await store.get(resolveWorkspaceId(req)) });
    } catch (error) {
      next(error);
    }
  });
  router.put(
    '/work-item-types',
    requireAuth,
    requireModulePermission('pbis', 'edit'),
    async (req, res, next) => {
      try {
        const { types } = parseBody(bodySchema, req);
        res.json({ types: await store.save(resolveWorkspaceId(req), types) });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
