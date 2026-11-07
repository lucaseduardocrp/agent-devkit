import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/lib/api-client.js';
import type { NotificationRuleInput } from '../src/features/notifications/notification-types.js';

const answer = (status: number, body: unknown = {}) =>
  vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) });

const input: NotificationRuleInput = {
  name: 'Tell the assignee',
  enabled: true,
  event: 'issue.assigned',
  channels: ['email'],
  recipients: { subject: true, userIds: [] },
  subject: '',
  message: '',
};

describe('ApiClient notifications', () => {
  it('reads the channels, the events and the rules', async () => {
    const channels = [{ id: 'email', label: 'E-mail', available: true }];
    const fetcher = answer(200, { channels, events: [{ key: 'a' }], rules: [{ id: 'r1' }] });
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test' });
    expect(await client.getNotificationChannels()).toEqual(channels);
    expect(await client.getNotificationEvents()).toEqual([{ key: 'a' }]);
    expect(await client.getNotificationRules()).toEqual([{ id: 'r1' }]);
    expect(fetcher.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://adk.test/notifications/channels',
      'http://adk.test/notifications/events',
      'http://adk.test/notifications/rules',
    ]);
  });

  it('creates a rule, or replaces the one it is given', async () => {
    const fetcher = answer(200, { rule: { id: 'r1', ...input } });
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test' });
    expect(await client.saveNotificationRule(input)).toMatchObject({ id: 'r1' });
    await client.saveNotificationRule(input, 'a b');
    const [createUrl, create] = fetcher.mock.calls[0]!;
    expect(createUrl).toBe('http://adk.test/notifications/rules');
    expect(create).toMatchObject({ method: 'POST', body: JSON.stringify(input) });
    const [updateUrl, update] = fetcher.mock.calls[1]!;
    expect(updateUrl).toBe('http://adk.test/notifications/rules/a%20b');
    expect(update).toMatchObject({ method: 'PUT' });
  });

  it('deletes a rule, and fails when the server refuses', async () => {
    const ok = answer(204);
    await new ApiClient({ fetcher: ok, baseUrl: 'http://adk.test' }).deleteNotificationRule('r/1');
    expect(ok.mock.calls[0]![0]).toBe('http://adk.test/notifications/rules/r%2F1');
    expect(ok.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });

    await expect(
      new ApiClient({
        fetcher: answer(403, { error: 'Forbidden' }),
      }).deleteNotificationRule('r1'),
    ).rejects.toThrow();
  });

  it('sends a test message and returns how each delivery went', async () => {
    const results = [{ channel: 'email', userId: 'u1', status: 'sent' }];
    const fetcher = answer(200, { results });
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test' });
    expect(await client.sendTestNotification('email')).toEqual(results);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://adk.test/notifications/test');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ channel: 'email' }) });
  });

  it('reads one page of the people, and saves the contacts of a member', async () => {
    const contacts = [{ userId: 'u1', channel: 'email', address: 'a@x.com' }];
    const page = {
      total: 1,
      people: [{ userId: 'u1', name: 'Ana', email: 'a@x.com', contacts: {} }],
    };
    const reply = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(reply(page))
      .mockResolvedValueOnce(reply(page))
      .mockResolvedValueOnce(reply({ contacts }));
    const client = new ApiClient({ fetcher, baseUrl: 'http://adk.test' });
    expect(await client.getNotificationPeople({ search: 'a b', offset: 25, limit: 25 })).toEqual(
      page,
    );
    // Without a search the text is left out of the address.
    await client.getNotificationPeople({ search: '', offset: 0, limit: 10 });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'http://adk.test/notifications/people?offset=25&limit=25&search=a+b',
    );
    expect(String(fetcher.mock.calls[1]![0])).toBe(
      'http://adk.test/notifications/people?offset=0&limit=10',
    );
    expect(await client.saveNotificationContacts('u/1', { email: 'a@x.com' })).toEqual(contacts);
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe('http://adk.test/notifications/contacts/u%2F1');
    expect(init).toMatchObject({
      method: 'PUT',
      body: JSON.stringify({ contacts: { email: 'a@x.com' } }),
    });
  });
});
