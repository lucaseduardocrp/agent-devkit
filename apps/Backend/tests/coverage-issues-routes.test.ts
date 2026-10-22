import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import type { RequestContextResolver } from '../src/adapters/http/compatibility-routes.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import type { RequestContext } from '../src/shared/context.js';
import { ApplicationError } from '../src/shared/errors.js';

const agentId = '11111111-1111-4111-8111-111111111111';
const otherAgentId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';
const strangerId = '44444444-4444-4444-8444-444444444444';
const admin: RequestContext = {
  requestId: 'r',
  ownerId: 'ws',
  workspaceId: 'ws',
  actorId: 'user-a',
  memberRole: 'ADMIN',
};

let context: RequestContext | Error;
let store: InMemoryIssueStore;
let runs: {
  [
    K in
      | 'list'
      | 'assignedTo'
      | 'get'
      | 'create'
      | 'checkout'
      | 'completeHost'
      | 'cancel'
      | 'costs'
      | 'recordUsage'
      | 'setBudget'
      | 'setRate'
      | 'removeRate'
  ]: ReturnType<typeof vi.fn>;
};
let agents: { getAgent: ReturnType<typeof vi.fn>; listAgents: ReturnType<typeof vi.fn> };
let workspaces: { listMembers: ReturnType<typeof vi.fn> };

const resolver: RequestContextResolver = () => {
  if (context instanceof Error) throw context;
  return context;
};

function build(withResolver = true) {
  const app = express();
  app.use(express.json());
  if (!withResolver)
    app.use((req, _res, next) => {
      req.context = context as RequestContext;
      next();
    });
  app.use(
    createIssuesRouter(
      store,
      agents as unknown as AgentService,
      workspaces as unknown as WorkspaceService,
      runs as unknown as RunService,
      withResolver ? resolver : undefined,
    ),
  );
  app.use(errorMiddleware);
  return app;
}

afterEach(() => vi.restoreAllMocks());

const conflict = () => new ApplicationError('ISSUE_ALREADY_RUNNING', 'Already running.', 409);

beforeEach(() => {
  context = admin;
  store = new InMemoryIssueStore();
  runs = {
    list: vi.fn().mockResolvedValue([]),
    assignedTo: vi.fn().mockResolvedValue([]),
    get: vi.fn(async (_ws: string, id: string) => ({ id })),
    create: vi.fn(async (issueId: string, _ctx: unknown, mode = 'server') => ({
      id: 'run',
      issueId,
      mode,
    })),
    checkout: vi.fn(async (_ws: string, id: string) => ({ id, status: 'running' })),
    completeHost: vi.fn(async (_ws: string, id: string) => ({ id, status: 'succeeded' })),
    cancel: vi.fn(async (_ws: string, id: string) => ({ id, status: 'cancelled' })),
    costs: vi.fn().mockResolvedValue({
      monthSpendMicros: 1,
      totalInputTokens: 2,
      totalOutputTokens: 3,
      totalTokens: 5,
      monthlyBudgetMicros: 0,
      unpricedRuns: 0,
      rates: [],
      byAgent: {},
      mcpUsage: { calls: 0 },
    }),
    recordUsage: vi.fn().mockResolvedValue({ id: 'usage' }),
    setBudget: vi.fn(async (_ws: string, micros: number) => ({ monthlyBudgetMicros: micros })),
    setRate: vi.fn(async (rate: unknown) => rate),
    removeRate: vi.fn().mockResolvedValue(true),
  };
  agents = {
    getAgent: vi.fn().mockResolvedValue({}),
    listAgents: vi.fn().mockResolvedValue([{ toJSON: () => ({ id: agentId }) }]),
  };
  workspaces = { listMembers: vi.fn().mockResolvedValue([{ userId: memberId }]) };
});

