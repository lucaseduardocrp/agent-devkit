import { Router } from 'express';
import { z } from 'zod';
import {
  isSafeDesignFileName,
  type DesignService,
} from '../../modules/design/application/design-service.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import { resolveWorkspaceId } from './agents-routes.js';
import { parseBody } from './validation.js';

const providerSchema = z.enum(['github', 'azure']);
const imageSchema = z
  .object({
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z
      .string()
      .min(1)
      .max(7_000_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .refine((data) => Buffer.byteLength(data, 'base64') <= 5 * 1024 * 1024),
  })
  .refine(({ mimeType, data }) => {
    const bytes = Buffer.from(data, 'base64');
    if (mimeType === 'image/png')
      return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    if (mimeType === 'image/jpeg')
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mimeType === 'image/gif')
      return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    return (
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  });
export const designImagesSchema = z.array(imageSchema).max(4).optional();
const projectIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/);
const designFilesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(160).refine(isSafeDesignFileName),
      language: z.string().trim().min(1).max(40),
      content: z.string().max(500000),
    }),
  )
  .min(1)
  .max(30);
const createSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    agentId: z.string().uuid().optional(),
    prompt: z.string().trim().min(1).max(20000),
    designSystemId: projectIdSchema.optional(),
    provider: providerSchema,
    images: designImagesSchema,
    // Prototype files authored by the caller's own model (MCP host mode); skips server generation.
    files: designFilesSchema
      .refine((files) => files.some((file) => file.name === 'index.html'), {
        message: 'index.html is required.',
      })
      .optional(),
    summary: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((body) => Boolean(body.files ?? body.agentId), {
    message: 'agentId is required when files are not provided.',
    path: ['agentId'],
  });
const chatSchema = z.object({
  content: z.string().trim().min(1).max(20000),
  agentId: z.string().uuid().optional(),
  images: designImagesSchema,
});
const filesSchema = z.object({ files: designFilesSchema });
const designSystemSchema = z.object({
  id: projectIdSchema.optional(),
  name: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(100_000),
});
const generateDesignSystemSchema = z.object({
  agentId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(20_000),
  images: designImagesSchema,
});

export function createDesignRouter(
  service: DesignService,
  resolveContext: RequestContextResolver,
): Router {
  const router = Router();
  router.use('/design', async (req, res, next) => {
    try {
      req.context = await resolveContext(req, res);
      next();
    } catch (error) {
      next(error);
    }
  });
  router.get('/design/providers', requireAuth, async (req, res, next) => {
    try {
      res.json({ providers: await service.providers(resolveWorkspaceId(req)) });
    } catch (error) {
      next(error);
    }
  });
  router.get('/design/projects', requireAuth, async (req, res, next) => {
    try {
      const provider = providerSchema.parse(req.query.provider);
      res.json({ projects: await service.list(resolveWorkspaceId(req), provider) });
    } catch (error) {
      next(error);
    }
  });
  router.get('/design/projects/:id', requireAuth, async (req, res, next) => {
    try {
      const provider = providerSchema.parse(req.query.provider);
      res.json(
        await service.get(
          resolveWorkspaceId(req),
          provider,
          projectIdSchema.parse(req.params['id']),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get('/design/systems', requireAuth, async (req, res, next) => {
    try {
      res.json({
        systems: await service.listDesignSystems(
          resolveWorkspaceId(req),
          providerSchema.parse(req.query.provider),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post(
    '/design/systems/generate',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        const body = parseBody(generateDesignSystemSchema, req);
        res.json(
          await service.generateDesignSystem(
            resolveWorkspaceId(req),
            body.agentId,
            body.prompt,
            body.images,
            req.context,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.put(
    '/design/systems',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        const body = parseBody(designSystemSchema, req);
        res.json(
          await service.saveDesignSystem(
            resolveWorkspaceId(req),
            providerSchema.parse(req.query.provider),
            body,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.delete(
    '/design/systems/:id',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        await service.deleteDesignSystem(
          resolveWorkspaceId(req),
          providerSchema.parse(req.query.provider),
          projectIdSchema.parse(req.params['id']),
        );
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/design/projects',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        const body = parseBody(createSchema, req);
        res.status(201).json(await service.create(resolveWorkspaceId(req), body, req.context));
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/design/projects/:id/messages',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        const body = parseBody(chatSchema, req);
        const provider = providerSchema.parse(req.query.provider);
        res.json(
          await service.chat(
            resolveWorkspaceId(req),
            provider,
            projectIdSchema.parse(req.params['id']),
            body.content,
            body.agentId,
            body.images,
            req.context,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.put(
    '/design/projects/:id/files',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        const body = parseBody(filesSchema, req);
        const provider = providerSchema.parse(req.query.provider);
        res.json(
          await service.updateFiles(
            resolveWorkspaceId(req),
            provider,
            projectIdSchema.parse(req.params['id']),
            body.files,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  router.delete(
    '/design/projects/:id',
    requireAuth,
    requireModulePermission('design', 'edit'),
    async (req, res, next) => {
      try {
        const provider = providerSchema.parse(req.query.provider);
        await service.delete(
          resolveWorkspaceId(req),
          provider,
          projectIdSchema.parse(req.params['id']),
        );
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
