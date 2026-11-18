import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeRouter } from '../src/adapters/http/knowledge-routes.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { KnowledgeChunkRepository } from '../src/modules/knowledge/application/knowledge-provider.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const context: RequestContext = {
  requestId: 'r',
  ownerId: 'owner',
  workspaceId: 'ws',
  actorId: 'user-a',
  memberRole: 'ADMIN',
};

const chunk = (pageId: string, chunkIndex: number, content: string) => ({
  id: `${pageId}-${chunkIndex}`,
  ownerId: 'owner',
  pageId,
  source: 'app://local?title=Doc',
  chunkIndex,
  content,
  createdAt: 'now',
  updatedAt: 'now',
});

const link = {
  id: 'https://files.example.test/spec.pdf',
  name: 'spec.pdf',
  scope: 'brain',
  source: 'url',
  url: 'https://files.example.test/spec.pdf',
};

function build(
  options: { store?: InMemoryE2eArtifactStore | null; context?: RequestContext } = {},
) {
  const chunks = [chunk('page-1', 1, 'World'), chunk('page-1', 0, 'Hello ')];
  const knowledgeRepository = {
    all: vi.fn(async () => chunks),
    deletePage: vi.fn(async () => undefined),
  } as unknown as KnowledgeChunkRepository;
  const store =
    options.store === null ? undefined : (options.store ?? new InMemoryE2eArtifactStore());
  const app = express();
  app.use(express.json());
  app.use(
    createKnowledgeRouter(
      knowledgeRepository,
      {} as DynamicProviderFactory,
      () => options.context ?? context,
      store,
    ),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError)
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    else res.status(500).json({ code: 'INTERNAL', message: String(error) });
  });
  return { app, store, knowledgeRepository };
}

describe('Brain page attachments', () => {
  it('lists no attachments until some are saved, and saves them next to the page', async () => {
    const { app, store } = build();
    expect(
      (await request(app).get('/knowledge/documents/page-1/attachments').expect(200)).body,
    ).toEqual({
      attachments: [],
    });
    const saved = await request(app)
      .put('/knowledge/documents/page-1/attachments')
      .send({ attachments: [link] })
      .expect(200);
    expect(saved.body.attachments).toEqual([link]);
    expect(
      (await request(app).get('/knowledge/documents/page-1/attachments').expect(200)).body,
    ).toEqual({
      attachments: [link],
    });
    expect(await store!.listKeys!('attachments/ws/brain-pages')).toHaveLength(1);
    await request(app)
      .put('/knowledge/documents/page-1/attachments')
      .send({ attachments: [] })
      .expect(200);
    expect(
      (await request(app).get('/knowledge/documents/page-1/attachments').expect(200)).body,
    ).toEqual({
      attachments: [],
    });
  });

  it('reads an unreadable attachment list as empty', async () => {
    const { app, store } = build();
    const key = `attachments/ws/brain-pages/${Buffer.from('page-1').toString('base64url')}.json`;
    await store!.put(key, Buffer.from('{not json'));
    expect(
      (await request(app).get('/knowledge/documents/page-1/attachments').expect(200)).body,
    ).toEqual({
      attachments: [],
    });
  });

  it('answers 404 for unknown pages and 503 without file storage', async () => {
    const { app } = build();
    expect(
      (await request(app).get('/knowledge/documents/missing/attachments').expect(404)).body.code,
    ).toBe('DOCUMENT_NOT_FOUND');
    await request(app)
      .put('/knowledge/documents/missing/attachments')
      .send({ attachments: [] })
      .expect(404);
    const { app: bare } = build({ store: null });
    expect(
      (await request(bare).get('/knowledge/documents/page-1/attachments').expect(503)).body.code,
    ).toBe('ATTACHMENTS_UNAVAILABLE');
    await request(bare)
      .put('/knowledge/documents/page-1/attachments')
      .send({ attachments: [] })
      .expect(503);
  });

  it('requires a list of attachments and rejects invalid ones', async () => {
    const { app } = build();
    const missing = await request(app)
      .put('/knowledge/documents/page-1/attachments')
      .send({})
      .expect(400);
    expect(missing.body.message).toBe('attachments must be a list.');
    await request(app)
      .put('/knowledge/documents/page-1/attachments')
      .send({ attachments: [{ ...link, scope: 'issue' }] })
      .expect(400);
  });

  it('uses the owner as the storage scope when the request has no workspace', async () => {
    const { app, store } = build({ context: { ...context, workspaceId: undefined } });
    await request(app)
      .put('/knowledge/documents/page-1/attachments')
      .send({ attachments: [link] })
      .expect(200);
    expect(await store!.listKeys!('attachments/owner/brain-pages')).toHaveLength(1);
  });

  it('deletes a page without file storage configured', async () => {
    const { app, knowledgeRepository } = build({ store: null });
    await request(app).delete('/knowledge/documents/page-1').expect(200);
    expect(knowledgeRepository.deletePage).toHaveBeenCalled();
  });
});
