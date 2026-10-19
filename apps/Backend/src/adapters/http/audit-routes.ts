import { Router } from 'express';
import { z } from 'zod';
import {
  testCaseHistory,
  type AuditEvent,
  type AuditPersistence,
  type EntityType,
} from '../../modules/audit/audit.js';
import type { PermissionModule } from '../../modules/workspaces/domain/permissions.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireOwnerId } from '../../modules/knowledge/application/ownership.js';
import { ApplicationError } from '../../shared/errors.js';
import { requireModuleAccess } from './module-policy.js';
import { parseQuery } from './validation.js';

const moduleOf: Record<EntityType, PermissionModule> = {
  document: 'brain',
  specification: 'specs',
  template: 'specs',
  testplan: 'testplans',
  testcase: 'testplans',
  pbi: 'pbis',
  issue: 'issues',
  release_note: 'releaseNotes',
};
const querySchema = z.object({
  entityType: z.enum(Object.keys(moduleOf) as [EntityType, ...EntityType[]]),
  entityId: z.string().min(1).max(4096).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
// A test case history is derived from the whole history of its plan.
const planHistoryLimit = 5000;
const planHistoryBatch = 500;

async function planEvents(
  persistence: AuditPersistence,
  workspaceId: string,
  planId: string,
): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (let offset = 0; offset < planHistoryLimit; offset += planHistoryBatch) {
    const page = await persistence.list({
      workspaceId,
      entityType: 'testplan',
      entityId: planId,
      offset,
      limit: planHistoryBatch,
    });
    events.push(...page.items);
    if (offset + planHistoryBatch >= page.total) break;
  }
  return events;
}

export function createAuditRouter(
  persistence: AuditPersistence,
  resolve: RequestContextResolver,
): Router {
  const router = Router();
  router.get('/audit/history', async (req, res, next) => {
    try {
      const context = await resolve(req, res);
      const workspaceId = requireOwnerId(context);
      const query = parseQuery(querySchema, req);
      requireModuleAccess(context, [{ module: moduleOf[query.entityType], operation: 'view' }]);
      const offset = (query.page - 1) * query.pageSize;
      let result: { items: AuditEvent[]; total: number };
      if (query.entityType === 'testcase') {
        const [planId, caseId] = query.entityId?.split(':') ?? [];
        if (!planId || !caseId)
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'entityId must be <planId>:<caseId>.',
            400,
            [{ field: 'entityId' }],
          );
        const items = testCaseHistory(await planEvents(persistence, workspaceId, planId), caseId);
        result = { items: items.slice(offset, offset + query.pageSize), total: items.length };
      } else
        result = await persistence.list({
          workspaceId,
          entityType: query.entityType,
          entityId: query.entityId,
          offset,
          limit: query.pageSize,
        });
      res.json({
        ...result,
        page: query.page,
        pageSize: query.pageSize,
        totalPages: Math.ceil(result.total / query.pageSize),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
