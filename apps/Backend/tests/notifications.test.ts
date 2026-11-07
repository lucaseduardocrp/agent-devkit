import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import { createNotificationsRouter } from '../src/adapters/http/notifications-routes.js';
import { errorMiddleware } from '../src/adapters/http/app.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import { EmailNotificationChannel } from '../src/modules/notifications/adapters/email-channel.js';
import {
  NotificationChannelRegistry,
  type NotificationChannel,
  type NotificationDelivery,
} from '../src/modules/notifications/application/channel.js';
import { NOTIFICATION_EVENTS } from '../src/modules/notifications/application/event-catalog.js';
import {
  NotificationService,
  type RecipientDirectory,
} from '../src/modules/notifications/application/notification-service.js';
import { InMemoryNotificationContactStore } from '../src/modules/notifications/application/contact-store.js';
import { InMemoryNotificationRuleStore } from '../src/modules/notifications/application/rule-store.js';
import { renderTemplate } from '../src/modules/notifications/application/template.js';
import type { Recipient } from '../src/modules/notifications/domain/notification.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import type { RequestContext } from '../src/shared/context.js';

const WS = 'workspace-a';
const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const people: Record<string, Recipient> = {
  [ANA]: { userId: ANA, name: 'Ana', email: 'ana@example.com' },
  [BEN]: { userId: BEN, name: 'Ben', email: 'ben@example.com' },
  [CAROL]: { userId: CAROL, name: 'Carol', email: 'carol@example.com' },
};
const directory: RecipientDirectory = {
  find: async (_workspaceId, userId) => people[userId] ?? null,
};

/** A channel that records what it delivers, and can be made to break or be unavailable. */
function fakeChannel(
  id = 'chat',
  options: { available?: boolean; failWith?: string } = {},
): NotificationChannel & { sent: NotificationDelivery[] } {
  const sent: NotificationDelivery[] = [];
  return {
    id,
    label: id.toUpperCase(),
    sent,
    isAvailable: async () => options.available ?? true,
    send: async (delivery) => {
      if (options.failWith) throw new Error(options.failWith);
      sent.push(delivery);
    },
  };
}

function setup(channels: NotificationChannel[] = [fakeChannel()]) {
  const rules = new InMemoryNotificationRuleStore();
  const registry = new NotificationChannelRegistry(channels);
  const log = vi.fn();
  const service = new NotificationService({
    channels: registry,
    rules,
    directory,
    workspaceName: async () => 'Acme',
    appUrl: 'https://adk.example.com',
    log,
  });
  return { rules, registry, service, log };
}

const ruleInput = (patch: Record<string, unknown> = {}) => ({
  name: 'Tell the assignee',
  enabled: true,
  event: 'issue.assigned',
  channels: ['chat'],
  recipients: { subject: true, userIds: [] as string[] },
  subject: '',
  message: '',
  ...patch,
});
const event = (patch: Record<string, unknown> = {}) => ({
  type: 'issue.assigned',
  workspaceId: WS,
  actorId: BEN,
  subjectUserId: ANA,
  data: { 'issue.number': '7', 'issue.title': 'Fix login', 'issue.priority': 'high' },
  ...patch,
});

describe('renderTemplate', () => {
  it('fills known names, tolerates spaces and empties unknown ones', () => {
    expect(
      renderTemplate('#{{ issue.number }} {{issue.title}} {{nope}}!', {
        'issue.number': '7',
        'issue.title': 'Fix',
      }),
    ).toBe('#7 Fix !');
    expect(renderTemplate('plain', {})).toBe('plain');
  });
});

describe('NotificationChannelRegistry', () => {
  it('finds channels by id and refuses to register one twice', () => {
    const registry = new NotificationChannelRegistry([fakeChannel('a')]);
    expect(registry.get('a')?.label).toBe('A');
    expect(registry.get('b')).toBeUndefined();
    registry.register(fakeChannel('b'));
    expect(registry.list().map((channel) => channel.id)).toEqual(['a', 'b']);
    expect(() => registry.register(fakeChannel('a'))).toThrow('already registered');
    expect(new NotificationChannelRegistry().list()).toEqual([]);
  });
});

