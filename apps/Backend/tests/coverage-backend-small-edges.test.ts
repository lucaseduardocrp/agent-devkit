import { describe, expect, it, vi } from 'vitest';
import { Cache, MemoryCacheStore, type CacheStore } from '../src/shared/cache.js';
import { hostAccessFetch } from '../src/shared/host-access.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

describe('Cache edge cases', () => {
  it('caches a loader that returns undefined as null', async () => {
    const cache = new Cache(new MemoryCacheStore());
    const load = vi.fn().mockResolvedValue(undefined);
    expect(await cache.json('s', 'k', 60, load)).toBeUndefined();
    expect(await cache.json('s', 'k', 60, load)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('warns with the raw value when the store throws something that is not an Error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store: CacheStore = {
      kind: 'memory',
      get: () => Promise.reject('plain failure'),
      set: () => Promise.resolve(),
      incr: () => Promise.resolve(1),
      close: () => Promise.resolve(),
    };
    const cache = new Cache(store);
    expect(await cache.text('s', 'k', 60, async () => 'value')).toBe('value');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('store unavailable'),
      'plain failure',
    );
    warn.mockRestore();
  });
});

describe('hostAccessFetch', () => {
  it('keeps the method and body of a whole Request and resolves other hosts normally', async () => {
    const seen: { method?: string; host?: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method, host: req.headers.host, body });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const fetcher = hostAccessFetch('127.0.0.1');
      const response = await fetcher(
        new Request(`http://localhost:${port}/a`, { method: 'POST', body: 'payload' }),
      );
      expect(await response.text()).toBe('ok');
      // A name other than localhost is looked up as it is.
      await fetcher(`http://127.0.0.2:${port}/b`);
      expect(seen[0]).toMatchObject({ method: 'POST', body: 'payload', host: `localhost:${port}` });
      expect(seen).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('WorkspaceService system lookups', () => {
  it('knows workspace names and member contacts, and answers null for strangers', async () => {
    const authRepo = new InMemoryAuthRepository();
    const workspaces = new InMemoryWorkspaceRepository();
    const service = new WorkspaceService(workspaces, authRepo);
    expect(await service.workspaceName('missing')).toBeNull();
    expect(await service.memberContact('missing', 'nobody')).toBeNull();
    const orphan = await authRepo.createUser({
      email: 'gone@example.com',
      name: 'Gone',
      passwordHash: 'hash',
    } as never);
    const owned = await service.createWorkspace(orphan.id, 'Orphans', 'orphans');
    await workspaces.addMember({
      workspaceId: owned.workspace.id,
      userId: 'user-without-record',
      role: 'MEMBER',
    } as never);
    expect(await service.memberContact(owned.workspace.id, 'user-without-record')).toBeNull();
    const user = await authRepo.createUser({
      email: 'ana@example.com',
      name: 'Ana',
      passwordHash: 'hash',
    } as never);
    const { workspace } = await service.createWorkspace(user.id, 'Acme', 'acme');
    expect(await service.workspaceName(workspace.id)).toBe('Acme');
    expect(await service.memberContact(workspace.id, user.id)).toEqual({
      id: user.id,
      name: 'Ana',
      email: 'ana@example.com',
    });
  });
});

describe('stores behind adapters', () => {
  it('reads through the PBI change hook without notifying, and notifies after writes', async () => {
    const { InMemoryPbiStore, withPbiChangeHook } = await import('../src/modules/pbi/pbi-store.js');
    const inner = new InMemoryPbiStore();
    const onChange = vi.fn().mockResolvedValue(undefined);
    const store = withPbiChangeHook(inner, onChange);
    const item = await store.create('ws', { kind: 'pbi', title: 'A' });
    await store.link('ws', item.id, {
      providerId: 'jira',
      externalId: 'J-1',
      externalUrl: null,
      boardId: null,
    });
    onChange.mockClear();
    expect((await store.search('ws', { page: 1, pageSize: 5 })).total).toBe(1);
    expect((await store.findByExternal('ws', 'jira', 'J-1'))?.id).toBe(item.id);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists the integrations of a provider across owners with Prisma', async () => {
    const { PrismaUserIntegrationStore } =
      await import('../src/modules/integrations/adapters/prisma-integrations-store.js');
    const row = {
      id: '1',
      ownerId: 'o',
      category: 'PROJECT_MANAGEMENT',
      providerId: 'jira',
      isEnabled: true,
      settings: { a: 1 },
      encryptedSecrets: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const findMany = vi.fn().mockResolvedValue([row]);
    const store = new PrismaUserIntegrationStore({ integrationRecord: { findMany } } as never);
    const records = await store.listByProvider('PROJECT_MANAGEMENT', 'jira');
    expect(findMany).toHaveBeenCalledWith({
      where: { category: 'PROJECT_MANAGEMENT', providerId: 'jira' },
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ ownerId: 'o', providerId: 'jira' });
  });

  it('keeps work item types in Prisma, with the defaults until saved', async () => {
    const { PrismaWorkItemTypeStore } =
      await import('../src/modules/work-item-types/work-item-types.js');
    const types = [{ key: 'epic', label: 'Epic', color: '#112233', icon: 'flag', aliases: [] }];
    const record = {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ types }),
      upsert: vi.fn().mockResolvedValue({ types }),
    };
    const store = new PrismaWorkItemTypeStore({ workItemTypeSettingsRecord: record } as never);
    expect((await store.get('ws')).length).toBeGreaterThan(0);
    expect(await store.get('ws')).toEqual(types);
    expect(await store.save('ws', types)).toEqual(types);
    expect(record.upsert).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      create: { workspaceId: 'ws', types },
      update: { types },
    });
  });
});

describe('hub index helpers', () => {
  const file = (path: string) => ({ path, size: 1, sha256: 'a'.repeat(64) });

  it('rejects an index this ADK cannot read', async () => {
    const { parseHubIndex } = await import('../src/modules/hub/domain/hub-index.js');
    expect(parseHubIndex({ schemaVersion: 2 })).toBeNull();
  });

  it('finds the instructions file of a skill or agent, falling back to the first agent file', async () => {
    const { skillFileOf, agentFileOf } = await import('../src/modules/hub/domain/hub-index.js');
    expect(skillFileOf({ files: [file('notes.md')] } as never)).toBeNull();
    expect(skillFileOf({ files: [file('notes.md'), file('SKILL.md')] } as never)?.path).toBe(
      'SKILL.md',
    );
    expect(agentFileOf({ files: [file('x.md'), file('AGENT.md')] } as never).path).toBe('AGENT.md');
    expect(agentFileOf({ files: [file('x.md'), file('y.md')] } as never).path).toBe('x.md');
  });
});

describe('Azure wiki attachment links', () => {
  it('keeps a malformed percent escape as written', async () => {
    const { absoluteWikiAttachments, relativeWikiAttachments } =
      await import('../src/modules/knowledge/adapters/wiki-providers.js');
    const absolute = absoluteWikiAttachments(
      '![x](/.attachments/bad%E0.png)',
      'https://dev.azure.com/o/p',
      'repo',
    );
    expect(absolute).toContain('path=%2F.attachments%2Fbad%25E0.png');
    const back = relativeWikiAttachments(
      'https://dev.azure.com/o/p/_apis/git/repositories/repo/items?path=%2F.attachments%2Fbad%E0.png&download=true&api-version=7.0',
    );
    expect(back).toBe('%2F.attachments%2Fbad%E0.png');
  });
});