describe('issue routes: context and permissions', () => {
  it('forwards resolver failures and missing workspace or actor context', async () => {
    context = new ApplicationError('UNAUTHORIZED', 'No session.', 401);
    await request(build()).get('/issues').expect(401);
    context = { requestId: 'r', ownerId: 'ws' };
    const app = build();
    for (const path of ['/issues', '/dashboard', '/runs', '/runs/x', '/costs', '/issues/x'])
      expect((await request(app).get(path).expect(400)).body.code).toBe('WORKSPACE_REQUIRED');
    await request(app)
      .post('/costs/usage')
      .send({ tool: 't', inputTokens: 1, outputTokens: 1 })
      .expect(400);
    expect(runs.recordUsage).not.toHaveBeenCalled();
    context = { requestId: 'r', ownerId: 'ws', workspaceId: 'ws' };
    expect((await request(app).get('/inbox').expect(401)).body.code).toBe('UNAUTHORIZED');
  });

  it('works without a context resolver when context is already set', async () => {
    await store.create('ws', 'user-a', { title: 'Existing' });
    const response = await request(build(false)).get('/issues').expect(200);
    expect(response.body.issues).toHaveLength(1);
  });

  it('rejects writes from read-only tokens and members without cost permissions', async () => {
    context = { ...admin, tokenScope: 'read' };
    const app = build();
    const writes: [string, string, object?][] = [
      ['post', '/issues', { title: 'x' }],
      ['patch', '/issues/x', { title: 'x' }],
      ['delete', '/issues/x'],
      ['post', '/issues/x/comments', { body: 'x' }],
      ['post', '/issues/x/runs', {}],
      ['post', '/runs/x/checkout'],
      ['post', '/runs/x/complete', { output: 'x' }],
      ['post', '/runs/x/cancel'],
      ['patch', '/costs/budget', { monthlyBudgetMicros: 1 }],
      ['put', '/costs/rates', {}],
      ['delete', '/costs/rates/p/m'],
    ];
    for (const [method, path, body] of writes) {
      const call = (request(app) as unknown as Record<string, (p: string) => request.Test>)[
        method
      ]!(path);
      expect((await (body ? call.send(body) : call).expect(403)).body.code).toBe('FORBIDDEN');
    }
    context = { ...admin, memberRole: 'VIEWER' };
    for (const [method, path] of [
      ['patch', '/costs/budget'],
      ['put', '/costs/rates'],
      ['delete', '/costs/rates/p/m'],
    ] as const) {
      const response = await (
        request(app) as unknown as Record<string, (p: string) => request.Test>
      )[method]!(path).expect(403);
      expect(response.body.code).toBe('WORKSPACE_PERMISSION_DENIED');
    }
  });
});

describe('issue routes: create', () => {
  it('validates assignees against agents and workspace members', async () => {
    const app = build();
    await request(app)
      .post('/issues')
      .send({ title: 'Stranger', assigneeUserId: strangerId })
      .expect(400);
    const created = await request(app)
      .post('/issues')
      .send({ title: 'Member', assigneeUserId: memberId })
      .expect(201);
    expect(created.body.issue.assigneeUserId).toBe(memberId);
    expect(workspaces.listMembers).toHaveBeenCalledWith('ws', 'user-a');
    agents.getAgent.mockRejectedValueOnce(new ApplicationError('AGENT_NOT_FOUND', 'No.', 404));
    await request(app).post('/issues').send({ title: 'Bad', assigneeAgentId: agentId }).expect(404);
  });

  it('starts agent runs and reports automation failures', async () => {
    const app = build();
    const ok = await request(app)
      .post('/issues')
      .send({ title: 'Run', assigneeAgentId: agentId })
      .expect(201);
    expect(ok.body.run).toMatchObject({ mode: 'server' });
    const backlog = await request(app)
      .post('/issues')
      .send({ title: 'Later', assigneeAgentId: agentId, status: 'backlog' })
      .expect(201);
    expect(backlog.body).not.toHaveProperty('run');

    runs.create.mockRejectedValueOnce(new Error('No model'));
    const failed = await request(app)
      .post('/issues')
      .send({ title: 'Fail', assigneeAgentId: agentId })
      .expect(201);
    expect(failed.body).toMatchObject({
      automationError: 'No model',
      issue: { status: 'blocked' },
    });

    runs.create.mockRejectedValueOnce('opaque');
    const opaque = await request(app)
      .post('/issues')
      .send({ title: 'Opaque', assigneeAgentId: agentId })
      .expect(201);
    expect(opaque.body.automationError).toBe('Could not start agent.');

    runs.create.mockRejectedValueOnce(conflict());
    const busy = await request(app)
      .post('/issues')
      .send({ title: 'Busy', assigneeAgentId: agentId })
      .expect(201);
    expect(busy.body).toMatchObject({
      automationError: 'Already running.',
      issue: { status: 'todo' },
    });
  });

  it('returns the created issue when it cannot be read back', async () => {
    vi.spyOn(store, 'get').mockResolvedValueOnce(null);
    const response = await request(build()).post('/issues').send({ title: 'Gone' }).expect(201);
    expect(response.body.issue.title).toBe('Gone');
  });
});

