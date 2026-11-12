import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { STREAM_HEARTBEAT_MS } from './issues-routes.js';
import type { EventBus } from '../../modules/realtime/event-bus.js';
import { parseBody, parseQuery } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import type { Actor, DevelopmentService } from '../../modules/development/development-service.js';
import {
  ARTIFACT_KINDS,
  CHANGE_ACTIONS,
  CHANGE_FRAMEWORKS,
  DIFF_STATUSES,
  EVENT_KINDS,
  SESSION_CLIS,
  SESSION_STATUSES,
  SUBAGENT_STATUSES,
} from '../../modules/development/development.js';

/** A branch name git accepts as a plain ref: never an option, never a path trick. */
const branch = z
  .string()
  .trim()
  .min(1)
  .max(250)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..'));
/** A file path inside the repository: relative, with no way out of it. */
const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => !/^([/\\]|[A-Za-z]:)/.test(value) && !value.split(/[/\\]/).includes('..'));
const repository = z.object({
  provider: z.enum(['github', 'azure_devops']),
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(300),
  baseBranch: branch,
});
const artifact = z.object({
  id: z.string().min(1).max(100).optional(),
  kind: z.enum(ARTIFACT_KINDS),
  path: repositoryPath,
  content: z.string().max(200_000),
});
const changeFields = z.object({
  title: z.string().trim().min(1).max(240),
  slug: z.string().trim().min(1).max(80).optional(),
  summary: z.string().max(4000).optional(),
  framework: z.enum(CHANGE_FRAMEWORKS).optional(),
  artifacts: z.array(artifact).max(60).optional(),
  repository: repository.nullable().optional(),
  specificationId: z.string().min(1).max(100).nullable().optional(),
});
const changeUpdate = changeFields
  .omit({ slug: true, framework: true })
  .partial()
  .refine((data) => Object.keys(data).length > 0);
const transition = z.object({ action: z.enum(CHANGE_ACTIONS) });

const sessionFields = z.object({
  title: z.string().trim().min(1).max(240),
  prompt: z.string().trim().min(1).max(40_000),
  changeId: z.string().min(1).max(100).optional(),
  pbiItemId: z.string().min(1).max(100).optional(),
  issueId: z.string().min(1).max(100).optional(),
  cli: z.enum(SESSION_CLIS).optional(),
  agentId: z.string().min(1).max(100).optional(),
  agentIds: z.array(z.string().min(1).max(100)).max(50).optional(),
  repository: repository.optional(),
  baseBranch: branch.optional(),
  windowTokens: z.number().int().min(1000).max(10_000_000).optional(),
  compactAtPercent: z.number().int().min(10).max(100).optional(),
  maxSubagents: z.number().int().min(0).max(20).optional(),
});
const sessionsQuery = z.object({
  status: z.enum(SESSION_STATUSES).optional(),
  /** Only the sessions the caller created: what a runner may execute on its owner's computer. */
  mine: z.enum(['true', 'false']).optional(),
});
const branchesQuery = z.object({
  provider: z.enum(['github', 'azure_devops']),
  repositoryId: z.string().trim().min(1).max(300),
});
const claim = z.object({
  runner: z.string().trim().min(1).max(120),
  worktreePath: z.string().min(1).max(1000).optional(),
});
const report = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(EVENT_KINDS),
        text: z.string().min(1).max(8000),
        subagentId: z.string().min(1).max(100).optional(),
      }),
    )
    .max(100)
    .optional(),
  usedTokens: z.number().int().min(0).max(100_000_000).optional(),
  subagents: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().min(1).max(120),
        role: z.string().max(240),
        status: z.enum(SUBAGENT_STATUSES),
        summary: z.string().max(4000),
        usedTokens: z.number().int().min(0).max(100_000_000),
      }),
    )
    .max(50)
    .optional(),
  worktreePath: z.string().min(1).max(1000).optional(),
});
const diff = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(1000),
        status: z.enum(DIFF_STATUSES),
        additions: z.number().int().min(0),
        deletions: z.number().int().min(0),
        patch: z.string().max(400_000),
      }),
    )
    .max(300),
});
const complete = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  summary: z.string().max(20_000).optional(),
  error: z.string().max(4000).optional(),
});
const review = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  note: z.string().trim().min(1).max(4000).optional(),
});
const comment = z.object({
  body: z.string().trim().min(1).max(8000),
  path: z.string().min(1).max(1000).optional(),
  line: z.number().int().min(1).optional(),
  author: z.enum(['user', 'agent']).optional(),
});
const resolve = z.object({ resolved: z.boolean() });

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}
/** The module policy already checked the permission; a read-only token still may not write. */
function requireWrite(request: Request): void {
  if (request.context?.tokenScope === 'read')
    throw new ApplicationError('FORBIDDEN', 'Workspace write access is required.', 403);
}
function actor(request: Request): Actor {
  return {
    id: request.context?.actorId ?? null,
    name: request.context?.actorName ?? 'Unknown',
  };
}
const param = (request: Request, name: string) => String(request.params[name]);

