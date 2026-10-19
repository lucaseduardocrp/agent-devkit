import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import {
  slugify,
  WorkspaceService,
} from '../src/modules/workspaces/application/workspace-service.js';
import { ApplicationError } from '../src/shared/errors.js';

describe('WorkspaceService', () => {
  function setup() {
    const authRepo = new InMemoryAuthRepository();
    const wsRepo = new InMemoryWorkspaceRepository();
    const service = new WorkspaceService(wsRepo, authRepo);
    return { authRepo, wsRepo, service };
  }

  describe('slugify helper', () => {
    it('converts accents, uppercase, and special chars to kebab-case', () => {
      expect(slugify('Espaço de Trabalho - QA!')).toBe('espaco-de-trabalho-qa');
      expect(slugify('   ')).toBe('workspace');
      expect(slugify('---test---')).toBe('test');
    });
  });

  describe('createWorkspace', () => {
    it('validates workspace name length', async () => {
      const { service } = setup();
      await expect(service.createWorkspace('u1', '')).rejects.toThrow(ApplicationError);
      await expect(service.createWorkspace('u1', 'a'.repeat(101))).rejects.toThrow(
        ApplicationError,
      );
    });

    it('creates workspace, adds creator as ADMIN, and handles slug collision', async () => {
      const { service } = setup();

      const res1 = await service.createWorkspace('u1', 'Alpha Corp', 'alpha');
      expect(res1.workspace.name).toBe('Alpha Corp');
      expect(res1.workspace.slug).toBe('alpha');
      expect(res1.member.role).toBe('ADMIN');
      expect(res1.member.permissions).toEqual({});
      expect(res1.access?.workspace.deleteWorkspace).toBe(true);
      expect(res1.access?.modules.integrations).toBe('delete');

      const res2 = await service.createWorkspace('u2', 'Alpha Team', 'alpha');
      expect(res2.workspace.slug).toMatch(/^alpha-/);
    });

    it('handles repeated slug collisions by appending full UUID after 5 attempts', async () => {
      const { service, wsRepo } = setup();
      const { vi } = await import('vitest');
      let findCount = 0;
      vi.spyOn(wsRepo, 'findBySlug').mockImplementation(() => {
        findCount++;
        if (findCount <= 6) {
          return Promise.resolve({
            id: 'ws-collision',
            name: 'Old',
            slug: 'collide',
            ownerId: 'u1',
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
        return Promise.resolve(null);
      });

      const res = await service.createWorkspace('u1', 'Collide');
      expect(res.workspace).toBeDefined();
    });
  });

  describe('listUserWorkspaces & getWorkspace', () => {
    it('lists user workspaces and fetches workspace details for members', async () => {
      const { service } = setup();
      const created = await service.createWorkspace('u1', 'Workspace A');

      const list = await service.listUserWorkspaces('u1');
      expect(list).toHaveLength(1);
      expect(list[0]?.workspace.id).toBe(created.workspace.id);

      const fetched = await service.getWorkspace(created.workspace.id, 'u1');
      expect(fetched.workspace.id).toBe(created.workspace.id);

      // non-member fails
      await expect(service.getWorkspace(created.workspace.id, 'u2')).rejects.toThrow(
        ApplicationError,
      );

      // workspace not found when member exists but ws deleted
      const { service: s2, wsRepo: r2 } = setup();
      await r2.addMember({ workspaceId: 'ws-ghost', userId: 'u1', role: 'MEMBER' });
      await expect(s2.getWorkspace('ws-ghost', 'u1')).rejects.toThrow(ApplicationError);
    });
  });

  describe('members management', () => {
    async function workspaceWith(...emails: string[]) {
      const context = setup();
      const created = await context.service.createWorkspace('admin-1', 'Workspace 1');
      for (const email of emails)
        await context.authRepo.createUser({ email, name: email.split('@')[0]!, passwordHash: 'h' });
      return { ...context, ...created };
    }

    it('lists members with their groups for workspace members and rejects non-members', async () => {
      const { service, workspace, member } = await workspaceWith();
      const [editors] = await service.listGroups(workspace.id, 'admin-1');
      await service.updateMember(workspace.id, 'admin-1', member.id, undefined, undefined, [
        editors!.id,
      ]);

      const members = await service.listMembers(workspace.id, 'admin-1');
      expect(members).toHaveLength(1);
      expect(members[0]?.groupIds).toEqual([editors!.id]);

      await expect(service.listMembers(workspace.id, 'stranger')).rejects.toThrow(ApplicationError);
    });

    it('adds members by email with workspace permissions and groups', async () => {
      const { service, workspace } = await workspaceWith(
        'collab@example.com',
        'viewer@example.com',
        'custom@example.com',
      );
      const groups = await service.listGroups(workspace.id, 'admin-1');

      const viewer = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'viewer@example.com',
        'VIEWER',
      );
      expect(viewer.permissions).toEqual({});
      expect(viewer.groupIds).toEqual([]);

      // Members without addMembers cannot add anyone.
      await expect(
        service.addMemberByEmail(workspace.id, viewer.userId, 'collab@example.com', 'MEMBER'),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });

      await expect(
        service.addMemberByEmail(workspace.id, 'admin-1', 'unknown@example.com', 'MEMBER'),
      ).rejects.toThrow('Usuário com este e-mail não encontrado na plataforma.');
      await expect(
        service.addMemberByEmail(workspace.id, 'admin-1', 'collab@example.com', 'MEMBER', {}, [
          'missing-group',
        ]),
      ).rejects.toMatchObject({ code: 'PERMISSION_GROUP_NOT_FOUND' });

      const added = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'collab@example.com',
        'INTEGRATOR',
        { addMembers: true, manageGroups: false },
        [groups[0]!.id, groups[0]!.id],
      );
      expect(added.role).toBe('INTEGRATOR');
      expect(added.permissions).toEqual({ addMembers: true });
      expect(added.groupIds).toEqual([groups[0]!.id]);
      const access = (await service.getWorkspace(workspace.id, added.userId)).access!;
      expect(access.modules.pbis).toBe('delete');
      expect(access.workspace.addMembers).toBe(true);
      expect(access.workspace.manageRoles).toBe(false);

      await expect(
        service.addMemberByEmail(workspace.id, 'admin-1', 'collab@example.com', 'MEMBER'),
      ).rejects.toThrow('Usuário já é membro deste workspace.');

      // A member who may add members cannot add administrators, set permissions or groups.
      for (const args of [
        ['ADMIN'],
        ['MEMBER', { addMembers: true }],
        ['MEMBER', undefined, [groups[0]!.id]],
      ] as const)
        await expect(
          service.addMemberByEmail(
            workspace.id,
            added.userId,
            'custom@example.com',
            ...(args as unknown as ['MEMBER']),
          ),
        ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      const plain = await service.addMemberByEmail(
        workspace.id,
        added.userId,
        'custom@example.com',
        'MEMBER',
      );
      expect(plain.groupIds).toEqual([]);
    });

    it('updates roles, permissions and groups and prevents demoting the last admin', async () => {
      const {
        service,
        workspace,
        member: adminMember,
      } = await workspaceWith('u2@example.com', 'u3@example.com');
      const [editors, viewers] = await service.listGroups(workspace.id, 'admin-1');
      const m2 = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'u2@example.com',
        'MEMBER',
      );
      const m3 = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'u3@example.com',
        'MEMBER',
      );

      // Without manageRoles / manageGroups
      await expect(
        service.updateMember(workspace.id, m2.userId, m3.id, 'VIEWER'),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      await expect(
        service.updateMember(workspace.id, m2.userId, m3.id, undefined, undefined, []),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });

      await expect(
        service.updateMember(workspace.id, 'admin-1', 'fake-id', 'VIEWER'),
      ).rejects.toThrow(ApplicationError);
      await expect(
        service.updateMember(workspace.id, 'admin-1', adminMember.id, 'MEMBER'),
      ).rejects.toThrow('O workspace deve ter pelo menos um administrador.');

      // Groups only
      const grouped = await service.updateMember(
        workspace.id,
        'admin-1',
        m3.id,
        undefined,
        undefined,
        [viewers!.id],
      );
      expect(grouped.groupIds).toEqual([viewers!.id]);
      expect((await service.getWorkspace(workspace.id, m3.userId)).access!.modules.pbis).toBe(
        'view',
      );

      // manageRoles allows changing roles, but not granting or touching administration.
      await service.updateMember(workspace.id, 'admin-1', m2.id, undefined, {
        manageRoles: true,
      });
      const viewerRole = await service.updateMember(workspace.id, m2.userId, m3.id, 'VIEWER');
      expect(viewerRole.role).toBe('VIEWER');
      expect(viewerRole.groupIds).toEqual([viewers!.id]);
      await expect(
        service.updateMember(workspace.id, m2.userId, m3.id, 'ADMIN'),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      await expect(
        service.updateMember(workspace.id, m2.userId, adminMember.id, 'MEMBER'),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      // Cannot grant a permission the actor lacks.
      await expect(
        service.updateMember(workspace.id, m2.userId, m3.id, undefined, { manageGroups: true }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });

      // Promote m2, then demoting the first admin is allowed.
      await service.updateMember(workspace.id, 'admin-1', m2.id, 'ADMIN', undefined, [editors!.id]);
      const demoted = await service.updateMember(workspace.id, 'admin-1', adminMember.id, 'MEMBER');
      expect(demoted.role).toBe('MEMBER');
      expect(demoted.groupIds).toEqual([]);
    });

    it('removes members with removeMembers and prevents removing the last admin', async () => {
      const {
        service,
        workspace,
        member: adminMember,
      } = await workspaceWith('u2@example.com', 'u3@example.com');
      const m2 = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'u2@example.com',
        'MEMBER',
      );
      const m3 = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'u3@example.com',
        'VIEWER',
      );

      await expect(service.removeMember(workspace.id, 'stranger', m2.id)).rejects.toThrow(
        ApplicationError,
      );
      await expect(service.removeMember(workspace.id, 'admin-1', 'fake-id')).rejects.toThrow(
        ApplicationError,
      );
      await expect(service.removeMember(workspace.id, m2.userId, m3.id)).rejects.toMatchObject({
        code: 'WORKSPACE_PERMISSION_DENIED',
      });

      // removeMembers allows removing others, except administrators.
      await service.updateMember(workspace.id, 'admin-1', m2.id, undefined, {
        removeMembers: true,
      });
      await expect(
        service.removeMember(workspace.id, m2.userId, adminMember.id),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      await service.removeMember(workspace.id, m2.userId, m3.id);

      // Self-removal is always allowed.
      await service.removeMember(workspace.id, m2.userId, m2.id);
      expect(await service.listMembers(workspace.id, 'admin-1')).toHaveLength(1);

      await expect(service.removeMember(workspace.id, 'admin-1', adminMember.id)).rejects.toThrow(
        'Não é possível remover o único administrador do workspace.',
      );
    });

    it('lets the last but one admin be removed by another admin', async () => {
      const { service, workspace, member: adminMember } = await workspaceWith('u2@example.com');
      const m2 = await service.addMemberByEmail(workspace.id, 'admin-1', 'u2@example.com', 'ADMIN');
      await service.removeMember(workspace.id, m2.userId, adminMember.id);
      expect(await service.listMembers(workspace.id, m2.userId)).toHaveLength(1);
    });

    it('renames and deletes the workspace with the matching workspace permissions', async () => {
      const {
        service,
        wsRepo,
        workspace,
        member: adminMember,
      } = await workspaceWith('member@example.com');
      const member = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'member@example.com',
        'MEMBER',
      );

      await expect(
        service.renameWorkspace(workspace.id, member.userId, 'New'),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      await service.updateMember(workspace.id, 'admin-1', member.id, undefined, {
        editWorkspace: true,
      });
      expect((await service.renameWorkspace(workspace.id, member.userId, '  New  ')).name).toBe(
        'New',
      );
      await expect(service.renameWorkspace(workspace.id, 'admin-1', ' ')).rejects.toMatchObject({
        code: 'INVALID_WORKSPACE_NAME',
      });

      await expect(service.deleteWorkspace(workspace.id, 'stranger')).rejects.toMatchObject({
        code: 'WORKSPACE_ACCESS_DENIED',
      });
      await expect(service.deleteWorkspace(workspace.id, member.userId)).rejects.toMatchObject({
        code: 'WORKSPACE_PERMISSION_DENIED',
      });

      vi.spyOn(wsRepo, 'findById').mockResolvedValueOnce(null);
      await expect(service.deleteWorkspace(workspace.id, adminMember.userId)).rejects.toThrow(
        'Workspace não encontrado.',
      );

      const auditedDelete = vi.fn((_id: string, remove: () => Promise<void>) => remove());
      await service.deleteWorkspace(workspace.id, adminMember.userId, auditedDelete);
      expect(auditedDelete).toHaveBeenCalledWith(workspace.id, expect.any(Function));
      expect(await wsRepo.findById(workspace.id)).toBeNull();
      expect(await wsRepo.findMember(workspace.id, adminMember.userId)).toBeNull();
      expect(await wsRepo.listGroups(workspace.id)).toEqual([]);
    });
  });

  describe('permission groups', () => {
    it('seeds localized default groups and grants modules through membership', async () => {
      const { service, authRepo } = setup();
      const pt = await service.createWorkspace('admin-1', 'PT');
      expect((await service.listGroups(pt.workspace.id, 'admin-1')).map((g) => g.name)).toEqual([
        'Editores',
        'Leitores',
      ]);
      const en = await service.createWorkspace('admin-1', 'EN', undefined, 'en-US');
      const [editors, viewers] = await service.listGroups(en.workspace.id, 'admin-1');
      expect([editors!.name, viewers!.name]).toEqual(['Editors', 'Viewers']);
      expect(viewers!.modules.integrations).toBeUndefined();
      expect(editors!.modules.integrations).toBe('view');

      await authRepo.createUser({ email: 'u@example.com', name: 'U', passwordHash: 'h' });
      const member = await service.addMemberByEmail(
        en.workspace.id,
        'admin-1',
        'u@example.com',
        'MEMBER',
        undefined,
        [editors!.id, viewers!.id],
      );
      const [membership] = await service.listUserWorkspaces(member.userId);
      expect(membership?.access?.modules).toMatchObject({ pbis: 'delete', integrations: 'view' });
      await expect(service.listGroups(en.workspace.id, 'stranger')).rejects.toMatchObject({
        code: 'WORKSPACE_ACCESS_DENIED',
      });
    });

    it('creates, updates and deletes groups with validation', async () => {
      const { service, authRepo } = setup();
      const { workspace, member: admin } = await service.createWorkspace('admin-1', 'WS');
      await authRepo.createUser({ email: 'u@example.com', name: 'U', passwordHash: 'h' });
      const member = await service.addMemberByEmail(
        workspace.id,
        'admin-1',
        'u@example.com',
        'MEMBER',
      );

      await expect(
        service.createGroup(workspace.id, member.userId, { name: 'QA' }),
      ).rejects.toMatchObject({ code: 'WORKSPACE_PERMISSION_DENIED' });
      await expect(
        service.createGroup(workspace.id, 'admin-1', { name: ' ' }),
      ).rejects.toMatchObject({ code: 'INVALID_PERMISSION_GROUP' });
      await expect(service.createGroup(workspace.id, 'admin-1', {})).rejects.toMatchObject({
        code: 'INVALID_PERMISSION_GROUP',
      });
      await expect(
        service.createGroup(workspace.id, 'admin-1', { name: 'editores' }),
      ).rejects.toMatchObject({ code: 'PERMISSION_GROUP_NAME_TAKEN' });
      await expect(
        service.createGroup(workspace.id, 'admin-1', { name: 'QA', memberIds: ['ghost'] }),
      ).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });

      const qa = await service.createGroup(workspace.id, 'admin-1', {
        name: ' QA ',
        description: ' Testers ',
        modules: { testplans: 'delete', e2e: 'edit', pbis: 'none', brain: 'bogus' } as never,
        memberIds: [member.id, member.id],
      });
      expect(qa).toMatchObject({
        name: 'QA',
        description: 'Testers',
        modules: { testplans: 'delete', e2e: 'edit' },
        memberIds: [member.id],
      });
      const access = (await service.getWorkspace(workspace.id, member.userId)).access!;
      expect(access.modules).toMatchObject({ testplans: 'delete', e2e: 'edit', pbis: 'none' });

      await expect(
        service.updateGroup(workspace.id, 'admin-1', 'missing', { name: 'X' }),
      ).rejects.toMatchObject({ code: 'PERMISSION_GROUP_NOT_FOUND' });
      await expect(
        service.updateGroup(workspace.id, 'admin-1', qa.id, { name: 'Leitores' }),
      ).rejects.toMatchObject({ code: 'PERMISSION_GROUP_NAME_TAKEN' });
      const renamed = await service.updateGroup(workspace.id, 'admin-1', qa.id, {
        name: 'qa',
        memberIds: [admin.id],
      });
      expect(renamed).toMatchObject({ name: 'qa', memberIds: [admin.id], description: 'Testers' });
      const kept = await service.updateGroup(workspace.id, 'admin-1', qa.id, {
        modules: { pbis: 'view' },
      });
      expect(kept).toMatchObject({ name: 'qa', modules: { pbis: 'view' }, memberIds: [admin.id] });

      // Groups of another workspace are not reachable.
      const other = await service.createWorkspace('admin-1', 'Other');
      await expect(service.deleteGroup(other.workspace.id, 'admin-1', qa.id)).rejects.toMatchObject(
        { code: 'PERMISSION_GROUP_NOT_FOUND' },
      );

      await service.deleteGroup(workspace.id, 'admin-1', qa.id);
      expect((await service.listGroups(workspace.id, 'admin-1')).map((g) => g.id)).not.toContain(
        qa.id,
      );
    });
  });

  describe('ensureDefaultWorkspace', () => {
    it('creates default workspace when user has none, and reuses when existing', async () => {
      const { service } = setup();
      const ws1 = await service.ensureDefaultWorkspace({
        id: 'u-default',
        name: 'Ana',
        email: 'ana@example.com',
      });
      expect(ws1.workspace.name).toBe("Ana's Workspace");

      const ws2 = await service.ensureDefaultWorkspace({
        id: 'u-default',
        name: 'Ana',
        email: 'ana@example.com',
      });
      expect(ws2.workspace.id).toBe(ws1.workspace.id);

      // fallback name
      const wsFallback = await service.ensureDefaultWorkspace({
        id: 'u-anon',
        name: '',
        email: 'bot@example.com',
      });
      expect(wsFallback.workspace.name).toBe("bot's Workspace");

      // fallback to 'Meu' when email has no username part
      const wsMeu = await service.ensureDefaultWorkspace({
        id: 'u-meu',
        name: '',
        email: '@example.com',
      });
      expect(wsMeu.workspace.name).toBe("Meu's Workspace");
    });
  });
});