describe('NotificationService.dispatch', () => {
  it('tells the person the event is about, with the wording of the event', async () => {
    const chat = fakeChannel();
    const { rules, service } = setup([chat]);
    await rules.save(WS, null, ruleInput());
    const results = await service.dispatch(event());

    expect(results).toEqual([{ channel: 'chat', userId: ANA, status: 'sent' }]);
    expect(chat.sent).toHaveLength(1);
    expect(chat.sent[0]).toMatchObject({
      workspaceId: WS,
      recipient: people[ANA],
      message: {
        title: 'Issue #7 was assigned to you',
        text: 'Ben assigned you issue #7: Fix login (priority high).',
        url: 'https://adk.example.com',
      },
    });
  });

  it('uses the rule wording, the workspace name and the recipient name when given', async () => {
    const chat = fakeChannel();
    const { rules, service } = setup([chat]);
    await rules.save(
      WS,
      null,
      ruleInput({
        subject: '[{{workspace.name}}] new task',
        message: 'Hi {{recipient.name}}: {{issue.title}}',
      }),
    );
    await service.dispatch(event());
    expect(chat.sent[0]!.message).toMatchObject({
      title: '[Acme] new task',
      text: 'Hi Ana: Fix login',
    });
  });

  it('also tells chosen people, once each, and never the person who did it for the subject', async () => {
    const chat = fakeChannel();
    const { rules, service } = setup([chat]);
    await rules.save(
      WS,
      null,
      ruleInput({ recipients: { subject: true, userIds: [CAROL, CAROL] } }),
    );
    await service.dispatch(event());
    expect(chat.sent.map((delivery) => delivery.recipient.userId).sort()).toEqual(
      [ANA, CAROL].sort(),
    );

    // Assigning to yourself does not notify you...
    chat.sent.length = 0;
    await service.dispatch(event({ actorId: ANA }));
    expect(chat.sent.map((delivery) => delivery.recipient.userId)).toEqual([CAROL]);
    // ...and an event about nobody only reaches the people named.
    chat.sent.length = 0;
    const { subjectUserId: _subject, ...about } = event();
    await service.dispatch(about);
    expect(chat.sent.map((delivery) => delivery.recipient.userId)).toEqual([CAROL]);
  });

  it('reaches every channel of a rule and every rule of the event', async () => {
    const chat = fakeChannel('chat');
    const mail = fakeChannel('mail');
    const { rules, service } = setup([chat, mail]);
    await rules.save(WS, null, ruleInput({ channels: ['chat', 'mail'] }));
    await rules.save(
      WS,
      null,
      ruleInput({
        name: 'Second',
        channels: ['mail'],
        recipients: { subject: false, userIds: [BEN] },
      }),
    );
    const results = await service.dispatch(event());
    expect(results).toHaveLength(3);
    expect(chat.sent).toHaveLength(1);
    expect(mail.sent).toHaveLength(2);
  });

  it('ignores disabled rules, other events, other workspaces and unknown events', async () => {
    const chat = fakeChannel();
    const { rules, service } = setup([chat]);
    await rules.save(WS, null, ruleInput({ enabled: false }));
    await rules.save(WS, null, ruleInput({ event: 'issue.proofreader_assigned' }));
    await rules.save('workspace-b', null, ruleInput());
    expect(await service.dispatch(event())).toEqual([]);
    expect(await service.dispatch(event({ type: 'nothing.happened' }))).toEqual([]);
    expect(chat.sent).toEqual([]);
  });

  it('reports what it could not do instead of failing', async () => {
    const broken = fakeChannel('broken', { failWith: 'x'.repeat(500) });
    const off = fakeChannel('off', { available: false });
    const { rules, service, log } = setup([broken, off, fakeChannel('chat')]);
    await rules.save(
      WS,
      null,
      ruleInput({
        channels: ['broken', 'off', 'ghost', 'chat'],
        recipients: { subject: true, userIds: ['44444444-4444-4444-8444-444444444444'] },
      }),
    );
    const results = await service.dispatch(event());
    const by = (channel: string, userId: string) =>
      results.find((r) => r.channel === channel && r.userId === userId)!;

    expect(by('broken', ANA)).toMatchObject({ status: 'failed' });
    expect(by('broken', ANA).reason).toHaveLength(300);
    expect(by('off', ANA)).toMatchObject({
      status: 'skipped',
      reason: 'The channel is not set up.',
    });
    expect(by('ghost', ANA)).toMatchObject({ status: 'skipped', reason: 'Unknown channel.' });
    expect(by('chat', ANA).status).toBe('sent');
    expect(by('chat', '44444444-4444-4444-8444-444444444444')).toMatchObject({
      status: 'skipped',
      reason: 'Not a member of the workspace.',
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('broken could not deliver'),
      expect.any(Error),
    );
  });

  it('handles errors that are not Error objects and channels that cannot tell if they are ready', async () => {
    const odd: NotificationChannel = {
      id: 'odd',
      label: 'Odd',
      isAvailable: async () => true,
      // A channel library may reject with something that is not an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      send: () => Promise.reject('nope'),
    };
    const moody: NotificationChannel = {
      id: 'moody',
      label: 'Moody',
      isAvailable: () => Promise.reject(new Error('down')),
      send: async () => undefined,
    };
    const { rules, service } = setup([odd, moody]);
    await rules.save(WS, null, ruleInput({ channels: ['odd', 'moody'] }));
    const results = await service.dispatch(event());
    expect(results.find((r) => r.channel === 'odd')).toMatchObject({
      status: 'failed',
      reason: 'Delivery failed.',
    });
    expect(results.find((r) => r.channel === 'moody')).toMatchObject({
      status: 'failed',
      reason: 'down',
    });
    expect((await service.channels(WS)).find((c) => c.id === 'moody')).toMatchObject({
      available: false,
    });
  });

  it('works for an event nobody caused', async () => {
    const chat = fakeChannel();
    const { rules, service } = setup([chat]);
    await rules.save(WS, null, ruleInput());
    const { actorId: _actor, ...system } = event();
    expect(await service.dispatch(system)).toHaveLength(1);
    expect(chat.sent[0]!.message.text).toContain('Someone assigned you');
  });

  it('never throws, even when the rules cannot be read', async () => {
    const { rules, service, log } = setup();
    vi.spyOn(rules, 'listForEvent').mockRejectedValue(new Error('db down'));
    expect(await service.dispatch(event())).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      '[Notifications] Could not dispatch an event:',
      expect.any(Error),
    );
  });
});

