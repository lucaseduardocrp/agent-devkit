import { Router, type Request } from 'express';
import { z } from 'zod';
import type {
  AgentService,
  AgentStreamEvent,
} from '../../modules/agents/application/agent-service.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireAuth } from './auth-middleware.js';
import { ApplicationError, toErrorResponse } from '../../shared/errors.js';
import type { SupportedLocale } from '../../shared/i18n.js';
import { parseBody } from './validation.js';
import {
  MAX_AGENT_SKILLS,
  type AgentRole,
  type AgentSkill,
} from '../../modules/agents/domain/agent-entity.js';
import { AGENT_WORKFLOW_MAX_DELAY_MINUTES } from '../../modules/agents/domain/agent-workflow.js';
import type { HubAgentService } from '../../modules/hub/application/hub-agent-service.js';
import { registerHubAgentRoutes } from './hub-agents-routes.js';

const agentRoleEnum = z.enum(['QA', 'DOCUMENTATION', 'REFACTOR', 'CUSTOM']);

/** ADK Hub skill names; the server reads each SKILL.md from the hub. */
const skillNames = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use the hub skill name, e.g. test-design.')
      .max(64),
  )
  .max(MAX_AGENT_SKILLS);

const createAgentSchema = z.object({
  name: z.string().trim().min(1, 'Nome do agente é obrigatório.').max(100),
  parentAgentId: z.string().uuid().nullable().optional(),
  slug: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  role: agentRoleEnum.optional(),
  instructions: z.string().trim().min(1, 'Instruções (.md) são obrigatórias.'),
  model: z.string().trim().optional(),
  temperature: z.number().min(0).max(2).optional(),
  isDefault: z.boolean().optional(),
  skills: skillNames.optional(),
});

const updateAgentSchema = z.object({
  parentAgentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  slug: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(500).optional(),
  role: agentRoleEnum.optional(),
  instructions: z.string().trim().min(1).optional(),
  model: z.string().trim().optional(),
  temperature: z.number().min(0).max(2).optional(),
  isDefault: z.boolean().optional(),
  /** The full list of skills the agent uses; the ones it already has keep their copy. */
  skills: skillNames.optional(),
  /** Skills to read again from the hub, to bring them to the current version. */
  refreshSkills: skillNames.optional(),
});

const executeAgentSchema = z.object({
  prompt: z.string().trim().min(1, 'Prompt de execução é obrigatório.'),
  includeKnowledge: z.boolean().optional(),
  useKnowledge: z
    .boolean()
    .optional()
    .transform((value) => value),
  llmProvider: z.string().trim().min(1).optional(),
});

const chatAgentSchema = executeAgentSchema.extend({
  /** Earlier turns, oldest first; the server uses the last few. */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(20_000),
      }),
    )
    .max(40)
    .optional(),
});

const STREAM_HEARTBEAT_MS = 15_000;

const brainQuerySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  history: z.string().trim().max(8000).optional(),
});

/** The modules a rule or an action node can cover. */
const workflowNotificationSchema = z.object({
  channels: z.array(z.string().trim().min(1).max(50)).max(10).default([]),
  userIds: z.array(z.string().uuid()).max(50).default([]),
  roles: z
    .array(z.enum(['assignee', 'proofreader']))
    .max(2)
    .default([]),
  subject: z.string().max(200).default(''),
  message: z.string().max(5000).default(''),
});

const workflowToolsetSchema = z.enum([
  'all',
  'agents',
  'integrations',
  'brain',
  'issues',
  'pbi',
  'spec',
  'testplans',
  'design',
  'e2e',
  'releasenotes',
  'development',
  'integrationtests',
  'loadtests',
  'audit',
  'workspaces',
  'notifications',
]);

