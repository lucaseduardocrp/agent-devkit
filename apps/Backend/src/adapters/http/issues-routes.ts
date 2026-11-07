import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { accessForContext, requireModuleAccess } from './module-policy.js';
import { parseBody } from './validation.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import type { AgentService } from '../../modules/agents/application/agent-service.js';
import type { WorkspaceService } from '../../modules/workspaces/application/workspace-service.js';
import type { Issue, IssueStore, IssueChanges } from '../../modules/issues/issue-store.js';
import type { RunService } from '../../modules/issues/run-service.js';
import type { EventBus } from '../../modules/realtime/event-bus.js';
import { issueNotificationData } from '../../modules/notifications/application/issue-notifications.js';
import type { NotificationService } from '../../modules/notifications/application/notification-service.js';
import type { IssueBriefService } from '../../modules/issues/agent-brief/brief-service.js';
import {
  BRIEF_EFFORTS,
  BRIEF_REFERENCE_KINDS,
} from '../../modules/issues/agent-brief/brief-types.js';
import type { E2eArtifactStore } from '../../modules/e2e/application/artifact-store.js';
import type { ImageAttachmentScope } from '../../modules/shared/image-attachment.js';
import { validateAttachments } from './attachments-routes.js';
import { fileOwner, syncItemFilesSafely } from '../../modules/shared/attachment-files.js';

/** What of an issue can reference stored files. */
const issueFiles = (issue: Pick<Issue, 'description' | 'attachments'> | null) =>
  issue && { description: issue.description, attachments: issue.attachments };

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
  attachments: z.array(z.unknown()).max(20).optional(),
  status: status.optional(),
  priority: priority.optional(),
  type: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{0,40}$/)
    .optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  proofreaderUserId: z.string().uuid().nullable().optional(),
});
const issueCreateFields = issueFields.extend({ runMode: z.enum(['server', 'host']).optional() });
const updateFields = issueCreateFields
  .partial()
  .refine((value) => Object.keys(value).some((key) => key !== 'runMode'));