describe('NotificationService.send', () => {
  it('sends straight to people, names the actor and falls back when it is unknown', async () => {
    const chat = fakeChannel();
    const { service } = setup([chat]);
    await service.send({
      workspaceId: WS,
      actorId: BEN,
      userIds: [ANA],
      channels: ['chat'],
      subject: 's',
      message: '{{actor.name}} -> {{recipient.name}}',
    });
    expect(chat.sent[0]!.message.text).toBe('Ben -> Ana');
    await service.send({
      workspaceId: WS,
      actorId: '99999999-9999-4999-8999-999999999999',
      userIds: [ANA],
      channels: ['chat'],
      subject: 's',
      message: '{{actor.name}}',
    });
    await service.send({
      workspaceId: WS,
      userIds: [ANA],
      channels: ['chat'],
      subject: 's',
      message: '{{actor.name}}',
    });
    expect(chat.sent.map((d) => d.message.text)).toEqual(['Ben -> Ana', 'Someone', 'Someone']);
  });

  it('works without a workspace name or app link, and never throws', async () => {
    const chat = fakeChannel();
    const bare = new NotificationService({
      channels: new NotificationChannelRegistry([chat]),
      rules: new InMemoryNotificationRuleStore(),
      directory,
      workspaceName: async () => Promise.reject(new Error('x')),
    });
    await bare.send({
      workspaceId: WS,
      userIds: [ANA],
      channels: ['chat'],
      subject: '{{workspace.name}}!',
      message: 'm',
    });
    expect(chat.sent[0]!.message).toEqual({ title: '!', text: 'm' });

    const failing = new NotificationService({
      channels: new NotificationChannelRegistry([chat]),
      rules: new InMemoryNotificationRuleStore(),
      directory: { find: () => Promise.reject(new Error('db')) },
      log: vi.fn(),
    });
    expect(
      await failing.send({
        workspaceId: WS,
        userIds: [ANA],
        channels: ['chat'],
        subject: 's',
        message: 'm',
      }),
    ).toEqual([]);
    const noName = new NotificationService({
      channels: new NotificationChannelRegistry([chat]),
      rules: new InMemoryNotificationRuleStore(),
      directory,
    });
    await noName.send({
      workspaceId: WS,
      userIds: [ANA],
      channels: ['chat'],
      subject: '[{{workspace.name}}]',
      message: 'm',
    });
    expect(chat.sent.at(-1)!.message.title).toBe('[]');
  });

  it('falls back to the console when no logger is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new NotificationService({
      channels: new NotificationChannelRegistry([fakeChannel()]),
      rules: new InMemoryNotificationRuleStore(),
      directory: { find: () => Promise.reject(new Error('db')) },
    });
    await service.send({
      workspaceId: WS,
      userIds: [ANA],
      channels: ['chat'],
      subject: 's',
      message: 'm',
    });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('sends about an issue to the roles it holds and fills its values', async () => {
    const chat = fakeChannel();
    const { service } = setup([chat]);
    const issue = {
      number: 7,
      title: 'Fix login',
      status: 'todo',
      priority: 'high',
      assigneeUserId: ANA,
      proofreaderUserId: CAROL,
    } as never;
    await service.sendForIssue({
      workspaceId: WS,
      issue,
      roles: ['assignee', 'proofreader'],
      userIds: [BEN],
      channels: ['chat'],
      subject: '#{{issue.number}}',
      message: '{{issue.title}} is {{issue.status}}',
    });
    expect(chat.sent.map((d) => d.recipient.userId).sort()).toEqual([ANA, BEN, CAROL].sort());
    expect(chat.sent[0]!.message.text).toBe('Fix login is todo');

    chat.sent.length = 0;
    const nobody = { ...(issue as object), assigneeUserId: null, proofreaderUserId: null } as never;
    expect(
      await service.sendForIssue({
        workspaceId: WS,
        issue: nobody,
        userIds: [],
        channels: ['chat'],
        subject: 's',
        message: 'm',
      }),
    ).toEqual([]);
    await service.sendForIssue({
      workspaceId: WS,
      issue: nobody,
      roles: ['assignee'],
      userIds: [],
      channels: ['chat'],
      subject: 's',
      message: 'm',
    });
    expect(chat.sent).toEqual([]);
  });

  it('lists the channels with their availability', async () => {
    const { service } = setup([fakeChannel('on'), fakeChannel('off', { available: false })]);
    expect(await service.channels(WS)).toEqual([
      { id: 'on', label: 'ON', available: true },
      { id: 'off', label: 'OFF', available: false },
    ]);
  });
});