const agentWorkflowSchema = z.object({
  enabled: z.boolean(),
  autonomy: z.enum(['supervised', 'balanced', 'autonomous']).default('balanced'),
  finalReview: z.boolean().default(true),
  uncertaintyBehavior: z.enum(['ask', 'assume']).default('ask'),
  issueCreationBehavior: z.enum(['ask', 'allow']).default('ask'),
  defaultAction: z.enum(['allow', 'deny']).default('allow'),
  rules: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(100),
        toolset: workflowToolsetSchema,
        toolName: z
          .string()
          .trim()
          .regex(/^[a-z][a-z0-9_]{2,63}$/)
          .optional(),
        effect: z.enum(['allow', 'deny']).default('allow'),
        allowedProviders: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
        createIssueForAction: z.boolean().optional(),
        requireApproval: z.boolean().optional(),
      }),
    )
    .max(100)
    .default([]),
  steps: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(100),
        name: z.string().trim().min(1).max(100),
        agentId: z.string().uuid().optional(),
        instructions: z.string().trim().min(1).max(10000),
        reviewRequired: z.boolean().optional(),
      }),
    )
    .max(20),
  // The editor's flow: the layout, the trigger and the nodes the runner walks. `steps` stays
  // beside it as the plain ordered list, so a reader that predates the canvas still works.
  canvas: z
    .object({
      nodes: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(100),
            // `start` is the name the trigger node had before triggers were configurable.
            kind: z
              .enum([
                'start',
                'trigger',
                'step',
                'approval',
                'action',
                'condition',
                'delay',
                'rule',
              ])
              .transform((kind) => (kind === 'start' ? ('trigger' as const) : kind)),
            x: z.number().finite(),
            y: z.number().finite(),
            trigger: z
              .object({
                kind: z.enum(['issue-assigned', 'product-event', 'schedule']),
                events: z
                  .array(z.enum(['pbi.created', 'pbi.moved', 'spec.published', 'issue.commented']))
                  .max(10)
                  .optional(),
                cron: z.string().trim().min(1).max(120).optional(),
              })
              .optional(),
            action: z
              .object({
                toolset: workflowToolsetSchema,
                toolName: z
                  .string()
                  .trim()
                  .regex(/^[a-z][a-z0-9_]{2,63}$/)
                  .optional(),
                provider: z.string().trim().min(1).max(100).optional(),
                notification: workflowNotificationSchema.optional(),
              })
              .optional(),
            condition: z
              .object({
                operator: z.enum(['contains', 'not-contains', 'matches']),
                value: z.string().max(500),
              })
              .optional(),
            delay: z
              .object({ minutes: z.number().finite().min(0).max(AGENT_WORKFLOW_MAX_DELAY_MINUTES) })
              .optional(),
          }),
        )
        .max(100),
      edges: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(100),
            from: z.string().trim().min(1).max(100),
            fromPort: z.enum(['true', 'false']).optional(),
            to: z.string().trim().min(1).max(100),
          }),
        )
        .max(400),
    })
    .optional(),
});

export function resolveWorkspaceId(request: Request): string {
  const wsId =
    request.context?.workspaceId ?? request.header('x-workspace-id') ?? request.context?.ownerId;

  if (!wsId || !wsId.trim()) {
    throw new ApplicationError('INVALID_WORKSPACE', 'Workspace ID é obrigatório.', 400);
  }
  return wsId.trim();
}