describe('issue routes: update and delete', () => {
  it('blocks status or agent changes while a run is active', async () => {
    const issue = await store.create('ws', 'user-a', { title: 'Busy' });
    runs.list.mockResolvedValue([{ status: 'running' }]);
    const app = build();
    await request(app).patch(`/issues/${issue.id}`).send({ status: 'done' }).expect(409);
    await request(app).patch(`/issues/${issue.id}`).send({ assigneeAgentId: agentId }).expect(409);
    await request(app).patch(`/issues/${issue.id}`).send({ title: 'Renamed' }).expect(200);
    runs.list.mockResolvedValue([{ status: 'succeeded' }]);
    await request(app).patch(`/issues/${issue.id}`).send({ status: 'done' }).expect(200);
    await request(app).patch(`/issues/${issue.id}`).send({ runMode: 'host' }).expect(400);
  });

  it('validates only changed responsible users', async () => {
    const issue = await store.create('ws', 'user-a', {
      title: 'Owned',
      assigneeUserId: strangerId,
    });
    const app = build();
    await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeUserId: strangerId, title: 'Kept' })
      .expect(200);
    expect(workspaces.listMembers).not.toHaveBeenCalled();
    await request(app).patch(`/issues/${issue.id}`).send({ assigneeUserId: memberId }).expect(200);
    expect(workspaces.listMembers).toHaveBeenCalledOnce();
  });

  it('starts runs when an agent is assigned or the issue returns to todo', async () => {
    const issue = await store.create('ws', 'user-a', { title: 'Flow', status: 'backlog' });
    const app = build();
    const assigned = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeAgentId: agentId })
      .expect(200);
    expect(assigned.body).not.toHaveProperty('run');
    const todo = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ status: 'todo', runMode: 'host' })
      .expect(200);
    expect(todo.body.run).toMatchObject({ mode: 'host' });
    expect(runs.create).toHaveBeenLastCalledWith(issue.id, admin, 'host');
    await request(app).patch(`/issues/${issue.id}`).send({ status: 'todo' }).expect(200);
    expect(runs.create).toHaveBeenCalledOnce();

    runs.create.mockRejectedValueOnce(new Error('No model'));
    const failed = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeAgentId: otherAgentId })
      .expect(200);
    expect(failed.body).toMatchObject({
      automationError: 'No model',
      issue: { status: 'blocked' },
    });

    await store.update('ws', issue.id, { status: 'todo' });
    runs.create.mockRejectedValueOnce('opaque');
    const opaque = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeAgentId: agentId })
      .expect(200);
    expect(opaque.body.automationError).toBe('Could not start agent.');

    await store.update('ws', issue.id, { status: 'todo' });
    runs.create.mockRejectedValueOnce(conflict());
    const busy = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeAgentId: otherAgentId })
      .expect(200);
    expect(busy.body).toMatchObject({
      automationError: 'Already running.',
      issue: { status: 'todo' },
    });

    const same = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeAgentId: otherAgentId })
      .expect(200);
    expect(same.body).not.toHaveProperty('run');

    await store.update('ws', issue.id, { status: 'todo' });
    const unassigned = await request(app)
      .patch(`/issues/${issue.id}`)
      .send({ assigneeAgentId: null })
      .expect(200);
    expect(unassigned.body).not.toHaveProperty('run');
  });

  it('keeps issues that have run history and reports missing issues', async () => {
    const issue = await store.create('ws', 'user-a', { title: 'History' });
    runs.list.mockResolvedValueOnce([{ status: 'succeeded' }]);
    const app = build();
    expect((await request(app).delete(`/issues/${issue.id}`).expect(409)).body.code).toBe(
      'ISSUE_HAS_RUNS',
    );
    await request(app).delete('/issues/missing').expect(404);
    await request(app).delete(`/issues/${issue.id}`).expect(204);
    expect(await store.get('ws', issue.id)).toBeNull();
  });
});

