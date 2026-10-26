import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createAgentsRouter } from '../src/adapters/http/agents-routes.js';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import { DeterministicLlm } from '../src/modules/agents/application/agent-ports.js';
import { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { AgentSkill } from '../src/modules/agents/domain/agent-entity.js';
import type { HubAgentService } from '../src/modules/hub/application/hub-agent-service.js';
import { ApplicationError } from '../src/shared/errors.js';

const WS = 'ws-routes';
const skill: AgentSkill = {
  name: 'test-design',
  description: 'Designs tests.',
  instructions: 'Write one test per criterion.',
  version: '1.0.0',
  revision: 'rev-1',
};
/** What the API returns: the SKILL.md body stays on the server. */
const { instructions: _instructions, ...publicSkill } = skill;

function build(service: AgentService, hub?: HubAgentService) {
  const app = express();
  app.use(express.json());
  app.use(
    createAgentsRouter(
      service,
      async () => ({ requestId: 'r', ownerId: 'owner', workspaceId: WS }),
      hub,
    ),
  );
  app.use(errorMiddleware);
  return app;
}

function realService() {
  return new AgentService({
    agentRepository: new InMemoryAgentRepository(),
    defaultLlm: new DeterministicLlm(),
  });
}

describe('agents workflow routes', () => {
  it('saves a workflow with defaults and lists steps with their agents', async () => {
    const service = realService();
    const app = build(service);
    const agent = await service.createAgent(WS, { name: 'Reviewer', instructions: 'Review.' });

    const saved = await request(app)
      .put('/agents/workflow')
      .send({
        enabled: true,
        steps: [
          { id: 's1', name: 'Plan', instructions: 'Plan it.' },
          { id: 's2', name: 'Review', instructions: 'Review it.', agentId: agent.id },
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.workflow).toMatchObject({
      enabled: true,
      autonomy: 'balanced',
      finalReview: true,
      uncertaintyBehavior: 'ask',
      issueCreationBehavior: 'ask',
      defaultAction: 'allow',
      rules: [],
    });

    const read = await request(app).get('/agents/workflow');
    expect(read.status).toBe(200);
    expect(read.body.workflow.steps).toEqual([
      { id: 's1', name: 'Plan', instructions: 'Plan it.' },
      {
        id: 's2',
        name: 'Review',
        instructions: 'Review it.',
        agentId: agent.id,
        agent: { id: agent.id, name: 'Reviewer', role: 'CUSTOM', instructions: 'Review.' },
      },
    ]);
  });

  it('rejects invalid workflow bodies and service validation errors', async () => {
    const app = build(realService());
    expect((await request(app).put('/agents/workflow').send({ steps: [] })).status).toBe(400);
    const empty = await request(app).put('/agents/workflow').send({ enabled: true, steps: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('AGENT_WORKFLOW_EMPTY');
  });

  it('keeps steps whose agent was deleted and forwards other lookup errors', async () => {
    const agentId = '00000000-0000-4000-8000-000000000001';
    const workflow = {
      enabled: true,
      steps: [{ id: 's1', name: 'Plan', instructions: 'Plan it.', agentId }],
    };
    const getAgent = vi
      .fn()
      .mockRejectedValueOnce(new ApplicationError('AGENT_NOT_FOUND', 'gone', 404))
      .mockRejectedValueOnce(new Error('database down'));
    const service = {
      getWorkflow: vi.fn().mockResolvedValue(workflow),
      getAgent,
    } as unknown as AgentService;
    const app = build(service);

    const kept = await request(app).get('/agents/workflow');
    expect(kept.status).toBe(200);
    expect(kept.body.workflow.steps).toEqual(workflow.steps);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await request(app).get('/agents/workflow')).status).toBe(500);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('agent skills without and with the ADK Hub', () => {
  it('keeps the skills an agent already has when the hub is not available', async () => {
    const service = realService();
    const app = build(service);
    const agent = await service.createAgent(WS, {
      name: 'QA',
      instructions: 'Test.',
      skills: [skill],
    });

    const kept = await request(app)
      .put(`/agents/${agent.id}`)
      .send({ skills: ['test-design'] });
    expect(kept.status).toBe(200);
    expect(kept.body.agent.skills).toEqual([publicSkill]);

    const added = await request(app)
      .put(`/agents/${agent.id}`)
      .send({ skills: ['test-design', 'edge-hunter'] });
    expect(added.status).toBe(503);
    expect(added.body.code).toBe('HUB_UNAVAILABLE');

    const refreshed = await request(app)
      .put(`/agents/${agent.id}`)
      .send({ refreshSkills: ['test-design'] });
    expect(refreshed.status).toBe(503);

    const created = await request(app)
      .post('/agents')
      .send({ name: 'New', instructions: 'Do.', skills: ['test-design'] });
    expect(created.status).toBe(503);
  });

  it('resolves skills through the hub when it is configured', async () => {
    const service = realService();
    const resolveSkills = vi.fn().mockResolvedValue([skill]);
    const hub = { resolveSkills, catalog: vi.fn() } as unknown as HubAgentService;
    const app = build(service, hub);

    const created = await request(app)
      .post('/agents')
      .send({ name: 'New', instructions: 'Do.', skills: ['test-design'] });
    expect(created.status).toBe(201);
    expect(created.body.agent.skills).toEqual([publicSkill]);
    expect(resolveSkills).toHaveBeenCalledWith(['test-design'], [], []);
  });

  it('forwards hub catalog failures', async () => {
    const hub = {
      catalog: vi.fn().mockRejectedValue(new ApplicationError('HUB_UNAVAILABLE', 'down', 503)),
    } as unknown as HubAgentService;
    const response = await request(build(realService(), hub)).get('/agents/hub');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('HUB_UNAVAILABLE');
  });
});
