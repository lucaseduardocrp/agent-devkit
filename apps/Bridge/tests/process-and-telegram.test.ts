import { describe, expect, it } from 'vitest';
import { TelegramChannel } from '../src/channels/telegram/telegram-channel.js';
import { runProcess } from '../src/core/process-runner.js';

const cwd = process.cwd();

describe('runProcess', () => {
  it('captures output, stdin and exit code', async () => {
    const result = await runProcess(
      {
        command: process.execPath,
        args: ['-e', 'process.stdin.pipe(process.stdout)'],
        stdin: 'echo',
      },
      { cwd, timeoutMs: 10_000 },
    );
    expect(result).toMatchObject({ stdout: 'echo', exitCode: 0 });
  });

  it('times out, cancels and reports a missing command', async () => {
    const sleep = { command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] };
    await expect(runProcess(sleep, { cwd, timeoutMs: 300 })).rejects.toThrow('Timed out');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(
      runProcess(sleep, { cwd, timeoutMs: 10_000, signal: controller.signal }),
    ).rejects.toThrow('Cancelled');
    await expect(
      runProcess({ command: 'no-such-cli-xyz', args: [] }, { cwd, timeoutMs: 1000 }),
    ).rejects.toThrow('not installed');
  });
});

describe('TelegramChannel', () => {
  it('polls, converts private messages and sends replies', async () => {
    const requests: { method: string; body: Record<string, unknown> }[] = [];
    const controller = new AbortController();
    const fetcher = (async (url: string, init: { body: string }) => {
      const method = url.split('/').pop()!;
      requests.push({ method, body: JSON.parse(init.body) });
      let result: unknown = true;
      if (method === 'getUpdates') {
        result = [
          {
            update_id: 5,
            message: {
              date: Date.now() / 1000,
              chat: { id: 7, type: 'private' },
              from: { id: 7 },
              text: 'hi',
            },
          },
        ];
        if (requests.filter((r) => r.method === 'getUpdates').length > 1) controller.abort();
      }
      return { ok: true, json: async () => ({ ok: true, result }) };
    }) as unknown as typeof fetch;
    const channel = new TelegramChannel({ token: '1:abc', fetch: fetcher });
    const received: string[] = [];
    await channel.start(
      async (m) => void received.push(`${m.userId}:${m.text}:${m.isPrivate}`),
      controller.signal,
    );
    await channel.send('7', 'reply');
    expect(received[0]).toBe('7:hi:true');
    expect(requests.some((r) => r.method === 'getUpdates' && r.body.offset === 6)).toBe(true);
    expect(requests.at(-1)).toMatchObject({
      method: 'sendMessage',
      body: { chat_id: '7', text: 'reply' },
    });
  });

  it('rejects malformed tokens', () => {
    expect(() => new TelegramChannel({ token: 'x/y' })).toThrow('Invalid');
  });
});
