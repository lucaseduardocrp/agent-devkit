import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createNotificationsRouter } from '../src/adapters/http/notifications-routes.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { EmailNotificationChannel } from '../src/modules/notifications/adapters/email-channel.js';
import { PrismaNotificationContactStore } from '../src/modules/notifications/adapters/prisma-contact-store.js';
import {
  NotificationChannelRegistry,
  type NotificationChannel,
} from '../src/modules/notifications/application/channel.js';
import { InMemoryNotificationContactStore } from '../src/modules/notifications/application/contact-store.js';
import { NotificationService } from '../src/modules/notifications/application/notification-service.js';
import { InMemoryNotificationRuleStore } from '../src/modules/notifications/application/rule-store.js';
import type { RequestContext } from '../src/shared/context.js';

const WS = 'workspace-a';
const ANA = '11111111-1111-4111-8111-111111111111';
const OUTSIDER = '99999999-9999-4999-8999-999999999999';

const BEN = '22222222-2222-4222-8222-222222222222';
const PEOPLE = [
  { id: ANA, name: 'Ana', email: 'ana@x.com' },
  { id: BEN, name: 'Ben', email: 'ben@x.com' },
];

const chat: NotificationChannel = {
  id: 'chat',
  label: 'Chat',
  isAvailable: async () => true,
  send: async () => undefined,
};

describe('InMemoryNotificationContactStore', () => {
  it('keeps one address per person and channel, and removes it on null', async () => {
    const store = new InMemoryNotificationContactStore();
    await store.save(WS, ANA, { email: 'a@x.com', chat: '42' });
    await store.save(WS, ANA, { email: 'b@x.com' });
    await store.save('other', ANA, { email: 'o@x.com' });

    expect(await store.forUser(WS, ANA)).toEqual({ email: 'b@x.com', chat: '42' });
    expect(await store.listForUsers(WS, [ANA])).toHaveLength(2);
    expect(await store.listForUsers(WS, ['someone-else'])).toEqual([]);

    await store.save(WS, ANA, { chat: null });
    expect(await store.forUser(WS, ANA)).toEqual({ email: 'b@x.com' });
    expect(await store.forUser('other', ANA)).toEqual({ email: 'o@x.com' });
  });
});

describe('PrismaNotificationContactStore', () => {
  function build() {
    const rows = [{ userId: ANA, channel: 'email', address: 'a@x.com' }];
    const record = {
      findMany: vi.fn(async () => rows),
      deleteMany: vi.fn((args: unknown) => ({ op: 'delete', args })),
      upsert: vi.fn((args: unknown) => ({ op: 'upsert', args })),
    };
    const db = {
      notificationContactRecord: record,
      $transaction: vi.fn(async (operations: unknown[]) => operations),
    };
    return { record, db, store: new PrismaNotificationContactStore(db as unknown as PrismaClient) };
  }

  it('reads the contacts of a workspace and of one person', async () => {
    const { store, record } = build();
    expect(await store.listForUsers(WS, [ANA])).toEqual([
      { userId: ANA, channel: 'email', address: 'a@x.com' },
    ]);
    expect(record.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId: WS, userId: { in: [ANA] } },
    });
    // Nobody asked about: nothing to look up.
    record.findMany.mockClear();
    expect(await store.listForUsers(WS, [])).toEqual([]);
    expect(record.findMany).not.toHaveBeenCalled();
    expect(await store.forUser(WS, ANA)).toEqual({ email: 'a@x.com' });
    expect(record.findMany).toHaveBeenLastCalledWith({ where: { workspaceId: WS, userId: ANA } });
  });

  it('upserts addresses and deletes the ones set to null, in one transaction', async () => {
    const { store, record, db } = build();
    await store.save(WS, ANA, { email: 'new@x.com', chat: null });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(record.upsert).toHaveBeenCalledWith({
      where: { workspaceId_userId_channel: { workspaceId: WS, userId: ANA, channel: 'email' } },
      create: { workspaceId: WS, userId: ANA, channel: 'email', address: 'new@x.com' },
      update: { address: 'new@x.com' },
    });
    expect(record.deleteMany).toHaveBeenCalledWith({
      where: { workspaceId: WS, userId: ANA, channel: 'chat' },
    });
  });
});

describe('the e-mail channel and contacts', () => {
  it('validates the address an admin types', () => {
    const channel = new EmailNotificationChannel(null);
    expect(channel.validateAddress('ana@work.com')).toBeNull();
    expect(channel.validateAddress('not an email')).toMatch(/valid e-mail/);
  });

  it('sends to the contact address when there is one, and to the account e-mail otherwise', async () => {
    const send = vi.fn(async () => undefined);
    const channel = new EmailNotificationChannel({ send });
    const message = { title: 'Hi', text: 'Hello' };
    const recipient = { userId: ANA, name: 'Ana', email: 'account@x.com' };

    await channel.send({ workspaceId: WS, recipient, message });
    await channel.send({
      workspaceId: WS,
      recipient: { ...recipient, addresses: { email: 'work@x.com' } },
      message,
    });

    expect(send.mock.calls.map((call) => (call as unknown as [{ to: string }])[0].to)).toEqual([
      'account@x.com',
      'work@x.com',
    ]);
  });
});

