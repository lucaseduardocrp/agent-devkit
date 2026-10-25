import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { LlmPort } from '../src/modules/agents/application/agent-ports.js';
import { InMemoryUsageStore } from '../src/modules/issues/usage-store.js';

function setup() {
  const app = createApp({
    requestContextResolver: (req) => ({
      requestId: 'issue-test',
      ownerId: req.header('x-test-workspace') ?? 'workspace-a',
      workspaceId: req.header('x-test-workspace') ?? 'workspace-a',
      actorId: req.header('x-test-user') ?? 'user-a',
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
    }),
  });
  const as = (workspace: string, user = 'user-a') => ({
    'x-test-workspace': workspace,
    'x-test-user': user,
  });
  return { app, as };
}

describe('issues, inbox and dashboard routes', () => {
  it('runs MCP assigned issues with the host model and no configured LLM', async () => {
    const { app, as } = setup();
    const headers = as('workspace-a');
    const agent = await request(app)
      .post('/agents')
      .set(headers)
      .send({ name: 'QA', instructions: 'Write test cases.' })
      .expect(201);
    const created = await request(app)
      .post('/issues')
      .set(headers)
      .send({ title: 'Check checkout', assigneeAgentId: agent.body.agent.id, runMode: 'host' })
      .expect(201);
    expect(created.body.run).toMatchObject({ mode: 'host', status: 'queued', attempt: 1 });
    expect(created.body.issue.status).toBe('in_progress');
    expect(created.body).not.toHaveProperty('automationError');
    const runId = created.body.run.id as string;
    await request(app).post(`/runs/${runId}/checkout`).set(headers).expect(200);
    await request(app)
      .post(`/runs/${runId}/complete`)
      .set(headers)
      .send({ output: 'Test cases written.' })
      .expect(200);
    expect(
      (await request(app).get(`/issues/${created.body.issue.id}`).set(headers)).body.issue.status,
    ).toBe('done');

    const updated = await request(app)
      .patch(`/issues/${created.body.issue.id}`)
      .set(headers)
      .send({ status: 'todo', runMode: 'host' })
      .expect(200);
    expect(updated.body.run).toMatchObject({ mode: 'host', status: 'queued', attempt: 2 });
    expect(updated.body.issue.status).toBe('in_progress');
  });

  it('routes comments to the assigned agent and records its reply', async () => {
    const { app, as } = setup();
    const headers = as('workspace-a');
    const agent = await request(app)
      .post('/agents')
      .set(headers)
      .send({ name: 'Writer', instructions: 'Improve documentation.' })
      .expect(201);
    const created = await request(app)
      .post('/issues')
      .set(headers)
      .send({ title: 'Document changes', assigneeAgentId: agent.body.agent.id, runMode: 'host' })
      .expect(201);
    const issueId = created.body.issue.id as string;
    const initialId = created.body.run.id as string;
    const pending = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set(headers)
      .send({ body: 'Add a migration example.' })
      .expect(201);
    expect(pending.body).toMatchObject({
      pending: true,
      comment: { body: 'Add a migration example.' },
    });
    await request(app).post(`/runs/${initialId}/checkout`).set(headers).expect(200);
    await request(app)
      .post(`/runs/${initialId}/complete`)
      .set(headers)
      .send({ output: 'Initial draft complete.' })
      .expect(200);
    const runs = await request(app).get('/runs').set(headers).query({ issueId }).expect(200);
    expect(runs.body.runs).toHaveLength(2);
    expect(runs.body.runs[0]).toMatchObject({ mode: 'host', status: 'queued' });
    expect(runs.body.runs[0].prompt).toContain('Add a migration example.');
    await request(app).post(`/runs/${runs.body.runs[0].id}/checkout`).set(headers).expect(200);
    await request(app)
      .post(`/runs/${runs.body.runs[0].id}/complete`)
      .set(headers)
      .send({ output: 'The migration example is now in the draft.' })
      .expect(200);
    const detail = await request(app).get(`/issues/${issueId}`).set(headers).expect(200);
    expect(detail.body.comments).toMatchObject([
      { authorId: 'user-a', body: 'Add a migration example.' },
      { authorId: agent.body.agent.id, body: 'The migration example is now in the draft.' },
    ]);
    const followUp = await request(app)
      .post(`/issues/${issueId}/comments`)
      .set(headers)
      .send({ body: 'Could you explain the rollback too?' })
      .expect(201);
    expect(followUp.body.run).toMatchObject({ mode: 'host', status: 'queued' });
    expect(followUp.body.run.prompt).toContain('The migration example is now in the draft.');
    expect(followUp.body.run.prompt).toContain('Could you explain the rollback too?');
  });

  it('starts PBI-derived issues in host mode without a configured LLM', async () => {
    const { app, as } = setup();
    const headers = as('workspace-a');
    const agent = await request(app)
      .post('/agents')
      .set(headers)
      .send({ name: 'QA', instructions: 'Write test cases.' })
      .expect(201);
    const pbi = await request(app)
      .post('/pbi/items')
      .set(headers)
      .send({ kind: 'pbi', title: 'Checkout', description: 'Cover failed payments.' })
      .expect(201);
    const response = await request(app)
      .post(`/pbi/items/${pbi.body.item.id}/issues`)
      .set(headers)
      .send({ assigneeAgentId: agent.body.agent.id, runMode: 'host' })
      .expect(201);
    expect(response.body.run).toMatchObject({ mode: 'host', status: 'queued' });
    expect(response.body.run.prompt).toContain('Cover failed payments.');
    expect(response.body.issue.status).toBe('in_progress');
  });

  it('automatically executes assigned issues and exposes priced runs in costs and dashboard', async () => {
    const llm: LlmPort = {
      provider: 'OpenAI',
      complete: async () => ({
        provider: 'OpenAI',
        text: 'Completed',
        model: 'demo',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
      async *stream() {
        yield 'Completed';
      },
    };
    const app = createApp({
      defaultLlm: llm,
      requestContextResolver: () => ({
        requestId: 'run-test',
        ownerId: 'workspace-a',
        workspaceId: 'workspace-a',
        actorId: 'user-a',
        memberRole: 'ADMIN',
      }),
    });
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'Worker', instructions: 'Summarize the task result.' })
      .expect(201);
    await request(app)
      .put('/costs/rates')
      .send({ provider: 'OpenAI', model: 'demo', inputUsdPerMillion: 2, outputUsdPerMillion: 4 })
      .expect(200);
    const created = await request(app)
      .post('/issues')
      .send({ title: 'Draft a result', assigneeAgentId: agent.body.agent.id })
      .expect(201);
    const id = created.body.issue.id as string;
    await vi.waitFor(async () => {
      const response = await request(app).get('/runs').query({ issueId: id });
      expect(response.body.runs[0]?.status).toBe('waiting_review');
    });
    const costs = await request(app).get('/costs').expect(200);
    expect(costs.body).toMatchObject({
      monthSpendMicros: 400,
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
      unpricedRuns: 0,
    });
    const dashboard = await request(app).get('/dashboard').expect(200);
    expect(dashboard.body).toMatchObject({
      activeRuns: 1, // the run waits for final review
      costs: {
        monthSpendMicros: 400,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
      },
    });
    expect((await request(app).get(`/issues/${id}`)).body.issue.status).toBe('in_review');
  });
  it('creates numbered issues per workspace and keeps workspaces isolated', async () => {
    const { app, as } = setup();
    const first = await request(app)
      .post('/issues')
      .set(as('workspace-a'))
      .send({ title: 'First', priority: 'high' })
      .expect(201);
    const second = await request(app)
      .post('/issues')
      .set(as('workspace-a'))
      .send({ title: 'Second' })
      .expect(201);
    const other = await request(app)
      .post('/issues')
      .set(as('workspace-b'))
      .send({ title: 'Other' })
      .expect(201);
    expect([first.body.issue.number, second.body.issue.number, other.body.issue.number]).toEqual([
      1, 2, 1,
    ]);
    expect(
      (await request(app).get('/issues').set(as('workspace-a')).expect(200)).body.issues,
    ).toHaveLength(2);
    await request(app).get(`/issues/${first.body.issue.id}`).set(as('workspace-b')).expect(404);
    await request(app)
      .patch(`/issues/${first.body.issue.id}`)
      .set(as('workspace-b'))
      .send({ status: 'done' })
      .expect(404);
  });

  it('updates issues, comments, user inbox state and dashboard totals', async () => {
    const { app, as } = setup();
    const created = await request(app)
      .post('/issues')
      .set(as('workspace-a'))
      .send({ title: 'Work item' })
      .expect(201);
    const id = created.body.issue.id as string;
    await request(app)
      .patch(`/issues/${id}`)
      .set(as('workspace-a'))
      .send({ status: 'in_progress' })
      .expect(200);
    await request(app)
      .post(`/issues/${id}/comments`)
      .set(as('workspace-a'))
      .send({ body: 'Started' })
      .expect(201);
    const detail = await request(app).get(`/issues/${id}`).set(as('workspace-a')).expect(200);
    expect(detail.body.comments).toMatchObject([{ body: 'Started', authorId: 'user-a' }]);
    await request(app)
      .patch(`/inbox/${id}`)
      .set(as('workspace-a'))
      .send({ read: true, archived: true })
      .expect(200);
    // The inbox is private and lists only runs executed while the issue was assigned to the
    // user: an issue that never ran for anyone stays out of every inbox.
    expect((await request(app).get('/inbox').set(as('workspace-a')).expect(200)).body).toEqual({
      items: [],
    });
    expect(
      (await request(app).get('/inbox').set(as('workspace-a', 'user-b')).expect(200)).body,
    ).toEqual({ items: [] });
    const dashboard = await request(app).get('/dashboard').set(as('workspace-a')).expect(200);
    expect(dashboard.body).toMatchObject({ totalIssues: 1, inProgress: 1, open: 1 });
    await request(app).delete(`/issues/${id}`).set(as('workspace-a')).expect(204);
    expect(
      (await request(app).get('/issues').set(as('workspace-a')).expect(200)).body.issues,
    ).toHaveLength(0);
  });

  it('records MCP token usage, prices it with the rate table and reports it with the costs', async () => {
    const usageStore = new InMemoryUsageStore();
    const app = createApp({
      usageStore,
      requestContextResolver: (req) => ({
        requestId: 'usage-test',
        ownerId: 'workspace-a',
        workspaceId: req.header('x-test-workspace') ?? 'workspace-a',
        actorId: 'user-a',
        memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
      }),
    });
    await request(app)
      .put('/costs/rates')
      .send({
        provider: 'mcp',
        model: 'claude-code',
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
      })
      .expect(200);
    const priced = await request(app)
      .post('/costs/usage')
      .send({
        tool: 'brain_search',
        provider: 'MCP',
        model: 'claude-code',
        inputTokens: 1000,
        outputTokens: 100,
      })
      .expect(201);
    expect(priced.body.event).toMatchObject({
      workspaceId: 'workspace-a',
      actorId: 'user-a',
      source: 'mcp',
      tool: 'brain_search',
      provider: 'mcp',
      model: 'claude-code',
      estimated: true,
      costMicros: 4500,
    });
    const unpriced = await request(app)
      .post('/costs/usage')
      .send({ tool: 'issues_list', inputTokens: 40, outputTokens: 10, estimated: false })
      .expect(201);
    expect(unpriced.body.event).toMatchObject({
      provider: 'mcp',
      model: 'unknown',
      estimated: false,
      costMicros: null,
    });
    expect(await usageStore.totals('workspace-a')).toEqual({
      inputTokens: 1040,
      outputTokens: 110,
    });

    const costs = await request(app).get('/costs').expect(200);
    expect(costs.body).toMatchObject({
      monthSpendMicros: 4500,
      totalInputTokens: 1040,
      totalOutputTokens: 110,
      totalTokens: 1150,
      unpricedRuns: 0,
      mcpUsage: {
        calls: 2,
        inputTokens: 1040,
        outputTokens: 110,
        totalTokens: 1150,
        spendMicros: 4500,
        unpricedCalls: 1,
        estimated: true,
        byTool: [
          { tool: 'brain_search', calls: 1, totalTokens: 1100 },
          { tool: 'issues_list', calls: 1, totalTokens: 50 },
        ],
        byClient: [
          { provider: 'mcp', model: 'claude-code', calls: 1, totalTokens: 1100 },
          { provider: 'mcp', model: 'unknown', calls: 1, totalTokens: 50 },
        ],
      },
    });
    const dashboard = await request(app).get('/dashboard').expect(200);
    expect(dashboard.body.costs).toMatchObject({
      totalTokens: 1150,
      mcpUsage: { calls: 2, totalTokens: 1150 },
    });
    const other = await request(app)
      .get('/costs')
      .set('x-test-workspace', 'workspace-b')
      .expect(200);
    expect(other.body).toMatchObject({
      totalTokens: 0,
      mcpUsage: { calls: 0, totalTokens: 0, estimated: false, byTool: [], byClient: [] },
    });

    await request(app)
      .post('/costs/usage')
      .send({ tool: '', inputTokens: 1, outputTokens: 1 })
      .expect(400);
    await request(app)
      .post('/costs/usage')
      .send({ tool: 'brain_search', inputTokens: -1, outputTokens: 1 })
      .expect(400);
    // Viewers and read-only tokens consume tokens too, so their MCP usage is recorded.
    await request(app)
      .post('/costs/usage')
      .set('x-test-role', 'VIEWER')
      .send({ tool: 'brain_search', inputTokens: 1, outputTokens: 1 })
      .expect(201);
  });

  it('counts priced MCP usage against the monthly budget', async () => {
    const { app, as } = setup();
    const headers = as('workspace-a');
    await request(app)
      .put('/costs/rates')
      .set(headers)
      .send({ provider: 'mcp', model: 'codex', inputUsdPerMillion: 1_000, outputUsdPerMillion: 0 })
      .expect(200);
    await request(app)
      .patch('/costs/budget')
      .set(headers)
      .send({ monthlyBudgetMicros: 1_000 })
      .expect(200);
    await request(app)
      .post('/costs/usage')
      .set(headers)
      .send({ tool: 'spec_get', model: 'codex', inputTokens: 1, outputTokens: 0 })
      .expect(201);
    const agent = await request(app)
      .post('/agents')
      .set(headers)
      .send({ name: 'QA', instructions: 'Write test cases.' })
      .expect(201);
    const created = await request(app)
      .post('/issues')
      .set(headers)
      .send({ title: 'Over budget', assigneeAgentId: agent.body.agent.id, runMode: 'host' })
      .expect(201);
    expect(created.body.automationError).toBe('Monthly agent budget has been reached.');
  });

  it('rejects invalid issue data and viewer writes', async () => {
    const { app, as } = setup();
    await request(app).post('/issues').set(as('workspace-a')).send({ title: '' }).expect(400);
    const created = await request(app)
      .post('/issues')
      .set(as('workspace-a'))
      .send({ title: 'Protected' })
      .expect(201);
    const viewer = { ...as('workspace-a'), 'x-test-role': 'VIEWER' };
    await request(app).post('/issues').set(viewer).send({ title: 'Denied' }).expect(403);
    await request(app)
      .patch(`/issues/${created.body.issue.id}`)
      .set(viewer)
      .send({ status: 'done' })
      .expect(403);
    await request(app)
      .post(`/issues/${created.body.issue.id}/comments`)
      .set(viewer)
      .send({ body: 'Denied' })
      .expect(403);
  });
});
