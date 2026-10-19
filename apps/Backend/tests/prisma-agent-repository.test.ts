import { describe, expect, it } from 'vitest';
import {
  PrismaAgentRepository,
  type PrismaAgentClient,
} from '../src/modules/agents/adapters/prisma-agent-repository.js';
import { CustomAgent } from '../src/modules/agents/domain/agent-entity.js';

describe('PrismaAgentRepository', () => {
  function setupMockClient() {
    const store = new Map<string, any>();

    const client: PrismaAgentClient = {
      agentRecord: {
        upsert: async (args) => {
          const id = args.where.id;
          const existing = store.get(id);
          const data = existing ? { ...existing, ...args.update } : { ...args.create };
          const record = {
            ...data,
            createdAt: existing?.createdAt ?? new Date(),
            updatedAt: new Date(),
          };
          store.set(id, record);
          return record;
        },
        findUnique: async (args) => {
          if (args.where.id) {
            return store.get(args.where.id) ?? null;
          }
          if (args.where.workspaceId_slug) {
            const { workspaceId, slug } = args.where.workspaceId_slug;
            for (const r of store.values()) {
              if (r.workspaceId === workspaceId && r.slug === slug) {
                return r;
              }
            }
          }
          return null;
        },
        findMany: async (args) => {
          const results: any[] = [];
          for (const r of store.values()) {
            if (r.workspaceId === args.where.workspaceId) {
              if (!args.where.role || r.role === args.where.role) {
                results.push(r);
              }
            }
          }
          return results;
        },
        delete: async (args) => {
          const r = store.get(args.where.id);
          store.delete(args.where.id);
          return r;
        },
      },
    };

    const repo = new PrismaAgentRepository(client);
    return { repo, store };
  }

  it('saves, finds, lists, and deletes agents', async () => {
    const { repo } = setupMockClient();

    const agent = new CustomAgent({
      id: 'ag-1',
      workspaceId: 'ws-1',
      name: 'Agent One',
      slug: 'agent-one',
      description: 'First agent',
      role: 'QA',
      instructions: '# Rules',
      isDefault: true,
    });

    const saved = await repo.save(agent);
    expect(saved.id).toBe('ag-1');
    expect(saved.name).toBe('Agent One');

    // Find by ID
    const found = await repo.findById('ag-1', 'ws-1');
    expect(found).not.toBeNull();
    expect(found?.slug).toBe('agent-one');

    // Find by ID wrong workspace
    const wrongWs = await repo.findById('ag-1', 'other-ws');
    expect(wrongWs).toBeNull();

    // Find by ID missing
    expect(await repo.findById('missing-id')).toBeNull();

    // Find by Slug
    const bySlug = await repo.findBySlug('ws-1', 'agent-one');
    expect(bySlug).not.toBeNull();
    expect(bySlug?.id).toBe('ag-1');

    // Find by Slug missing
    expect(await repo.findBySlug('ws-1', 'missing-slug')).toBeNull();

    // List by workspace
    const list = await repo.listByWorkspace('ws-1');
    expect(list).toHaveLength(1);

    const listQa = await repo.listByWorkspace('ws-1', 'QA');
    expect(listQa).toHaveLength(1);

    const listDoc = await repo.listByWorkspace('ws-1', 'DOCUMENTATION');
    expect(listDoc).toHaveLength(0);

    // Save with model and update
    const agentWithModel = new CustomAgent({
      id: 'ag-2',
      workspaceId: 'ws-1',
      name: 'Agent Model',
      slug: 'agent-model',
      description: 'With model',
      role: 'CUSTOM',
      instructions: '# Rules',
      model: 'gemini-2.5-flash',
    });
    await repo.save(agentWithModel);
    const updatedModel = await repo.save(agentWithModel);
    expect(updatedModel.model).toBe('gemini-2.5-flash');

    // Delete
    const deleted = await repo.delete('ag-1', 'ws-1');
    expect(deleted).toBe(true);

    const deletedAgain = await repo.delete('ag-1', 'ws-1');
    expect(deletedAgain).toBe(false);
  });
});
