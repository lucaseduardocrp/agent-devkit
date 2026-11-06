import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, errorMiddleware } from '../src/adapters/http/app.js';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import type { RunService } from '../src/modules/issues/run-service.js';

function setup() {
  const app = createApp({
    requestContextResolver: (req) => ({
      requestId: 'brief-test',
      ownerId: 'workspace-a',
      workspaceId: 'workspace-a',
      actorId: 'user-a',
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
    }),
  });
  return { app };
}

const edits = {
  considerations: ['Keep it small'],
  budget: { maxInputTokens: 100, maxOutputTokens: 50 },
};

describe('issue agent brief routes', () => {
  it('generates a brief when an issue is created and again when its content changes', async () => {
    const { app } = setup();
    const created = await request(app)
      .post('/issues')
      .send({ title: 'Fix typo in label', description: 'Small text change.' })
      .expect(201);
    const id = created.body.issue.id as string;
    const first = (await request(app).get(`/issues/${id}/brief`).expect(200)).body.brief;
    expect(first).toMatchObject({
      issueId: id,
      source: 'engine',
      locked: [],
      complexity: { level: 'trivial' },
    });
    expect(first.prompt.task).toContain('Fix typo in label');

    await request(app)
      .patch(`/issues/${id}`)
      .send({ title: 'Refactor the architecture', type: 'epic' })
      .expect(200);
    const second = (await request(app).get(`/issues/${id}/brief`).expect(200)).body.brief;
    expect(second.prompt.task).toContain('Refactor the architecture');
    expect(second.complexity.score).toBeGreaterThan(first.complexity.score);

    // Status and assignment do not feed the engine, so the stored brief is left alone.
    await request(app).patch(`/issues/${id}`).send({ status: 'blocked' }).expect(200);
    const third = (await request(app).get(`/issues/${id}/brief`).expect(200)).body.brief;
    expect(third.generatedAt).toBe(second.generatedAt);
  });

  it('keeps human edits across regeneration and restores the engine with force', async () => {
    const { app } = setup();
    const { body } = await request(app)
      .post('/issues')
      .send({ title: 'Edit the brief' })
      .expect(201);
    const id = body.issue.id as string;
    const put = await request(app).put(`/issues/${id}/brief`).send(edits).expect(200);
    expect(put.body.brief).toMatchObject({
      source: 'edited',
      locked: ['considerations', 'budget'],
      considerations: ['Keep it small'],
    });

    await request(app).patch(`/issues/${id}`).send({ description: 'More detail.' }).expect(200);
    const kept = (await request(app).get(`/issues/${id}/brief`)).body.brief;
    expect(kept.considerations).toEqual(['Keep it small']);
    expect(kept.prompt.task).toContain('More detail.');

    const regenerated = await request(app)
      .post(`/issues/${id}/brief/regenerate`)
      .send({})
      .expect(200);
    expect(regenerated.body.brief.locked).toEqual(['considerations', 'budget']);

    const forced = await request(app)
      .post(`/issues/${id}/brief/regenerate`)
      .send({ force: true })
      .expect(200);
    expect(forced.body.brief).toMatchObject({ source: 'engine', locked: [] });
  });

  it('validates edits and the issue it belongs to', async () => {
    const { app } = setup();
    const { body } = await request(app).post('/issues').send({ title: 'Validate' }).expect(201);
    const id = body.issue.id as string;
    await request(app).put(`/issues/${id}/brief`).send({}).expect(400);
    await request(app)
      .put(`/issues/${id}/brief`)
      .send({ recommendation: { provider: 'x', model: 'y', effort: 'extreme' } })
      .expect(400);
    await request(app)
      .put(`/issues/${id}/brief`)
      .send({
        recommendation: {
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          effort: 'high',
          rationale: 'Because',
          estimatedCostUsd: null,
          alternatives: [],
        },
        readFirst: [{ kind: 'file', label: 'a.ts', ref: 'src/a.ts', reason: 'entry' }],
        prompt: { system: 's', task: 't', outputFormat: 'o' },
      })
      .expect(200);
    const unknown = '00000000-0000-4000-8000-000000000000';
    await request(app).get(`/issues/${unknown}/brief`).expect(404);
    await request(app).put(`/issues/${unknown}/brief`).send(edits).expect(404);
    await request(app).post(`/issues/${unknown}/brief/regenerate`).send({}).expect(404);
  });

  it('lets viewers read the brief but not change it', async () => {
    const { app } = setup();
    const { body } = await request(app).post('/issues').send({ title: 'Read only' }).expect(201);
    const id = body.issue.id as string;
    const viewer = { 'x-test-role': 'VIEWER' };
    await request(app).get(`/issues/${id}/brief`).set(viewer).expect(200);
    await request(app).put(`/issues/${id}/brief`).set(viewer).send(edits).expect(403);
    await request(app).post(`/issues/${id}/brief/regenerate`).set(viewer).send({}).expect(403);
  });

  it('adds the brief to the prompt an agent receives', async () => {
    const { app } = setup();
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'Dev', instructions: 'Write code.' })
      .expect(201);
    const created = await request(app)
      .post('/issues')
      .send({
        title: 'Check checkout',
        assigneeAgentId: agent.body.agent.id,
        runMode: 'host',
      })
      .expect(201);
    expect(created.body.run.prompt).toContain('Execution brief (trivial, effort low):');
    expect(created.body.run.prompt).toContain('Answer in at most 80 words');
  });

  it('answers without a brief engine: empty reads and 501 for changes', async () => {
    const store = new InMemoryIssueStore();
    const issue = await store.create('workspace-a', 'user-a', { title: 'No engine' });
    const app = express();
    app.use(express.json());
    app.use(
      createIssuesRouter(
        store,
        {} as AgentService,
        {} as WorkspaceService,
        {} as RunService,
        () => ({
          requestId: 'r',
          workspaceId: 'workspace-a',
          ownerId: 'workspace-a',
          actorId: 'user-a',
          memberRole: 'ADMIN',
        }),
      ),
    );
    app.use(errorMiddleware);
    expect((await request(app).get(`/issues/${issue.id}/brief`).expect(200)).body).toEqual({
      brief: null,
    });
    await request(app).put(`/issues/${issue.id}/brief`).send(edits).expect(501);
  });
});
