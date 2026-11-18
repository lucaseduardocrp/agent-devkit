import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/app/config.js';
import { nextRun, parseSchedule } from '../src/app/schedule.js';
import { claudeAdapter } from '../src/cli/claude.js';
import { codexAdapter } from '../src/cli/codex.js';
import { parseCustomClis } from '../src/cli/custom.js';

const out = (stdout: string, exitCode = 0, stderr = '') => ({ stdout, stderr, exitCode });

describe('claude', () => {
  it('reads result and session, including the verbose array form', () => {
    const event = { type: 'result', result: ' done ', session_id: 'abc' };
    expect(claudeAdapter.parseOutput(out(JSON.stringify(event)))).toEqual({
      text: 'done',
      sessionId: 'abc',
    });
    expect(claudeAdapter.parseOutput(out(JSON.stringify([{ type: 'system' }, event]))).text).toBe(
      'done',
    );
  });
  it('throws on errors', () => {
    expect(() =>
      claudeAdapter.parseOutput(out(JSON.stringify({ is_error: true, result: 'bad key' }), 1)),
    ).toThrow('bad key');
    expect(() => claudeAdapter.parseOutput(out('', 1, 'boom'))).toThrow('boom');
    expect(() => claudeAdapter.parseOutput(out('garbage'))).toThrow('Unexpected');
  });
});

describe('codex', () => {
  it('collects agent messages and the thread id', () => {
    const lines = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n');
    expect(codexAdapter.parseOutput(out(lines))).toEqual({ text: 'answer', sessionId: 't1' });
  });
  it('resumes and fails on turn.failed', () => {
    const { args } = codexAdapter.buildInvocation({
      prompt: 'p',
      sessionId: 't1',
      autonomy: 'auto',
      cwd: '/',
    });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(() =>
      codexAdapter.parseOutput(
        out(JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } })),
      ),
    ).toThrow('nope');
  });
});

describe('custom clis and config', () => {
  it('validates the JSON', () => {
    expect(parseCustomClis(undefined)).toEqual([]);
    expect(() => parseCustomClis('{')).toThrow('JSON array');
    expect(() => parseCustomClis('[{"id":"a b","command":"x"}]')).toThrow('"id"');
    expect(() => parseCustomClis('[{"id":"a"}]')).toThrow('"command"');
  });
  it('validates the environment', () => {
    expect(() => loadConfig({ BRIDGE_ALLOWED_USER_IDS: 'abc' })).toThrow('numeric');
    expect(() => loadConfig({ BRIDGE_DEFAULT_MODE: 'x' })).toThrow('safe');
    expect(loadConfig({}).allowedUserIds.size).toBe(0);
  });
  it('listens on BRIDGE_HTTP_PORT, else the PORT of the platform, else 3500', () => {
    expect(loadConfig({}).httpPort).toBe(3500);
    expect(loadConfig({ PORT: '8080' }).httpPort).toBe(8080);
    expect(loadConfig({ PORT: '8080', BRIDGE_HTTP_PORT: '4000' }).httpPort).toBe(4000);
  });
});

describe('schedule', () => {
  it('parses intervals and daily times', () => {
    expect(parseSchedule('every 2h do x')).toEqual({
      schedule: { kind: 'every', ms: 7_200_000 },
      rest: 'do x',
    });
    expect(parseSchedule('daily 09:30 y')?.schedule).toEqual({
      kind: 'daily',
      hour: 9,
      minute: 30,
    });
    expect(parseSchedule('daily 25:00 y')).toBeNull();
    expect(parseSchedule('hello')).toBeNull();
  });
  it('computes the next daily run strictly in the future', () => {
    const base = new Date(2026, 0, 1, 10, 0, 0).getTime();
    expect(new Date(nextRun({ kind: 'daily', hour: 9, minute: 0 }, base)).getDate()).toBe(2);
    expect(new Date(nextRun({ kind: 'daily', hour: 11, minute: 0 }, base)).getDate()).toBe(1);
  });
});
