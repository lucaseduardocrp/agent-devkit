import { Router } from 'express';
import { z } from 'zod';
import type { SpecWorkflows } from '../../modules/spec/application/spec-workflows.js';
import type { RequestContext } from '../../shared/context.js';
import { requireAuth } from './auth-middleware.js';
import { requireModuleAccess } from './module-policy.js';
import { resolveWorkspaceId } from './agents-routes.js';
import { parseBody } from './validation.js';

/** `brain` is the access the workflow needs on the Brain besides access to the spec. */
function requireWrite(context: RequestContext, brain: 'none' | 'read' | 'write'): void {
  requireModuleAccess(context, [
    { module: 'specs', operation: brain === 'write' ? 'view' : 'edit' },
    ...(brain === 'none'
      ? []
      : [
          {
            module: 'brain' as const,
            operation: brain === 'write' ? ('edit' as const) : ('view' as const),
          },
        ]),
  ]);
}

// Mounted after createSpecRouter, which authenticates and resolves the workspace context.
export function createSpecWorkflowRouter(service: SpecWorkflows): Router {
  const router = Router();
  router.delete('/spec/specifications/:id/messages', requireAuth, async (req, res, next) => {
    try {
      requireWrite(req.context!, 'none');
      res.json(await service.clearMessages(resolveWorkspaceId(req), String(req.params.id)));
    } catch (error) {
      next(error);
    }
  });
  router.post('/spec/specifications/:id/knowledge', requireAuth, async (req, res, next) => {
    try {
      requireWrite(req.context!, 'write');
      res
        .status(201)
        .json(await service.publish(resolveWorkspaceId(req), String(req.params.id), req.context!));
    } catch (error) {
      next(error);
    }
  });
  router.post('/spec/from-knowledge', requireAuth, async (req, res, next) => {
    try {
      requireWrite(req.context!, 'read');
      const input = parseBody(
        z.object({
          pageId: z.string().min(1),
          source: z.string().min(1),
          title: z.string().trim().min(1),
          agentId: z.string().min(1),
        }),
        req,
      );
      res.status(201).json(await service.generate(resolveWorkspaceId(req), input, req.context!));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