const briefText = (max: number) => z.string().trim().max(max);
const briefEdits = z
  .object({
    recommendation: z.object({
      provider: briefText(100),
      model: briefText(200),
      effort: z.enum(BRIEF_EFFORTS),
      rationale: briefText(2000),
      estimatedCostUsd: z.number().finite().min(0).nullable(),
      alternatives: z
        .array(
          z.object({
            provider: briefText(100),
            model: briefText(200),
            effort: z.enum(BRIEF_EFFORTS),
            reason: briefText(500),
          }),
        )
        .max(10),
    }),
    readFirst: z
      .array(
        z.object({
          kind: z.enum(BRIEF_REFERENCE_KINDS),
          label: briefText(300),
          ref: briefText(500),
          reason: briefText(500),
          excerpt: briefText(1200).optional(),
        }),
      )
      .max(30),
    considerations: z.array(briefText(500)).max(30),
    prompt: z.object({
      system: briefText(8000),
      task: briefText(30000),
      outputFormat: briefText(2000),
    }),
    budget: z.object({
      maxInputTokens: z.number().int().min(0).max(2_000_000),
      maxOutputTokens: z.number().int().min(0).max(500_000),
    }),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
const regenerateFields = z.object({ force: z.boolean().default(false) });
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
const stepReportFields = z.object({
  nodeId: z.string().trim().min(1).max(100),
  status: z.enum(['started', 'completed']),
  summary: z.string().trim().max(2000).optional(),
});
/** Comment line that keeps proxies and load balancers from closing an idle stream. */
export const STREAM_HEARTBEAT_MS = 25_000;
const continueRunFields = z
  .object({
    action: z.enum(['approve', 'answer', 'revise']),
    answer: z.string().trim().min(1).max(10000).optional(),
  })
  .refine((value) => value.action === 'approve' || Boolean(value.answer), {
    message: 'A response is required to continue this workflow.',
    path: ['answer'],
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

/** Issue fields the brief engine reads; changing status or assignment does not regenerate it. */
const BRIEF_INPUTS = ['title', 'description', 'attachments', 'type', 'priority'] as const;

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
  if (changes.assigneeUserId || changes.proofreaderUserId) {
    const members = await workspaces.listMembers(wsId, actor);
    if (
      changes.assigneeUserId &&
      !members.some((member) => member.userId === changes.assigneeUserId)
    ) {
      throw new ApplicationError('VALIDATION_ERROR', 'Assignee must be a workspace member.', 400);
    }
    if (
      changes.proofreaderUserId &&
      !members.some((member) => member.userId === changes.proofreaderUserId)
    ) {
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Proofreader must be a workspace member.',
        400,
      );
    }
  }
}

/** Newest run of an inbox item, or the issue's last update when it has no run yet. */
function lastActivity(item: {
  issue: { updatedAt: Date };
  runs: readonly { createdAt: Date }[];
}): number {
  return new Date(item.runs[0]?.createdAt ?? item.issue.updatedAt).getTime();
}

function requireBriefs(briefs: IssueBriefService | undefined): IssueBriefService {
  if (!briefs)
    throw new ApplicationError('BRIEFS_UNAVAILABLE', 'Agent briefs are not available.', 501);
  return briefs;
}

export function createIssuesRouter(
  store: IssueStore,
  agents: AgentService,
  workspaces: WorkspaceService,
  runs: RunService,
  contextResolver?: RequestContextResolver,
  imageStore?: E2eArtifactStore,
  briefs?: IssueBriefService,
  events?: EventBus,
  notifications?: Pick<NotificationService, 'dispatch' | 'issueUrl'>,
): Router {
  /**
   * Tells the people an issue was just handed to (assignee, proofreader) when rules ask for it.
   * Not awaited: delivering can take seconds (SMTP) and must never delay or fail the request.
   */
  const announceAssignment = (
    request: Request,
    issue: Issue,
    previous: Pick<Issue, 'assigneeUserId' | 'proofreaderUserId'> | null,
  ) => {
    if (!notifications) return;
    const url = notifications.issueUrl(workspaceId(request), issue.id);
    const base = {
      workspaceId: workspaceId(request),
      actorId: actorId(request),
      data: issueNotificationData(issue),
      ...(url ? { url } : {}),
    };
    if (issue.assigneeUserId && issue.assigneeUserId !== previous?.assigneeUserId)
      void notifications.dispatch({
        ...base,
        type: 'issue.assigned',
        subjectUserId: issue.assigneeUserId,
      });
    if (issue.proofreaderUserId && issue.proofreaderUserId !== previous?.proofreaderUserId)
      void notifications.dispatch({
        ...base,
        type: 'issue.proofreader_assigned',
        subjectUserId: issue.proofreaderUserId,
      });
  };
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
      const {
        runMode,
        attachments: rawAttachments,
        ...fields
      } = parseBody(issueCreateFields, request);
      await validateAssignee(agents, workspaces, workspaceId(request), actorId(request), fields);
      const attachments =
        rawAttachments === undefined
          ? []
          : await validateAttachments(imageStore!, workspaceId(request), rawAttachments, [
              'issue',
              'pbi',
            ] satisfies readonly ImageAttachmentScope[]);
      const issue = await store.create(workspaceId(request), actorId(request), {
        ...fields,
        attachments,
      });
      await syncItemFilesSafely(
        imageStore,
        workspaceId(request),
        fileOwner('issue', issue.id),
        null,
        issueFiles(issue),
      );
      await briefs?.refresh(request.context!, issue);
      announceAssignment(request, issue, null);
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
      const { runMode, attachments: rawAttachments, ...fields } = parseBody(updateFields, request);
      const changes = {
        ...fields,
        ...(rawAttachments === undefined
          ? {}
          : {
              attachments: await validateAttachments(
                imageStore!,
                workspaceId(request),
                rawAttachments,
                ['issue', 'pbi'],
              ),
            }),
      };
      // Changing the responsible user does not affect a running agent.
      if (changes.status !== undefined || changes.assigneeAgentId !== undefined) {
        const active = (await runs.list(workspaceId(request), existing.id)).some((run) =>
          ['queued', 'running', 'waiting_review', 'waiting_input'].includes(run.status),
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
          changes.assigneeAgentId === undefined
            ? existing.assigneeAgentId
            : changes.assigneeAgentId,
        // An unchanged user stays valid even if they later left the workspace.
        assigneeUserId:
          changes.assigneeUserId === undefined || changes.assigneeUserId === existing.assigneeUserId
            ? null
            : changes.assigneeUserId,
        proofreaderUserId:
          changes.proofreaderUserId === undefined ||
          changes.proofreaderUserId === existing.proofreaderUserId
            ? null
            : changes.proofreaderUserId,
      });
      const updated = await store.update(workspaceId(request), existing.id, changes);
      if (updated) announceAssignment(request, updated, existing);
      await syncItemFilesSafely(
        imageStore,
        workspaceId(request),
        fileOwner('issue', existing.id),
        issueFiles(existing),
        issueFiles(updated),
      );
      if (updated && BRIEF_INPUTS.some((field) => changes[field] !== undefined))
        await briefs?.refresh(request.context!, updated);
      let automationError: string | undefined;
      let run;
      const shouldStart =
        updated?.assigneeAgentId &&
        ['todo', 'in_progress'].includes(updated.status) &&
        ((changes.assigneeAgentId !== undefined &&
          changes.assigneeAgentId !== existing.assigneeAgentId) ||
          (changes.status === 'todo' && existing.status !== 'todo'));
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
  router.get('/issues/:id/brief', requireAuth, async (request, response, next) => {
    try {
      const issue = await findIssue(store, request);
      response.json({ brief: (await briefs?.get(workspaceId(request), issue.id)) ?? null });
    } catch (error) {
      next(error);
    }
  });
  router.put('/issues/:id/brief', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const issue = await findIssue(store, request);
      const edits = parseBody(briefEdits, request);
      response.json({ brief: await requireBriefs(briefs).edit(request.context!, issue, edits) });
    } catch (error) {
      next(error);
    }
  });
  router.post('/issues/:id/brief/regenerate', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const issue = await findIssue(store, request);
      const { force } = parseBody(regenerateFields, request);
      response.json({
        brief: await requireBriefs(briefs).regenerate(request.context!, issue, force),
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/issues/:id', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const issue = await findIssue(store, request);
      // The store keeps the run and cost history of an issue with runs; only an active run blocks.
      const active = (await runs.list(workspaceId(request), issue.id)).some((run) =>
        ['queued', 'running', 'waiting_review', 'waiting_input'].includes(run.status),
      );
      if (active)
        throw new ApplicationError(
          'ISSUE_ALREADY_RUNNING',
          'Cancel the active run before deleting the issue.',
          409,
        );
      await store.remove(workspaceId(request), issue.id);
      await syncItemFilesSafely(
        imageStore,
        workspaceId(request),
        fileOwner('issue', issue.id),
        issueFiles(issue),
        null,
      );
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
      const [issues, states, assigned] = await Promise.all([
        store.list(wsId),
        store.inboxStates(wsId, userId),
        runs.assignedTo(wsId, userId),
      ]);
      // The inbox is private: it lists the issues with runs executed while the issue was
      // assigned to this user (only those runs), plus issues under review: the proofreader and
      // the assignee of an issue that has a proofreader both see it, even before any run.
      // Newest activity first.
      const runsByIssue = new Map<string, typeof assigned>();
      for (const run of assigned)
        runsByIssue.set(run.issueId, [...(runsByIssue.get(run.issueId) ?? []), run]);
      const stateByIssue = new Map(states.map((state) => [state.issueId, state]));
      response.json({
        items: issues
          .filter(
            (issue) =>
              runsByIssue.has(issue.id) ||
              issue.proofreaderUserId === userId ||
              (!!issue.proofreaderUserId && issue.assigneeUserId === userId),
          )
          .map((issue) => {
            const state = stateByIssue.get(issue.id);
            return {
              issue,
              runs: (runsByIssue.get(issue.id) ?? []).map((run) => ({
                id: run.id,
                agentId: run.agentId,
                status: run.status,
                attempt: run.attempt,
                createdAt: run.createdAt,
                finishedAt: run.finishedAt,
              })),
              readAt: state?.readAt && state.readAt >= issue.updatedAt ? state.readAt : null,
              archivedAt:
                state?.archivedAt && state.archivedAt >= issue.updatedAt ? state.archivedAt : null,
            };
          })
          .sort((a, b) => lastActivity(b) - lastActivity(a)),
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
        activeRuns: agentRuns.filter((run) =>
          ['queued', 'running', 'waiting_review', 'waiting_input'].includes(run.status),
        ).length,
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
  // Server-sent events: every change of a run of the workspace, as it happens. Declared before
  // /runs/:id so "stream" is not taken for a run id.
  router.get('/runs/stream', requireAuth, (request, response, next) => {
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
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
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
  router.post('/runs/:id/steps', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const report = parseBody(stepReportFields, request);
      response.json({
        run: await runs.reportStep(workspaceId(request), request.params['id'] as string, {
          nodeId: report.nodeId,
          status: report.status,
          ...(report.summary ? { summary: report.summary } : {}),
        }),
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
  router.post('/runs/:id/continue', requireAuth, async (request, response, next) => {
    try {
      requireWrite(request);
      const fields = parseBody(continueRunFields, request);
      response.json({
        run: await runs.continueWorkflow(
          workspaceId(request),
          request.params['id'] as string,
          fields,
        ),
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
