import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { accessForContext, requireModuleAccess } from './module-policy.js';
import { parseBody } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import type { AgentService } from '../../modules/agents/application/agent-service.js';
import type { WorkspaceService } from '../../modules/workspaces/application/workspace-service.js';
import type { IssueStore, IssueChanges } from '../../modules/issues/issue-store.js';
import type { RunService } from '../../modules/issues/run-service.js';

const status = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
]);
const priority = z.enum(['urgent', 'high', 'medium', 'low']);
const issueFields = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(30000).optional(),
  status: status.optional(),
  priority: priority.optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
});
const issueCreateFields = issueFields.extend({ runMode: z.enum(['server', 'host']).optional() });
const updateFields = issueCreateFields
  .partial()
  .refine((value) => Object.keys(value).some((key) => key !== 'runMode'));
const commentFields = z.object({ body: z.string().trim().min(1).max(10000) });
const stateFields = z
  .object({ read: z.boolean().optional(), archived: z.boolean().optional() })
  .refine((value) => value.read !== undefined || value.archived !== undefined);
const runFields = z.object({ mode: z.enum(['server', 'host']).default('server') });
const budgetFields = z.object({ monthlyBudgetMicros: z.number().int().min(0).max(2_147_483_647) });
const rateFields = z.object({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  inputUsdPerMillion: z.number().finite().min(0).max(100_000),
  outputUsdPerMillion: z.number().finite().min(0).max(100_000),
});
const completionFields = z.object({
  output: z.string().trim().min(1).max(100_000),
  provider: z.string().trim().max(100).optional(),
  model: z.string().trim().max(200).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
});
const tokenCount = z.number().int().min(0).max(2_147_483_647);
const usageFields = z.object({
  tool: z.string().trim().min(1).max(100),
  provider: z.string().trim().min(1).max(100).default('mcp'),
  model: z.string().trim().min(1).max(200).default('unknown'),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  estimated: z.boolean().default(true),
});

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}
function actorId(request: Request): string {
  const id = request.context?.actorId;
  if (!id) throw new ApplicationError('UNAUTHORIZED', 'Authentication is required.', 401);
  return id;
}
function requireWrite(request: Request): void {
  if (request.context?.tokenScope === 'read') {
    throw new ApplicationError('FORBIDDEN', 'Workspace write access is required.', 403);
  }
  requireModuleAccess(request.context, [{ module: 'issues', operation: 'edit' }]);
}
function requireCostManager(request: Request): void {
  if (request.context?.tokenScope === 'read')
    throw new ApplicationError('FORBIDDEN', 'Workspace write access is required.', 403);
  if (!accessForContext(request.context)?.workspace.manageCosts)
    throw new ApplicationError(
      'WORKSPACE_PERMISSION_DENIED',
      'Workspace permission manageCosts is required.',
      403,
      [{ permission: 'manageCosts' }],
      { permission: 'manageCosts' },
    );
}
async function findIssue(store: IssueStore, request: Request) {
  const id = request.params['id'] as string;
  const issue = await store.get(workspaceId(request), id);
  if (!issue) throw new ApplicationError('ISSUE_NOT_FOUND', 'Issue not found.', 404);
  return issue;
}
async function validateAssignee(
  agents: AgentService,
  workspaces: WorkspaceService,
  wsId: string,
  actor: string,
  changes: IssueChanges,
): Promise<void> {
  if (changes.assigneeAgentId) await agents.getAgent(wsId, changes.assigneeAgentId);
  if (changes.assigneeUserId) {
    const members = await workspaces.listMembers(wsId, actor);
    if (!members.some((member) => member.userId === changes.assigneeUserId)) {
      throw new ApplicationError('VALIDATION_ERROR', 'Assignee must be a workspace member.', 400);
    }
  }
}

