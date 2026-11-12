import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdkChannel } from '../src/channels/adk/adk-channel.js';
import type { IncomingMessage } from '../src/core/types.js';
import { message, setup } from './helpers.js';

const TOKEN = 'shared-secret-token';
const controllers: AbortController[] = [];

afterEach(() => controllers.splice(0).forEach((c) => c.abort()));

async function startChannel(fetcher: typeof fetch = vi.fn() as unknown as typeof fetch) {
  const channel = new AdkChannel({
    port: 0,
    token: TOKEN,
    apiUrl: 'http://api:3000/',
    listClis: () => ['claude', 'codex'],
    fetch: fetcher,
  });
  const received: IncomingMessage[] = [];
  const controller = new AbortController();
  controllers.push(controller);
  void channel.start(async (m) => void received.push(m), controller.signal);
  await vi.waitFor(() => expect(channel.port).toBeGreaterThan(0));
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`http://127.0.0.1:${channel.port}${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
  return { channel, received, call };
}

describe('AdkChannel server', () => {
  it('requires the shared token, except for /health', async () => {
    const { call } = await startChannel();
    expect((await call('/health', {}, null)).status).toBe(200);
    expect((await call('/clis', {}, null)).status).toBe(401);
    expect((await call('/clis', {}, 'wrong')).status).toBe(401);
  });

  it('lists CLIs and rejects unknown routes', async () => {
    const { call } = await startChannel();
    expect(await (await call('/clis')).json()).toEqual({ clis: ['claude', 'codex'] });
    expect((await call('/nope')).status).toBe(404);
    expect((await call('/messages')).status).toBe(404);
  });

  it('accepts messages with 202 and hands them to the bridge', async () => {
    const { call, received } = await startChannel();
    const response = await call('/messages', {
      method: 'POST',
      body: JSON.stringify({ chatId: 'ws:42', userId: '7', text: 'hello' }),
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({
      channel: 'adk',
      chatId: 'ws:42',
      userId: '7',
      text: 'hello',
      isPrivate: true,
    });
  });

  it('rejects malformed and oversized bodies', async () => {
    const { call, received } = await startChannel();
    for (const body of ['not json', JSON.stringify({ chatId: 'x' }), 'x'.repeat(300_000)]) {
      const response = await call('/messages', { method: 'POST', body });
      expect(response.status).toBe(400);
    }
    expect(received).toEqual([]);
  });
});

describe('AdkChannel replies', () => {
  it('posts replies and typing to the ADK API with the token', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const { channel } = await startChannel(fetcher as unknown as typeof fetch);
    await channel.send('ws:42', 'done');
    await channel.indicateBusy('ws:42');
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]?.[0]).toBe('http://api:3000/messaging/bridge/send');
    expect(calls[0]?.[1]).toMatchObject({ headers: { authorization: `Bearer ${TOKEN}` } });
    expect(JSON.parse(String(calls[0]?.[1].body))).toEqual({ chatId: 'ws:42', text: 'done' });
    expect(calls[1]?.[0]).toBe('http://api:3000/messaging/bridge/typing');
  });

  it('fails when the API refuses', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 409 }));
    const { channel } = await startChannel(fetcher as unknown as typeof fetch);
    await expect(channel.send('ws:42', 'x')).rejects.toThrow('409');
  });
});

describe('trusted channels', () => {
  const ok = async () => ({
    stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's' }),
    stderr: '',
    exitCode: 0,
  });

  it('are denied by an empty allowlist when untrusted', async () => {
    const { bridge, channel, calls } = setup(ok, { BRIDGE_ALLOWED_USER_IDS: '' });
    await bridge.handle(message('hi', '55'));
    expect(channel.sent[0]).toContain('Access denied');
    expect(calls).toHaveLength(0);
  });

  it('skip the allowlist, because the ADK already paired the chat', async () => {
    const { bridge, channel, calls } = setup(ok, { BRIDGE_ALLOWED_USER_IDS: '' });
    channel.trusted = true;
    await bridge.handle(message('hi', '55'));
    // Past the allowlist, but not signed in to a CLI yet.
    expect(calls).toHaveLength(0);
    expect(channel.sent[0]).toContain('Connect your claude account');
    await bridge.handle(message('/auth claude sk-ant-api03-abc', '55'));
    await bridge.handle(message('hi', '55'));
    expect(calls).toHaveLength(1);
    expect(channel.sent.at(-1)).toBe('ok');
  });
});