describe('links to the issue', () => {
  const issue = {
    id: 'issue-9',
    number: 7,
    title: 'Fix',
    status: 'todo',
    priority: 'high',
    assigneeUserId: ANA,
    proofreaderUserId: null,
  } as never;

  it('builds an address that carries the workspace and the issue', () => {
    const { service } = setup();
    expect(service.issueUrl(WS, 'issue-9')).toBe(
      'https://adk.example.com/?workspace=workspace-a&issue=issue-9',
    );
    const slash = new NotificationService({
      channels: new NotificationChannelRegistry(),
      rules: new InMemoryNotificationRuleStore(),
      directory,
      appUrl: 'https://adk.example.com///',
    });
    expect(slash.issueUrl('w&1', 'i 2')).toBe('https://adk.example.com/?workspace=w%261&issue=i+2');
    const bare = new NotificationService({
      channels: new NotificationChannelRegistry(),
      rules: new InMemoryNotificationRuleStore(),
      directory,
    });
    expect(bare.issueUrl(WS, 'issue-9')).toBeUndefined();
  });

  it('sends the link of the issue, not just the app, to whoever is told about it', async () => {
    const chat = fakeChannel();
    const { service } = setup([chat]);
    await service.sendForIssue({
      workspaceId: WS,
      issue,
      roles: ['assignee'],
      userIds: [],
      channels: ['chat'],
      subject: 's',
      message: 'm',
    });
    expect(chat.sent[0]!.message.url).toBe(
      'https://adk.example.com/?workspace=workspace-a&issue=issue-9',
    );
  });

  it('sends no link when the server does not know the address of the app', async () => {
    const chat = fakeChannel();
    const bare = new NotificationService({
      channels: new NotificationChannelRegistry([chat]),
      rules: new InMemoryNotificationRuleStore(),
      directory,
    });
    await bare.sendForIssue({
      workspaceId: WS,
      issue,
      roles: ['assignee'],
      userIds: [],
      channels: ['chat'],
      subject: 's',
      message: 'm',
    });
    expect(chat.sent[0]!.message).toEqual({ title: 's', text: 'm' });
  });

  it('keeps the link an event brings, and falls back to the app for events without one', async () => {
    const chat = fakeChannel();
    const { rules, service } = setup([chat]);
    await rules.save(WS, null, ruleInput());
    await service.dispatch(event({ url: 'https://adk.example.com/?issue=custom' }));
    await service.dispatch(event());
    expect(chat.sent.map((delivery) => delivery.message.url)).toEqual([
      'https://adk.example.com/?issue=custom',
      'https://adk.example.com',
    ]);
  });
});

