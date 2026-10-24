import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AgentService } from '../../modules/agents/application/agent-service.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireAuth } from './auth-middleware.js';
import { ApplicationError } from '../../shared/errors.js';
import { parseBody } from './validation.js';
import {
  MAX_AGENT_SKILLS,
  type AgentRole,
  type AgentSkill,
} from '../../modules/agents/domain/agent-entity.js';
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

const brainQuerySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  history: z.string().trim().max(8000).optional(),
});

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
        toolset: z.enum([
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
          'integrationtests',
          'loadtests',
          'audit',
          'workspaces',
        ]),
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
      const result = await agentService.executeAgent(
        workspaceId,
        agent.id,
        {
          prompt: body.history
            ? `Conversa temporária:\n${body.history}\n\nPergunta atual:\n${body.prompt}`
            : body.prompt,
          knowledgeQuery: body.prompt,
          includeKnowledge: true,
          knowledgeOnly: true,
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

  return router;
}
