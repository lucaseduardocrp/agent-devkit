import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import {
  createAttachmentsRouter,
  validateAttachments,
  validateImageAttachments,
} from '../src/adapters/http/attachments-routes.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import {
  attachmentContentKey,
  attachmentMetaKey,
  MAX_ATTACHMENTS,
} from '../src/modules/shared/attachment.js';
import {
  resolveWorkspaceAccess,
  uniformModuleAccess,
} from '../src/modules/workspaces/domain/permissions.js';
import type { RequestContext } from '../src/shared/context.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const context: RequestContext = {
  requestId: 'r',
  ownerId: 'ws-1',
  workspaceId: 'ws-1',
  actorId: 'user-1',
};
// A public address, so the proxy accepts it without a DNS lookup.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const PUBLIC = 'https://13.107.42.20/org/_apis/wit/attachments/1?fileName=shot.png';

function build(
  options: {
    store?: InMemoryE2eArtifactStore;
    context?: RequestContext | (() => never);
    noResolver?: boolean;
    providers?: Pick<DynamicProviderFactory, 'resolveMediaAuthorization'> | null;
    fetcher?: typeof fetch;
  } = {},
) {
  const store = options.store ?? new InMemoryE2eArtifactStore();
  const app = express();
  const resolver = () => {
    if (typeof options.context === 'function') return options.context();
    return options.context ?? context;
  };
  app.use(
    createAttachmentsRouter(
      store,
      options.noResolver ? undefined : resolver,
      (options.providers ?? undefined) as DynamicProviderFactory | undefined,
      options.fetcher,
    ),
  );
  app.use(errorMiddleware);
  return { app, store };
}

const adkImage = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'a.png',
  scope: 'issue',
  source: 'adk',
  mimeType: 'image/png',
  ...extra,
});

describe('validateAttachments', () => {
  it('rejects too many, malformed, out-of-scope and repeated attachments', async () => {
    const store = new InMemoryE2eArtifactStore();
    await expect(
      validateAttachments(store, 'ws-1', new Array(MAX_ATTACHMENTS + 1).fill({}), ['issue']),
    ).rejects.toThrow(/up to 20/);
    await expect(validateAttachments(store, 'ws-1', [{ id: 1 }], ['issue'])).rejects.toThrow(
      'invalid',
    );
    await expect(validateAttachments(store, 'ws-1', [adkImage()], ['spec'])).rejects.toThrow(
      'scope',
    );
    const external = {
      id: 'x',
      name: 'n',
      scope: 'issue',
      source: 'url',
      url: 'https://example.com/a.txt',
    };
    await expect(
      validateAttachments(store, 'ws-1', [external, external], ['issue']),
    ).rejects.toThrow('repeated');
    await expect(
      validateAttachments(
        store,
        'ws-1',
        [{ ...external, url: 'https://u:p@example.com/a.txt' }],
        ['issue'],
      ),
    ).rejects.toThrow('HTTPS');
    await expect(
      validateAttachments(
        store,
        'ws-1',
        [{ ...external, url: 'ftp://example.com/a.txt' }],
        ['issue'],
      ),
    ).rejects.toThrow('HTTPS');
    await expect(validateAttachments(store, 'ws-1', [external], ['issue'])).resolves.toEqual([
      external,
    ]);
  });

  it('validates legacy images by their stored bytes', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put(`images/issue/ws-1/${ID}.png`, PNG);
    const [result] = await validateImageAttachments(store, 'ws-1', [adkImage()], ['issue']);
    expect(result).toMatchObject({
      id: ID,
      url: `/attachments/images/issue/${ID}`,
      source: 'adk',
    });
    // Not stored.
    await expect(validateAttachments(store, 'ws-2', [adkImage()], ['issue'])).rejects.toThrow(
      'not found or is invalid',
    );
    // Not an image type.
    await expect(
      validateAttachments(store, 'ws-1', [adkImage({ mimeType: 'text/plain' })], ['issue']),
    ).rejects.toThrow('not found or is invalid');
    await expect(
      validateAttachments(store, 'ws-1', [adkImage({ mimeType: undefined })], ['issue']),
    ).rejects.toThrow('not found or is invalid');
    // Stored bytes do not match the declared type.
    await store.put(`images/issue/ws-1/${ID}.jpg`, PNG);
    await expect(
      validateAttachments(store, 'ws-1', [adkImage({ mimeType: 'image/jpeg' })], ['issue']),
    ).rejects.toThrow('not found or is invalid');
  });
});

