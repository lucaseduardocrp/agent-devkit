import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import {
  createAttachmentsRouter,
  validateAttachments,
} from '../src/adapters/http/attachments-routes.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import { attachmentMetaKey } from '../src/modules/shared/attachment.js';
import { imageKey } from '../src/modules/shared/image-attachment.js';
import type { RequestContext } from '../src/shared/context.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const GIF = Buffer.from('GIF89a....');
const ID = '00000000-0000-4000-8000-0000000000aa';
const context: RequestContext = {
  requestId: 'r',
  ownerId: 'ws-1',
  workspaceId: 'ws-1',
  actorId: 'user-1',
};

function build(
  options: {
    store?: InMemoryE2eArtifactStore;
    context?: RequestContext | (() => Promise<RequestContext>);
    fetcher?: typeof fetch;
    authorized?: boolean;
  } = {},
) {
  const store = options.store ?? new InMemoryE2eArtifactStore();
  const resolver =
    typeof options.context === 'function' ? options.context : () => options.context ?? context;
  const providers = {
    resolveMediaAuthorization: vi.fn(async () =>
      options.authorized === false ? null : { authorization: 'Basic abc' },
    ),
  };
  const app = express();
  app.use(
    createAttachmentsRouter(
      store,
      resolver as never,
      providers as unknown as DynamicProviderFactory,
      options.fetcher,
    ),
  );
  app.use(errorMiddleware);
  return { app, store };
}

const proxy = (url: string) => `/attachments/proxy?url=${encodeURIComponent(url)}`;

describe('attachment validation edges', () => {
  it('rejects long, malformed and repeated lists', async () => {
    const store = new InMemoryE2eArtifactStore();
    const external = (id: string) => ({
      id,
      name: 'a',
      scope: 'spec',
      source: 'url',
      url: 'https://cdn.test/a',
    });
    await expect(
      validateAttachments(
        store,
        'ws',
        Array.from({ length: 21 }, (_, index) => external(String(index))),
        ['spec'],
      ),
    ).rejects.toThrow('up to 20');
    await expect(validateAttachments(store, 'ws', [{ id: 1 }], ['spec'])).rejects.toThrow(
      'invalid',
    );
    await expect(
      validateAttachments(store, 'ws', [external('a'), external('a')], ['spec']),
    ).rejects.toThrow('repeated');
    await expect(
      validateAttachments(
        store,
        'ws',
        [{ ...external('b'), url: 'https://u:p@cdn.test/a' }],
        ['spec'],
      ),
    ).rejects.toThrow('HTTPS');
  });

  it('accepts legacy images only when their stored bytes match the declared type', async () => {
    const store = new InMemoryE2eArtifactStore();
    const legacy = { id: ID, name: 'shot', scope: 'issue', source: 'adk', mimeType: 'image/gif' };
    await store.put(imageKey('ws', { id: ID, scope: 'issue', mimeType: 'image/gif' }), GIF);
    await expect(validateAttachments(store, 'ws', [legacy], ['issue'])).resolves.toEqual([
      { ...legacy, url: `/attachments/images/issue/${ID}` },
    ]);
    await expect(
      validateAttachments(store, 'ws', [{ ...legacy, mimeType: 'image/png' }], ['issue']),
    ).rejects.toThrow('not found or is invalid');
    await expect(
      validateAttachments(store, 'ws', [{ ...legacy, mimeType: 'text/plain' }], ['issue']),
    ).rejects.toThrow('not found or is invalid');
  });
});

