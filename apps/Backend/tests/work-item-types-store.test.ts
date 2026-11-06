import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { createWorkItemTypesRouter } from '../src/adapters/http/work-item-types-routes.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  PrismaWorkItemTypeStore,
  defaultWorkItemTypes,
  type WorkItemType,
  type WorkItemTypeStore,
} from '../src/modules/work-item-types/work-item-types.js';

describe('work item types routes when something fails', () => {
  const context = { requestId: 'wit', ownerId: 'ws', workspaceId: 'ws', actorId: 'u' };

  it('hands the error on when the request context cannot be resolved', async () => {
    const app = express();
    app.use(
      createWorkItemTypesRouter({ get: vi.fn(), save: vi.fn() }, () =>
        Promise.reject(new Error('no context')),
      ),
    );
    expect((await request(app).get('/work-item-types')).status).toBe(500);
  });

  it('answers with the error when the store cannot be read', async () => {
    const store: WorkItemTypeStore = {
      get: vi.fn().mockRejectedValue(new Error('database down')),
      save: vi.fn(),
    };
    const app = createApp({ requestContextResolver: () => context, workItemTypes: store });
    const response = await request(app).get('/work-item-types');
    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('PrismaWorkItemTypeStore', () => {
  const custom: WorkItemType[] = [
    { key: 'spike', label: 'Spike', color: '#aabbcc', icon: 'flask', aliases: [] },
  ];

  function database(row: { types: unknown } | null) {
    const record = {
      findUnique: vi.fn().mockResolvedValue(row),
      upsert: vi.fn(async ({ create }: { create: { types: unknown } }) => ({
        types: create.types,
      })),
    };
    return { db: { workItemTypeSettingsRecord: record } as unknown as PrismaClient, record };
  }

  it('reads what the workspace saved, or the defaults when it saved nothing', async () => {
    const saved = database({ types: custom });
    expect(await new PrismaWorkItemTypeStore(saved.db).get('ws')).toEqual(custom);
    expect(saved.record.findUnique).toHaveBeenCalledWith({ where: { workspaceId: 'ws' } });

    const empty = database(null);
    const types = await new PrismaWorkItemTypeStore(empty.db).get('ws');
    expect(types.map((type) => type.key)).toEqual(defaultWorkItemTypes.map((type) => type.key));
  });

  it('saves the types of a workspace, creating or replacing them', async () => {
    const { db, record } = database(null);
    const saved = await new PrismaWorkItemTypeStore(db).save('ws', custom);
    expect(saved).toEqual(custom);
    expect(record.upsert).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      create: { workspaceId: 'ws', types: custom },
      update: { types: custom },
    });
  });
});
