import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { createDevelopmentRouter } from '../src/adapters/http/development-routes.js';
import {
  developmentEventFromKey,
  developmentEventKey,
  EventingDevelopmentStore,
} from '../src/modules/development/development-events.js';
import { DevelopmentService } from '../src/modules/development/development-service.js';
import { InMemoryDevelopmentStore } from '../src/modules/development/development-store.js';
import { InMemoryEventBus, type RealtimeEvent } from '../src/modules/realtime/event-bus.js';
import { FakeScriptRepository } from './helpers/fake-script-repository.js';
import express from 'express';
import { errorMiddleware } from '../src/adapters/http/app.js';

function setup() {
  const eventBus = new InMemoryEventBus();
  const app = createApp({
    eventBus,
    e2eScripts: new FakeScriptRepository(),
    requestContextResolver: () => ({
      requestId: 'development-stream',
      ownerId: 'ws-a',
      workspaceId: 'ws-a',
      actorId: 'user-a',
      actorName: 'Alice',
      memberRole: 'ADMIN',
    }),
  });
  return { app, eventBus };
}

describe('development bus keys', () => {
  it('tells which item moved from the key', () => {
    expect(developmentEventKey('session', 's1')).toBe('session:s1');
    expect(developmentEventFromKey('session:s1')).toEqual({ kind: 'session', id: 's1' });
    expect(developmentEventFromKey('change:a:b')).toEqual({ kind: 'change', id: 'a:b' });
    expect(developmentEventFromKey('run:r1')).toBeNull();
    expect(developmentEventFromKey('session:')).toBeNull();
    expect(developmentEventFromKey('nothing')).toBeNull();
  });
});

describe('EventingDevelopmentStore', () => {
  const changeBody = {
    slug: 'a',
    title: 'A',
    summary: '',
    framework: 'openspec' as const,
    status: 'draft' as const,
    artifacts: [],
    repository: null,
    specificationId: null,
    createdBy: null,
    decidedBy: null,
    decidedAt: null,
  };
  const sessionBody = {
    changeId: null,
    pbiItemId: null,
    issueId: null,
    title: 'S',
    prompt: 'p',
    cli: 'claude' as const,
    agentId: null,
    agentIds: [],
    status: 'queued' as const,
    attempt: 1,
    repository: null,
    worktree: { branch: 'adk/s', baseBranch: 'main', path: null },
    context: { windowTokens: 1000, usedTokens: 0, compactAtPercent: 80, compactions: 0 },
    maxSubagents: 3,
    subagents: [],
    events: [],
    diff: [],
    comments: [],
    summary: '',
    error: null,
    runner: null,
    createdBy: null,
    reviewedBy: null,
  };

  it('announces every write of a change or a session, and only what was written', async () => {
    const bus = new InMemoryEventBus();
    const heard: RealtimeEvent[] = [];
    bus.subscribe('ws', (event) => heard.push(event));
    bus.subscribe('other', () => heard.push({ type: 'run', workspaceId: 'x', data: 0, at: '' }));
    const store = new EventingDevelopmentStore(new InMemoryDevelopmentStore(), bus);

    const change = await store.createChange('ws', changeBody);
    await store.updateChange('ws', change.id, { ...changeBody, title: 'B' });
    await store.updateChange('ws', 'ghost', changeBody);
    const session = await store.createSession('ws', sessionBody);
    await store.updateSession('ws', session.id, { ...sessionBody, status: 'running' });
    expect(await store.getChange('ws', change.id)).toMatchObject({ title: 'B' });
    expect(await store.listChanges('ws')).toHaveLength(1);
    expect(await store.getSession('ws', session.id)).toMatchObject({ status: 'running' });
    expect(await store.listSessions('ws')).toHaveLength(1);
    expect(await store.removeSession('other', session.id)).toBe(false);
    expect(await store.removeSession('ws', session.id)).toBe(true);
    expect(await store.removeChange('ws', change.id)).toBe(true);

    expect(heard.map((event) => [event.type, event.data])).toEqual([
      ['development', { kind: 'change', id: change.id }],
      ['development', { kind: 'change', id: change.id }],
      ['development', { kind: 'session', id: session.id }],
      ['development', { kind: 'session', id: session.id }],
      ['development', { kind: 'session', id: session.id, deleted: true }],
      ['development', { kind: 'change', id: change.id, deleted: true }],
    ]);
  });
});

describe('development stream', () => {
  it('streams the changes and sessions of the workspace as they move', async () => {
    const { app, eventBus } = setup();
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/development/stream`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toContain('no-transform');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      const readUntil = async (text: string) => {
        while (!received.includes(text)) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`Stream ended before "${text}": ${received}`);
          received += decoder.decode(value);
        }
      };

      await readUntil('event: ready');
      expect(eventBus.subscriberCount('ws-a')).toBe(1);
      // Runs of the workspace travel on the same bus: this stream is not for them.
      eventBus.publish('ws-a', 'run', { id: 'r1' });

      const created = await request(app)
        .post('/development/sessions')
        .send({ title: 'Implement login', prompt: 'Do it' })
        .expect(201);
      await readUntil('event: development');
      await readUntil(`"kind":"session","id":"${created.body.session.id as string}"`);
      expect(received).not.toContain('event: run');
      expect(received).not.toContain('Do it');
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
    await vi.waitFor(() => expect(eventBus.subscriberCount('ws-a')).toBe(0));
  });

  it('sends a heartbeat so idle proxies keep the stream open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { app } = setup();
    const server = app.listen(0);
    const controller = new AbortController();
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/development/stream`, {
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      await reader.read();
      await vi.advanceTimersByTimeAsync(25_000);
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(': keep-alive');
    } finally {
      controller.abort();
      vi.useRealTimers();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('says live updates are unavailable without a bus', async () => {
    const bare = express();
    bare.use(createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore())));
    bare.use((req, _res, next) => {
      (req as unknown as { user: object }).user = { id: 'u1' };
      next();
    });
    bare.use(errorMiddleware);
    await request(bare).get('/development/stream').expect(401);

    const signedIn = express();
    signedIn.use((req, _res, next) => {
      (req as unknown as { user: object }).user = { id: 'u1' };
      next();
    });
    signedIn.use(
      createDevelopmentRouter(new DevelopmentService(new InMemoryDevelopmentStore()), () => ({
        requestId: 'r',
        ownerId: 'ws',
        workspaceId: 'ws',
      })),
    );
    signedIn.use(errorMiddleware);
    await request(signedIn).get('/development/stream').expect(501);
  });
});
