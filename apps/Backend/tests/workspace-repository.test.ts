import { describe, expect, it, vi } from 'vitest';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import {
  PrismaWorkspaceRepository,
  type PrismaWorkspacesClient,
} from '../src/modules/workspaces/adapters/prisma-workspace-repository.js';

describe('Workspace Repositories', () => {
  describe('InMemoryWorkspaceRepository', () => {
    it('handles registerUser, duplicate slug error, update not found, and admin count', async () => {
      const repo = new InMemoryWorkspaceRepository();
      repo.registerUser({ id: 'u1', name: 'User 1', email: 'u1@test.com' });

      const ws = await repo.createWorkspace({ name: 'Alpha', slug: 'alpha', ownerId: 'u1' });
      expect(ws.slug).toBe('alpha');

      // duplicate slug throws error
      await expect(
        repo.createWorkspace({ name: 'Alpha 2', slug: 'alpha', ownerId: 'u1' }),
      ).rejects.toThrow('already exists');

      // addMember with duplicate throws error
      await repo.addMember({ workspaceId: ws.id, userId: 'u1', role: 'ADMIN' });
      await expect(
        repo.addMember({ workspaceId: ws.id, userId: 'u1', role: 'ADMIN' }),
      ).rejects.toThrow('already a member');

      // countAdmins
      expect(await repo.countAdmins(ws.id)).toBe(1);

      // update member with undefined role & permissions keeps existing
      const m1 = await repo.addMember({ workspaceId: ws.id, userId: 'u2', role: 'MEMBER' });
      const updatedM1 = await repo.updateMember(m1.id, {});
      expect(updatedM1.role).toBe('MEMBER');

      // update non-existing member
      await expect(repo.updateMember('fake-m', { role: 'VIEWER' })).rejects.toThrow(
        'Member not found',
      );

      // deleteWorkspace removes workspace and its members
      await repo.deleteWorkspace(ws.id);
      expect(await repo.findById(ws.id)).toBeNull();
      expect(await repo.findMember(ws.id, 'u1')).toBeNull();
    });

    it('keeps permission groups, memberships and renames consistent', async () => {
      const repo = new InMemoryWorkspaceRepository();
      const ws = await repo.createWorkspace({ name: 'Alpha', slug: 'alpha', ownerId: 'u1' });
      const other = await repo.createWorkspace({ name: 'Beta', slug: 'beta', ownerId: 'u1' });
      expect((await repo.renameWorkspace(ws.id, 'Alpha 2')).name).toBe('Alpha 2');
      await expect(repo.renameWorkspace('missing', 'X')).rejects.toThrow('Workspace not found');

      const m1 = await repo.addMember({ workspaceId: ws.id, userId: 'u1', role: 'MEMBER' });
      const base = { workspaceId: ws.id, description: '', modules: {} };
      const b = await repo.createGroup({ ...base, name: 'B', memberIds: [m1.id, m1.id] });
      const a = await repo.createGroup({ ...base, name: 'A', memberIds: [] });
      const foreign = await repo.createGroup({
        ...base,
        workspaceId: other.id,
        name: 'Foreign',
        memberIds: [],
      });
      expect(b.memberIds).toEqual([m1.id]);
      expect((await repo.listGroups(ws.id)).map((group) => group.name)).toEqual(['A', 'B']);
      expect(await repo.findGroup('missing')).toBeNull();

      await repo.setMemberGroups(ws.id, m1.id, [a.id]);
      expect((await repo.findGroup(a.id))?.memberIds).toEqual([m1.id]);
      expect((await repo.findGroup(b.id))?.memberIds).toEqual([]);
      expect((await repo.findGroup(foreign.id))?.memberIds).toEqual([]);

      const renamed = await repo.updateGroup(a.id, { name: 'A2', memberIds: [m1.id, m1.id] });
      expect(renamed).toMatchObject({ name: 'A2', memberIds: [m1.id] });
      const unchanged = await repo.updateGroup(a.id, {});
      expect(unchanged).toMatchObject({ name: 'A2', description: '', modules: {} });
      await expect(repo.updateGroup('missing', {})).rejects.toThrow('Group not found');

      // Deleting a member removes it from its groups; other groups stay untouched.
      await repo.deleteMember(m1.id);
      expect((await repo.findGroup(a.id))?.memberIds).toEqual([]);

      await repo.deleteGroup(b.id);
      expect(await repo.findGroup(b.id)).toBeNull();
      await repo.deleteWorkspace(ws.id);
      expect(await repo.listGroups(ws.id)).toEqual([]);
      expect(await repo.listGroups(other.id)).toHaveLength(1);
    });
  });

  describe('PrismaWorkspaceRepository', () => {
    it('maps all Prisma delegate operations correctly', async () => {
      const mockDate = new Date();
      const mockWorkspaceRecord = {
        id: 'ws-1',
        name: 'Workspace 1',
        slug: 'ws-1',
        ownerId: 'u-1',
        createdAt: mockDate,
        updatedAt: mockDate,
      };

      const mockMemberRecord = {
        id: 'm-1',
        workspaceId: 'ws-1',
        userId: 'u-1',
        role: 'ADMIN' as const,
        permissions: { canManageIntegrations: true },
        createdAt: mockDate,
        updatedAt: mockDate,
        user: { id: 'u-1', name: 'Ana', email: 'ana@test.com' },
        workspace: mockWorkspaceRecord,
      };

      const groupRecord = {
        id: 'g-1',
        workspaceId: 'ws-1',
        name: 'QA',
        description: '',
        modules: { testplans: 'delete', pbis: 'bogus' },
        createdAt: mockDate,
        updatedAt: mockDate,
        members: [{ memberId: 'm-1' }],
      };
      const mockClient: PrismaWorkspacesClient = {
        workspaceRecord: {
          create: vi.fn().mockResolvedValue(mockWorkspaceRecord),
          findUnique: vi.fn().mockImplementation((args) => {
            if (args.where.id === 'ws-1' || args.where.slug === 'ws-1') {
              return Promise.resolve(mockWorkspaceRecord);
            }
            return Promise.resolve(null);
          }),
          update: vi.fn().mockResolvedValue({ ...mockWorkspaceRecord, name: 'Renamed' }),
          delete: vi.fn().mockResolvedValue(mockWorkspaceRecord),
        },
        permissionGroupRecord: {
          findMany: vi.fn().mockResolvedValue([groupRecord]),
          findUnique: vi
            .fn()
            .mockImplementation((args: { where: { id: string } }) =>
              Promise.resolve(args.where.id === 'g-1' ? groupRecord : null),
            ),
          create: vi.fn().mockResolvedValue(groupRecord),
          update: vi.fn().mockResolvedValue({ ...groupRecord, members: undefined }),
          delete: vi.fn().mockResolvedValue(groupRecord),
        },
        permissionGroupMemberRecord: {
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        $transaction: vi.fn((operation: (client: PrismaWorkspacesClient) => Promise<unknown>) =>
          operation(mockClient),
        ) as PrismaWorkspacesClient['$transaction'],
        workspaceMemberRecord: {
          create: vi.fn().mockResolvedValue(mockMemberRecord),
          findUnique: vi.fn().mockImplementation((args) => {
            if (args.where.id === 'm-1' || args.where.workspaceId_userId?.userId === 'u-1') {
              return Promise.resolve(mockMemberRecord);
            }
            return Promise.resolve(null);
          }),
          findMany: vi.fn().mockImplementation((args) => {
            if (args.where.userId === 'u-1') {
              // A membership read without its workspace is skipped.
              return Promise.resolve([
                mockMemberRecord,
                { ...mockMemberRecord, id: 'm-3', workspace: undefined },
              ]);
            }
            if (args.where.workspaceId === 'ws-1') {
              return Promise.resolve([
                mockMemberRecord,
                { ...mockMemberRecord, id: 'm-2', user: undefined, permissions: null },
              ]);
            }
            return Promise.resolve([]);
          }),
          update: vi.fn().mockResolvedValue({ ...mockMemberRecord, role: 'MEMBER' as const }),
          delete: vi.fn().mockResolvedValue({ id: 'm-1' }),
          count: vi.fn().mockResolvedValue(1),
        },
      };

      const repo = new PrismaWorkspaceRepository(mockClient);

      // createWorkspace
      const ws = await repo.createWorkspace({ name: 'Workspace 1', slug: 'ws-1', ownerId: 'u-1' });
      expect(ws.id).toBe('ws-1');

      // findById & findBySlug
      expect(await repo.findById('ws-1')).toEqual(mockWorkspaceRecord);
      expect(await repo.findBySlug('ws-1')).toEqual(mockWorkspaceRecord);
      expect(await repo.findById('fake')).toBeNull();

      // listUserWorkspaces
      const list = await repo.listUserWorkspaces('u-1');
      expect(list).toHaveLength(1);
      expect(list[0]?.workspace.id).toBe('ws-1');
      expect(list[0]?.member.user?.name).toBe('Ana');

      // addMember
      const m = await repo.addMember({ workspaceId: 'ws-1', userId: 'u-1', role: 'ADMIN' });
      expect(m.id).toBe('m-1');

      // findMember & findMemberById
      expect(await repo.findMember('ws-1', 'u-1')).not.toBeNull();
      expect(await repo.findMember('ws-1', 'fake')).toBeNull();
      expect(await repo.findMemberById('m-1')).not.toBeNull();
      expect(await repo.findMemberById('fake')).toBeNull();

      // listMembers
      const members = await repo.listMembers('ws-1');
      expect(members).toHaveLength(2);
      expect(members[1]?.user).toBeUndefined();

      // updateMember
      const updated = await repo.updateMember('m-1', {
        role: 'MEMBER',
        permissions: { canManageIntegrations: false },
      });
      expect(updated.role).toBe('MEMBER');
      await repo.updateMember('m-1', {});
      expect(mockClient.workspaceMemberRecord.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: {} }),
      );

      // deleteMember
      await repo.deleteMember('m-1');
      expect(mockClient.workspaceMemberRecord.delete).toHaveBeenCalledWith({
        where: { id: 'm-1' },
      });

      // countAdmins
      const count = await repo.countAdmins('ws-1');
      expect(count).toBe(1);

      // deleteWorkspace without optional delegates
      await repo.deleteWorkspace('ws-1');
      expect(mockClient.workspaceRecord.delete).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
      });

      // renameWorkspace and permission groups
      expect((await repo.renameWorkspace('ws-1', 'Renamed')).name).toBe('Renamed');
      const groups = await repo.listGroups('ws-1');
      expect(groups[0]).toMatchObject({
        id: 'g-1',
        modules: { testplans: 'delete' },
        memberIds: ['m-1'],
      });
      expect(await repo.findGroup('g-1')).toMatchObject({ name: 'QA' });
      expect(await repo.findGroup('missing')).toBeNull();
      await repo.createGroup({
        workspaceId: 'ws-1',
        name: 'QA',
        description: '',
        modules: {},
        memberIds: ['m-1', 'm-1'],
      });
      expect(mockClient.permissionGroupRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ members: { create: [{ memberId: 'm-1' }] } }),
        }),
      );
      expect((await repo.updateGroup('g-1', { name: 'QA 2' })).memberIds).toEqual([]);
      await repo.updateGroup('g-1', { memberIds: ['m-1'] });
      expect(mockClient.permissionGroupRecord.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            members: { deleteMany: {}, create: [{ memberId: 'm-1' }] },
          }),
        }),
      );
      await repo.deleteGroup('g-1');
      expect(mockClient.permissionGroupRecord.delete).toHaveBeenCalledWith({
        where: { id: 'g-1' },
      });
      await repo.setMemberGroups('ws-1', 'm-1', []);
      expect(mockClient.permissionGroupMemberRecord.createMany).not.toHaveBeenCalled();
      await repo.setMemberGroups('ws-1', 'm-1', ['g-1']);
      expect(mockClient.permissionGroupMemberRecord.deleteMany).toHaveBeenCalledWith({
        where: { memberId: 'm-1', group: { workspaceId: 'ws-1' } },
      });
      expect(mockClient.permissionGroupMemberRecord.createMany).toHaveBeenCalledWith({
        data: [{ groupId: 'g-1', memberId: 'm-1' }],
        skipDuplicates: true,
      });

      // deleteWorkspace with knowledgeChunkRecord and integrationRecord delegates
      const chunkDeleteSpy = vi.fn().mockResolvedValue({ count: 2 });
      const relationDeleteSpy = vi.fn().mockResolvedValue({ count: 2 });
      const integrationDeleteSpy = vi.fn().mockResolvedValue({ count: 1 });
      const auditDeleteSpy = vi.fn().mockResolvedValue({ count: 3 });
      const fullClient: PrismaWorkspacesClient = {
        ...mockClient,
        knowledgeChunkRecord: { deleteMany: chunkDeleteSpy },
        knowledgeRelationRecord: { deleteMany: relationDeleteSpy },
        integrationRecord: { deleteMany: integrationDeleteSpy },
        auditEventRecord: { deleteMany: auditDeleteSpy },
      };
      const fullRepo = new PrismaWorkspaceRepository(fullClient);
      await fullRepo.deleteWorkspace('ws-1');
      expect(chunkDeleteSpy).toHaveBeenCalledWith({ where: { ownerId: 'ws-1' } });
      expect(relationDeleteSpy).toHaveBeenCalledWith({ where: { ownerId: 'ws-1' } });
      expect(integrationDeleteSpy).toHaveBeenCalledWith({ where: { ownerId: 'ws-1' } });
      expect(auditDeleteSpy).toHaveBeenCalledWith({ where: { workspaceId: 'ws-1' } });
    });
  });
});
