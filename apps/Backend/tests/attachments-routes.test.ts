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
import {
  absoluteWikiAttachments,
  relativeWikiAttachments,
} from '../src/modules/knowledge/adapters/wiki-providers.js';
import {
  attachmentContentKey,
  detectAttachmentType,
  readAttachmentMeta,
} from '../src/modules/shared/attachment.js';
import {
  PENDING_FILE_TTL_MS,
  fileOwner,
  sweepPendingFiles,
  syncItemFiles,
} from '../src/modules/shared/attachment-files.js';
import { inlineImageAttachments } from '../src/modules/shared/image-attachment.js';
import type { RequestContext } from '../src/shared/context.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const context: RequestContext = {
  requestId: 'r',
  ownerId: 'ws-1',
  workspaceId: 'ws-1',
  actorId: 'user-1',
};

function build(
  options: {
    store?: InMemoryE2eArtifactStore;
    context?: RequestContext;
    providers?: Pick<DynamicProviderFactory, 'resolveMediaAuthorization'>;
    fetcher?: typeof fetch;
  } = {},
) {
  const store = options.store ?? new InMemoryE2eArtifactStore();
  const app = express();
  app.use(
    createAttachmentsRouter(
      store,
      () => options.context ?? context,
      options.providers as DynamicProviderFactory | undefined,
      options.fetcher,
    ),
  );
  app.use(errorMiddleware);
  return { app, store };
}

describe('attachment type detection', () => {
  it('reads the type from the content, using the name only for zips and text', () => {
    expect(detectAttachmentType(PNG, 'photo.pdf')).toEqual({
      mimeType: 'image/png',
      kind: 'image',
    });
    expect(detectAttachmentType(Buffer.from('%PDF-1.7 ...'), 'report.bin')?.mimeType).toBe(
      'application/pdf',
    );
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom0000')]);
    expect(detectAttachmentType(mp4, 'clip.mp4')).toEqual({
      mimeType: 'video/mp4',
      kind: 'video',
    });
    const zip = Buffer.from('PK\u0003\u0004rest');
    expect(detectAttachmentType(zip, 'spec.docx')?.mimeType).toContain('wordprocessingml');
    expect(detectAttachmentType(zip, 'bundle.zip')?.mimeType).toBe('application/zip');
    expect(detectAttachmentType(Buffer.from('a,b\n1,2'), 'data.csv')?.mimeType).toBe('text/csv');
    expect(detectAttachmentType(Buffer.from('a\u0000b'), 'data.txt')).toBeNull();
    expect(detectAttachmentType(Buffer.from('<script>'), 'page.html')).toBeNull();
  });
});

describe('attachments routes', () => {
  it('stores an upload with its detected type and serves it back', async () => {
    const { app } = build();
    const upload = await request(app)
      .post('/attachments/files?scope=brain&name=diagram.png')
      .set('content-type', 'application/octet-stream')
      .send(PNG)
      .expect(201);
    const attachment = upload.body.attachment;
    expect(attachment).toMatchObject({
      name: 'diagram.png',
      kind: 'image',
      mimeType: 'image/png',
      size: PNG.length,
      scope: 'brain',
      source: 'adk',
      url: `/attachments/files/${attachment.id}`,
    });

    const file = await request(app).get(attachment.url).expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toContain('inline');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(file.body)).toEqual(PNG);
  });

  it('treats a body parsed as JSON before the router as an empty upload', async () => {
    // The API parses JSON for every route first, so an upload can arrive as an array.
    const app = express();
    app.use(express.json());
    app.use(createAttachmentsRouter(new InMemoryE2eArtifactStore(), () => context));
    app.use(errorMiddleware);
    const response = await request(app)
      .post('/attachments/files?scope=brain&name=diagram.png')
      .send([137, 80, 78, 71, 13, 10, 26, 10])
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unsupported files and files of other workspaces', async () => {
    const store = new InMemoryE2eArtifactStore();
    const { app } = build({ store });
    await request(app)
      .post('/attachments/files?scope=issue&name=page.html')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('<html></html>'))
      .expect(415);
    const upload = await request(app)
      .post('/attachments/files?scope=issue&name=a.png')
      .set('content-type', 'application/octet-stream')
      .send(PNG)
      .expect(201);
    const other = build({ store, context: { ...context, ownerId: 'ws-2', workspaceId: 'ws-2' } });
    await request(other.app).get(upload.body.attachment.url).expect(404);
  });

  it('validates attachments sent with an item', async () => {
    const { app, store } = build();
    const upload = await request(app)
      .post('/attachments/files?scope=spec&name=a.png')
      .set('content-type', 'application/octet-stream')
      .send(PNG);
    const uploaded = upload.body.attachment;
    const external = {
      id: 'provider:1',
      name: 'log.txt',
      kind: 'document',
      scope: 'spec',
      source: 'url',
      url: 'https://dev.azure.com/org/_apis/wit/attachments/1?fileName=log.txt',
    };
    await expect(
      validateAttachments(store, 'ws-1', [{ ...uploaded, name: 'Renamed' }, external], ['spec']),
    ).resolves.toEqual([{ ...uploaded, name: 'Renamed' }, external]);
    await expect(validateAttachments(store, 'ws-2', [uploaded], ['spec'])).rejects.toThrow(
      'not found',
    );
    await expect(validateAttachments(store, 'ws-1', [uploaded], ['issue'])).rejects.toThrow(
      'scope',
    );
    await expect(
      validateAttachments(store, 'ws-1', [{ ...external, url: 'http://x.test/a' }], ['spec']),
    ).rejects.toThrow('HTTPS');
  });

  it('shows integration files with the integration credentials only', async () => {
    const resolveMediaAuthorization = vi.fn(async (_owner: string, url: URL) =>
      url.hostname === 'dev.azure.com' ? { authorization: 'Basic abc' } : null,
    );
    const fetcher = vi.fn(async () => new Response(PNG, { status: 200 }));
    const { app } = build({ providers: { resolveMediaAuthorization }, fetcher });
    // 13.107.42.20 is a public address, so the proxy accepts it without a DNS lookup.
    const url = 'https://13.107.42.20/org/_apis/wit/attachments/1?fileName=shot.png';
    await request(app)
      .get(`/attachments/proxy?url=${encodeURIComponent(url)}`)
      .expect(403);

    resolveMediaAuthorization.mockResolvedValueOnce({ authorization: 'Basic abc' });
    const file = await request(app)
      .get(`/attachments/proxy?url=${encodeURIComponent(url)}`)
      .expect(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(fetcher).toHaveBeenCalledWith(
      new URL(url),
      expect.objectContaining({ headers: { authorization: 'Basic abc' } }),
    );

    await request(app)
      .get(`/attachments/proxy?url=${encodeURIComponent('https://127.0.0.1/a.png')}`)
      .expect(403);
  });
});