describe('uploads', () => {
  const upload = (app: express.Express, query: string, body: Buffer | string = PNG) =>
    request(app)
      .post(`/attachments/files?${query}`)
      .set('content-type', 'application/octet-stream')
      .send(body as Buffer);

  it('requires authentication and a valid scope and name', async () => {
    const anonymous = build({ context: { requestId: 'r' } as RequestContext });
    await upload(anonymous.app, 'scope=issue&name=a.png').expect(401);
    const { app } = build();
    await upload(app, 'scope=nope&name=a.png').expect(500);
    await upload(app, 'scope=issue').expect(500);
  });

  it('rejects empty files', async () => {
    const { app } = build();
    const response = await request(app)
      .post('/attachments/files?scope=issue&name=a.png')
      .set('content-type', 'application/json')
      .send({});
    expect(response.status).toBe(415);
    await request(app)
      .post('/attachments/files?scope=issue&name=a.png')
      .set('content-type', 'application/octet-stream')
      .expect(400);
  });

  it('rejects a body another parser already consumed', async () => {
    const app = express();
    app.use(express.json());
    app.use(createAttachmentsRouter(new InMemoryE2eArtifactStore(), () => context));
    app.use(errorMiddleware);
    await request(app)
      .post('/attachments/files?scope=issue&name=a.png')
      .send({ not: 'a file' })
      .expect(400);
  });

  it('rejects files above the limit of their kind', async () => {
    const { app } = build();
    const huge = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const response = await upload(app, 'scope=issue&name=big.png', huge).expect(413);
    expect(response.body.error?.code ?? response.body.code).toBe('ATTACHMENT_TOO_LARGE');
  });

  it('blocks read-only tokens and members without edit access', async () => {
    await upload(
      build({ context: { ...context, tokenScope: 'read' } }).app,
      'scope=issue&name=a.png',
    ).expect(403);
    await upload(
      build({ context: { ...context, memberRole: 'VIEWER' } }).app,
      'scope=issue&name=a.png',
    ).expect(403);
  });

  it('requires a workspace and omits the uploader when the actor is unknown', async () => {
    const noWorkspace = build({ context: { requestId: 'r', ownerId: 'o' } });
    await upload(noWorkspace.app, 'scope=issue&name=a.png').expect(400);
    const { app, store } = build({
      context: { requestId: 'r', ownerId: 'ws-1', workspaceId: 'ws-1' },
    });
    const response = await upload(app, 'scope=issue&name=a.png').expect(201);
    const meta = JSON.parse(
      (await store.get(attachmentMetaKey('ws-1', response.body.attachment.id)))!.toString(),
    );
    expect(meta.createdBy).toBeUndefined();
    expect(meta.status).toBe('pending');
  });

  it('works without a context resolver when the request is authenticated elsewhere', async () => {
    const { app } = build({ noResolver: true });
    await upload(app, 'scope=issue&name=a.png').expect(401);
  });

  it('forwards context resolution failures', async () => {
    const { app } = build({
      context: () => {
        throw new Error('resolver failed');
      },
    });
    await upload(app, 'scope=issue&name=a.png').expect(500);
  });
});

describe('downloads and deletes', () => {
  const saveFile = async (
    store: InMemoryE2eArtifactStore,
    extra: Record<string, unknown> = {},
    content: Buffer | null = PNG,
  ) => {
    await store.put(
      attachmentMetaKey('ws-1', ID),
      Buffer.from(
        JSON.stringify({
          id: ID,
          name: 'a.png',
          kind: 'image',
          mimeType: 'image/png',
          size: 1,
          scope: 'issue',
          createdAt: new Date().toISOString(),
          ...extra,
        }),
      ),
    );
    if (content) await store.put(attachmentContentKey('ws-1', ID), content);
  };

  it('answers 404 for unknown ids, missing content and bad ids', async () => {
    const { app, store } = build();
    await request(app).get(`/attachments/files/${ID}`).expect(404);
    await request(app).get('/attachments/files/not-a-uuid').expect(500);
    await saveFile(store, {}, null);
    await request(app).get(`/attachments/files/${ID}`).expect(404);
  });

  it('requires view access to the scope of the file', async () => {
    const store = new InMemoryE2eArtifactStore();
    await saveFile(store);
    await request(build({ store }).app).get(`/attachments/files/${ID}`).expect(200);
    const denied = build({
      store,
      context: {
        ...context,
        access: {
          modules: { ...uniformModuleAccess('view'), issues: 'none' },
          workspace: resolveWorkspaceAccess('VIEWER', {}),
        },
      },
    });
    await request(denied.app).get(`/attachments/files/${ID}`).expect(403);
  });

  it('treats deleting an unknown file as done', async () => {
    const { app } = build();
    await request(app).delete(`/attachments/files/${ID}`).expect(204);
    await request(app).delete('/attachments/files/nope').expect(500);
  });

  it('only lets the uploader delete a pending file, with edit access', async () => {
    const store = new InMemoryE2eArtifactStore();
    await saveFile(store, { status: 'pending', createdBy: 'user-1' });
    await request(build({ store, context: { ...context, tokenScope: 'read' } }).app)
      .delete(`/attachments/files/${ID}`)
      .expect(403);
    await request(build({ store, context: { ...context, actorId: 'other' } }).app)
      .delete(`/attachments/files/${ID}`)
      .expect(409);
    await request(build({ store }).app).delete(`/attachments/files/${ID}`).expect(204);
    expect(await store.get(attachmentContentKey('ws-1', ID))).toBeNull();
    await saveFile(store, { status: 'committed', createdBy: 'user-1' });
    await request(build({ store }).app).delete(`/attachments/files/${ID}`).expect(409);
  });

  it('serves legacy images by scope and id', async () => {
    const store = new InMemoryE2eArtifactStore();
    await store.put(`images/issue/ws-1/${ID}.png`, PNG);
    await store.put(`images/pbi/ws-1/${ID}.jpg`, PNG);
    const { app } = build({ store });
    const found = await request(app).get(`/attachments/images/issue/${ID}`).expect(200);
    expect(found.headers['content-type']).toBe('image/png');
    expect(found.headers['content-disposition']).toContain('inline');
    // Content that does not match the extension is not served.
    await request(app).get(`/attachments/images/pbi/${ID}`).expect(404);
    await request(app).get(`/attachments/images/spec/${ID}`).expect(404);
    await request(app).get(`/attachments/images/nope/${ID}`).expect(500);
    await request(app).get('/attachments/images/issue/nope').expect(500);
    await store.put(`images/issue/ws-1/${ID}.jpg`, JPEG);
    await request(app).get(`/attachments/images/issue/${ID}`).expect(200);
  });

  it('serves documents as downloads', async () => {
    const store = new InMemoryE2eArtifactStore();
    await saveFile(
      store,
      { kind: 'document', mimeType: 'application/pdf', name: 'r.pdf' },
      Buffer.from('%PDF-1.7'),
    );
    const { app } = build({ store });
    const response = await request(app).get(`/attachments/files/${ID}`).expect(200);
    expect(response.headers['content-disposition']).toContain('attachment');
  });
});

