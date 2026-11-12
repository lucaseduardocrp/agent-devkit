import { describe, expect, it, vi } from 'vitest';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import {
  PrismaWorkspaceRepository,
  type PrismaWorkspacesClient,
} from '../src/modules/workspaces/adapters/prisma-workspace-repository.js';
import { cachedWorkspaceRepository } from '../src/modules/workspaces/application/cached-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

async function workspaceWith(names: readonly string[]) {
  const repo = new InMemoryWorkspaceRepository();
  const workspace = await repo.createWorkspace({ name: 'W', slug: 'w', ownerId: 'u0' });
  for (const [index, name] of names.entries()) {
    repo.registerUser({ id: `u${index}`, name, email: `${name.toLowerCase()}@x.com` });
    await repo.addMember({ workspaceId: workspace.id, userId: `u${index}`, role: 'MEMBER' });
  }
  return { repo, workspace };
}

describe('searching the members of a workspace', () => {
  it('pages through the members and counts all that match, in memory', async () => {
    const { repo, workspace } = await workspaceWith(['Ana', 'Ben', 'Cai', 'Anabel']);

    const page = await repo.searchMembers(workspace.id, { search: '', offset: 1, limit: 2 });
    expect(page.members.map((member) => member.user?.name)).toEqual(['Ben', 'Cai']);
    expect(page.total).toBe(4);

    // Name or e-mail, whatever the case; the total is of the matches, not of the page.
    const found = await repo.searchMembers(workspace.id, { search: ' ANA', offset: 0, limit: 1 });
    expect(found.members.map((member) => member.user?.name)).toEqual(['Ana']);
    expect(found.total).toBe(2);
    expect(
      (await repo.searchMembers(workspace.id, { search: 'cai@x', offset: 0, limit: 9 })).total,
    ).toBe(1);
  });

  it('does not match a member whose user is unknown, but still lists them', async () => {
    const repo = new InMemoryWorkspaceRepository();
    const workspace = await repo.createWorkspace({ name: 'W', slug: 'w', ownerId: 'u0' });
    await repo.addMember({ workspaceId: workspace.id, userId: 'ghost', role: 'MEMBER' });
    expect(
      (await repo.searchMembers(workspace.id, { search: '', offset: 0, limit: 5 })).total,
    ).toBe(1);
    expect(
      (await repo.searchMembers(workspace.id, { search: 'x', offset: 0, limit: 5 })).total,
    ).toBe(0);
  });

  it('asks the database for one page, filtered by name or e-mail', async () => {
    const row = {
      id: 'm1',
      workspaceId: 'ws',
      userId: 'u1',
      role: 'MEMBER' as const,
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      user: { id: 'u1', name: 'Ana', email: 'ana@x.com' },
    };
    const findMany = vi.fn(async () => [row]);
    const count = vi.fn(async () => 41);
    const client = {
      workspaceMemberRecord: { findMany, count },
    } as unknown as PrismaWorkspacesClient;
    const repo = new PrismaWorkspaceRepository(client);

    const page = await repo.searchMembers('ws', { search: ' ana ', offset: 25, limit: 25 });
    expect(page.total).toBe(41);
    expect(page.members[0]?.user?.name).toBe('Ana');
    const where = {
      workspaceId: 'ws',
      user: {
        OR: [
          { name: { contains: 'ana', mode: 'insensitive' } },
          { email: { contains: 'ana', mode: 'insensitive' } },
        ],
      },
    };
    expect(findMany).toHaveBeenCalledWith({
      where,
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: 25,
      take: 25,
    });
    expect(count).toHaveBeenCalledWith({ where });

    // Without a search there is no filter on the user at all.
    await repo.searchMembers('ws', { search: '  ', offset: 0, limit: 10 });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws' } }),
    );
  });

  it('is not cached, since a page depends on what was typed', async () => {
    const { repo, workspace } = await workspaceWith(['Ana']);
    const spy = vi.spyOn(repo, 'searchMembers');
    const cache = { json: vi.fn(), invalidate: vi.fn() };
    const cached = cachedWorkspaceRepository(repo, cache as never);
    const query = { search: 'a', offset: 0, limit: 5 };
    expect((await cached.searchMembers(workspace.id, query)).total).toBe(1);
    expect(spy).toHaveBeenCalledWith(workspace.id, query);
    expect(cache.json).not.toHaveBeenCalled();
  });

  it('gives the service the people of a page, finding a missing user in the accounts', async () => {
    const { repo, workspace } = await workspaceWith(['Ana', 'Ben']);
    const auth = new InMemoryAuthRepository();
    await repo.addMember({ workspaceId: workspace.id, userId: 'orphan', role: 'MEMBER' });
    await repo.addMember({ workspaceId: workspace.id, userId: 'nobody', role: 'MEMBER' });
    const account = await auth.createUser({
      name: 'Orphan',
      email: 'orphan@x.com',
      passwordHash: 'x',
    } as never);
    vi.spyOn(auth, 'findById').mockImplementation(async (id) => (id === 'orphan' ? account : null));
    const service = new WorkspaceService(repo, auth);

    const page = await service.searchMemberContacts(workspace.id, {
      search: '',
      offset: 0,
      limit: 10,
    });
    // "nobody" has no account at all, so there is no one to show.
    expect(page.people.map((person) => person.name)).toEqual(['Ana', 'Ben', 'Orphan']);
    expect(page.total).toBe(4);
  });
});