describe('notification contact routes', () => {
  const context = (role: RequestContext['memberRole']): RequestContext => ({
    requestId: 't',
    ownerId: WS,
    workspaceId: WS,
    actorId: ANA,
    ...(role ? { memberRole: role } : {}),
  });

  function build(role: RequestContext['memberRole'] = 'ADMIN') {
    const registry = new NotificationChannelRegistry([new EmailNotificationChannel(null), chat]);
    const contacts = new InMemoryNotificationContactStore();
    const service = new NotificationService({
      channels: registry,
      rules: new InMemoryNotificationRuleStore(),
      directory: { find: async () => null },
    });
    const app = express();
    app.use(express.json());
    app.use(
      createNotificationsRouter(
        {
          service,
          rules: new InMemoryNotificationRuleStore(),
          channels: registry,
          issues: new InMemoryIssueStore(),
          contacts,
          people: async (_workspace, query) => {
            const all = PEOPLE.filter(
              (person) =>
                !query.search || person.name.toLowerCase().includes(query.search.toLowerCase()),
            );
            return {
              people: all.slice(query.offset, query.offset + query.limit),
              total: all.length,
            };
          },
          isMember: async (_workspace, id) => id === ANA,
        },
        () => context(role),
      ),
    );
    app.use(errorMiddleware);
    return { app, contacts };
  }

  it('lists one page of the people, with the addresses of those on it', async () => {
    const { app, contacts } = build();
    await contacts.save(WS, ANA, { email: 'work@x.com' });
    await contacts.save(WS, BEN, { chat: '@ben' });

    const first = await request(app).get('/notifications/people?limit=1').expect(200);
    expect(first.body).toEqual({
      total: 2,
      people: [{ userId: ANA, name: 'Ana', email: 'ana@x.com', contacts: { email: 'work@x.com' } }],
    });
    const second = await request(app).get('/notifications/people?limit=1&offset=1').expect(200);
    expect(second.body.people).toEqual([
      { userId: BEN, name: 'Ben', email: 'ben@x.com', contacts: { chat: '@ben' } },
    ]);
    const found = await request(app).get('/notifications/people?search=ben').expect(200);
    expect(found.body.total).toBe(1);
  });

  it('refuses a page that makes no sense', async () => {
    const { app } = build();
    await request(app).get('/notifications/people?limit=0').expect(400);
    await request(app).get('/notifications/people?limit=500').expect(400);
    await request(app).get('/notifications/people?offset=-1').expect(400);
  });

  it('shows the people to a member, without where they are reached', async () => {
    const { app, contacts } = build('MEMBER');
    await contacts.save(WS, ANA, { email: 'work@x.com' });
    const response = await request(app).get('/notifications/people').expect(200);
    expect(response.body.people[0]).toMatchObject({ name: 'Ana', contacts: {} });
  });

  it('is closed to someone who is not in the workspace', async () => {
    const { app } = build(null as unknown as undefined);
    await request(app).get('/notifications/people').expect(403);
  });

  it('saves, changes and removes the addresses of a member', async () => {
    const { app, contacts } = build();
    const saved = await request(app)
      .put(`/notifications/contacts/${ANA}`)
      .send({ contacts: { email: ' work@x.com ', chat: '@ana' } })
      .expect(200);
    expect(saved.body.contacts).toHaveLength(2);
    expect(await contacts.forUser(WS, ANA)).toEqual({ email: 'work@x.com', chat: '@ana' });

    // An empty address removes it; the channel that is not named stays as it was.
    const cleared = await request(app)
      .put(`/notifications/contacts/${ANA}`)
      .send({ contacts: { email: '' } })
      .expect(200);
    expect(cleared.body.contacts).toEqual([{ userId: ANA, channel: 'chat', address: '@ana' }]);
  });

  it('refuses an invalid address, an unknown channel and someone who is not a member', async () => {
    const { app } = build();
    const invalid = await request(app)
      .put(`/notifications/contacts/${ANA}`)
      .send({ contacts: { email: 'nope' } })
      .expect(400);
    expect(invalid.body.error?.code ?? invalid.body.code).toBe('NOTIFICATION_CONTACT_INVALID');

    await request(app)
      .put(`/notifications/contacts/${ANA}`)
      .send({ contacts: { pigeon: 'coo' } })
      .expect(400);
    await request(app)
      .put(`/notifications/contacts/${OUTSIDER}`)
      .send({ contacts: { chat: '1' } })
      .expect(400);
    await request(app).put('/notifications/contacts/not-a-uuid').send({ contacts: {} }).expect(400);
  });

  it('is for admins only', async () => {
    const { app } = build('MEMBER');
    await request(app)
      .put(`/notifications/contacts/${ANA}`)
      .send({ contacts: { chat: '1' } })
      .expect(403);
  });

  it('passes a failure of the store on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, contacts } = build();
    vi.spyOn(contacts, 'listForUsers').mockRejectedValueOnce(new Error('db down'));
    await request(app).get('/notifications/people').expect(500);
    vi.spyOn(contacts, 'save').mockRejectedValueOnce(new Error('db down'));
    await request(app)
      .put(`/notifications/contacts/${ANA}`)
      .send({ contacts: { chat: '1' } })
      .expect(500);
  });
});
