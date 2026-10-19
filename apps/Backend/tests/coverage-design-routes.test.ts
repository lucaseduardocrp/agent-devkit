import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, errorMiddleware } from '../src/adapters/http/app.js';
import { createDesignRouter, designImagesSchema } from '../src/adapters/http/design-routes.js';
import { ApplicationError } from '../src/shared/errors.js';
import {
  DesignService,
  type DesignProject,
  type DesignRemoteStore,
  type DesignSystem,
} from '../src/modules/design/application/design-service.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';

const context = () => ({
  requestId: 'r',
  ownerId: 'ws-1',
  workspaceId: 'ws-1',
  actorId: 'u1',
  memberRole: 'ADMIN' as const,
});

const project: DesignProject = {
  id: 'login-1234',
  provider: 'github',
  title: 'Login',
  agentId: 'agent',
  updatedAt: '2026-01-01',
  files: [{ name: 'index.html', language: 'html', content: '<main />' }],
  messages: [],
};

function store(): DesignRemoteStore {
  return {
    configuredProviders: vi.fn().mockResolvedValue(['github']),
    list: vi.fn().mockResolvedValue([project]),
    find: vi.fn(async (_ws, _provider, id: string) => (id === project.id ? project : null)),
    save: vi.fn(async (_ws, saved: DesignProject) => saved),
    delete: vi.fn(async (_ws, _provider, id: string) => id === project.id),
    listDesignSystems: vi
      .fn()
      .mockResolvedValue([{ id: 'aurora', name: 'Aurora', content: '<html>', updatedAt: '' }]),
    saveDesignSystem: vi.fn(async (_ws: string, _provider: string, system: DesignSystem) => system),
    deleteDesignSystem: vi.fn(async (_ws, _provider, id: string) => id === 'aurora'),
  };
}

function setup(resolver: () => ReturnType<typeof context> = context) {
  const designStore = store();
  const executeAgent = vi.fn(async (_ws: string, _agent: string, input: { prompt: string }) => ({
    result: input.prompt.startsWith('Crie um Design System')
      ? '<!doctype html><html></html>'
      : JSON.stringify({
          summary: 'Done',
          files: [{ name: 'index.html', language: 'html', content: '<main>new</main>' }],
        }),
  }));
  const app = createApp({
    designStore,
    agentService: { executeAgent } as unknown as AgentService,
    requestContextResolver: resolver,
  });
  return { app, designStore, executeAgent };
}

const agentId = '11111111-1111-4111-8111-111111111111';

