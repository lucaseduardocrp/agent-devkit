import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { requireModuleAccess } from './module-policy.js';
import { parseBody, parseParams, parseQuery } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import type { PbiService } from '../../modules/pbi/pbi-service.js';
import type { IssueStore } from '../../modules/issues/issue-store.js';
import type { RunService } from '../../modules/issues/run-service.js';
import type { PbiItem } from '../../modules/pbi/pbi-store.js';
import type { WorkspaceService } from '../../modules/workspaces/application/workspace-service.js';
import type { PushAssignee } from '../../modules/pbi/push-contract.js';
import { pbiLinkTypes } from '../../modules/pbi/pbi-relations.js';

const customValue = z.union([
  z.string().max(30000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(500)).max(100),
  z.null(),
]);

const itemFields = z.object({
  kind: z.enum(['pbi', 'card']),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(30000).optional(),
  status: z.string().trim().min(1).max(100).optional(),
  parentId: z.string().uuid().nullable().optional(),
  position: z.number().finite().optional(),
  sourceData: z
    .object({
      adkPriority: z.string().max(20).optional(),
      adkAgentId: z.string().max(100).optional(),
      adkAssigneeUserId: z.string().max(100).optional(),
      adkCardType: z.string().max(100).optional(),
      customFields: z
        .record(z.string().max(100), z.record(z.string().max(200), customValue))
        .optional(),
    })
    .optional(),
});
const updateFields = itemFields
  .omit({ kind: true })
  .partial()
  .refine((data) => Object.keys(data).length > 0);
