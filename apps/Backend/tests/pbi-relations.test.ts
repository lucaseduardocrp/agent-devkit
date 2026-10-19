import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createApp } from '../src/adapters/http/app.js';
import { createPbiRouter } from '../src/adapters/http/pbi-routes.js';
import type { IssueStore } from '../src/modules/issues/issue-store.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import { InMemoryUserIntegrationStore } from '../src/modules/integrations/adapters/in-memory-integrations-store.js';
import { IntegrationsService } from '../src/modules/integrations/application/integrations-service.js';
import {
  canonicalRelation,
  InMemoryPbiRelationStore,
  PrismaPbiRelationStore,
  relationTypeFor,
} from '../src/modules/pbi/pbi-relations.js';
import { InMemoryPbiStore, PrismaPbiStore } from '../src/modules/pbi/pbi-store.js';
import { PbiService } from '../src/modules/pbi/pbi-service.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { EntityAuditLog } from '../src/modules/audit/entity-audit.js';
import type { AuditEvent, AuditPersistence, AuditUnit } from '../src/modules/audit/audit.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';

function service() {
  const events: AuditEvent[] = [];
  const persistence: AuditPersistence = {
    run: (_workspaceId, work) =>
      work({
        append: (batch) => {
          events.push(...batch);
          return Promise.resolve();
        },
      } as AuditUnit),
    list: () => Promise.resolve({ items: [], total: 0 }),
  };
  const store = new InMemoryPbiStore();
  return {
    store,
    events,
    service: new PbiService(
      store,
      new IntegrationsService(new InMemoryUserIntegrationStore()),
      fetch,
      new EntityAuditLog(persistence),
      new InMemoryPbiRelationStore(),
    ),
  };
}

