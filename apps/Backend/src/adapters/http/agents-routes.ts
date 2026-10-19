import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AgentService } from '../../modules/agents/application/agent-service.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { requireAuth } from './auth-middleware.js';
import { ApplicationError } from '../../shared/errors.js';
import { parseBody } from './validation.js';
import type { AgentRole } from '../../modules/agents/domain/agent-entity.js';

const agentRoleEnum = z.enum(['QA', 'DOCUMENTATION', 'REFACTOR', 'CUSTOM']);

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

  router.post('/agents', requireAuth, async (req, res, next) => {
    try {
      const workspaceId = resolveWorkspaceId(req);
      const body = parseBody(createAgentSchema, req);
      const created = await agentService.createAgent(workspaceId, body);
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
      const body = parseBody(updateAgentSchema, req);
      const updated = await agentService.updateAgent(workspaceId, agentId, body);
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
