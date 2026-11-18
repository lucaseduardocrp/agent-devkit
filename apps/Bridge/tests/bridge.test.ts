import { describe, expect, it } from 'vitest';
import { CliError } from '../src/core/types.js';
import { message, setup } from './helpers.js';

const claudeOk =
  (result: string, session = 's1') =>
  async () => ({
    stdout: JSON.stringify({ type: 'result', is_error: false, result, session_id: session }),
    stderr: '',
    exitCode: 0,
  });

describe('Bridge', () => {
  it('answers whoami to anyone, and denies everything else to strangers', async () => {
    const { bridge, channel } = setup(claudeOk('x'));
    await bridge.handle(message('/whoami', '99'));
    await bridge.handle(message('hello', '99'));
    expect(channel.sent[0]).toBe('99');
    expect(channel.sent[1]).toContain('Access denied');
  });

  it('ignores groups', async () => {
    const { bridge, channel } = setup(claudeOk('x'));
    await bridge.handle(message('hello', '1', false));
    expect(channel.sent).toEqual([]);
  });

  it('sends the text to the default CLI and resumes its session', async () => {
    const { bridge, channel, calls } = setup(claudeOk('hi there'));
    await bridge.handle(message('first'));
    await bridge.handle(message('second'));
    expect(channel.sent).toEqual(['hi there', 'hi there']);
    expect(calls[0]?.stdin).toBe('first');
    expect(calls[0]?.args).not.toContain('--resume');
    expect(calls[1]?.args).toContain('--resume');
    expect(calls[1]?.args).toContain('s1');
  });

  it('/new drops the session, /mode safe restricts tools', async () => {
    const { bridge, calls } = setup(claudeOk('ok'));
    await bridge.handle(message('a'));
    await bridge.handle(message('/new'));
    await bridge.handle(message('/mode safe'));
    await bridge.handle(message('b'));
    expect(calls[1]?.args).not.toContain('--resume');
    expect(calls[1]?.args).toContain('--allowedTools');
    expect(calls[0]?.args).toContain('--dangerously-skip-permissions');
  });

  it('switches CLI per chat and rejects unknown ones', async () => {
    const { bridge, channel, calls } = setup(async () => ({
      stdout: 'gem',
      stderr: '',
      exitCode: 0,
    }));
    await bridge.handle(message('/cli nope'));
    await bridge.handle(message('/cli gemini'));
    await bridge.handle(message('question'));
    expect(channel.sent[0]).toContain('does not exist');
    expect(calls[0]?.command).toBe('gemini');
    expect(channel.sent.at(-1)).toBe('gem');
  });

  it('reports CLI failures to the chat', async () => {
    const { bridge, channel } = setup(async () => {
      throw new CliError('"claude" is not installed in this container.');
    });
    await bridge.handle(message('hi'));
    expect(channel.sent.join('')).toContain('not installed');
  });

  it('splits long answers to the channel limit', async () => {
    const { bridge, channel } = setup(claudeOk('word '.repeat(30)));
    channel.maxMessageLength = 50;
    await bridge.handle(message('hi'));
    expect(channel.sent.length).toBeGreaterThan(1);
    expect(channel.sent.every((part) => part.length <= 50)).toBe(true);
  });

  it('/cancel aborts the run in progress without an error message', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const { bridge, channel } = setup((_inv, options) => {
      started();
      return new Promise((_, reject) =>
        options.signal?.addEventListener('abort', () => reject(new CliError('Cancelled.'))),
      );
    });
    const run = bridge.handle(message('long task'));
    await running;
    await bridge.handle(message('/cancel'));
    await run;
    expect(channel.sent).toEqual(['Cancelled.']);
    expect(bridge.isBusy('telegram:1')).toBe(false);
  });

  it('supports custom CLIs from the configuration', async () => {
    const custom = JSON.stringify([{ id: 'agy', command: 'agy', args: ['--print', '{prompt}'] }]);
    const { bridge, calls } = setup(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }), {
      BRIDGE_CUSTOM_CLIS: custom,
      BRIDGE_DEFAULT_CLI: 'agy',
    });
    await bridge.handle(message('do it'));
    expect(calls[0]?.command).toBe('agy');
    expect(calls[0]?.args[0]).toBe('--print');
    // The standing security rules travel in front of the request.
    expect(calls[0]?.args[1]).toContain('Operating rules from the system operator');
    expect(calls[0]?.args[1]?.endsWith('User request:\ndo it')).toBe(true);
  });

  it('schedules, lists and removes tasks, and runs them when due', async () => {
    const { bridge, channel } = setup(claudeOk('report'));
    await bridge.handle(message('/schedule every 30m check build'));
    await bridge.handle(message('/schedule nonsense'));
    await bridge.handle(message('/tasks'));
    expect(channel.sent[0]).toContain('Task #1 scheduled');
    expect(channel.sent.join(' ')).toContain('Usage');
    expect(channel.sent.at(-1)).toContain('check build');

    bridge.store.tasks()[0]!.nextRunAt = 0;
    await bridge.scheduler.tick();
    expect(channel.sent.at(-1)).toContain('Task #1\nreport');
    await bridge.handle(message('/unschedule 1'));
    expect(bridge.store.tasks()).toHaveLength(0);
  });
});
