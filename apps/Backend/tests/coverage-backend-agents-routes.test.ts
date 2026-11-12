import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgentsRouter } from '../src/adapters/http/agents-routes.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { HubAgentService } from '../src/modules/hub/application/hub-agent-service.js';
import type { AgentSkill } from '../src/modules/agents/domain/agent-entity.js';
import { ApplicationError } from '../src/shared/errors.js';

const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_AGENT_ID = '33333333-3333-4333-8333-333333333333';
const GONE_AGENT_ID = '44444444-4444-4444-8444-444444444444';

const skill = (name: string): AgentSkill => ({
  name,
  description: `${name} skill`,
  instructions: 'Do it.',
  version: '1',
  revision: 'abc',
});

const agentView = (id: string, skills: AgentSkill[] = []) => ({
  id,
  name: `Agent ${id.slice(0, 2)}`,
  role: 'QA',
  instructions: 'Be careful.',
  skills,
  toJSON: () => ({ id, skills }),
});

function build(service: Partial<Record<keyof AgentService, unknown>>, hub?: HubAgentService) {
  const app = express();
  app.use(express.json());
  app.use(
    createAgentsRouter(
      service as unknown as AgentService,
      () => ({ requestId: 'r', ownerId: 'ws', workspaceId: 'ws', actorId: 'user-a' }),
      hub,
    ),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError)
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    else res.status(500).json({ code: 'INTERNAL', message: String(error) });
  });
  return app;
}

const workflow = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  rules: [],
  steps: [
    { id: 's1', name: 'Plan', instructions: 'Plan it.' },
    { id: 's2', name: 'Do', agentId: AGENT_ID, instructions: 'Do it.' },
    { id: 's3', name: 'Missing', agentId: GONE_AGENT_ID, instructions: 'Review.' },
  ],
};

describe('agents routes (coverage)', () => {
  it('lists agents of a role', async () => {
    const listAgents = vi.fn().mockResolvedValue([agentView(AGENT_ID)]);
    const app = build({ listAgents });
    expect((await request(app).get('/agents?role=QA').expect(200)).body.agents).toHaveLength(1);
    expect(listAgents).toHaveBeenLastCalledWith('ws', 'QA');
    await request(app).get('/agents').expect(200);
    expect(listAgents).toHaveBeenLastCalledWith('ws', undefined);
  });

  it('shows the workflow with the agent of each step, leaving out agents that no longer exist', async () => {
    const getAgent = vi.fn(async (_ws: string, id: string) => {
      if (id === GONE_AGENT_ID) throw new ApplicationError('AGENT_NOT_FOUND', 'Gone.', 404);
      return agentView(id);
    });
    const app = build({ getWorkflow: vi.fn().mockResolvedValue(workflow), getAgent });
    const { steps } = (await request(app).get('/agents/workflow').expect(200)).body.workflow;
    expect(steps[0]).toEqual(workflow.steps[0]);
    expect(steps[1].agent).toEqual({
      id: AGENT_ID,
      name: 'Agent 22',
      role: 'QA',
      instructions: 'Be careful.',
    });
    expect(steps[2]).toEqual(workflow.steps[2]);
  });

  it('forwards unexpected failures while loading the workflow', async () => {
    const failing = build({ getWorkflow: vi.fn().mockRejectedValue(new Error('db down')) });
    expect((await request(failing).get('/agents/workflow').expect(500)).body.message).toContain(
      'db down',
    );
    const lookup = build({
      getWorkflow: vi.fn().mockResolvedValue(workflow),
      getAgent: vi.fn().mockRejectedValue(new ApplicationError('BOOM', 'Lookup failed.', 409)),
    });
    expect((await request(lookup).get('/agents/workflow').expect(409)).body.code).toBe('BOOM');
  });

  it('saves a workflow, reading the legacy start node as the trigger', async () => {
    const setWorkflow = vi.fn(async (_ws: string, saved: unknown) => saved);
    const app = build({ setWorkflow });
    const body = {
      ...workflow,
      steps: [],
      canvas: {
        nodes: [
          { id: 'n1', kind: 'start', x: 0, y: 0 },
          { id: 'n2', kind: 'step', x: 1, y: 1 },
        ],
        edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
      },
    };
    const response = await request(app).put('/agents/workflow').send(body).expect(200);
    expect(response.body.workflow.canvas.nodes.map((node: { kind: string }) => node.kind)).toEqual([
      'trigger',
      'step',
    ]);
    const failing = build({ setWorkflow: vi.fn().mockRejectedValue(new Error('nope')) });
    await request(failing).put('/agents/workflow').send(body).expect(500);
  });

  describe('skills without the hub', () => {
    it('keeps the skills an agent already has and refuses ones it would need from the hub', async () => {
      const current = [skill('test-design'), skill('refactor')];
      const getAgent = vi.fn().mockResolvedValue(agentView(AGENT_ID, current));
      const updateAgent = vi.fn(async (_ws: string, id: string) => agentView(id));
      const app = build({ getAgent, updateAgent });

      await request(app)
        .put(`/agents/${AGENT_ID}`)
        .send({ skills: ['refactor'] })
        .expect(200);
      expect(updateAgent).toHaveBeenLastCalledWith('ws', AGENT_ID, { skills: [current[1]] });

      const unknown = await request(app)
        .put(`/agents/${AGENT_ID}`)
        .send({ skills: ['new-skill'] })
        .expect(503);
      expect(unknown.body.code).toBe('HUB_UNAVAILABLE');

      const refreshed = await request(app)
        .put(`/agents/${AGENT_ID}`)
        .send({ refreshSkills: ['refactor'] })
        .expect(503);
      expect(refreshed.body.code).toBe('HUB_UNAVAILABLE');

      const created = await request(app)
        .post('/agents')
        .send({ name: 'New', instructions: 'Work.', skills: ['anything'] })
        .expect(503);
      expect(created.body.code).toBe('HUB_UNAVAILABLE');
    });
  });

  describe('skills with the hub', () => {
    it('reads skills through the hub when creating and updating', async () => {
      const resolveSkills = vi.fn(async (names: readonly string[]) => names.map(skill));
      const hub = { resolveSkills } as unknown as HubAgentService;
      const createAgent = vi.fn(async () => agentView(AGENT_ID));
      const updateAgent = vi.fn(async (_ws: string, id: string) => agentView(id));
      const getAgent = vi.fn().mockResolvedValue(agentView(OTHER_AGENT_ID, [skill('old')]));
      const app = build({ createAgent, updateAgent, getAgent }, hub);

      await request(app)
        .post('/agents')
        .send({ name: 'New', instructions: 'Work.', skills: ['test-design'] })
        .expect(201);
      expect(resolveSkills).toHaveBeenLastCalledWith(['test-design'], [], []);
      expect(createAgent).toHaveBeenLastCalledWith('ws', {
        name: 'New',
        instructions: 'Work.',
        skills: [skill('test-design')],
      });

      await request(app)
        .put(`/agents/${OTHER_AGENT_ID}`)
        .send({ refreshSkills: ['old'] })
        .expect(200);
      expect(resolveSkills).toHaveBeenLastCalledWith(['old'], [skill('old')], ['old']);
    });
  });
});
