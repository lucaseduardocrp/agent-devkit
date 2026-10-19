import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

const app = createApp({
  requestContextResolver: (req) => ({
    requestId: 'pbi-route-test',
    ownerId: req.header('x-test-workspace') ?? 'ws-a',
    workspaceId: req.header('x-test-workspace') ?? 'ws-a',
    actorId: 'user-a',
    memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
  }),
});

describe('PBI routes', () => {
  it('creates a hierarchy, restricts it to its workspace, and creates a linked issue', async () => {
    expect((await request(app).get('/pbi/current-iteration').expect(200)).body).toEqual({
      currentIteration: null,
    });
    const created = await request(app)
      .post('/pbi/items')
      .send({ kind: 'pbi', title: 'Release', description: 'Ship safely' })
      .expect(201);
    const rootId = created.body.item.id as string;
    const synced = await request(app).post(`/pbi/items/${rootId}/sync-children`).expect(200);
    expect(synced.body.items).toContainEqual(expect.objectContaining({ id: rootId }));
    await request(app)
      .post(`/pbi/items/${rootId}/sync-children`)
      .set('x-test-role', 'VIEWER')
      .expect(403);
    expect(
      (await request(app).get(`/pbi/items/${rootId}/comments`).expect(200)).body.comments,
    ).toEqual([]);
    await request(app)
      .get(`/pbi/items/${rootId}/comments`)
      .set('x-test-workspace', 'ws-b')
      .expect(404);
    const child = await request(app)
      .post('/pbi/items')
      .send({ kind: 'card', title: 'Verify', description: 'Check rollout', parentId: rootId })
      .expect(201);
    expect(child.body.item.parentId).toBe(rootId);
    const grandchild = await request(app)
      .post('/pbi/items')
      .send({ kind: 'card', title: 'Check logs', parentId: child.body.item.id })
      .expect(201);
    expect(grandchild.body.item.parentId).toBe(child.body.item.id);
    const edited = await request(app)
      .patch(`/pbi/items/${child.body.item.id}`)
      .send({ sourceData: { adkPriority: '1', adkAgentId: 'agent-1', adkCardType: 'Task' } })
      .expect(200);
    expect(edited.body.item.sourceData).toMatchObject({ adkPriority: '1', adkAgentId: 'agent-1' });
    const context = await request(app).get(`/pbi/items/${rootId}/context`).expect(200);
    expect(context.body.descendants).toHaveLength(2);
    const issue = await request(app).post(`/pbi/items/${rootId}/issues`).send({}).expect(201);
    expect(issue.body.issue).toMatchObject({ title: 'Release', pbiItemId: rootId });
    expect(issue.body.issue.description).toContain('Verify: Check rollout');
    await request(app).get(`/pbi/items/${rootId}`).set('x-test-workspace', 'ws-b').expect(404);
    await request(app)
      .patch(`/pbi/items/${rootId}`)
      .set('x-test-role', 'VIEWER')
      .send({ title: 'Changed' })
      .expect(403);
  });
  it('assigns workspace members and records who changed, deleted and commented', async () => {
    const audited = createApp({
      requestContextResolver: () => ({
        requestId: 'pbi-audit-test',
        ownerId: 'ws-a',
        workspaceId: 'ws-a',
        actorId: 'user-a',
        actorName: 'Alice',
        actorEmail: 'alice@example.test',
        memberRole: 'ADMIN',
      }),
      workspaceService: {
        listMembers: () => Promise.resolve([{ userId: 'user-a' }, { userId: 'user-b' }]),
      } as unknown as WorkspaceService,
    });
    const root = await request(audited)
      .post('/pbi/items')
      .send({ kind: 'pbi', title: 'Audit me' })
      .expect(201);
    const rootId = root.body.item.id as string;
    const child = await request(audited)
      .post('/pbi/items')
      .send({ kind: 'card', title: 'Child task', parentId: rootId })
      .expect(201);
    await request(audited)
      .patch(`/pbi/items/${rootId}`)
      .send({ sourceData: { adkAssigneeUserId: 'stranger' } })
      .expect(400);
    const assigned = await request(audited)
      .patch(`/pbi/items/${rootId}`)
      .send({ status: 'Active', sourceData: { adkAssigneeUserId: 'user-b' } })
      .expect(200);
    expect(assigned.body.item.sourceData.adkAssigneeUserId).toBe('user-b');
    await request(audited).delete(`/pbi/items/${rootId}`).expect(204);

    const history = await request(audited)
      .get('/audit/history')
      .query({ entityType: 'pbi', entityId: rootId })
      .expect(200);
    expect(history.body.items.map((event: { action: string }) => event.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);
    expect(history.body.items[1]).toMatchObject({
      actorId: 'user-a',
      actorName: 'Alice',
      operation: `PATCH /pbi/items/${rootId}`,
      before: { title: 'Audit me', status: 'backlog' },
      after: { title: 'Audit me', status: 'Active', adkAssigneeUserId: 'user-b' },
    });
    const childHistory = await request(audited)
      .get('/audit/history')
      .query({ entityType: 'pbi', entityId: child.body.item.id })
      .expect(200);
    expect(childHistory.body.items[0]).toMatchObject({ action: 'delete', actorId: 'user-a' });

    const issue = await request(audited).post('/issues').send({ title: 'Audit issue' }).expect(201);
    const issueId = issue.body.issue.id as string;
    await request(audited)
      .patch(`/issues/${issueId}`)
      .send({ priority: 'high', assigneeUserId: null })
      .expect(200);
    await request(audited).post(`/issues/${issueId}/comments`).send({ body: 'Looks good' });
    await request(audited).delete(`/issues/${issueId}`).expect(204);
    const issueHistory = await request(audited)
      .get('/audit/history')
      .query({ entityType: 'issue', entityId: issueId })
      .expect(200);
    expect(issueHistory.body.items.map((event: { action: string }) => event.action)).toEqual([
      'delete',
      'comment',
      'update',
      'create',
    ]);
    expect(issueHistory.body.items[2]).toMatchObject({
      before: { title: 'Audit issue', priority: 'medium' },
      after: { title: 'Audit issue', priority: 'high' },
    });
  });
  it('lets an issue have both an agent and a responsible workspace member', async () => {
    const memberId = '6f1c9a52-3b7e-4a43-9d0e-5c2f8b7a1e90';
    const app = createApp({
      requestContextResolver: () => ({
        requestId: 'issue-assignees',
        ownerId: 'ws-a',
        workspaceId: 'ws-a',
        actorId: 'user-a',
        memberRole: 'ADMIN',
      }),
      workspaceService: {
        listMembers: () => Promise.resolve([{ userId: 'user-a' }, { userId: memberId }]),
      } as unknown as WorkspaceService,
    });
    const agent = await request(app)
      .post('/agents')
      .send({ name: 'QA', instructions: 'Write test cases.' })
      .expect(201);
    const created = await request(app)
      .post('/issues')
      .send({
        title: 'Both assignees',
        status: 'backlog',
        assigneeAgentId: agent.body.agent.id,
        assigneeUserId: memberId,
      })
      .expect(201);
    expect(created.body.issue).toMatchObject({
      assigneeAgentId: agent.body.agent.id,
      assigneeUserId: memberId,
    });
    const cleared = await request(app)
      .patch(`/issues/${created.body.issue.id}`)
      .send({ assigneeUserId: null })
      .expect(200);
    expect(cleared.body.issue).toMatchObject({
      assigneeAgentId: agent.body.agent.id,
      assigneeUserId: null,
    });
  });
});