describe('design routes', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards context resolution failures to the error handler', async () => {
    const app = express();
    app.use(
      createDesignRouter(new DesignService(store(), {} as AgentService), () => {
        throw new ApplicationError('UNAUTHORIZED', 'Session expired.', 401);
      }),
    );
    app.use(errorMiddleware);
    const response = await request(app).get('/design/providers');
    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).toContain('UNAUTHORIZED');
  });

  it('lists providers, projects and a single project', async () => {
    const { app, designStore } = setup();
    expect((await request(app).get('/design/providers').expect(200)).body).toEqual({
      providers: ['github'],
    });
    expect(
      (await request(app).get('/design/projects?provider=github').expect(200)).body.projects,
    ).toHaveLength(1);
    expect(
      (await request(app).get('/design/projects/login-1234?provider=github').expect(200)).body,
    ).toMatchObject({ id: 'login-1234', title: 'Login' });
    await request(app).get('/design/projects/missing?provider=github').expect(404);

    vi.spyOn(designStore, 'configuredProviders').mockRejectedValueOnce(new Error('boom'));
    await request(app).get('/design/providers').expect(500);
    await request(app).get('/design/projects?provider=gitlab').expect(500);
    await request(app).get('/design/projects/Bad_Id?provider=github').expect(500);
  });

  it('lists, generates, saves and deletes design systems', async () => {
    const { app } = setup();
    expect(
      (await request(app).get('/design/systems?provider=github').expect(200)).body.systems,
    ).toEqual([expect.objectContaining({ id: 'aurora' })]);
    await request(app).get('/design/systems').expect(500);

    expect(
      (
        await request(app)
          .post('/design/systems/generate')
          .send({ agentId, prompt: 'Dark theme' })
          .expect(200)
      ).body,
    ).toEqual({ content: '<!doctype html><html></html>' });
    await request(app).post('/design/systems/generate').send({ prompt: 'x' }).expect(400);

    const saved = await request(app)
      .put('/design/systems?provider=azure')
      .send({ id: 'aurora', name: 'Aurora', content: '<html>' })
      .expect(200);
    expect(saved.body).toMatchObject({ id: 'aurora', name: 'Aurora' });
    await request(app).put('/design/systems').send({ name: 'A', content: 'x' }).expect(500);

    await request(app).delete('/design/systems/aurora?provider=github').expect(204);
    await request(app).delete('/design/systems/missing?provider=github').expect(404);
  });

  it('creates projects through an agent and rejects invalid bodies', async () => {
    const { app, executeAgent } = setup();
    const created = await request(app)
      .post('/design/projects')
      .send({ title: 'Login', agentId, prompt: 'Login page', provider: 'github' })
      .expect(201);
    expect(created.body.files[0].content).toBe('<main>new</main>');
    expect(executeAgent).toHaveBeenCalledTimes(1);
    await request(app).post('/design/projects').send({ title: '' }).expect(400);
  });

  it('chats, updates files and deletes projects', async () => {
    const { app, designStore } = setup();
    const chatted = await request(app)
      .post('/design/projects/login-1234/messages?provider=github')
      .send({ content: 'Add a button' })
      .expect(200);
    expect(chatted.body.messages.map((message: { content: string }) => message.content)).toEqual([
      'Add a button',
      'Done',
    ]);
    await request(app)
      .post('/design/projects/login-1234/messages?provider=github')
      .send({ content: '' })
      .expect(400);

    const files = [{ name: 'index.html', language: 'html', content: '<main>edited</main>' }];
    const updated = await request(app)
      .put('/design/projects/login-1234/files?provider=github')
      .send({ files })
      .expect(200);
    expect(updated.body.files).toEqual(files);
    await request(app)
      .put('/design/projects/login-1234/files?provider=github')
      .send({ files: [{ name: '../x', language: 'js', content: '' }] })
      .expect(400);

    await request(app).delete('/design/projects/login-1234?provider=github').expect(204);
    expect(vi.mocked(designStore).delete.mock.calls).toEqual([['ws-1', 'github', 'login-1234']]);
    await request(app).delete('/design/projects/missing?provider=github').expect(404);
  });
});

describe('design image signatures', () => {
  const encode = (hex: string, ascii = '') =>
    Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from(ascii, 'ascii')]).toString('base64');

  it('accepts JPEG, GIF and WEBP signatures', () => {
    expect(
      designImagesSchema.parse([
        { mimeType: 'image/jpeg', data: encode('ffd8ffe000') },
        { mimeType: 'image/gif', data: encode('', 'GIF89a..') },
        { mimeType: 'image/webp', data: encode('', 'RIFF\0\0\0\0WEBPVP8 ') },
      ]),
    ).toHaveLength(3);
  });

  it('rejects mismatched GIF and WEBP data and non-base64 payloads', () => {
    expect(() =>
      designImagesSchema.parse([{ mimeType: 'image/gif', data: encode('', 'PNG...') }]),
    ).toThrow();
    expect(() =>
      designImagesSchema.parse([{ mimeType: 'image/webp', data: encode('', 'RIFF\0\0\0\0AVI ') }]),
    ).toThrow();
    expect(() => designImagesSchema.parse([{ mimeType: 'image/png', data: '!!!' }])).toThrow();
  });
});