describe('EmailNotificationChannel', () => {
  const delivery = (url?: string): NotificationDelivery => ({
    workspaceId: WS,
    recipient: people[ANA]!,
    message: { title: 'Hello', text: 'Line 1 <b>&"</b>\nLine 2', ...(url ? { url } : {}) },
  });

  it('sends a plain and an escaped HTML version, with the link when there is one', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = new EmailNotificationChannel({ send });
    expect(channel.id).toBe('email');
    expect(await channel.isAvailable()).toBe(true);

    await channel.send(delivery('https://adk.example.com/?a="1"'));
    expect(send).toHaveBeenCalledWith({
      to: 'ana@example.com',
      subject: 'Hello',
      text: 'Line 1 <b>&"</b>\nLine 2\n\nhttps://adk.example.com/?a="1"',
      html: '<p>Line 1 &lt;b&gt;&amp;&quot;&lt;/b&gt;<br>Line 2</p><p><a href="https://adk.example.com/?a=&quot;1&quot;">Open in ADK</a></p>',
    });
    await channel.send(delivery());
    expect(send.mock.calls[1]![0]).toMatchObject({
      text: 'Line 1 <b>&"</b>\nLine 2',
      html: expect.not.stringContaining('Open in ADK'),
    });
  });

  it('is not available without SMTP and refuses to send', async () => {
    const channel = new EmailNotificationChannel(null);
    expect(await channel.isAvailable()).toBe(false);
    await expect(channel.send(delivery())).rejects.toThrow('SMTP is not configured');
  });
});

describe('InMemoryNotificationRuleStore', () => {
  it('keeps rules per workspace, updates in place and reports what is missing', async () => {
    const store = new InMemoryNotificationRuleStore();
    const created = (await store.save(WS, null, ruleInput()))!;
    expect(await store.save(WS, created.id, ruleInput({ name: 'Renamed' }))).toMatchObject({
      id: created.id,
      name: 'Renamed',
      createdAt: created.createdAt,
    });
    expect(await store.save('other', created.id, ruleInput())).toBeNull();
    expect(await store.save(WS, 'missing', ruleInput())).toBeNull();
    expect(await store.get(WS, created.id)).toMatchObject({ name: 'Renamed' });
    expect(await store.get('other', created.id)).toBeNull();
    expect(await store.get(WS, 'missing')).toBeNull();
    await store.save(WS, null, ruleInput({ name: 'Second' }));
    expect((await store.list(WS)).map((r) => r.name)).toEqual(['Renamed', 'Second']);
    expect(await store.delete('other', created.id)).toBe(false);
    expect(await store.delete(WS, created.id)).toBe(true);
    expect(await store.delete(WS, created.id)).toBe(false);
  });
});