describe('attachment upload and download edges', () => {
  it('reports context failures, missing workspaces and read-only tokens', async () => {
    const failing = build({ context: () => Promise.reject(new Error('no context')) });
    expect((await request(failing.app).get(`/attachments/files/${ID}`)).status).toBe(500);
    const noWorkspace = build({ context: { requestId: 'r', ownerId: 'o' } });
    const missing = await request(noWorkspace.app).get(`/attachments/files/${ID}`);
    expect(missing.body.code).toBe('WORKSPACE_REQUIRED');
    const readOnly = build({ context: { ...context, tokenScope: 'read' } });
    const denied = await request(readOnly.app)
      .post('/attachments/files?scope=issue&name=a.png')
      .set('content-type', 'application/octet-stream')
      .send(PNG);
    expect(denied.status).toBe(403);
  });

  it('rejects empty and oversized uploads, and stores files of anonymous actors', async () => {
    const { app, store } = build({ context: { requestId: 'r', ownerId: 'ws-1', workspaceId: 'ws-1' } });
    expect((await request(app).post('/attachments/files?scope=issue&name=a.png')).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const tooLarge = await request(app)
      .post('/attachments/files?scope=issue&name=a.png')
      .set('content-type', 'application/octet-stream')
      .send(big);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe('ATTACHMENT_TOO_LARGE');
    const upload = await request(app)
      .post('/attachments/files?scope=issue&name=notes.txt')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('hello'));
    expect(upload.status).toBe(201);
    const id = upload.body.attachment.id as string;
    const meta = JSON.parse((await store.get(attachmentMetaKey('ws-1', id)))!.toString('utf8'));
    expect(meta.createdBy).toBeUndefined();
    const file = await request(app).get(`/attachments/files/${id}`);
    expect(file.headers['content-disposition']).toMatch(/^attachment;/);
    await store.removePrefix(`attachments/ws-1/${id}/content`);
    expect((await request(app).get(`/attachments/files/${id}`)).status).toBe(404);
  });

  it('treats discarding an unknown upload as done', async () => {
    const { app } = build();
    expect((await request(app).delete(`/attachments/files/${ID}`)).status).toBe(204);
  });

  it('serves legacy images by trying each image type', async () => {
    const { app, store } = build();
    await store.put(imageKey('ws-1', { id: ID, scope: 'pbi', mimeType: 'image/gif' }), GIF);
    await store.put(imageKey('ws-1', { id: ID, scope: 'pbi', mimeType: 'image/png' }), GIF);
    const image = await request(app).get(`/attachments/images/pbi/${ID}`);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/gif');
    const missing = await request(app).get(`/attachments/images/issue/${ID}`);
    expect(missing.body.code).toBe('IMAGE_NOT_FOUND');
  });
});

describe('attachment proxy edges', () => {
  const host = 'https://13.107.42.20';

  it('refuses plain HTTP and hosts no integration owns', async () => {
    expect((await request(build().app).get(proxy('http://13.107.42.20/a.png'))).status).toBe(400);
    expect((await request(build({ authorized: false }).app).get(proxy(`${host}/a`))).status).toBe(
      403,
    );
  });

  it('follows redirects without credentials and names files from the best source', async () => {
    const fetcher = vi.fn(async (url: URL) => {
      if (url.hostname === '13.107.42.20')
        return new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/signed' } });
      return new Response(PNG, {
        headers: { 'content-disposition': `inline; filename*=UTF-8''r%C3%A9sum%C3%A9.png` },
      });
    });
    const response = await request(build({ fetcher: fetcher as never }).app).get(proxy(`${host}/a`));
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain("UTF-8''r%C3%A9sum%C3%A9.png");
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ headers: {} });

    const named = async (url: string, disposition?: string) => {
      const fileFetcher = vi.fn(
        async () =>
          new Response(Buffer.from('a,b'), {
            headers: disposition ? { 'content-disposition': disposition } : {},
          }),
      );
      const reply = await request(build({ fetcher: fileFetcher as never }).app).get(proxy(url));
      return [reply.status, reply.headers['content-disposition']];
    };
    expect(await named(`${host}/x`, 'attachment; filename="data.csv"')).toEqual([
      200,
      expect.stringContaining('filename="data.csv"'),
    ]);
    expect(await named(`${host}/x?path=/docs/data.csv`)).toEqual([
      200,
      expect.stringContaining('filename="data.csv"'),
    ]);
    expect(await named(`${host}/files/data.csv`)).toEqual([
      200,
      expect.stringContaining('filename="data.csv"'),
    ]);
    expect((await named(`${host}/files/data.bin`))[0]).toBe(415);
  });

  it('gives up on private hops, failures, large files and redirect loops', async () => {
    const status = async (fetcher: (url: URL) => Promise<Response>) =>
      (await request(build({ fetcher: fetcher as never }).app).get(proxy(`${host}/a`))).body.code;
    expect(
      await status(async () =>
        new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/a' } }),
      ),
    ).toBe('ATTACHMENT_UNAVAILABLE');
    expect(
      await status(async () =>
        new Response(null, { status: 301, headers: { location: `${host}/again` } }),
      ),
    ).toBe('ATTACHMENT_UNAVAILABLE');
    expect(await status(async () => new Response(null, { status: 304 }))).toBe(
      'ATTACHMENT_UNAVAILABLE',
    );
    expect(await status(async () => new Response('x', { status: 500 }))).toBe(
      'ATTACHMENT_UNAVAILABLE',
    );
    expect(
      await status(async () =>
        new Response(PNG, { headers: { 'content-length': String(200 * 1024 * 1024) } }),
      ),
    ).toBe('ATTACHMENT_UNAVAILABLE');
    const huge = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(100 * 1024 * 1024));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      });
    expect(await status(async () => new Response(huge()))).toBe('ATTACHMENT_UNAVAILABLE');
  });
});
