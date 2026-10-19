import { Router } from 'express';
import { z } from 'zod';
import type { SpecService } from '../../modules/spec/application/spec-service.js';
import { renderSpecificationMarkdown } from '../../modules/spec/domain/specification.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import { resolveWorkspaceId } from './agents-routes.js';
import { parseBody } from './validation.js';
import { ApplicationError } from '../../shared/errors.js';

const sectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  guidance: z.string().optional(),
  required: z.boolean(),
});
const templateSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1),
  sections: z.array(sectionSchema),
});
const specificationSectionSchema = z.object({
  templateSectionId: z.string(),
  title: z.string().trim().min(1),
  content: z.string(),
});
const specificationSchema = z.object({
  id: z.string().optional(),
  templateId: z.string().optional(),
  agentId: z.string().optional(),
  parentId: z.string().optional(),
  title: z.string().trim().min(1),
  sections: z.array(specificationSectionSchema),
});
const chatSchema = z.object({ agentId: z.string().min(1), content: z.string().trim().min(1) });
const hostChatSchema = z.object({
  userMessage: z.string().trim().min(1).max(20_000),
  assistantMessage: z.string().trim().min(1).max(100_000),
});

function requireTemplateManager(role: string | undefined): void {
  if (role !== 'ADMIN') {
    throw new ApplicationError(
      'SPEC_TEMPLATE_FORBIDDEN',
      'Apenas gestores podem personalizar templates.',
      403,
    );
  }
}

export function createSpecRouter(
  service: SpecService,
  contextResolver?: RequestContextResolver,
): Router {
  const router = Router();
  if (contextResolver)
    router.use('/spec', async (req, res, next) => {
      try {
        req.context = await contextResolver(req, res);
        next();
      } catch (error) {
        next(error);
      }
    });
  router.get('/spec/templates', requireAuth, async (req, res, next) => {
    try {
      res.json(await service.listTemplates(resolveWorkspaceId(req)));
    } catch (error) {
      next(error);
    }
  });
  router.post('/spec/templates', requireAuth, async (req, res, next) => {
    try {
      requireTemplateManager(req.context?.memberRole);
      res
        .status(201)
        .json(await service.saveTemplate(resolveWorkspaceId(req), parseBody(templateSchema, req)));
    } catch (error) {
      next(error);
    }
  });
  router.put('/spec/templates/:id', requireAuth, async (req, res, next) => {
    try {
      requireTemplateManager(req.context?.memberRole);
      const body = parseBody(templateSchema.omit({ id: true }), req);
      res.json(
        await service.saveTemplate(resolveWorkspaceId(req), {
          ...body,
          id: String(req.params.id),
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.delete('/spec/templates/:id', requireAuth, async (req, res, next) => {
    try {
      requireTemplateManager(req.context?.memberRole);
      await service.deleteTemplate(resolveWorkspaceId(req), String(req.params.id));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });
  router.get('/spec/specifications', requireAuth, async (req, res, next) => {
    try {
      res.json(await service.listSpecifications(resolveWorkspaceId(req)));
    } catch (error) {
      next(error);
    }
  });
  router.post('/spec/specifications', requireAuth, async (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          await service.saveSpecification(
            resolveWorkspaceId(req),
            parseBody(specificationSchema, req),
          ),
        );
    } catch (error) {
      next(error);
    }
  });
  router.put('/spec/specifications/:id', requireAuth, async (req, res, next) => {
    try {
      const body = parseBody(specificationSchema.omit({ id: true }), req);
      res.json(
        await service.saveSpecification(resolveWorkspaceId(req), {
          ...body,
          id: String(req.params.id),
        }),
      );
    } catch (error) {
      next(error);
    }
  });
  router.delete('/spec/specifications/:id', requireAuth, async (req, res, next) => {
    try {
      await service.deleteSpecification(resolveWorkspaceId(req), String(req.params.id));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });
  router.post('/spec/specifications/:id/chat', requireAuth, async (req, res, next) => {
    try {
      const body = parseBody(chatSchema, req);
      res.json(
        await service.chat(
          resolveWorkspaceId(req),
          String(req.params.id),
          body.agentId,
          body.content,
          req.context?.locale,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/spec/specifications/:id/chat/host',
    requireAuth,
    requireModulePermission('specs', 'edit'),
    async (req, res, next) => {
      try {
        res.json(
          await service.saveHostChatReply(
            resolveWorkspaceId(req),
            String(req.params.id),
            parseBody(hostChatSchema, req),
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/spec/specifications/:id/export', requireAuth, async (req, res, next) => {
    try {
      const spec = await service.getSpecification(resolveWorkspaceId(req), String(req.params.id));
      res
        .type('text/markdown')
        .attachment(`${spec.title}.md`)
        .send(renderSpecificationMarkdown(spec));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
