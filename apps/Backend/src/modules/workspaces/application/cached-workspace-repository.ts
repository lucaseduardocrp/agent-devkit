import { reviveDates, type Cache } from '../../../shared/cache.js';
import type { WorkspaceRepository } from './workspace-repository.js';

/** Cache scope of one workspace's access data: members, groups and the workspace itself. */
const scope = (workspaceId: string): string => `workspace:${workspaceId}`;
const revive = reviveDates('createdAt', 'updatedAt');
// Every write below invalidates at once; the TTL only bounds changes made outside this API.
const TTL_SECONDS = 5 * 60;

/**
 * Serves the reads every authenticated request makes (membership, workspace, permission
 * groups) from the cache, so a request does not start with several database round trips.
 */
export function cachedWorkspaceRepository(
  repository: WorkspaceRepository,
  cache: Cache,
): WorkspaceRepository {
  const read = <T>(workspaceId: string, key: string, load: () => Promise<T>) =>
    cache.json(scope(workspaceId), key, TTL_SECONDS, load, revive);
  const invalidate = (workspaceId: string | null | undefined) =>
    workspaceId ? cache.invalidate(scope(workspaceId)) : Promise.resolve();
  return {
    createWorkspace: (input) => repository.createWorkspace(input),
    findById: (id) => read(id, 'workspace', () => repository.findById(id)),
    findBySlug: (slug) => repository.findBySlug(slug),
    listUserWorkspaces: (userId) => repository.listUserWorkspaces(userId),
    async addMember(input) {
      const member = await repository.addMember(input);
      await invalidate(input.workspaceId);
      return member;
    },
    findMember: (workspaceId, userId) =>
      read(workspaceId, `member:${userId}`, () => repository.findMember(workspaceId, userId)),
    findMemberById: (memberId) => repository.findMemberById(memberId),
    listMembers: (workspaceId) =>
      read(workspaceId, 'members', () => repository.listMembers(workspaceId)),
    async updateMember(memberId, input) {
      const member = await repository.updateMember(memberId, input);
      await invalidate(member.workspaceId);
      return member;
    },
    async deleteMember(memberId) {
      const member = await repository.findMemberById(memberId);
      await repository.deleteMember(memberId);
      await invalidate(member?.workspaceId);
    },
    countAdmins: (workspaceId) => repository.countAdmins(workspaceId),
    async deleteWorkspace(id) {
      await repository.deleteWorkspace(id);
      await invalidate(id);
    },
    async renameWorkspace(id, name) {
      const workspace = await repository.renameWorkspace(id, name);
      await invalidate(id);
      return workspace;
    },
    listGroups: (workspaceId) =>
      read(workspaceId, 'groups', () => repository.listGroups(workspaceId)),
    findGroup: (groupId) => repository.findGroup(groupId),
    async createGroup(input) {
      const group = await repository.createGroup(input);
      await invalidate(input.workspaceId);
      return group;
    },
    async updateGroup(groupId, input) {
      const group = await repository.updateGroup(groupId, input);
      await invalidate(group.workspaceId);
      return group;
    },
    async deleteGroup(groupId) {
      const group = await repository.findGroup(groupId);
      await repository.deleteGroup(groupId);
      await invalidate(group?.workspaceId);
    },
    async setMemberGroups(workspaceId, memberId, groupIds) {
      await repository.setMemberGroups(workspaceId, memberId, groupIds);
      await invalidate(workspaceId);
    },
  };
}
