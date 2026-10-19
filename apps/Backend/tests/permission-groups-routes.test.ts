import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

async function setup() {
  const authRepo = new InMemoryAuthRepository();
  const authService = new AuthService(authRepo);
  const workspaceService = new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo);
  const app = createApp({ authService, workspaceService });
  const register = async (email: string) => {
    const response = await request(app)
      .post('/auth/register')
      .send({ email, password: 'StrongPassword123!', name: email.split('@')[0] });
    return response.body.token as string;
  };
  const ownerToken = await register('owner@example.com');
  const memberToken = await register('member@example.com');
  const created = await request(app)
    .post('/workspaces')
    .set('authorization', `Bearer ${ownerToken}`)
    .set('x-locale', 'en-US')
    .send({ name: 'Permissions' });
  const workspaceId = created.body.workspace.id as string;
  const as = (token: string) => ({
    get: (path: string) =>
      request(app)
        .get(path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', workspaceId),
    post: (path: string, body: object = {}) =>
      request(app)
        .post(path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', workspaceId)
        .send(body),
    patch: (path: string, body: object = {}) =>
      request(app)
        .patch(path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', workspaceId)
        .send(body),
    delete: (path: string) =>
      request(app)
        .delete(path)
        .set('authorization', `Bearer ${token}`)
        .set('x-workspace-id', workspaceId),
  });
  return { workspaceId, owner: as(ownerToken), member: as(memberToken), created };
}

describe('Permission groups and module enforcement', () => {
  it('returns the effective access with each membership', async () => {
    const { created, owner } = await setup();
    expect(created.body.access.modules.pbis).toBe('delete');
    expect(created.body.access.workspace.manageGroups).toBe(true);
    const list = await owner.get('/workspaces');
    expect(list.body[0].access.workspace.deleteWorkspace).toBe(true);
  });

  it('enforces view, edit and delete per module from the member groups', async () => {
    const { workspaceId, owner, member } = await setup();
    const groups = (await owner.get(`/workspaces/${workspaceId}/groups`)).body as {
      id: string;
      name: string;
    }[];
    expect(groups.map((group) => group.name)).toEqual(['Editors', 'Viewers']);

    const added = await owner.post(`/workspaces/${workspaceId}/members`, {
      email: 'member@example.com',
      role: 'MEMBER',
    });
    expect(added.status).toBe(201);
    const memberId = added.body.id as string;

    // Without any group the member cannot even view modules.
    expect((await member.get('/release-notes')).status).toBe(403);
    expect((await member.get('/release-notes')).body.code).toBe('MODULE_PERMISSION_DENIED');
    // Workspace and personal routes stay reachable.
    expect((await member.get('/workspaces')).status).toBe(200);
    expect((await member.get('/integrations')).status).toBe(200);

    const qa = await owner.post(`/workspaces/${workspaceId}/groups`, {
      name: 'QA',
      description: 'Release notes readers',
      modules: { releaseNotes: 'view' },
      memberIds: [memberId],
    });
    expect(qa.status).toBe(201);
    expect((await member.get('/release-notes')).status).toBe(200);
    expect((await member.post('/release-notes', { title: 'Notes' })).status).toBe(403);

    const edit = await owner.patch(`/workspaces/${workspaceId}/groups/${qa.body.id}`, {
      modules: { releaseNotes: 'edit' },
    });
    expect(edit.status).toBe(200);
    const note = await member.post('/release-notes', { title: 'Notes' });
    expect(note.status).toBe(201);
    expect((await member.delete(`/release-notes/${note.body.releaseNote.id}`)).status).toBe(403);

    // Group membership can also be changed from the member.
    const moved = await owner.patch(`/workspaces/${workspaceId}/members/${memberId}`, {
      groupIds: [groups[0]!.id],
    });
    expect(moved.body.groupIds).toEqual([groups[0]!.id]);
    expect((await member.delete(`/release-notes/${note.body.releaseNote.id}`)).status).toBe(204);
    const members = await owner.get(`/workspaces/${workspaceId}/members`);
    expect(
      (members.body as { id: string; groupIds: string[] }[]).find((m) => m.id === memberId)
        ?.groupIds,
    ).toEqual([groups[0]!.id]);

    expect((await owner.delete(`/workspaces/${workspaceId}/groups/${qa.body.id}`)).status).toBe(
      200,
    );
  });

  it('guards workspace actions and validates payloads', async () => {
    const { workspaceId, owner, member } = await setup();
    await owner.post(`/workspaces/${workspaceId}/members`, {
      email: 'member@example.com',
      role: 'MEMBER',
      permissions: { editWorkspace: true, canManageMembers: true },
    });

    const renamed = await member.patch(`/workspaces/${workspaceId}`, { name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Renamed');
    expect((await member.patch(`/workspaces/${workspaceId}`, { name: '' })).status).toBe(400);

    const denied = await member.post(`/workspaces/${workspaceId}/groups`, { name: 'Nope' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('WORKSPACE_PERMISSION_DENIED');
    expect((await owner.post(`/workspaces/${workspaceId}/groups`, {})).status).toBe(400);
    expect(
      (await owner.patch(`/workspaces/${workspaceId}/groups/missing`, { name: 'X' })).status,
    ).toBe(404);
    expect(
      (await owner.patch(`/workspaces/${workspaceId}/groups/missing`, { name: '' })).status,
    ).toBe(400);
    expect((await member.delete(`/workspaces/${workspaceId}/groups/missing`)).status).toBe(403);
    expect((await member.get('/workspaces/other/groups')).status).toBe(403);
    expect(
      (
        await owner.post(`/workspaces/${workspaceId}/members`, {
          email: 'x@example.com',
          role: 'MEMBER',
          groupIds: [''],
        })
      ).status,
    ).toBe(400);
  });
});