describe('notification routes', () => {
  const memberIds = new Set([ANA, BEN, CAROL]);
  const admin: RequestContext = {
    requestId: 't',
    ownerId: WS,
    workspaceId: WS,
    actorId: BEN,
    memberRole: 'ADMIN',
  };
  const issues = new InMemoryIssueStore();

  function build(context: RequestContext | null = admin) {
    const { rules, registry, service } = setup([
      fakeChannel('chat'),
      fakeChannel('off', { available: false }),
    ]);
    const app = express();
    app.use(express.json());
    app.use(
      createNotificationsRouter(
        {
          service,
          rules,
          channels: registry,
          issues,
          contacts: new InMemoryNotificationContactStore(),
          people: async () => ({ people: [], total: 0 }),
          isMember: async (_ws, id) => memberIds.has(id),
        },
        () => {
          if (!context)
            throw Object.assign(new Error('x'), { statusCode: 401, code: 'UNAUTHENTICATED' });
          return context;
        },
      ),
    );
    app.use(errorMiddleware);
    return { app, rules };
  }
  const body = (patch: Record<string, unknown> = {}) => ruleInput(patch);

  it('lists the channels and the events people can attach rules to', async () => {
    const { app } = build();
    const channels = await request(app).get('/notifications/channels').expect(200);
    expect(channels.body.channels).toEqual([
      { id: 'chat', label: 'CHAT', available: true },
      { id: 'off', label: 'OFF', available: false },
    ]);
    const events = await request(app).get('/notifications/events').expect(200);
    expect(events.body.events.map((e: { key: string }) => e.key)).toEqual(
      NOTIFICATION_EVENTS.map((e) => e.key),
    );
    expect(events.body.events[0].placeholders).toContain('issue.title');
  });

  it('creates, lists, updates and deletes rules', async () => {
    const { app } = build();
    const created = await request(app).post('/notifications/rules').send(body()).expect(201);
    const id = created.body.rule.id as string;
    expect(created.body.rule).toMatchObject({
      name: 'Tell the assignee',
      event: 'issue.assigned',
      enabled: true,
    });

    expect((await request(app).get('/notifications/rules').expect(200)).body.rules).toHaveLength(1);
    const updated = await request(app)
      .put(`/notifications/rules/${id}`)
      .send(body({ name: 'Renamed', enabled: false }))
      .expect(200);
    expect(updated.body.rule).toMatchObject({ name: 'Renamed', enabled: false });
    await request(app).delete(`/notifications/rules/${id}`).expect(204);
    await request(app).delete(`/notifications/rules/${id}`).expect(404);
    await request(app).put(`/notifications/rules/${id}`).send(body()).expect(404);
  });

  it('refuses rules that point at things that do not exist', async () => {
    const { app } = build();
    const refused = async (patch: Record<string, unknown>, code: string) => {
      const response = await request(app)
        .post('/notifications/rules')
        .send(body(patch))
        .expect(400);
      expect(response.body.code).toBe(code);
    };
    await refused({ event: 'nothing.happens' }, 'NOTIFICATION_EVENT_UNKNOWN');
    await refused({ channels: ['chat', 'carrier-pigeon'] }, 'NOTIFICATION_CHANNEL_UNKNOWN');
    await refused(
      { recipients: { subject: false, userIds: [] } },
      'NOTIFICATION_RECIPIENT_INVALID',
    );
    await refused(
      { recipients: { subject: false, userIds: ['44444444-4444-4444-8444-444444444444'] } },
      'NOTIFICATION_RECIPIENT_INVALID',
    );
    await refused({ channels: [] }, 'VALIDATION_ERROR');
    await refused({ name: '' }, 'VALIDATION_ERROR');
  });

  it('only lets the person the event is about be a recipient for events that have one', async () => {
    const { app } = build();
    const original = NOTIFICATION_EVENTS[0]!;
    const { subjectLabel: _label, ...withoutSubject } = original;
    const index = NOTIFICATION_EVENTS.indexOf(original);
    (NOTIFICATION_EVENTS as unknown as unknown[])[index] = withoutSubject;
    try {
      const response = await request(app)
        .post('/notifications/rules')
        .send(body({ recipients: { subject: true, userIds: [] } }))
        .expect(400);
      expect(response.body.code).toBe('NOTIFICATION_RECIPIENT_INVALID');
    } finally {
      (NOTIFICATION_EVENTS as unknown as unknown[])[index] = original;
    }
  });

  it('sends a message about an issue to the people and roles it names', async () => {
    const { app } = build();
    const issue = await issues.create(WS, BEN, {
      title: 'Fix login',
      assigneeUserId: ANA,
      proofreaderUserId: CAROL,
    });
    const response = await request(app)
      .post('/notifications/send')
      .send({
        issueId: issue.id,
        roles: ['assignee', 'proofreader'],
        userIds: [BEN],
        channels: ['chat'],
        subject: '#{{issue.number}}',
        message: '{{issue.title}}',
      })
      .expect(200);
    expect(response.body.results).toHaveLength(3);
    expect(response.body.results.every((r: { status: string }) => r.status === 'sent')).toBe(true);

    await request(app)
      .post('/notifications/send')
      .send({
        issueId: '55555555-5555-4555-8555-555555555555',
        channels: ['chat'],
        subject: 's',
        message: 'm',
      })
      .expect(404);
    await request(app)
      .post('/notifications/send')
      .send({ issueId: issue.id, channels: [], subject: 's', message: 'm' })
      .expect(400);
  });

  it('sends a test message to whoever asks, on a channel that exists', async () => {
    const { app } = build();
    const ok = await request(app).post('/notifications/test').send({ channel: 'chat' }).expect(200);
    expect(ok.body.results).toEqual([{ channel: 'chat', userId: BEN, status: 'sent' }]);
    const off = await request(app).post('/notifications/test').send({ channel: 'off' }).expect(200);
    expect(off.body.results[0]).toMatchObject({ status: 'skipped' });
    await request(app).post('/notifications/test').send({ channel: 'ghost' }).expect(400);
  });

  it('needs a workspace and a signed-in person', async () => {
    const noWorkspace = { ...admin } as {
      -readonly [K in keyof RequestContext]: RequestContext[K];
    };
    delete (noWorkspace as { workspaceId?: string }).workspaceId;
    await request(build(noWorkspace).app).get('/notifications/rules').expect(400);
    await request(build(noWorkspace).app).get('/notifications/channels').expect(400);
    // A context that cannot be resolved (no valid session) stops the request.
    const unresolved = await request(build(null).app).get('/notifications/rules');
    expect(unresolved.status).toBeGreaterThanOrEqual(400);
    const noActor = { ...admin } as { -readonly [K in keyof RequestContext]: RequestContext[K] };
    delete (noActor as { actorId?: string }).actorId;
    await request(build(noActor).app)
      .post('/notifications/test')
      .send({ channel: 'chat' })
      .expect(401);
  });
});