export function createAgentsRouter(
  agentService: AgentService,
  contextResolver?: RequestContextResolver,
  hubAgents?: HubAgentService,
): Router {
  const router = Router();

  if (contextResolver) {
    router.use('/agents', async (req, res, next) => {
      try {
        req.context = await contextResolver(req, res);
        next();
      } catch (err) {
        next(err);
      }
    });
  }

  // Before /agents/:id, so /agents/hub is not read as an agent id.
  if (hubAgents) registerHubAgentRoutes(router, hubAgents, resolveWorkspaceId);

  // Skills come from the ADK Hub: without it, an agent can only keep the skills it has.
  const resolveSkills = async (
    names: readonly string[],
    current: readonly AgentSkill[] = [],
    refresh: readonly string[] = [],
  ): Promise<AgentSkill[]> => {
    if (hubAgents) return hubAgents.resolveSkills(names, current, refresh);
    if (refresh.length === 0 && names.every((name) => current.some((s) => s.name === name))) {
      return names.map((name) => current.find((skill) => skill.name === name)!);
    }
    throw new ApplicationError(
      'HUB_UNAVAILABLE',
      'Skills come from the ADK Hub, which this server does not use.',
      503,
    );
  };

  router.get('/agents', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const role = typeof req.query.role === 'string' ? (req.query.role as AgentRole) : undefined;
      const agents = await agentService.listAgents(workspaceId, role);
      res.status(200).json({ agents: agents.map((a) => a.toJSON()) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/agents/workflow', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const workflow = await agentService.getWorkflow(workspaceId);
      const steps = await Promise.all(
        workflow.steps.map(async (step) => {
          if (!step.agentId) return step;
          let agent;
          try {
            agent = await agentService.getAgent(workspaceId, step.agentId);
          } catch (error) {
            if (error instanceof ApplicationError && error.code === 'AGENT_NOT_FOUND') return step;
            throw error;
          }
          return {
            ...step,
            agent: {
              id: agent.id,
              name: agent.name,
              role: agent.role,
              instructions: agent.instructions,
            },
          };
        }),
      );
      res.status(200).json({ workflow: { ...workflow, steps } });
    } catch (err) {
      next(err);
    }
  });

  router.put('/agents/workflow', requireAuth, async (req, res, next) => {
    try {
      const workflow = parseBody(agentWorkflowSchema, req);
      const saved = await agentService.setWorkflow(resolveWorkspaceId(req), workflow);
      res.status(200).json({ workflow: saved });
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const { skills, ...body } = parseBody(createAgentSchema, req);
      const created = await agentService.createAgent(workspaceId, {
        ...body,
        ...(skills ? { skills: await resolveSkills(skills) } : {}),
      });
      res.status(201).json({ agent: created.toJSON() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/agents/:id', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const agentId = req.params['id'] as string;
      const agent = await agentService.getAgent(workspaceId, agentId);
      res.status(200).json({ agent: agent.toJSON() });
    } catch (err) {
      next(err);
    }
  });

  router.put('/agents/:id', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const agentId = req.params['id'] as string;
      const { skills, refreshSkills, ...body } = parseBody(updateAgentSchema, req);
      let resolved: AgentSkill[] | undefined;
      if (skills || refreshSkills) {
        const current = (await agentService.getAgent(workspaceId, agentId)).skills;
        resolved = await resolveSkills(
          skills ?? current.map((skill) => skill.name),
          current,
          refreshSkills,
        );
      }
      const updated = await agentService.updateAgent(workspaceId, agentId, {
        ...body,
        ...(resolved ? { skills: resolved } : {}),
      });
      res.status(200).json({ agent: updated.toJSON() });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/agents/:id', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const agentId = req.params['id'] as string;
      await agentService.deleteAgent(workspaceId, agentId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/default/brain-query', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const body = parseBody(brainQuerySchema, req);
      const agents = await agentService.listAgents(workspaceId);
      const agent =
        agents.find((item) => item.isDefault) ??
        agents.find((item) => item.role === 'DOCUMENTATION') ??
        agents[0];
      if (!agent)
        throw new ApplicationError(
          'BRAIN_AGENT_NOT_CONFIGURED',
          'No default agent is configured for this workspace.',
          404,
        );
      const result = await agentService.askBrain(
        workspaceId,
        agent.id,
        {
          prompt: body.history
            ? `Conversa temporária:\n${body.history}\n\nPergunta atual:\n${body.prompt}`
            : body.prompt,
          knowledgeQuery: body.prompt,
          ...(body.history ? { knowledgeHistory: body.history } : {}),
        },
        req.context,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/:id/execute', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const agentId = req.params['id'] as string;
      const body = parseBody(executeAgentSchema, req);
      const result = await agentService.executeAgent(
        workspaceId,
        agentId,
        {
          prompt: body.prompt,
          includeKnowledge: body.includeKnowledge ?? body.useKnowledge,
          llmProvider: body.llmProvider,
        },
        req.context,
      );
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // Server-sent events: the agent's answer as the model writes it. Works the same whether the
  // workspace's LLM is an API key or a provider CLI, because both sit behind `LlmPort`.
  //   event: start  data: { agent, provider }
  //   event: delta  data: { text }
  //   event: done   data: { result, agent, provider, model?, usage? }  (the verified answer)
  //   event: error  data: { code, message }
  router.post('/agents/:id/chat', requireAuth, async (req, res, next) => {
    // The client leaving must stop the model (and kill a CLI process), not let it run to the end.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    // Pull the first event before the headers go out: a failure to start (bad agent, no LLM,
    // blocked prompt) is then an ordinary JSON error with its real status code.
    let events: AsyncGenerator<AgentStreamEvent>;
    let first: IteratorResult<AgentStreamEvent>;
    try {
      const body = parseBody(chatAgentSchema, req);
      events = agentService.streamAgent(
        resolveWorkspaceId(req),
        req.params['id'] as string,
        {
          prompt: body.prompt,
          includeKnowledge: body.includeKnowledge ?? body.useKnowledge,
          llmProvider: body.llmProvider,
          ...(body.history ? { history: body.history } : {}),
        },
        req.context,
        controller.signal,
      );
      first = await events.next();
    } catch (err) {
      next(err);
      return;
    }

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform keeps the compression middleware from buffering the stream.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (type: string, data: unknown): void => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const emit = (event: AgentStreamEvent): void => {
      if (event.type === 'start') send('start', { agent: event.agent, provider: event.provider });
      else if (event.type === 'delta') send('delta', { text: event.text });
      else send('done', event.response);
    };
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), STREAM_HEARTBEAT_MS);
    try {
      // The generator yields `start` first or throws, so a finished first step cannot happen.
      emit(first.value as AgentStreamEvent);
      for await (const event of events) emit(event);
    } catch (error) {
      if (!controller.signal.aborted) {
        // The same translated, detail-free message an ordinary JSON error would carry.
        const failure = toErrorResponse(
          error,
          res.locals['requestId'] as string,
          res.locals['locale'] as SupportedLocale | undefined,
        );
        if (!(error instanceof ApplicationError))
          console.error('[AgentChat] stream failed:', error);
        send('error', { code: failure.code, message: failure.message });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });

  return router;
}
