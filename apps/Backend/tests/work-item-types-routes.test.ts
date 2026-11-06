import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';

function setup() {
  const app = createApp({
    requestContextResolver: (req) => ({
      requestId: 'work-item-types-test',
      ownerId: req.header('x-test-workspace') ?? 'workspace-a',
      workspaceId: req.header('x-test-workspace') ?? 'workspace-a',
      actorId: 'user-a',
      memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
    }),
  });
  return { app, as: (workspace: string) => ({ 'x-test-workspace': workspace }) };
}

describe('work item types', () => {
  it('serves the defaults until a workspace saves its own types', async () => {
    const { app, as } = setup();
    const { body } = await request(app).get('/work-item-types').set(as('workspace-a')).expect(200);
    expect(body.types.map((type: { key: string }) => type.key)).toEqual(
      expect.arrayContaining(['bug', 'task', 'pbi']),
    );
  });

  it('saves types per workspace and rejects duplicates and unknown colors', async () => {
    const { app, as } = setup();
    const types = [
      { key: 'spike', label: 'Spike', color: 'pink', icon: 'flask', aliases: ['Pesquisa'] },
    ];
    const saved = await request(app)
      .put('/work-item-types')
      .set(as('workspace-a'))
      .send({ types })
      .expect(200);
    expect(saved.body.types[0]).toMatchObject({ key: 'spike', aliases: ['pesquisa'] });
    expect(
      (await request(app).get('/work-item-types').set(as('workspace-a'))).body.types,
    ).toHaveLength(1);
    expect(
      (await request(app).get('/work-item-types').set(as('workspace-b'))).body.types.length,
    ).toBeGreaterThan(1);
    await request(app)
      .put('/work-item-types')
      .set(as('workspace-a'))
      .send({ types: [...types, ...types] })
      .expect(400);
    await request(app)
      .put('/work-item-types')
      .set(as('workspace-a'))
      .send({ types: [{ ...types[0], color: 'chartreuse' }] })
      .expect(400);
  });

  it('stores a type on issues', async () => {
    const { app, as } = setup();
    const created = await request(app)
      .post('/issues')
      .set(as('workspace-a'))
      .send({ title: 'Checkout falha', type: 'bug' })
      .expect(201);
    expect(created.body.issue.type).toBe('bug');
    const updated = await request(app)
      .patch(`/issues/${created.body.issue.id}`)
      .set(as('workspace-a'))
      .send({ type: 'task' })
      .expect(200);
    expect(updated.body.issue.type).toBe('task');
  });
});
