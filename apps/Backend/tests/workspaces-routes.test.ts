import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

describe('Workspaces HTTP Routes', () => {
  async function setup() {
    const authRepo = new InMemoryAuthRepository();
    const authService = new AuthService(authRepo);
    const wsRepo = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(wsRepo, authRepo);

    const app = createApp({
      authService,
      workspaceService,
    });

    const reg = await request(app).post('/auth/register').send({
      email: 'owner@example.com',
      password: 'StrongPassword123!',
      name: 'Owner User',
    });
    const token = reg.body.token as string;
    const userId = reg.body.user.id as string;

    const collabReg = await request(app).post('/auth/register').send({
      email: 'collab@example.com',
      password: 'StrongPassword123!',
      name: 'Collab User',
    });
    const collabToken = collabReg.body.token as string;
    const collabUserId = collabReg.body.user.id as string;

    return { app, token, userId, collabToken, collabUserId, workspaceService };
  }

  it('creates and lists workspaces for authenticated users', async () => {
    const { app, token } = await setup();

    // unauthenticated create
    const unauthCreate = await request(app).post('/workspaces').send({ name: 'Secret WS' });
    expect(unauthCreate.status).toBe(401);

    // invalid name
    const invalidName = await request(app)
      .post('/workspaces')
      .set('authorization', `Bearer ${token}`)
      .send({ name: '' });
    expect(invalidName.status).toBe(400);

    // successful create
    const createRes = await request(app)
      .post('/workspaces')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'Acme Corp', slug: 'acme' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.workspace.name).toBe('Acme Corp');
    expect(createRes.body.member.role).toBe('ADMIN');

    // list workspaces
    const listRes = await request(app).get('/workspaces').set('authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);

    // get single workspace
    const wsId = createRes.body.workspace.id as string;
    const getRes = await request(app)
      .get(`/workspaces/${wsId}`)
      .set('authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.workspace.id).toBe(wsId);
  });

  it('manages members: list, add by email, update role, and remove', async () => {
    const { app, token, collabToken } = await setup();

    const createRes = await request(app)
      .post('/workspaces')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'Team WS' });
    const wsId = createRes.body.workspace.id as string;

    // list members initially
    const listMembersRes = await request(app)
      .get(`/workspaces/${wsId}/members`)
      .set('authorization', `Bearer ${token}`);
    expect(listMembersRes.status).toBe(200);
    expect(listMembersRes.body).toHaveLength(1);

    // invalid add member payload
    const invalidAdd = await request(app)
      .post(`/workspaces/${wsId}/members`)
      .set('authorization', `Bearer ${token}`)
      .send({ email: 'not-an-email', role: 'INVALID' });
    expect(invalidAdd.status).toBe(400);

    // add member by email
    const addRes = await request(app)
      .post(`/workspaces/${wsId}/members`)
      .set('authorization', `Bearer ${token}`)
      .send({
        email: 'collab@example.com',
        role: 'MEMBER',
        permissions: {
          modules: { brain: 'write', connect: 'none' },
        },
      });
    expect(addRes.status).toBe(201);
    expect(addRes.body.role).toBe('MEMBER');
    const memberId = addRes.body.id as string;

    // update member role
    const updateRes = await request(app)
      .patch(`/workspaces/${wsId}/members/${memberId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ role: 'INTEGRATOR' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.role).toBe('INTEGRATOR');

    // invalid update payload
    const invalidUpdate = await request(app)
      .patch(`/workspaces/${wsId}/members/${memberId}`)
      .set('authorization', `Bearer ${token}`)
      .send({ role: 'INVALID_ROLE' });
    expect(invalidUpdate.status).toBe(400);

    // remove member
    const removeRes = await request(app)
      .delete(`/workspaces/${wsId}/members/${memberId}`)
      .set('authorization', `Bearer ${token}`);
    expect(removeRes.status).toBe(200);
    expect(removeRes.body.success).toBe(true);

    // verify member is gone
    const listAfter = await request(app)
      .get(`/workspaces/${wsId}/members`)
      .set('authorization', `Bearer ${token}`);
    expect(listAfter.body).toHaveLength(1);

    // collab cannot access workspace after removal
    const collabAccess = await request(app)
      .get(`/workspaces/${wsId}`)
      .set('authorization', `Bearer ${collabToken}`);
    expect(collabAccess.status).toBe(403);

    // collab cannot list members of workspace they are not in
    const collabListMembers = await request(app)
      .get(`/workspaces/${wsId}/members`)
      .set('authorization', `Bearer ${collabToken}`);
    expect(collabListMembers.status).toBe(403);

    // collab cannot remove members from workspace they are not in
    const collabRemove = await request(app)
      .delete(`/workspaces/${wsId}/members/some-member`)
      .set('authorization', `Bearer ${collabToken}`);
    expect(collabRemove.status).toBe(403);

    // collab cannot delete workspace they are not admin of
    const collabDeleteWs = await request(app)
      .delete(`/workspaces/${wsId}`)
      .set('authorization', `Bearer ${collabToken}`);
    expect(collabDeleteWs.status).toBe(403);

    // admin deletes workspace
    const deleteWsRes = await request(app)
      .delete(`/workspaces/${wsId}`)
      .set('authorization', `Bearer ${token}`);
    expect(deleteWsRes.status).toBe(200);
    expect(deleteWsRes.body.success).toBe(true);

    // verify workspace is deleted
    const getAfterDelete = await request(app)
      .get(`/workspaces/${wsId}`)
      .set('authorization', `Bearer ${token}`);
    expect(getAfterDelete.status).toBe(403);
  });

  it('requireUserId throws UNAUTHORIZED when actorId or context is missing', async () => {
    const { requireUserId } = await import('../src/adapters/http/workspaces-routes.js');
    expect(() => requireUserId({ context: {} } as never)).toThrow('Usuário não autenticado.');
    expect(() => requireUserId({} as never)).toThrow('Usuário não autenticado.');
  });

  it('propagates contextResolver errors in workspaces router', async () => {
    const authRepo = new InMemoryAuthRepository();
    const wsRepo = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(wsRepo, authRepo);

    const failingResolver = () => Promise.reject(new Error('Resolver failed'));
    const app = createApp({
      workspaceService,
      requestContextResolver: failingResolver,
    });

    const res = await request(app).get('/workspaces');
    expect(res.status).toBe(500);
  });

  it('propagates errors when listUserWorkspaces throws', async () => {
    const authRepo = new InMemoryAuthRepository();
    const wsRepo = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(wsRepo, authRepo);
    const { vi } = await import('vitest');
    vi.spyOn(workspaceService, 'listUserWorkspaces').mockRejectedValueOnce(
      new Error('Database unavailable'),
    );

    const mockResolver = () =>
      Promise.resolve({
        requestId: 'req-1',
        actorId: 'u-1',
        ownerId: 'u-1',
      });
    const app = createApp({
      workspaceService,
      requestContextResolver: mockResolver as never,
    });

    const res = await request(app).get('/workspaces');
    expect(res.status).toBe(500);
  });

  it('propagates errors when deleteWorkspace throws', async () => {
    const authRepo = new InMemoryAuthRepository();
    const wsRepo = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(wsRepo, authRepo);
    const { vi } = await import('vitest');
    vi.spyOn(workspaceService, 'deleteWorkspace').mockRejectedValueOnce(
      new Error('Failed to delete workspace'),
    );

    const mockResolver = () =>
      Promise.resolve({
        requestId: 'req-1',
        actorId: 'u-1',
        ownerId: 'u-1',
      });
    const app = createApp({
      workspaceService,
      requestContextResolver: mockResolver as never,
    });

    const res = await request(app).delete('/workspaces/ws-1');
    expect(res.status).toBe(500);
  });
});