describe('PBI relations', () => {
  it('stores each link once and reads its inverse from the other item', () => {
    expect(canonicalRelation('b', 'related', 'a')).toEqual({
      sourceId: 'a',
      targetId: 'b',
      type: 'related',
    });
    expect(canonicalRelation('a', 'predecessor', 'b')).toEqual({
      sourceId: 'b',
      targetId: 'a',
      type: 'successor',
    });
    expect(canonicalRelation('a', 'tests', 'b').type).toBe('tested_by');
    expect(canonicalRelation('a', 'duplicate', 'b')).toMatchObject({ sourceId: 'a' });
    const relation = canonicalRelation('a', 'duplicate_of', 'b');
    expect(relationTypeFor(relation, 'a')).toBe('duplicate_of');
    expect(relationTypeFor(relation, 'b')).toBe('duplicate');
  });

  it('links many items, keeps the hierarchy acyclic and records history', async () => {
    const { service: pbis, events, store } = service();
    const story = await pbis.create('ws', { kind: 'pbi', title: 'Story' });
    const blocker = await pbis.create('ws', { kind: 'pbi', title: 'Blocker' });
    const other = await pbis.create('ws', { kind: 'pbi', title: 'Other' });
    const epic = await pbis.create('ws', { kind: 'pbi', title: 'Epic' });

    const related = await pbis.addRelations('ws', story.id, 'related', [
      blocker.id,
      other.id,
      other.id,
    ]);
    expect(related.map((view) => [view.type, view.item?.title])).toEqual([
      ['related', 'Blocker'],
      ['related', 'Other'],
    ]);
    // Adding the same link again is idempotent.
    await pbis.addRelations('ws', blocker.id, 'related', [story.id]);
    await pbis.addRelations('ws', story.id, 'predecessor', [blocker.id]);
    expect(
      (await pbis.relations('ws', blocker.id)).map((view) => [view.type, view.item?.title]),
    ).toEqual([
      ['related', 'Story'],
      ['successor', 'Story'],
    ]);

    await pbis.addRelations('ws', story.id, 'parent', [epic.id]);
    expect((await store.get('ws', story.id))?.kind).toBe('card');
    await pbis.addRelations('ws', epic.id, 'child', [other.id]);
    const epicLinks = await pbis.relations('ws', epic.id);
    expect(
      epicLinks.filter((view) => view.type === 'child').map((view) => view.item?.title),
    ).toEqual(['Story', 'Other']);
    expect((await pbis.relations('ws', story.id))[0]).toMatchObject({
      type: 'parent',
      origin: 'adk',
      item: { title: 'Epic', type: 'PBI' },
    });

    await expect(pbis.addRelations('ws', epic.id, 'parent', [story.id])).rejects.toMatchObject({
      code: 'PBI_LINK_INVALID',
      messageParams: { detail: 'The hierarchy cannot contain a cycle.' },
    });
    await expect(pbis.addRelations('ws', story.id, 'related', [story.id])).rejects.toMatchObject({
      messageParams: { detail: 'An item cannot be linked to itself.' },
    });
    await expect(pbis.addRelations('ws', story.id, 'related', [])).rejects.toMatchObject({
      messageParams: { detail: 'Choose at least one item to link.' },
    });
    await expect(
      pbis.addRelations('ws', story.id, 'parent', [blocker.id, other.id]),
    ).rejects.toMatchObject({ messageParams: { detail: 'An item can have only one parent.' } });

    await pbis.removeRelation('ws', story.id, 'parent', epic.id);
    expect(await store.get('ws', story.id)).toMatchObject({ parentId: null, kind: 'pbi' });
    await pbis.removeRelation('ws', epic.id, 'child', other.id);
    await pbis.removeRelation('ws', blocker.id, 'successor', story.id);
    expect((await pbis.relations('ws', story.id)).map((view) => view.type)).toEqual([
      'related',
      'related',
    ]);
    await expect(pbis.removeRelation('ws', story.id, 'parent', epic.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(pbis.removeRelation('ws', story.id, 'child', epic.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(pbis.removeRelation('ws', story.id, 'tests', epic.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const history = events.filter(
      (event) =>
        event.entityId === story.id &&
        (event.after as Record<string, unknown> | null)?.['relations'] !== undefined,
    );
    expect(history[0]?.after).toEqual({
      title: 'Story',
      relations: ['related: Blocker', 'related: Other'],
    });
  });

  it('shows links read from Azure DevOps next to ADK links', async () => {
    const { service: pbis, store } = service();
    const imported = await pbis.create('ws', {
      kind: 'pbi',
      title: 'Imported',
      sourceData: {
        relatedExternalIds: ['10', '11', 3],
        externalLinks: [
          { type: 'successor', externalId: '10' },
          { type: 'bogus', externalId: '12' },
          null,
        ],
      },
    });
    const ten = await pbis.create('ws', { kind: 'card', title: 'Ten', parentId: imported.id });
    await store.link('ws', ten.id, {
      providerId: 'azure_devops',
      externalId: '10',
      externalUrl: 'https://dev.azure.com/x/10',
      boardId: null,
    });
    await pbis.addRelations('ws', imported.id, 'related', [ten.id]);
    const views = await pbis.relations('ws', imported.id);
    expect(
      views.map((view) => [view.type, view.origin, view.item?.title ?? view.externalId]),
    ).toEqual([
      ['child', 'adk', 'Ten'],
      ['related', 'adk', 'Ten'],
      ['related', 'azure_devops', '11'],
      ['successor', 'azure_devops', 'Ten'],
    ]);
    const plain = await pbis.create('ws', { kind: 'pbi', title: 'Plain', sourceData: {} });
    expect(await pbis.relations('ws', plain.id)).toEqual([]);
  });

  it('persists relations with Prisma', async () => {
    const row = {
      id: 'r1',
      workspaceId: 'ws',
      sourceId: 'a',
      targetId: 'b',
      type: 'related',
      createdBy: null,
      createdAt: new Date(),
    };
    const prisma = {
      pbiRelationRecord: {
        findMany: vi.fn().mockResolvedValue([row]),
        upsert: vi.fn().mockResolvedValue(row),
        deleteMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
      },
      pbiItemRecord: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'c',
            workspaceId: 'ws',
            parentId: 'a',
            kind: 'card',
            title: 'C',
            description: '',
            status: 'New',
            position: 0,
            sourceData: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            links: [],
          },
        ]),
      },
    } as unknown as PrismaClient;
    const relations = new PrismaPbiRelationStore(prisma);
    expect(await relations.list('ws', 'a')).toEqual([row]);
    const key = { sourceId: 'a', targetId: 'b', type: 'related' as const };
    expect(await relations.add('ws', key, 'user')).toEqual(row);
    expect(prisma.pbiRelationRecord.upsert).toHaveBeenCalledWith({
      where: { sourceId_targetId_type: key },
      create: { workspaceId: 'ws', ...key, createdBy: 'user' },
      update: {},
    });
    expect(await relations.remove('ws', key)).toBe(true);
    expect(await relations.remove('ws', key)).toBe(false);
    const children = await new PrismaPbiStore(prisma).listChildren('ws', 'a');
    expect(children.map((child) => child.title)).toEqual(['C']);
    const memory = new InMemoryPbiRelationStore();
    expect(await memory.remove('ws', key)).toBe(false);
  });
});

describe('PBI push and link routes', () => {
  const workspaces = {
    listMembers: vi
      .fn()
      .mockResolvedValue([
        { userId: 'user-a', user: { id: 'user-a', name: 'Ana Souza', email: 'ana@example.com' } },
      ]),
  } as unknown as WorkspaceService;

  it('serves push contracts with the ADK assignee and manages links', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws-a', 'PROJECT_MANAGEMENT', 'trello', {
      isEnabled: true,
      settings: { apiKey: 'k', boardId: 'board' },
      secret: 't',
    });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
      if (url.includes('/members/me/boards')) return json([{ id: 'board', name: 'Main' }]);
      if (url.includes('/boards/board/lists')) return json([{ id: 'l1', name: 'Doing' }]);
      if (url.includes('/boards/board/members'))
        return json([{ id: 'm1', fullName: 'Ana Souza', username: 'ana' }]);
      if (url.includes('/lists?') && init?.method === 'POST') return json({ id: 'l2' });
      throw new Error(url);
    });
    vi.stubGlobal('fetch', fetcher);
    try {
      const app = createApp({
        integrationsService: integrations,
        workspaceService: workspaces,
        requestContextResolver: (req) => ({
          requestId: 'r',
          ownerId: 'ws-a',
          workspaceId: 'ws-a',
          actorId: 'user-a',
          memberRole: req.header('x-test-role') === 'VIEWER' ? 'VIEWER' : 'ADMIN',
        }),
      });
      const root = (
        await request(app).post('/pbi/items').send({ kind: 'pbi', title: 'Root' }).expect(201)
      ).body.item as { id: string };
      const card = (
        await request(app)
          .post('/pbi/items')
          .send({
            kind: 'card',
            title: 'Card',
            status: 'Active',
            parentId: root.id,
            sourceData: { adkAssigneeUserId: 'user-a' },
          })
          .expect(201)
      ).body.item as { id: string };
      const contract = await request(app)
        .post(`/pbi/items/${card.id}/push-contract`)
        .send({ providerId: 'trello' })
        .expect(200);
      expect(
        (contract.body.contract.fields as { key: string; value: string }[]).map((field) => [
          field.key,
          field.value,
        ]),
      ).toEqual([
        ['board', 'board'],
        ['list', 'l1'],
        ['member', 'm1'],
      ]);
      await request(app)
        .post(`/pbi/items/${card.id}/push-contract`)
        .set('x-test-role', 'VIEWER')
        .send({ providerId: 'trello' })
        .expect(403);
      await request(app)
        .post(`/pbi/items/${card.id}/push-contract`)
        .send({ providerId: 'nope' })
        .expect(400);
      const pushed = await request(app)
        .post(`/pbi/items/${root.id}/push`)
        .send({ providerId: 'trello', fields: { board: 'board' } })
        .expect(200);
      expect(pushed.body).toMatchObject({ item: { id: root.id }, warnings: [] });
      await request(app).post(`/pbi/items/${root.id}/push`).send({}).expect(400);

      const other = (
        await request(app).post('/pbi/items').send({ kind: 'pbi', title: 'Other' }).expect(201)
      ).body.item as { id: string };
      const linked = await request(app)
        .post(`/pbi/items/${root.id}/relations`)
        .send({ type: 'tested_by', targetIds: [other.id] })
        .expect(201);
      expect(linked.body.relations).toContainEqual(
        expect.objectContaining({
          type: 'tested_by',
          item: expect.objectContaining({ id: other.id }),
        }),
      );
      const listed = await request(app).get(`/pbi/items/${other.id}/relations`).expect(200);
      expect(listed.body.relations).toEqual([
        expect.objectContaining({ type: 'tests', origin: 'adk' }),
      ]);
      await request(app)
        .post(`/pbi/items/${root.id}/relations`)
        .send({ type: 'blocks', targetIds: [other.id] })
        .expect(400);
      await request(app)
        .post(`/pbi/items/${root.id}/relations`)
        .set('x-test-role', 'VIEWER')
        .send({ type: 'related', targetIds: [other.id] })
        .expect(403);
      await request(app).delete(`/pbi/items/${root.id}/relations/blocks/${other.id}`).expect(400);
      await request(app)
        .delete(`/pbi/items/${root.id}/relations/tested_by/${other.id}`)
        .set('x-test-role', 'VIEWER')
        .expect(403);
      const removed = await request(app)
        .delete(`/pbi/items/${root.id}/relations/tested_by/${other.id}`)
        .expect(200);
      expect(removed.body.relations).toEqual([
        expect.objectContaining({ type: 'child', item: expect.objectContaining({ id: card.id }) }),
      ]);
      await request(app).get(`/pbi/items/missing/relations`).expect(404);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats an assignee who left the workspace as an unmapped name', async () => {
    const integrations = new IntegrationsService(new InMemoryUserIntegrationStore());
    await integrations.saveIntegration('ws-a', 'PROJECT_MANAGEMENT', 'trello', {
      isEnabled: true,
      settings: { apiKey: 'k', boardId: 'board' },
      secret: 't',
    });
    const store = new InMemoryPbiStore();
    const item = await store.create('ws-a', {
      kind: 'pbi',
      title: 'Gone',
      sourceData: { adkAssigneeUserId: 'former' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })),
    );
    try {
      const app = createApp({
        integrationsService: integrations,
        workspaceService: workspaces,
        pbiStore: store,
        requestContextResolver: () => ({
          requestId: 'r',
          ownerId: 'ws-a',
          workspaceId: 'ws-a',
          actorId: 'user-a',
          memberRole: 'ADMIN',
        }),
      });
      await request(app)
        .post(`/pbi/items/${item.id}/push`)
        .send({ providerId: 'trello' })
        .expect(400)
        .expect((res) => expect(res.body.code).toBe('PBI_PUSH_FIELDS'));
      // Without a workspace service (router used on its own) no assignee is mapped.
      const noMembers = express();
      noMembers.use(express.json());
      noMembers.use(
        createPbiRouter(
          new PbiService(store, integrations),
          {} as IssueStore,
          {} as RunService,
          () =>
            Promise.resolve({
              requestId: 'r',
              ownerId: 'ws-a',
              workspaceId: 'ws-a',
              actorId: 'user-a',
              memberRole: 'ADMIN' as const,
            }),
        ),
      );
      await request(noMembers)
        .post(`/pbi/items/${item.id}/push-contract`)
        .send({ providerId: 'trello', values: { board: 'x' } })
        .expect(200);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