describe('proxy', () => {
  const authorized = {
    resolveMediaAuthorization: vi.fn(async () => ({ authorization: 'Basic a' })),
  };
  const get = (app: express.Express, url: string) =>
    request(app).get(`/attachments/proxy?url=${encodeURIComponent(url)}`);

  it('rejects invalid and non-https URLs', async () => {
    const { app } = build({ providers: authorized });
    await request(app).get('/attachments/proxy').expect(500);
    await request(app).get('/attachments/proxy?url=nope').expect(500);
    await get(app, 'http://13.107.42.20/a.png').expect(400);
    await get(app, 'https://user:pw@13.107.42.20/a.png').expect(400);
  });

  it('refuses hosts that no integration owns, including when no providers exist', async () => {
    await get(build().app, PUBLIC).expect(403);
  });

  it('answers 502 when the provider does not return the file', async () => {
    const statuses = [
      new Response('x', { status: 404 }),
      new Response(null, { status: 200 }),
      new Response('x', { headers: { 'content-length': String(200 * 1024 * 1024) } }),
    ];
    for (const response of statuses) {
      const { app } = build({ providers: authorized, fetcher: vi.fn(async () => response) });
      await get(app, PUBLIC).expect(502);
    }
    const stream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(60 * 1024 * 1024));
          controller.enqueue(new Uint8Array(60 * 1024 * 1024));
          controller.close();
        },
      }),
    );
    await get(
      build({ providers: authorized, fetcher: vi.fn(async () => stream) }).app,
      PUBLIC,
    ).expect(502);
    // Private address
    await get(build({ providers: authorized }).app, 'https://10.0.0.1/a.png').expect(502);
  });

  it('answers 415 for unsupported file types', async () => {
    const fetcher = vi.fn(async () => new Response(Buffer.from('MZ\u0090\u0000'), { status: 200 }));
    await get(build({ providers: authorized, fetcher }).app, PUBLIC).expect(415);
  });

  it('follows redirects without credentials and gives up after too many', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://13.107.42.21/signed' } }),
      )
      .mockResolvedValueOnce(
        new Response(PNG, {
          headers: { 'content-disposition': 'inline; filename="my pic.png"' },
        }),
      );
    const { app } = build({ providers: authorized, fetcher });
    const response = await get(app, PUBLIC).expect(200);
    expect(response.headers['content-disposition']).toContain('my pic.png');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ headers: { authorization: 'Basic a' } });
    expect(fetcher.mock.calls[1]![1]).toMatchObject({ headers: {} });

    const loop = vi.fn(
      async () =>
        new Response(null, { status: 301, headers: { location: 'https://13.107.42.22/x' } }),
    );
    await get(build({ providers: authorized, fetcher: loop }).app, PUBLIC).expect(502);
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it('names the file from the disposition, query string or path', async () => {
    const send = async (url: string, headers: Record<string, string> = {}) => {
      const fetcher = vi.fn(async () => new Response(PNG, { headers }));
      const response = await get(build({ providers: authorized, fetcher }).app, url).expect(200);
      return response.headers['content-disposition'] as string;
    };
    expect(
      await send(PUBLIC, { 'content-disposition': "attachment; filename*=UTF-8''a%20b.png" }),
    ).toContain('a b.png');
    expect(await send(PUBLIC)).toContain('shot.png');
    expect(await send('https://13.107.42.20/items?path=%2Fdir%2Fdeep.png')).toContain('deep.png');
    expect(await send('https://13.107.42.20/dir/plain.png')).toContain('plain.png');
    expect(await send('https://13.107.42.20/')).toContain('filename=""');
  });
});