export function createIssuesRouter(
  store: IssueStore,
  agents: AgentService,
  workspaces: WorkspaceService,
  runs: RunService,
  contextResolver?: RequestContextResolver,
): Router {
  const router = Router();
  if (contextResolver)
    router.use(
      ['/issues', '/inbox', '/dashboard', '/runs', '/costs'],
      async (request, response, next) => {
        try {
          request.context = await contextResolver(request, response);
          next();
        } catch (error) {
          next(error);
        }
      },
    );

  router.get('/issues', requireAuth, async (request, response, next) => {
    try {
      response.json({ issues: await store.list(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/issues', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const { runMode, ...fields } = parseBody(issueCreateFields, request);
      await validateAssignee(agents, workspaces, workspaceId(request), actorId(request), fields);
      const issue = await store.create(workspaceId(request), actorId(request), fields);
      let automationError: string | undefined;
      let run;
      if (issue.assigneeAgentId && ['todo', 'in_progress'].includes(issue.status)) {
        try {
          run = await runs.create(issue.id, request.context!, runMode);
        } catch (error) {
          automationError = error instanceof Error ? error.message : 'Could not start agent.';
          if (!(error instanceof ApplicationError && error.code === 'ISSUE_ALREADY_RUNNING'))
            await store.update(workspaceId(request), issue.id, { status: 'blocked' });
        }
      }
      response.status(201).json({
        issue: (await store.get(workspaceId(request), issue.id)) ?? issue,
        ...(run ? { run } : {}),
        ...(automationError ? { automationError } : {}),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/issues/:id', requireAuth, async (request, response, next) => {
    try {
      const issue = await findIssue(store, request);
      response.json({ issue, comments: await store.comments(issue.id) });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/issues/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const existing = await findIssue(store, request);
      const { runMode, ...fields } = parseBody(updateFields, request);
      // Changing the responsible user does not affect a running agent.
      if (fields.status !== undefined || fields.assigneeAgentId !== undefined) {
        const active = (await runs.list(workspaceId(request), existing.id)).some((run) =>
          ['queued', 'running'].includes(run.status),
        );
        if (active)
          throw new ApplicationError(
            'ISSUE_ALREADY_RUNNING',
            'Cancel the active run before changing assignment or status.',
            409,
          );
      }
      await validateAssignee(agents, workspaces, workspaceId(request), actorId(request), {
        assigneeAgentId:
          fields.assigneeAgentId === undefined ? existing.assigneeAgentId : fields.assigneeAgentId,
        // An unchanged user stays valid even if they later left the workspace.
        assigneeUserId:
          fields.assigneeUserId === undefined || fields.assigneeUserId === existing.assigneeUserId
            ? null
            : fields.assigneeUserId,
      });
      const updated = await store.update(workspaceId(request), existing.id, fields);
      let automationError: string | undefined;
      let run;
      const shouldStart =
        updated?.assigneeAgentId &&
        ['todo', 'in_progress'].includes(updated.status) &&
        ((fields.assigneeAgentId !== undefined &&
          fields.assigneeAgentId !== existing.assigneeAgentId) ||
          (fields.status === 'todo' && existing.status !== 'todo'));
      if (shouldStart) {
        try {
          run = await runs.create(existing.id, request.context!, runMode);
        } catch (error) {
          automationError = error instanceof Error ? error.message : 'Could not start agent.';
          if (!(error instanceof ApplicationError && error.code === 'ISSUE_ALREADY_RUNNING'))
            await store.update(workspaceId(request), existing.id, { status: 'blocked' });
        }
      }
      response.json({
        issue: await store.get(workspaceId(request), existing.id),
        ...(run ? { run } : {}),
        ...(automationError ? { automationError } : {}),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/issues/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const issue = await findIssue(store, request);
      if ((await runs.list(workspaceId(request), issue.id)).length)
        throw new ApplicationError(
          'ISSUE_HAS_RUNS',
          'Issues with agent runs retain their execution and cost history.',
          409,
        );
      await store.remove(workspaceId(request), issue.id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.post('/issues/:id/comments', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const issue = await findIssue(store, request);
      const { body } = parseBody(commentFields, request);
      const comment = await store.addComment(issue.id, actorId(request), body);
      let run;
      let pending = false;
      let automationError: string | undefined = issue.assigneeAgentId
        ? undefined
        : 'Assign an agent to this issue so it can respond to comments.';
      if (issue.assigneeAgentId) {
        try {
          const previousRuns = await runs.list(workspaceId(request), issue.id);
          run = await runs.create(
            issue.id,
            request.context!,
            previousRuns[0]?.mode ?? 'server',
            comment,
          );
        } catch (error) {
          if (error instanceof ApplicationError && error.code === 'ISSUE_ALREADY_RUNNING')
            pending = true;
          else automationError = error instanceof Error ? error.message : 'Could not start agent.';
        }
      }
      response.status(201).json({
        comment,
        ...(run ? { run } : {}),
        ...(pending ? { pending: true } : {}),
        ...(automationError ? { automationError } : {}),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/inbox', requireAuth, async (request, response, next) => {
    try {
      const wsId = workspaceId(request);
      const userId = actorId(request);
      const [issues, states] = await Promise.all([
        store.list(wsId),
        store.inboxStates(wsId, userId),
      ]);
      const stateByIssue = new Map(states.map((state) => [state.issueId, state]));
      response.json({
        items: issues.map((issue) => {
          const state = stateByIssue.get(issue.id);
          return {
            issue,
            readAt: state?.readAt && state.readAt >= issue.updatedAt ? state.readAt : null,
            archivedAt:
              state?.archivedAt && state.archivedAt >= issue.updatedAt ? state.archivedAt : null,
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/inbox/:id', requireAuth, async (request, response, next) => {
    try {
      const issue = await findIssue(store, request);
      const { read, archived } = parseBody(stateFields, request);
      const userId = actorId(request);
      const current = (await store.inboxStates(workspaceId(request), userId)).find(
        (state) => state.issueId === issue.id,
      );
      const state = await store.setInboxState(issue.id, userId, {
        readAt: read === undefined ? (current?.readAt ?? null) : read ? new Date() : null,
        archivedAt:
          archived === undefined ? (current?.archivedAt ?? null) : archived ? new Date() : null,
      });
      response.json({ state });
    } catch (error) {
      next(error);
    }
  });
  router.get('/dashboard', requireAuth, async (request, response, next) => {
    try {
      const wsId = workspaceId(request);
      const [issues, agentList, agentRuns, costs] = await Promise.all([
        store.list(wsId),
        agents.listAgents(wsId),
        runs.list(wsId),
        runs.costs(wsId),
      ]);
      const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const recent = issues.filter((issue) => issue.updatedAt.getTime() >= since);
      response.json({
        agents: agentList.map((agent) => agent.toJSON()),
        recentRuns: agentRuns.slice(0, 10),
        activeRuns: agentRuns.filter((run) => ['queued', 'running'].includes(run.status)).length,
        costs: {
          monthSpendMicros: costs.monthSpendMicros,
          totalInputTokens: costs.totalInputTokens,
          totalOutputTokens: costs.totalOutputTokens,
          totalTokens: costs.totalTokens,
          monthlyBudgetMicros: costs.monthlyBudgetMicros,
          unpricedRuns: costs.unpricedRuns,
          rates: costs.rates,
          byAgent: costs.byAgent,
          mcpUsage: costs.mcpUsage,
        },
        recentIssues: issues.slice(0, 10),
        recentActivity: recent.slice(0, 10),
        totalIssues: issues.length,
        inProgress: issues.filter((issue) => issue.status === 'in_progress').length,
        open: issues.filter((issue) => !['done', 'cancelled'].includes(issue.status)).length,
        byStatus: Object.fromEntries(
          status.options.map((value) => [
            value,
            recent.filter((issue) => issue.status === value).length,
          ]),
        ),
        byPriority: Object.fromEntries(
          priority.options.map((value) => [
            value,
            recent.filter((issue) => issue.priority === value).length,
          ]),
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/runs', requireAuth, async (request, response, next) => {
    try {
      response.json({
        runs: await runs.list(
          workspaceId(request),
          typeof request.query['issueId'] === 'string' ? request.query['issueId'] : undefined,
        ),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/runs/:id', requireAuth, async (request, response, next) => {
    try {
      response.json({ run: await runs.get(workspaceId(request), request.params['id'] as string) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/issues/:id/runs', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const { mode } = parseBody(runFields, request);
      response
        .status(201)
        .json({ run: await runs.create(request.params['id'] as string, request.context!, mode) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/runs/:id/checkout', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      response.json({
        run: await runs.checkout(workspaceId(request), request.params['id'] as string),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/runs/:id/complete', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const fields = parseBody(completionFields, request);
      response.json({
        run: await runs.completeHost(workspaceId(request), request.params['id'] as string, fields),
      });
    } catch (error) {
      next(error);
    }
  });
  router.post('/runs/:id/cancel', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      response.json({
        run: await runs.cancel(workspaceId(request), request.params['id'] as string),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/costs', requireAuth, async (request, response, next) => {
    try {
      response.json(await runs.costs(workspaceId(request)));
    } catch (error) {
      next(error);
    }
  });
  // Token usage reported by MCP clients; priced with the same rate table as agent runs.
  // Any member is metered (viewers and read-only tokens consume tokens as well).
  router.post('/costs/usage', requireAuth, async (request, response, next) => {
    try {
      const fields = parseBody(usageFields, request);
      const event = await runs.recordUsage(workspaceId(request), actorId(request), fields);
      response.status(201).json({ event });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/costs/budget', requireAuth, async (request, response, next) => {
    try {
      requireCostManager(request);
      const { monthlyBudgetMicros } = parseBody(budgetFields, request);
      response.json(await runs.setBudget(workspaceId(request), monthlyBudgetMicros));
    } catch (error) {
      next(error);
    }
  });
  router.put('/costs/rates', requireAuth, async (request, response, next) => {
    try {
      requireCostManager(request);
      const fields = parseBody(rateFields, request);
      response.json({ rate: await runs.setRate({ workspaceId: workspaceId(request), ...fields }) });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/costs/rates/:provider/:model', requireAuth, async (request, response, next) => {
    try {
      requireCostManager(request);
      const removed = await runs.removeRate(
        workspaceId(request),
        request.params['provider'] as string,
        request.params['model'] as string,
      );
      if (!removed) throw new ApplicationError('RATE_NOT_FOUND', 'Cost rate not found.', 404);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
}
