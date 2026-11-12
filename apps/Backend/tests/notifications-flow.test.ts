import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { AuthService } from '../src/modules/identity/application/auth-service.js';
import type { EmailMessage } from '../src/modules/identity/application/email-sender.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';
import { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import {
  NotificationChannelRegistry,
  type NotificationChannel,
} from '../src/modules/notifications/application/channel.js';
import { moduleRequirements } from '../src/adapters/http/module-policy.js';

const PASSWORD = 'StrongPassword123!';

/** The whole product in memory: real sign-in, workspace and issues; the e-mail is captured. */
async function setup(options: { email?: boolean; channels?: NotificationChannel[] } = {}) {
  const authRepo = new InMemoryAuthRepository();
  const emails: EmailMessage[] = [];
  const app = createApp({
    authService: new AuthService(authRepo),
    workspaceService: new WorkspaceService(new InMemoryWorkspaceRepository(), authRepo),
    frontendUrl: 'https://adk.example.com',
    ...(options.email === false
      ? {}
      : {
          emailSender: {
            send: async (message: EmailMessage) => {
              emails.push(message);
            },
          },
        }),
    ...(options.channels ? { notificationChannels: options.channels } : {}),
  });
  const register = async (name: string) => {
    const response = await request(app)
      .post('/auth/register')
      .send({ email: `${name.toLowerCase()}@example.com`, password: PASSWORD, name });
    return { token: response.body.token as string, id: response.body.user.id as string, name };
  };
  const ana = await register('Ana');
  const ben = await register('Ben');
  const workspace = await request(app)
    .post('/workspaces')
    .set('authorization', `Bearer ${ana.token}`)
    .send({ name: 'Acme', slug: 'acme' });
  const workspaceId = workspace.body.workspace.id as string;
  await request(app)
    .post(`/workspaces/${workspaceId}/members`)
    .set('authorization', `Bearer ${ana.token}`)
    .send({ email: 'ben@example.com', role: 'MEMBER' })
    .expect(201);
  const as = (person: { token: string }) => ({
    authorization: `Bearer ${person.token}`,
    'x-workspace-id': workspaceId,
  });
  return { app, ana, ben, as, emails, workspaceId };
}

const rule = (patch: Record<string, unknown> = {}) => ({
  name: 'Tell the assignee',
  event: 'issue.assigned',
  channels: ['email'],
  recipients: { subject: true, userIds: [] },
  ...patch,
});

describe('notifications, from the rule to the inbox', () => {
  it('e-mails the person an issue is assigned to', async () => {
    const { app, ana, ben, as, emails, workspaceId } = await setup();
    await request(app).post('/notifications/rules').set(as(ana)).send(rule()).expect(201);

    const created = await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Fix login', assigneeUserId: ben.id })
      .expect(201);

    await vi.waitFor(() => expect(emails).toHaveLength(1));
    expect(emails[0]).toMatchObject({
      to: 'ben@example.com',
      subject: expect.stringMatching(/^Issue #\d+ was assigned to you$/),
    });
    expect(emails[0]!.text).toContain('Ana assigned you issue');
    expect(emails[0]!.text).toContain('Fix login');
    // The link opens this very issue, in this workspace.
    const link = /https:\/\/adk\.example\.com\/\?\S+/.exec(emails[0]!.text)![0];
    const params = new URL(link).searchParams;
    expect(params.get('workspace')).toBe(workspaceId);
    expect(params.get('issue')).toBe(created.body.issue.id);
    expect(emails[0]!.html).toContain('Open in ADK</a>');
  });

  it('e-mails the address an admin set for the person, and only admins can set it', async () => {
    const { app, ana, ben, as, emails } = await setup();
    await request(app).post('/notifications/rules').set(as(ana)).send(rule()).expect(201);

    await request(app)
      .put(`/notifications/contacts/${ben.id}`)
      .set(as(ben))
      .send({ contacts: { email: 'ben@elsewhere.com' } })
      .expect(403);
    await request(app)
      .put(`/notifications/contacts/${ben.id}`)
      .set(as(ana))
      .send({ contacts: { email: 'ben@work.example.com' } })
      .expect(200);
    const listed = await request(app).get('/notifications/people').set(as(ana)).expect(200);
    expect(
      listed.body.people.find((p: { userId: string }) => p.userId === ben.id).contacts,
    ).toEqual({
      email: 'ben@work.example.com',
    });
    // The module's policy keeps people without access to it out altogether.
    await request(app).get('/notifications/people').set(as(ben)).expect(403);

    await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Fix login', assigneeUserId: ben.id })
      .expect(201);
    await vi.waitFor(() => expect(emails).toHaveLength(1));
    expect(emails[0]!.to).toBe('ben@work.example.com');
  });

  it('e-mails the person chosen as proofreader, also when it changes later', async () => {
    const { app, ana, ben, as, emails } = await setup();
    await request(app)
      .post('/notifications/rules')
      .set(as(ana))
      .send(
        rule({
          name: 'Tell the proofreader',
          event: 'issue.proofreader_assigned',
          subject: 'Please review: {{issue.title}}',
        }),
      )
      .expect(201);

    const created = await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Spec draft' })
      .expect(201);
    expect(emails).toHaveLength(0);
    await request(app)
      .patch(`/issues/${created.body.issue.id}`)
      .set(as(ana))
      .send({ proofreaderUserId: ben.id })
      .expect(200);

    await vi.waitFor(() => expect(emails).toHaveLength(1));
    expect(emails[0]).toMatchObject({
      to: 'ben@example.com',
      subject: 'Please review: Spec draft',
    });
  });

  it('does not tell people about what they did themselves, nor when no rule matches', async () => {
    const { app, ana, as, emails } = await setup();
    await request(app).post('/notifications/rules').set(as(ana)).send(rule()).expect(201);
    await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Mine', assigneeUserId: ana.id })
      .expect(201);
    await request(app)
      .post('/notifications/rules')
      .set(as(ana))
      .send(rule({ name: 'Off', enabled: false, event: 'issue.proofreader_assigned' }))
      .expect(201);
    await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Mine too', proofreaderUserId: ana.id })
      .expect(201);
    // Give the (not awaited) delivery a moment to prove it does not happen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emails).toEqual([]);
  });

  it('keeps working when the e-mail cannot be sent', async () => {
    const { app, ana, ben, as } = await setup({ email: false });
    const channels = await request(app).get('/notifications/channels').set(as(ana)).expect(200);
    expect(channels.body.channels).toEqual([{ id: 'email', label: 'E-mail', available: false }]);
    await request(app).post('/notifications/rules').set(as(ana)).send(rule()).expect(201);

    const created = await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Fix login', assigneeUserId: ben.id });
    expect(created.status).toBe(201);
    const test = await request(app)
      .post('/notifications/test')
      .set(as(ana))
      .send({ channel: 'email' })
      .expect(200);
    expect(test.body.results[0]).toMatchObject({ status: 'skipped' });
  });

  it('sends a test message to the person who asks', async () => {
    const { app, ana, as, emails } = await setup();
    const result = await request(app)
      .post('/notifications/test')
      .set(as(ana))
      .send({ channel: 'email' })
      .expect(200);
    expect(result.body.results).toEqual([{ channel: 'email', userId: ana.id, status: 'sent' }]);
    expect(emails[0]).toMatchObject({ to: 'ana@example.com', subject: 'ADK test notification' });
    expect(emails[0]!.text).toContain('Ana, your Acme notifications work.');
  });

  it('accepts a new channel next to e-mail, with no other change', async () => {
    const delivered: string[] = [];
    const teams: NotificationChannel = {
      id: 'teams',
      label: 'Microsoft Teams',
      isAvailable: async () => true,
      send: async ({ recipient, message }) => {
        delivered.push(`${recipient.name}: ${message.title}`);
      },
    };
    const { app, ana, ben, as, emails } = await setup({ channels: [teams] });
    const channels = await request(app).get('/notifications/channels').set(as(ana)).expect(200);
    expect(channels.body.channels.map((c: { id: string }) => c.id)).toEqual(['email', 'teams']);
    await request(app)
      .post('/notifications/rules')
      .set(as(ana))
      .send(rule({ channels: ['email', 'teams'] }))
      .expect(201);

    await request(app)
      .post('/issues')
      .set(as(ana))
      .send({ title: 'Fix', assigneeUserId: ben.id })
      .expect(201);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    expect(delivered[0]).toMatch(/^Ben: Issue #\d+ was assigned to you$/);
    expect(emails).toHaveLength(1);
  });

  it('only lets people who can configure integrations manage the rules', async () => {
    const { app, ben, as } = await setup();
    const asMember = as(ben);
    await request(app).post('/auth/login').send({ email: 'ben@example.com', password: PASSWORD });
    // A member without access to integrations may read nothing and change nothing there.
    expect(moduleRequirements('GET', '/notifications/rules')).toEqual([
      { module: 'integrations', operation: 'view' },
    ]);
    expect(moduleRequirements('POST', '/notifications/rules')).toEqual([
      { module: 'integrations', operation: 'edit' },
    ]);
    expect(moduleRequirements('DELETE', '/notifications/rules/x')).toEqual([
      { module: 'integrations', operation: 'delete' },
    ]);
    // Sending a message about an issue only needs to be able to edit issues.
    expect(moduleRequirements('POST', '/notifications/send')).toEqual([
      { module: 'issues', operation: 'edit' },
    ]);
    expect(moduleRequirements('POST', '/notifications/test')).toEqual([
      { module: 'issues', operation: 'edit' },
    ]);
    expect(asMember['x-workspace-id']).toBeTruthy();
  });

  it('only accepts members of the workspace as recipients', async () => {
    const { app, ana, as } = await setup();
    const stranger = '44444444-4444-4444-8444-444444444444';
    const response = await request(app)
      .post('/notifications/rules')
      .set(as(ana))
      .send(rule({ recipients: { subject: false, userIds: [stranger] } }))
      .expect(400);
    expect(response.body.code).toBe('NOTIFICATION_RECIPIENT_INVALID');
  });

  it('offers a registry that rejects two channels with the same id', () => {
    const channel = (): NotificationChannel => ({
      id: 'same',
      label: 'Same',
      isAvailable: async () => true,
      send: async () => undefined,
    });
    expect(() => new NotificationChannelRegistry([channel(), channel()])).toThrow(
      'already registered',
    );
  });
});