describe('issue routes: comments and inbox', () => {
  it('asks for an agent, reuses the previous run mode and reports start failures', async () => {
    const plain = await store.create('ws', 'user-a', { title: 'Plain' });
    const assigned = await store.create('ws', 'user-a', {
      title: 'Assigned',
      assigneeAgentId: agentId,
    });
    const app = build();
    const unassigned = await request(app)
      .post(`/issues/${plain.id}/comments`)
      .send({ body: 'Hi' })
      .expect(201);
    expect(unassigned.body.automationError).toContain('Assign an agent');

    const first = await request(app)
      .post(`/issues/${assigned.id}/comments`)
      .send({ body: 'Go' })
      .expect(201);
    expect(first.body.run).toMatchObject({ mode: 'server' });
    runs.list.mockResolvedValueOnce([{ mode: 'host' }]);
    const second = await request(app)
      .post(`/issues/${assigned.id}/comments`)
      .send({ body: 'Again' })
      .expect(201);
    expect(second.body.run).toMatchObject({ mode: 'host' });

    runs.create.mockRejectedValueOnce(new Error('Budget'));
    const failed = await request(app)
      .post(`/issues/${assigned.id}/comments`)
      .send({ body: 'Fail' })
      .expect(201);
    expect(failed.body).toMatchObject({ automationError: 'Budget' });
    expect(failed.body).not.toHaveProperty('pending');

    runs.create.mockRejectedValueOnce(42);
    const opaque = await request(app)
      .post(`/issues/${assigned.id}/comments`)
      .send({ body: 'Opaque' })
      .expect(201);
    expect(opaque.body.automationError).toBe('Could not start agent.');

    await request(app).post(`/issues/${assigned.id}/comments`).send({ body: ' ' }).expect(400);
  });

  it('lists only the runs executed while each issue was assigned to the user', async () => {
    const older = await store.create('ws', 'user-b', { title: 'Older' });
    const newer = await store.create('ws', 'user-b', { title: 'Newer' });
    await store.create('ws', 'user-a', { title: 'Created by me, never run for me' });
    const run = (id: string, issueId: string, createdAt: string) => ({
      id,
      issueId,
      agentId,
      status: 'succeeded',
      attempt: 1,
      prompt: 'secret prompt',
      output: 'output',
      createdAt: new Date(createdAt),
      finishedAt: null,
    });
    runs.assignedTo.mockResolvedValueOnce([
      run('r3', newer.id, '2026-01-03T00:00:00Z'),
      run('r2', older.id, '2026-01-02T00:00:00Z'),
      run('r1', older.id, '2026-01-01T00:00:00Z'),
    ]);
    const inbox = await request(build()).get('/inbox').expect(200);
    expect(runs.assignedTo).toHaveBeenCalledWith('ws', 'user-a');
    expect(
      inbox.body.items.map((item: { issue: { title: string }; runs: { id: string }[] }) => [
        item.issue.title,
        item.runs.map((entry) => entry.id),
      ]),
    ).toEqual([
      ['Newer', ['r3']],
      ['Older', ['r2', 'r1']],
    ]);
    expect(inbox.body.items[0].runs[0]).toEqual({
      id: 'r3',
      agentId,
      status: 'succeeded',
      attempt: 1,
      createdAt: '2026-01-03T00:00:00.000Z',
      finishedAt: null,
    });
  });

  it('only shows read and archived states newer than the latest activity', async () => {
    const issue = await store.create('ws', 'user-a', { title: 'Inbox' });
    runs.assignedTo.mockResolvedValueOnce([
      { id: 'run', issueId: issue.id, createdAt: new Date(), finishedAt: null },
    ]);
    const app = build();
    const old = new Date(issue.updatedAt.getTime() - 1000);
    await store.setInboxState(issue.id, 'user-a', { readAt: old, archivedAt: old });
    const stale = await request(app).get('/inbox').expect(200);
    expect(stale.body.items[0]).toMatchObject({ readAt: null, archivedAt: null });

    const archived = await request(app)
      .patch(`/inbox/${issue.id}`)
      .send({ archived: true })
      .expect(200);
    expect(archived.body.state.readAt).toBe(old.toISOString());
    expect(archived.body.state.archivedAt).toBeTruthy();
    const read = await request(app).patch(`/inbox/${issue.id}`).send({ read: false }).expect(200);
    expect(read.body.state).toMatchObject({
      readAt: null,
      archivedAt: archived.body.state.archivedAt,
    });
    const cleared = await request(app)
      .patch(`/inbox/${issue.id}`)
      .send({ archived: false })
      .expect(200);
    expect(cleared.body.state).toMatchObject({ readAt: null, archivedAt: null });

    const fresh = await store.create('ws', 'user-a', { title: 'Fresh' });
    const created = await request(app).patch(`/inbox/${fresh.id}`).send({ read: true }).expect(200);
    expect(created.body.state).toMatchObject({ archivedAt: null });
    await request(app).patch(`/inbox/${fresh.id}`).send({}).expect(400);
  });

  it('forwards inbox store failures', async () => {
    vi.spyOn(store, 'inboxStates').mockRejectedValueOnce(new Error('db'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await request(build()).get('/inbox').expect(500);
  });
});

describe('issue routes: dashboard, runs and costs', () => {
  it('summarizes recent issues by status and priority', async () => {
    await store.create('ws', 'user-a', { title: 'A', status: 'in_progress', priority: 'high' });
    const done = await store.create('ws', 'user-a', { title: 'B', status: 'done' });
    const current = await store.list('ws');
    vi.spyOn(store, 'list').mockResolvedValueOnce([
      ...current,
      { ...done, id: 'old', updatedAt: new Date(2000, 0, 1) },
    ]);
    runs.list.mockResolvedValueOnce([{ status: 'running' }, { status: 'failed' }]);
    const response = await request(build()).get('/dashboard').expect(200);
    expect(response.body).toMatchObject({
      agents: [{ id: agentId }],
      activeRuns: 1,
      totalIssues: 3,
      inProgress: 1,
      open: 1,
      byStatus: { in_progress: 1, done: 1, todo: 0 },
      byPriority: { high: 1, medium: 1 },
      costs: { totalTokens: 5 },
    });
    expect(response.body.recentActivity).toHaveLength(2);
  });

  it('lists, reads and drives runs', async () => {
    const app = build();
    await request(app).get('/runs').query({ issueId: 'i1' }).expect(200);
    expect(runs.list).toHaveBeenLastCalledWith('ws', 'i1');
    await request(app).get('/runs?issueId=a&issueId=b').expect(200);
    expect(runs.list).toHaveBeenLastCalledWith('ws', undefined);
    expect((await request(app).get('/runs/r1').expect(200)).body.run).toEqual({ id: 'r1' });

    expect(
      (await request(app).post('/issues/i1/runs').send({}).expect(201)).body.run,
    ).toMatchObject({ issueId: 'i1', mode: 'server' });
    await request(app).post('/issues/i1/runs').send({ mode: 'other' }).expect(400);
    expect((await request(app).post('/runs/r1/checkout').expect(200)).body.run.status).toBe(
      'running',
    );
    await request(app)
      .post('/runs/r1/complete')
      .send({ output: 'Done', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 2 })
      .expect(200);
    expect(runs.completeHost).toHaveBeenCalledWith('ws', 'r1', {
      output: 'Done',
      provider: 'p',
      model: 'm',
      inputTokens: 1,
      outputTokens: 2,
    });
    await request(app).post('/runs/r1/complete').send({ output: '' }).expect(400);
    expect((await request(app).post('/runs/r1/cancel').expect(200)).body.run.status).toBe(
      'cancelled',
    );

    runs.checkout.mockRejectedValueOnce(new ApplicationError('INVALID_RUN_MODE', 'No.', 409));
    await request(app).post('/runs/r1/checkout').expect(409);
    runs.cancel.mockRejectedValueOnce(new ApplicationError('INVALID_RUN_STATE', 'No.', 409));
    await request(app).post('/runs/r1/cancel').expect(409);
    runs.get.mockRejectedValueOnce(new ApplicationError('RUN_NOT_FOUND', 'No.', 404));
    await request(app).get('/runs/missing').expect(404);
  });

  it('manages budgets and rates', async () => {
    const app = build();
    expect(
      (await request(app).patch('/costs/budget').send({ monthlyBudgetMicros: 10 }).expect(200))
        .body,
    ).toEqual({ monthlyBudgetMicros: 10 });
    await request(app).patch('/costs/budget').send({ monthlyBudgetMicros: -1 }).expect(400);
    const rate = { provider: 'p', model: 'm', inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
    expect((await request(app).put('/costs/rates').send(rate).expect(200)).body.rate).toEqual({
      workspaceId: 'ws',
      ...rate,
    });
    await request(app).put('/costs/rates').send({ provider: 'p' }).expect(400);
    await request(app).delete('/costs/rates/p/m').expect(204);
    expect(runs.removeRate).toHaveBeenCalledWith('ws', 'p', 'm');
    runs.removeRate.mockResolvedValueOnce(false);
    expect((await request(app).delete('/costs/rates/p/m').expect(404)).body.code).toBe(
      'RATE_NOT_FOUND',
    );
  });
});