describe('issue routes announce assignments', () => {
  const admin: RequestContext = {
    requestId: 't',
    ownerId: WS,
    workspaceId: WS,
    actorId: BEN,
    memberRole: 'ADMIN',
  };

  function build(withNotifications = true) {
    const store = new InMemoryIssueStore();
    const dispatch = vi.fn().mockResolvedValue([]);
    const issueUrl = vi.fn(
      (workspaceId: string, issueId: string) =>
        `https://adk.example.com/?workspace=${workspaceId}&issue=${issueId}`,
    );
    const app = express();
    app.use(express.json());
    app.use(
      createIssuesRouter(
        store,
        { getAgent: vi.fn() } as unknown as AgentService,
        {
          listMembers: vi
            .fn()
            .mockResolvedValue([{ userId: ANA }, { userId: BEN }, { userId: CAROL }]),
        } as unknown as WorkspaceService,
        { list: vi.fn().mockResolvedValue([]), create: vi.fn() } as unknown as RunService,
        () => admin,
        undefined,
        undefined,
        undefined,
        withNotifications ? { dispatch, issueUrl } : undefined,
      ),
    );
    app.use(errorMiddleware);
    return { app, dispatch, store };
  }

  it('tells the new assignee and the new proofreader when an issue is created', async () => {
    const { app, dispatch } = build();
    await request(app)
      .post('/issues')
      .send({ title: 'Fix login', assigneeUserId: ANA, proofreaderUserId: CAROL })
      .expect(201);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'issue.assigned',
        workspaceId: WS,
        actorId: BEN,
        subjectUserId: ANA,
        url: expect.stringMatching(
          /^https:\/\/adk\.example\.com\/\?workspace=workspace-a&issue=.+/,
        ),
        data: expect.objectContaining({ 'issue.title': 'Fix login' }),
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'issue.proofreader_assigned', subjectUserId: CAROL }),
    );
  });

  it('says nothing when nobody is assigned', async () => {
    const { app, dispatch } = build();
    await request(app).post('/issues').send({ title: 'No owner' }).expect(201);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('tells only the person who changed, not those who were already there', async () => {
    const { app, dispatch, store } = build();
    const issue = await store.create(WS, BEN, {
      title: 'Fix',
      assigneeUserId: ANA,
      proofreaderUserId: CAROL,
    });
    await request(app).patch(`/issues/${issue.id}`).send({ title: 'Renamed' }).expect(200);
    await request(app).patch(`/issues/${issue.id}`).send({ assigneeUserId: ANA }).expect(200);
    expect(dispatch).not.toHaveBeenCalled();

    await request(app).patch(`/issues/${issue.id}`).send({ assigneeUserId: BEN }).expect(200);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'issue.assigned', subjectUserId: BEN }),
    );

    dispatch.mockClear();
    await request(app).patch(`/issues/${issue.id}`).send({ proofreaderUserId: ANA }).expect(200);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'issue.proofreader_assigned', subjectUserId: ANA }),
    );
    dispatch.mockClear();
    await request(app).patch(`/issues/${issue.id}`).send({ assigneeUserId: null }).expect(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('works when notifications are not configured', async () => {
    const { app } = build(false);
    await request(app).post('/issues').send({ title: 'Fix', assigneeUserId: ANA }).expect(201);
  });
});