export function createDevelopmentRouter(
  service: DevelopmentService,
  contextResolver?: RequestContextResolver,
  events?: EventBus,
): Router {
  const router = Router();
  if (contextResolver)
    router.use('/development', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });

  /** A read answers 200 with the body; errors go to the error middleware. */
  const read =
    (handler: (request: Request) => Promise<object>): RequestHandler =>
    async (request, response, next) => {
      try {
        response.json(await handler(request));
      } catch (error) {
        next(error);
      }
    };
  /** A write also refuses read-only tokens; `status` 204 sends no body. */
  const write =
    (handler: (request: Request) => Promise<object | void>, status = 200): RequestHandler =>
    async (request, response, next) => {
      try {
        requireWrite(request);
        const body = await handler(request);
        if (status === 204) response.status(204).end();
        else response.status(status).json(body);
      } catch (error) {
        next(error);
      }
    };

  // Server-sent events: every change or session of the workspace that moves, as it happens.
  router.get('/development/stream', requireAuth, (request, response, next) => {
    try {
      const workspace = workspaceId(request);
      if (!events)
        throw new ApplicationError('REALTIME_UNAVAILABLE', 'Live updates are not available.', 501);
      response.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        // no-transform keeps the compression middleware from buffering the stream.
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      response.write('retry: 3000\n\nevent: ready\ndata: {}\n\n');
      const unsubscribe = events.subscribe(workspace, (event) => {
        if (event.type === 'development')
          response.write(`event: development\ndata: ${JSON.stringify(event.data)}\n\n`);
      });
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), STREAM_HEARTBEAT_MS);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.on('close', close);
      response.on('error', close);
    } catch (error) {
      next(error);
    }
  });

  router.get(
    '/development/changes',
    requireAuth,
    read(async (request) => ({ changes: await service.listChanges(workspaceId(request)) })),
  );
  router.post(
    '/development/changes',
    requireAuth,
    write(
      async (request) => ({
        change: await service.createChange(
          workspaceId(request),
          parseBody(changeFields, request),
          actor(request),
        ),
      }),
      201,
    ),
  );
  router.get(
    '/development/changes/:id',
    requireAuth,
    read(async (request) => ({
      change: await service.getChange(workspaceId(request), param(request, 'id')),
    })),
  );
  router.put(
    '/development/changes/:id',
    requireAuth,
    write(async (request) => ({
      change: await service.updateChange(
        workspaceId(request),
        param(request, 'id'),
        parseBody(changeUpdate, request),
      ),
    })),
  );
  router.post(
    '/development/changes/:id/transition',
    requireAuth,
    write(async (request) => ({
      change: await service.transitionChange(
        workspaceId(request),
        param(request, 'id'),
        parseBody(transition, request).action,
        actor(request),
      ),
    })),
  );
  router.delete(
    '/development/changes/:id',
    requireAuth,
    write((request) => service.removeChange(workspaceId(request), param(request, 'id')), 204),
  );

  router.get(
    '/development/repositories',
    requireAuth,
    read((request) => service.listRepositories(workspaceId(request))),
  );
  router.get(
    '/development/repositories/branches',
    requireAuth,
    read(async (request) => {
      const query = parseQuery(branchesQuery, request);
      return {
        branches: await service.listBranches(
          workspaceId(request),
          query.provider,
          query.repositoryId,
        ),
      };
    }),
  );

  router.get(
    '/development/pipeline',
    requireAuth,
    read(async (request) => ({ stages: await service.pipeline(workspaceId(request)) })),
  );

  router.get(
    '/development/sessions',
    requireAuth,
    read(async (request) => {
      const query = parseQuery(sessionsQuery, request);
      return {
        sessions: await service.listSessions(workspaceId(request), {
          ...(query.status ? { status: query.status } : {}),
          ...(query.mine === 'true' ? { createdBy: actor(request).id } : {}),
        }),
      };
    }),
  );
  router.post(
    '/development/sessions',
    requireAuth,
    write(
      async (request) => ({
        session: await service.createSession(
          workspaceId(request),
          parseBody(sessionFields, request),
          actor(request),
        ),
      }),
      201,
    ),
  );
  router.get(
    '/development/sessions/:id',
    requireAuth,
    read(async (request) => ({
      session: await service.getSession(workspaceId(request), param(request, 'id')),
    })),
  );
  router.get(
    '/development/sessions/:id/brief',
    requireAuth,
    read((request) => service.brief(workspaceId(request), param(request, 'id'))),
  );
  router.delete(
    '/development/sessions/:id',
    requireAuth,
    write((request) => service.removeSession(workspaceId(request), param(request, 'id')), 204),
  );

  // What the runner calls while it works on a session.
  router.post(
    '/development/sessions/:id/claim',
    requireAuth,
    write(async (request) => ({
      session: await service.claim(
        workspaceId(request),
        param(request, 'id'),
        parseBody(claim, request),
      ),
    })),
  );
  router.post(
    '/development/sessions/:id/report',
    requireAuth,
    write((request) =>
      service.report(workspaceId(request), param(request, 'id'), parseBody(report, request)),
    ),
  );
  router.put(
    '/development/sessions/:id/diff',
    requireAuth,
    write(async (request) => ({
      session: await service.submitDiff(
        workspaceId(request),
        param(request, 'id'),
        parseBody(diff, request).files,
      ),
    })),
  );
  router.post(
    '/development/sessions/:id/complete',
    requireAuth,
    write(async (request) => ({
      session: await service.complete(
        workspaceId(request),
        param(request, 'id'),
        parseBody(complete, request),
      ),
    })),
  );

  // What a person decides about a session.
  router.post(
    '/development/sessions/:id/cancel',
    requireAuth,
    write(async (request) => ({
      session: await service.cancel(workspaceId(request), param(request, 'id'), actor(request)),
    })),
  );
  router.post(
    '/development/sessions/:id/retry',
    requireAuth,
    write(async (request) => ({
      session: await service.retry(workspaceId(request), param(request, 'id'), actor(request)),
    })),
  );
  router.post(
    '/development/sessions/:id/review',
    requireAuth,
    write(async (request) => ({
      session: await service.review(
        workspaceId(request),
        param(request, 'id'),
        parseBody(review, request),
        actor(request),
      ),
    })),
  );
  router.post(
    '/development/sessions/:id/comments',
    requireAuth,
    write(
      async (request) => ({
        session: await service.addComment(
          workspaceId(request),
          param(request, 'id'),
          parseBody(comment, request),
          actor(request),
        ),
      }),
      201,
    ),
  );
  router.put(
    '/development/sessions/:id/comments/:commentId',
    requireAuth,
    write(async (request) => ({
      session: await service.resolveComment(
        workspaceId(request),
        param(request, 'id'),
        param(request, 'commentId'),
        parseBody(resolve, request).resolved,
      ),
    })),
  );
  return router;
}