describe('inline images', () => {
  it('finds Markdown and HTML images, including files stored by the ADK', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const found = inlineImageAttachments(
      `![Flow](/attachments/files/${id}) <img src="https://example.com/a.png" alt="A"> ![x](javascript:alert(1))`,
      'issue',
    );
    expect(found).toEqual([
      expect.objectContaining({ id, source: 'adk', kind: 'image', name: 'Flow' }),
      expect.objectContaining({ source: 'url', url: 'https://example.com/a.png', name: 'A' }),
    ]);
  });

  it('keeps Azure wiki attachments loadable and writes them back when pushing', () => {
    const base = 'https://dev.azure.com/org/project';
    const content = '![shot](/.attachments/image-1.png =500x) <img src="/.attachments/a%20b.png">';
    const absolute = absoluteWikiAttachments(content, base, 'repo-1');
    expect(absolute).toBe(
      `![shot](${base}/_apis/git/repositories/repo-1/items?path=%2F.attachments%2Fimage-1.png&download=true&api-version=7.0) <img src="${base}/_apis/git/repositories/repo-1/items?path=%2F.attachments%2Fa%20b.png&download=true&api-version=7.0">`,
    );
    expect(relativeWikiAttachments(absolute)).toBe(
      '![shot](/.attachments/image-1.png) <img src="/.attachments/a%20b.png">',
    );
    expect(absoluteWikiAttachments(content, base, undefined)).toBe(content);
  });
});

describe('stored file lifecycle', () => {
  const upload = async (app: express.Express, scope = 'issue') =>
    (
      await request(app)
        .post(`/attachments/files?scope=${scope}&name=a.png`)
        .set('content-type', 'application/octet-stream')
        .send(PNG)
        .expect(201)
    ).body.attachment as { id: string; url: string };

  it('keeps uploads pending until a saved item claims them', async () => {
    const { app, store } = build();
    const first = await upload(app);
    const second = await upload(app);
    expect((await readAttachmentMeta(store, 'ws-1', first.id))?.status).toBe('pending');

    const owner = fileOwner('issue', 'issue-1');
    await syncItemFiles(store, 'ws-1', owner, null, {
      description: `![a](${first.url})`,
      attachments: [second],
    });
    expect(await readAttachmentMeta(store, 'ws-1', first.id)).toMatchObject({
      status: 'committed',
      owner,
    });

    // The image left the text: its file goes; the attachment stays.
    await syncItemFiles(
      store,
      'ws-1',
      owner,
      { description: `![a](${first.url})`, attachments: [second] },
      { description: 'no images', attachments: [second] },
    );
    expect(await readAttachmentMeta(store, 'ws-1', first.id)).toBeNull();
    expect(await store.get(attachmentContentKey('ws-1', first.id))).toBeNull();

    // Deleting the item deletes its files, but never files another item owns.
    const shared = await upload(app);
    await syncItemFiles(store, 'ws-1', fileOwner('issue', 'other'), null, [shared.url]);
    await syncItemFiles(store, 'ws-1', owner, { attachments: [second], shared: shared.url }, null);
    expect(await readAttachmentMeta(store, 'ws-1', second.id)).toBeNull();
    expect(await readAttachmentMeta(store, 'ws-1', shared.id)).not.toBeNull();
  });

  it('lets the uploader discard an unsaved upload, never a saved file', async () => {
    const { app, store } = build();
    const unsaved = await upload(app);
    const saved = await upload(app);
    await syncItemFiles(store, 'ws-1', 'issue:1', null, [saved.url]);
    const other = build({ store, context: { ...context, actorId: 'user-2' } });
    await request(other.app).delete(unsaved.url).expect(409);
    await request(app).delete(saved.url).expect(409);
    await request(app).delete(unsaved.url).expect(204);
    expect(await readAttachmentMeta(store, 'ws-1', unsaved.id)).toBeNull();
  });

  it('removes pending uploads nobody saved after an hour', async () => {
    const { app, store } = build();
    const abandoned = await upload(app);
    const kept = await upload(app);
    await syncItemFiles(store, 'ws-1', 'spec:1', null, [kept.url]);
    expect(await sweepPendingFiles(store, PENDING_FILE_TTL_MS, Date.now())).toBe(0);
    expect(
      await sweepPendingFiles(store, PENDING_FILE_TTL_MS, Date.now() + PENDING_FILE_TTL_MS),
    ).toBe(1);
    expect(await readAttachmentMeta(store, 'ws-1', abandoned.id)).toBeNull();
    expect(await readAttachmentMeta(store, 'ws-1', kept.id)).not.toBeNull();
  });
});
