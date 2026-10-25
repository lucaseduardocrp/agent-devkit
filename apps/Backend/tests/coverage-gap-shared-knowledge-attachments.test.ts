import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createKnowledgeRouter } from '../src/adapters/http/knowledge-routes.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { KnowledgeChunkRepository } from '../src/modules/knowledge/application/knowledge-provider.js';
import { attachmentContentKey, attachmentMetaKey } from '../src/modules/shared/attachment.js';
import type { RequestContext } from '../src/shared/context.js';

const FILE = '00000000-0000-4000-8000-0000000000bb';
const context: RequestContext = { requestId: 'r', ownerId: 'ws-k', workspaceId: 'ws-k' };
const pageKey = (pageId: string) =>
  `attachments/ws-k/brain-pages/${Buffer.from(pageId, 'utf8').toString('base64url')}.json`;

function build(store?: InMemoryE2eArtifactStore, requestContext: RequestContext = context) {
  const chunks = [
    { id: 'c1', pageId: 'p1', chunkIndex: 1, content: ` see /attachments/files/${FILE}` },
    { id: 'c0', pageId: 'p1', chunkIndex: 0, content: 'Body' },
    { id: 'c2', pageId: 'p2', chunkIndex: 0, content: 'Other' },
  ];
  const repository = { all: vi.fn(async () => chunks) } as unknown as KnowledgeChunkRepository;
  const app = express();
  app.use(express.json());
  app.use(
    createKnowledgeRouter(
      repository,
      {} as DynamicProviderFactory,
      async () => requestContext,
      store,
    ),
  );
  app.use(errorMiddleware);
  return app;
}

describe('Brain page attachments', () => {
  it('lists, replaces and claims the files of a page', async () => {
    const store = new InMemoryE2eArtifactStore();
    const app = build(store);
    expect((await request(app).get('/knowledge/documents/p1/attachments')).body).toEqual({
      attachments: [],
    });
    await store.put(pageKey('p1'), Buffer.from('{broken'));
    expect((await request(app).get('/knowledge/documents/p1/attachments')).body).toEqual({
      attachments: [],
    });

    await store.put(
      attachmentMetaKey('ws-k', FILE),
      Buffer.from(
        JSON.stringify({
          id: FILE,
          name: 'a.png',
          kind: 'image',
          mimeType: 'image/png',
          size: 1,
          scope: 'brain',
          status: 'pending',
          createdAt: new Date().toISOString(),
        }),
      ),
    );
    await store.put(attachmentContentKey('ws-k', FILE), Buffer.from('x'));
    const external = {
      id: 'wiki:1',
      name: 'spec.pdf',
      kind: 'document',
      scope: 'brain',
      source: 'url',
      url: 'https://cdn.test/spec.pdf',
    };
    const saved = await request(app)
      .put('/knowledge/documents/p1/attachments')
      .send({ attachments: [external] });
    expect(saved.status).toBe(200);
    expect(saved.body.attachments).toEqual([external]);
    expect((await request(app).get('/knowledge/documents/p1/attachments')).body.attachments).toEqual(
      [external],
    );
    // The page text references the pending upload, so saving claims it for the page.
    const meta = JSON.parse((await store.get(attachmentMetaKey('ws-k', FILE)))!.toString('utf8'));
    expect(meta).toMatchObject({ status: 'committed', owner: 'brain:p1' });
  });

  it('rejects unknown pages, non-list bodies and missing storage', async () => {
    const app = build(new InMemoryE2eArtifactStore());
    expect((await request(app).get('/knowledge/documents/nope/attachments')).status).toBe(404);
    const invalid = await request(app)
      .put('/knowledge/documents/p1/attachments')
      .send({ attachments: 'x' });
    expect(invalid.status).toBe(400);
    const noBody = await request(app).put('/knowledge/documents/p1/attachments');
    expect(noBody.status).toBe(400);
    const withoutStore = build();
    expect((await request(withoutStore).get('/knowledge/documents/p1/attachments')).status).toBe(
      503,
    );
    expect(
      (
        await request(withoutStore)
          .put('/knowledge/documents/p1/attachments')
          .send({ attachments: [] })
      ).status,
    ).toBe(503);
  });

  it('keeps files of owner-only contexts under the owner', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put(pageKey('p2'), Buffer.from('[]'));
    const app = build(store, { requestId: 'r', ownerId: 'ws-k' });
    const response = await request(app).get('/knowledge/documents/p2/attachments');
    expect(response.status).toBe(200);
    expect(response.body.attachments).toEqual([]);
  });
});
