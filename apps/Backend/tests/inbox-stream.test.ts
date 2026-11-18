import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import { eventingIssueStore } from '../src/modules/issues/eventing-issue-store.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryEventBus, type RealtimeEvent } from '../src/modules/realtime/event-bus.js';

const workspaceId = 'workspace-a';

describe('eventingIssueStore', () => {
  function setup() {
    const bus = new InMemoryEventBus();
    const events: RealtimeEvent[] = [];
    bus.subscribe(workspaceId, (event) => events.push(event));
    return { store: eventingIssueStore(new InMemoryIssueStore(), bus), events };
  }

  it('announces the issue that was created, changed or removed', async () => {
    const { store, events } = setup();
    const issue = await store.create(workspaceId, 'user-a', { title: 'First' });
    await store.update(workspaceId, issue.id, { title: 'Second' });
    await store.remove(workspaceId, issue.id);
    expect(events.map((event) => [event.type, event.data])).toEqual([
      ['issue', { issueId: issue.id }],
      ['issue', { issueId: issue.id }],
      ['issue', { issueId: issue.id }],
    ]);
  });

  it('stays quiet when nothing changed', async () => {
    const { store, events } = setup();
    expect(await store.update(workspaceId, 'ghost', { title: 'x' })).toBeNull();
    expect(await store.remove(workspaceId, 'ghost')).toBe(false);
    expect(events).toEqual([]);
  });

  it('reads, comments and keeps the inbox state without announcing', async () => {
    const { store, events } = setup();
    const issue = await store.create(workspaceId, 'user-a', { title: 'First' });
    events.length = 0;
    await store.addComment(issue.id, 'user-a', 'Hello');
    await store.setInboxState(issue.id, 'user-a', { readAt: new Date(), archivedAt: null });
    expect(await store.list(workspaceId)).toHaveLength(1);
    expect((await store.search(workspaceId, { page: 1, pageSize: 10 })).total).toBe(1);
    expect((await store.get(workspaceId, issue.id))?.title).toBe('First');
    expect(await store.comments(issue.id)).toHaveLength(1);
    expect(await store.inboxStates(workspaceId, 'user-a')).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe('GET /inbox/stream', () => {
  function setup() {
    const eventBus = new InMemoryEventBus();
    const app = createApp({
      eventBus,
      requestContextResolver: () => ({
        requestId: 'inbox-stream-test',
        ownerId: workspaceId,
        workspaceId,
        actorId: 'user-a',
        memberRole: 'ADMIN',
      }),
    });
    return { app, eventBus };
  }

  /** Opens the stream and hands back what has arrived so far, as it arrives. */
  async function open(app: ReturnType<typeof setup>['app']) {
    const server = app.listen(0);
    const controller = new AbortController();
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/inbox/stream`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    return {
      response,
      received: () => received,
      /** Reads until `text` has arrived `times` times in all. */
      readUntil: async (text: string, times = 1) => {
        while (received.split(text).length - 1 < times) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`Stream ended before "${text}": ${received}`);
          received += decoder.decode(value);
        }
      },
      close: async () => {
        controller.abort();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  it('nudges the caller when an issue is created', async () => {
    const { app, eventBus } = setup();
    const stream = await open(app);
    try {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get('content-type')).toContain('text/event-stream');
      await stream.readUntil('event: ready');
      expect(eventBus.subscriberCount(workspaceId)).toBe(1);

      const created = await request(app).post('/issues').send({ title: 'Review me' }).expect(201);
      await stream.readUntil('event: inbox');
      await stream.readUntil(`"issueId":"${created.body.issue.id}"`);
    } finally {
      await stream.close();
    }
    await vi.waitFor(() => expect(eventBus.subscriberCount(workspaceId)).toBe(0));
  });

  it('nudges the caller about a comment and about a read mark', async () => {
    const { app } = setup();
    const created = await request(app).post('/issues').send({ title: 'Talk' }).expect(201);
    const id = created.body.issue.id as string;
    const stream = await open(app);
    try {
      await stream.readUntil('event: ready');
      await request(app).post(`/issues/${id}/comments`).send({ body: 'Hi' }).expect(201);
      await stream.readUntil('event: inbox');
      await request(app).patch(`/inbox/${id}`).send({ read: true }).expect(200);
      await stream.readUntil('event: inbox', 2);
    } finally {
      await stream.close();
    }
  });

  it('forwards only the runs executed while the issue was assigned to the caller', async () => {
    const { app, eventBus } = setup();
    const stream = await open(app);
    try {
      await stream.readUntil('event: ready');
      eventBus.publish(workspaceId, 'run', {
        id: 'r1',
        issueId: 'someone-else',
        assigneeUserId: 'user-b',
      });
      eventBus.publish(workspaceId, 'development', { id: 'd1' });
      eventBus.publish(workspaceId, 'run', { id: 'r2', issueId: 'mine', assigneeUserId: 'user-a' });
      await stream.readUntil('"issueId":"mine"');
      expect(stream.received()).not.toContain('someone-else');
      expect(stream.received()).not.toContain('event: development');
      expect(stream.received()).not.toContain('event: run');
      expect(stream.received()).not.toContain('"prompt"');
    } finally {
      await stream.close();
    }
  });

  it('answers 501 when the server has no event bus', async () => {
    const express = (await import('express')).default;
    const bare = express().use(
      createIssuesRouter(new InMemoryIssueStore(), {} as never, {} as never, {} as never, () => ({
        requestId: 't',
        ownerId: workspaceId,
        workspaceId,
        actorId: 'user-a',
        memberRole: 'ADMIN',
      })),
    );
    await request(bare).get('/inbox/stream').expect(501);
  });
});