const providerIds = z.enum(['azure_devops', 'trello', 'github_projects', 'jira']);
const contractValues = z.record(z.string().max(100), z.string().max(500));
const pushFields = z.object({
  providerId: providerIds,
  boardId: z.string().trim().max(200).optional(),
  listId: z.string().trim().max(200).optional(),
  issueType: z.string().trim().max(100).optional(),
  fields: contractValues.optional(),
  templateId: z.string().uuid().optional(),
});
const contractFields = z.object({ providerId: providerIds, values: contractValues.optional() });
const relationFields = z.object({
  type: z.enum(pbiLinkTypes),
  targetIds: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
});
const issueFields = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  runMode: z.enum(['server', 'host']).optional(),
});
const searchFields = z.object({
  externalId: z.string().trim().min(1).max(200).optional(),
  providerId: z.enum(['azure_devops', 'trello', 'github_projects', 'jira']).optional(),
  iterationPath: z.string().trim().min(1).max(500).optional(),
  compact: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}
function requireWrite(request: Request, module: 'pbis' | 'issues' = 'pbis'): void {
  if (request.context?.tokenScope === 'read')
    throw new ApplicationError('FORBIDDEN', 'Workspace write access is required.', 403);
  requireModuleAccess(request.context, [{ module, operation: 'edit' }]);
}
async function validateAssignee(
  workspaces: WorkspaceService | undefined,
  request: Request,
  sourceData: { adkAssigneeUserId?: string } | undefined,
  current?: PbiItem,
): Promise<void> {
  const userId = sourceData?.adkAssigneeUserId;
  // Unchanged assignments stay valid even if that user later left the workspace.
  if (!userId || !workspaces || current?.sourceData['adkAssigneeUserId'] === userId) return;
  const actorId = request.context?.actorId;
  if (!actorId) throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
  const members = await workspaces.listMembers(workspaceId(request), actorId);
  if (!members.some((member) => member.userId === userId))
    throw new ApplicationError('VALIDATION_ERROR', 'Assignee must be a workspace member.', 400);
}
/** The ADK assignee of an item as name and email, used to find the matching provider account. */
async function itemAssignee(
  workspaces: WorkspaceService | undefined,
  request: Request,
  item: PbiItem,
): Promise<PushAssignee | null> {
  const userId = item.sourceData['adkAssigneeUserId'];
  if (typeof userId !== 'string' || !userId || !workspaces) return null;
  const members = await workspaces.listMembers(workspaceId(request), request.context!.actorId!);
  const user = members.find((member) => member.userId === userId)?.user;
  return user ? { name: user.name, email: user.email } : { name: userId, email: '' };
}
function descendants(items: PbiItem[], parentId: string): PbiItem[] {
  return items
    .filter((item) => item.parentId === parentId)
    .flatMap((item) => [item, ...descendants(items, item.id)]);
}
export function createPbiRouter(
  service: PbiService,
  issues: IssueStore,
  runs: RunService,
  contextResolver?: RequestContextResolver,
  workspaces?: WorkspaceService,
): Router {
  const router = Router();
  if (contextResolver)
    router.use('/pbi', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });
  router.get('/pbi', requireAuth, async (request, response, next) => {
    try {
      if (Object.keys(request.query).length) {
        const { compact, ...options } = parseQuery(searchFields, request);
        const result = await service.search(workspaceId(request), options);
        response.json(
          compact
            ? {
                ...result,
                items: result.items.map((item) => ({
                  id: item.id,
                  parentId: item.parentId,
                  kind: item.kind,
                  title: item.title,
                  status: item.status,
                  iterationPath: item.sourceData.iterationPath ?? null,
                  links: item.links.map(({ providerId, externalId, externalUrl }) => ({
                    providerId,
                    externalId,
                    externalUrl,
                  })),
                })),
              }
            : result,
        );
      } else {
        response.json({ items: await service.list(workspaceId(request)) });
      }
    } catch (error) {
      next(error);
    }
  });
  router.get('/pbi/providers', requireAuth, async (request, response, next) => {
    try {
      response.json({ providers: await service.availableProviders(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });
  router.get('/pbi/field-catalog', requireAuth, async (request, response, next) => {
    try {
      const query = parseQuery(
        z.object({
          providerId: providerIds,
          scope: z.string().max(200).optional(),
          itemType: z.string().max(100).optional(),
        }),
        request,
      );
      response.json({
        fields: await service.fieldCatalog(
          workspaceId(request),
          query.providerId,
          query.scope,
          query.itemType,
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/pbi/current-iteration', requireAuth, async (request, response, next) => {
    try {
      response.json({ currentIteration: await service.currentIteration(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/pull', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const { summaryOnly } = parseQuery(
        z.object({ summaryOnly: z.enum(['true']).optional() }),
        request,
      );
      response.json(
        summaryOnly
          ? await service.pull(workspaceId(request), false)
          : await service.pull(workspaceId(request)),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const fields = parseBody(itemFields, request);
      await validateAssignee(workspaces, request, fields.sourceData);
      response.status(201).json({ item: await service.create(workspaceId(request), fields) });
    } catch (error) {
      next(error);
    }
  });
  router.get('/pbi/items/:id', requireAuth, async (request, response, next) => {
    try {
      response.json({
        item: await service.get(workspaceId(request), String(request.params['id'])),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/pbi/items/:id/comments', requireAuth, async (request, response, next) => {
    try {
      response.json({
        comments: await service.comments(workspaceId(request), String(request.params['id'])),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items/:id/sync-children', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      response.json({
        items: await service.syncChildren(workspaceId(request), String(request.params['id'])),
      });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/pbi/items/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const fields = parseBody(updateFields, request);
      if (fields.sourceData?.adkAssigneeUserId)
        await validateAssignee(
          workspaces,
          request,
          fields.sourceData,
          await service.get(workspaceId(request), String(request.params['id'])),
        );
      response.json({
        item: await service.update(workspaceId(request), String(request.params['id']), fields),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/pbi/items/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      await service.remove(workspaceId(request), String(request.params['id']));
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items/:id/push-contract', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const ws = workspaceId(request);
      const { providerId, values } = parseBody(contractFields, request);
      const item = await service.get(ws, String(request.params['id']));
      response.json({
        contract: await service.pushContract(
          ws,
          item.id,
          providerId,
          values,
          await itemAssignee(workspaces, request, item),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items/:id/field-preview', requireAuth, async (request, response, next) => {
    try {
      const body = parseBody(
        z.object({
          providerId: providerIds,
          templateId: z.string().uuid(),
          scope: z.string().max(200).default(''),
          itemType: z.string().max(100).default(''),
        }),
        request,
      );
      response.json(
        await service.previewFields(
          workspaceId(request),
          String(request.params['id']),
          body.providerId,
          body.templateId,
          body.scope,
          body.itemType,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items/:id/push', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const ws = workspaceId(request);
      const options = parseBody(pushFields, request);
      const item = await service.get(ws, String(request.params['id']));
      response.json(
        await service.push(ws, item.id, options, await itemAssignee(workspaces, request, item)),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get('/pbi/items/:id/relations', requireAuth, async (request, response, next) => {
    try {
      response.json({
        relations: await service.relations(workspaceId(request), String(request.params['id'])),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items/:id/relations', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const { type, targetIds } = parseBody(relationFields, request);
      response.status(201).json({
        relations: await service.addRelations(
          workspaceId(request),
          String(request.params['id']),
          type,
          targetIds,
          request.context?.actorId ?? null,
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete(
    '/pbi/items/:id/relations/:type/:targetId',
    requireAuth,
    async (request, response, next) => {
      try {
        requireWrite(request);
        const { type } = parseParams(
          z.object({ type: z.enum(pbiLinkTypes) }).passthrough(),
          request,
        );
        response.json({
          relations: await service.removeRelation(
            workspaceId(request),
            String(request.params['id']),
            type,
            String(request.params['targetId']),
          ),
        });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/pbi/items/:id/context', requireAuth, async (request, response, next) => {
    try {
      const ws = workspaceId(request);
      const root = await service.get(ws, String(request.params['id']));
      const all = await service.list(ws);
      response.json({ item: root, descendants: descendants(all, root.id) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/pbi/items/:id/issues', requireAuth, async (request, response, next) => {
    try {
      // Creating issues from a PBI only reads the PBI: it needs issues edit, not pbis edit.
      requireWrite(request, 'issues');
      const ws = workspaceId(request);
      const item = await service.get(ws, String(request.params['id']));
      const input = parseBody(issueFields, request);
      const related = descendants(await service.list(ws), item.id);
      const context = [
        item.description,
        ...related.map((child) => `- ${child.title}: ${child.description}`),
      ]
        .filter(Boolean)
        .join('\n\n');
      const issue = await issues.create(ws, request.context!.actorId!, {
        title: input.title ?? item.title,
        description: context,
        pbiItemId: item.id,
        assigneeAgentId: input.assigneeAgentId ?? null,
      });
      let automationError: string | undefined;
      let run;
      if (issue.assigneeAgentId) {
        try {
          run = await runs.create(issue.id, request.context!, input.runMode);
        } catch (error) {
          automationError =
            error instanceof Error ? error.message : 'Agent execution could not start.';
        }
      }
      response.status(201).json({
        issue: (await issues.get(ws, issue.id)) ?? issue,
        ...(run ? { run } : {}),
        ...(automationError ? { automationError } : {}),
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
