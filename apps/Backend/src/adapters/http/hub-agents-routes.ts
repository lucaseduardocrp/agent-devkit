import type { Request, Router } from 'express';
import { z } from 'zod';
import type { HubAgentService } from '../../modules/hub/application/hub-agent-service.js';
import { requireAuth } from './auth-middleware.js';
import { parseBody } from './validation.js';

const hubName = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use the hub name, e.g. qa-test-designer.')
  .max(64);

const installSchema = z
  .object({ name: hubName.optional(), plugin: hubName.optional() })
  .refine((input) => input.name || input.plugin, {
    message: 'Pass the agent name, the plugin name, or both.',
  });

/**
 * ADK Hub agents in a workspace: the catalog with what is installed, installing a hub agent or a
 * plugin's subagents, and updating an installed agent. Registered by the agents router before
 * `/agents/:id` so these paths are not read as agent ids. Removing is a plain agent delete.
 */
export function registerHubAgentRoutes(
  router: Router,
  hubAgents: HubAgentService,
  workspaceOf: (request: Request) => string,
): void {
  router.get('/agents/hub', requireAuth, async (req, res, next) => {
    try {
      res.status(200).json(await hubAgents.catalog(workspaceOf(req)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/hub/install', requireAuth, async (req, res, next) => {
    try {
      const input = parseBody(installSchema, req);
      const agents = await hubAgents.install(workspaceOf(req), input);
      res.status(201).json({ agents: agents.map((agent) => agent.toJSON()) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/agents/:id/hub-update', requireAuth, async (req, res, next) => {
    try {
      const agent = await hubAgents.update(workspaceOf(req), String(req.params['id']));
      res.status(200).json({ agent: agent.toJSON() });
    } catch (err) {
      next(err);
    }
  });
}
