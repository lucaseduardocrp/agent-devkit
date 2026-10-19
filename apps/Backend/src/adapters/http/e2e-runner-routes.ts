import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { RequestContext } from '../../shared/context.js';
import { ApplicationError } from '../../shared/errors.js';
import {
  MAX_RUNNER_VIDEO_BYTES,
  type E2eLocalRunnerService,
} from '../../modules/e2e/application/local-runner-service.js';
import { requireAuth, requireModulePermission } from './auth-middleware.js';
import { parseBody, parseParams } from './validation.js';

const runnerFields = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  name: z.string().trim().min(1).max(100),
  platform: z.string().trim().min(1).max(40),
  version: z.string().trim().min(1).max(40),
});
const claimFields = z.object({
  runner: runnerFields,
  creationId: z.string().trim().min(1).max(100).optional(),
  /** Long poll: how long the request waits for work before answering `null`. */
  waitSeconds: z.number().int().min(0).max(25).default(20),
});
const heartbeatFields = z.object({ runner: runnerFields });
const message = z.string().max(20_000);
const completeFields = z.object({
  runnerId: runnerFields.shape.id,
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('run'),
      status: z.enum(['passed', 'failed']),
      durationMs: z
        .number()
        .int()
        .min(0)
        .max(24 * 60 * 60_000),
      error: message.nullable(),
      logs: z.string().max(70_000),
      steps: z
        .array(
          z.object({
            position: z.number().int().min(1).max(99),
            title: z.string().max(500),
            status: z.enum(['passed', 'failed']),
            durationMs: z
              .number()
              .int()
              .min(0)
              .max(24 * 60 * 60_000),
            error: message.nullable(),
            hasScreenshot: z.boolean(),
          }),
        )
        .max(50),
      hasVideo: z.boolean(),
    }),
    z.object({
      kind: z.literal('explore'),
      snapshot: z.looseObject({
        startUrl: z.string().max(2_000),
        pages: z.array(z.unknown()).max(20),
      }),
    }),
    z.object({
      kind: z.literal('error'),
      code: z.enum([
        'E2E_BROWSER_NOT_INSTALLED',
        'E2E_TARGET_UNREACHABLE',
        'E2E_RUNNER_FAILED',
        'E2E_SCRIPT_REJECTED',
      ]),
      message,
    }),
  ]),
});
const taskParams = z.object({ id: z.string().min(1).max(100) });
const artifactParams = taskParams.extend({ name: z.string().min(1).max(40) });

/** Every route runs requireModulePermission first, which rejects requests without a context. */
function context(request: Request): RequestContext {
  return request.context!;
}

/** Aborts when the client goes away, so an abandoned long poll stops querying. */
function disconnectSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  // The request's own 'close' fires once its body is read; the response's fires on disconnect.
  response.once('close', () => controller.abort());
  return controller.signal;
}

/**
 * Endpoints used by `devkit runner` on the user's computer. Every connection starts
 * on that computer (HTTPS long polling), so no inbound access or tunnel is needed.
 */
export function createE2eRunnerRouter(service: E2eLocalRunnerService) {
  const router = Router();
  const read = requireModulePermission('e2e', 'view');
  const write = requireModulePermission('e2e', 'edit');

  router.get('/e2e/runners', requireAuth, read, async (request, response, next) => {
    try {
      response.json({ runners: await service.runners(context(request)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/e2e/runner/claim', requireAuth, write, async (request, response, next) => {
    try {
      const { runner, creationId, waitSeconds } = parseBody(claimFields, request);
      const task = await service.claim(context(request), runner, {
        ...(creationId ? { creationId } : {}),
        waitMs: waitSeconds * 1_000,
        signal: disconnectSignal(response),
      });
      response.setHeader('cache-control', 'no-store');
      response.json({ task });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    '/e2e/runner/tasks/:id/heartbeat',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(taskParams, request);
        const { runner } = parseBody(heartbeatFields, request);
        response.json({ status: await service.heartbeat(context(request), id, runner) });
      } catch (error) {
        next(error);
      }
    },
  );

  router.put(
    '/e2e/runner/tasks/:id/artifacts/:name',
    requireAuth,
    write,
    express.raw({ type: () => true, limit: MAX_RUNNER_VIDEO_BYTES }),
    async (request, response, next) => {
      try {
        const { id, name } = parseParams(artifactParams, request);
        const runnerId = runnerFields.shape.id.safeParse(request.header('x-adk-runner-id'));
        if (!runnerId.success || !Buffer.isBuffer(request.body))
          throw new ApplicationError('E2E_INVALID_ARTIFACT', 'Invalid evidence upload.', 400);
        await service.uploadArtifact(context(request), id, runnerId.data, name, request.body);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/e2e/runner/tasks/:id/complete',
    requireAuth,
    write,
    async (request, response, next) => {
      try {
        const { id } = parseParams(taskParams, request);
        const { runnerId, outcome } = parseBody(completeFields, request);
        await service.complete(context(request), id, runnerId, outcome);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
