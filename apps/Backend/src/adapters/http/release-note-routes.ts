import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { requireModuleAccess } from './module-policy.js';
import { parseBody, parseQuery } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import type { ReleaseNoteService } from '../../modules/release-notes/release-note-service.js';
import {
  fileName,
  toDocx,
  toMarkdown,
  toPdf,
} from '../../modules/release-notes/release-note-export.js';

const noteFields = z.object({
  title: z.string().trim().min(1).max(240),
  version: z.string().trim().max(100).optional(),
  content: z.string().max(200000).optional(),
  itemIds: z.array(z.string().uuid()).max(500).optional(),
});
const updateFields = noteFields.partial().refine((data) => Object.keys(data).length > 0);
const generateFields = z.object({
  title: z.string().trim().min(1).max(240),
  version: z.string().trim().max(100).optional(),
  agentId: z.string().min(1).max(100),
  itemIds: z.array(z.string().uuid()).min(1).max(300),
  instructions: z.string().max(4000).optional(),
});
const exportQuery = z.object({ format: z.enum(['markdown', 'pdf', 'docx']) });

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}
function requireWrite(request: Request): void {
  if (request.context?.tokenScope === 'read')
    throw new ApplicationError('FORBIDDEN', 'Workspace write access is required.', 403);
  requireModuleAccess(request.context, [{ module: 'releaseNotes', operation: 'edit' }]);
}
function attachment(name: string): string {
  return `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createReleaseNoteRouter(
  service: ReleaseNoteService,
  contextResolver?: RequestContextResolver,
): Router {
  const router = Router();
  if (contextResolver)
    router.use('/release-notes', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });
  router.get('/release-notes', requireAuth, async (request, response, next) => {
    try {
      response.json({ releaseNotes: await service.list(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/release-notes', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const fields = parseBody(noteFields, request);
      response.status(201).json({
        releaseNote: await service.create(workspaceId(request), {
          ...fields,
          createdBy: request.context?.actorId ?? null,
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/release-notes/generate', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      response.status(201).json({
        releaseNote: await service.generate(
          workspaceId(request),
          parseBody(generateFields, request),
          request.context!,
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/release-notes/:id', requireAuth, async (request, response, next) => {
    try {
      response.json({
        releaseNote: await service.get(workspaceId(request), String(request.params['id'])),
      });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/release-notes/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      response.json({
        releaseNote: await service.update(
          workspaceId(request),
          String(request.params['id']),
          parseBody(updateFields, request),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/release-notes/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      await service.remove(workspaceId(request), String(request.params['id']));
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.get('/release-notes/:id/export', requireAuth, async (request, response, next) => {
    try {
      const { format } = parseQuery(exportQuery, request);
      const note = await service.get(workspaceId(request), String(request.params['id']));
      if (format === 'markdown') {
        response
          .type('text/markdown; charset=utf-8')
          .setHeader('Content-Disposition', attachment(fileName(note, 'md')))
          .send(toMarkdown(note));
      } else if (format === 'pdf') {
        response
          .type('application/pdf')
          .setHeader('Content-Disposition', attachment(fileName(note, 'pdf')))
          .send(await toPdf(note));
      } else {
        response
          .type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
          .setHeader('Content-Disposition', attachment(fileName(note, 'docx')))
          .send(await toDocx(note));
      }
    } catch (error) {
      next(error);
    }
  });
  return router;
}
