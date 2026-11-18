import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { CliLlmProvider, detectCli } from '../src/modules/agents/adapters/cli-llm/cli-llm.js';
import {
  assertSafeArgument,
  killTree,
  startCli,
  type CliExit,
  type CliRun,
  type CliRunOptions,
} from '../src/modules/agents/adapters/cli-llm/cli-process.js';
import { CLI_SPECS, isValidModelId } from '../src/modules/agents/adapters/cli-llm/cli-specs.js';
import { isLlmCliEnabled, llmAuthMode } from '../src/modules/agents/adapters/cli-llm/cli-config.js';

const success = JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' });
const exited: CliExit = { exitCode: 0, stderr: '', timedOut: false, aborted: false };

function fakeChild(pid: number | undefined = 4242) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
  });
}
type FakeChild = ReturnType<typeof fakeChild>;

function startWith(child: FakeChild, extra: Partial<CliRunOptions> = {}) {
  const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn;
  const kill = vi.fn();
  const run = startCli({
    command: 'claude',
    args: ['-p', '', '--model', 'm'],
    stdin: 'prompt',
    cwd: '.',
    env: {},
    timeoutMs: 60_000,
    lines: true,
    platform: 'linux',
    spawnProcess,
    kill,
    ...extra,
  });
  return { run, spawnProcess, kill };
}

async function drain(output: AsyncIterable<string>): Promise<string[]> {
  const all: string[] = [];
  for await (const chunk of output) all.push(chunk);
  return all;
}

describe('startCli with a fake process', () => {
  it('starts through the shell with a quoted command line on Windows, and directly elsewhere', () => {
    const win = fakeChild();
    const windows = startWith(win, { platform: 'win32' });
    const [commandLine, windowsOptions] = (
      windows.spawnProcess as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, Record<string, unknown>];
    expect(commandLine).toBe('"claude" "-p" "" "--model" "m"');
    expect(windowsOptions).toMatchObject({ shell: true, detached: false, windowsHide: true });
    win.emit('close', 0);

    const posix = fakeChild();
    const linux = startWith(posix);
    const [command, args, options] = (linux.spawnProcess as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('claude');
    expect(args).toEqual(['-p', '', '--model', 'm']);
    expect(options).toMatchObject({ detached: true });
    expect(options).not.toHaveProperty('shell');
    posix.emit('close', 0);
  });

  it('refuses a command or argument with shell metacharacters before starting anything', () => {
    const child = fakeChild();
    expect(() => startWith(child, { command: 'claude; calc' })).toThrow();
    expect(() => startWith(child, { args: ['--x', 'a b'] })).toThrow();
    expect(() => assertSafeArgument('ok-1.2_3')).not.toThrow();
  });

  it('writes the prompt to stdin, hands over whole lines and flushes the unfinished last one', async () => {
    const child = fakeChild();
    const received: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => received.push(chunk.toString()));
    const { run } = startWith(child);

    child.stdout.write('{"a":1}\r\n{"b"');
    child.stdout.write(':2}\n\n{"c":3}');
    child.stderr.write('x'.repeat(5000) + 'tail');
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.emit('close', 3);

    expect(await drain(run.output)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    const exit = await run.exit;
    expect(exit.exitCode).toBe(3);
    expect(exit.stderr).toHaveLength(4000);
    expect(exit.stderr.endsWith('tail')).toBe(true);
    expect(received.join('')).toBe('prompt');
  });

  it('hands over raw chunks when the CLI prints plain text', async () => {
    const child = fakeChild();
    const { run } = startWith(child, { lines: false });
    child.stdout.write('Olá, ');
    child.stdout.write('mundo\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.emit('close', 0);
    expect((await drain(run.output)).join('')).toBe('Olá, mundo\n');
  });

  it('resumes a reader that was already waiting, and treats a missing exit code as a failure', async () => {
    const child = fakeChild();
    const { run } = startWith(child);
    const reading = drain(run.output); // starts before anything was written
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.stdout.write('late\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.emit('close', null);
    expect(await reading).toEqual(['late']);
    expect((await run.exit).exitCode).toBe(1);
  });

  it('also fails cleanly when a process with an abort signal cannot be started', async () => {
    const child = fakeChild(undefined);
    const { run } = startWith(child, { signal: new AbortController().signal });
    child.emit('error', new Error('spawn claude ENOENT'));
    await expect(drain(run.output)).rejects.toThrow('could not be started');
    expect((await run.exit).exitCode).toBe(127);
  });

  it('fails the reader and reports 127 when the process cannot be started', async () => {
    const child = fakeChild(undefined);
    const { run, kill } = startWith(child);
    child.emit('error', new Error('spawn claude ENOENT'));
    await expect(drain(run.output)).rejects.toThrow('"claude" could not be started');
    expect(await run.exit).toMatchObject({ exitCode: 127 });
    run.stop();
    expect(kill).not.toHaveBeenCalled();
  });

  it('kills the tree once on timeout, abort or stop, and never after the process is gone', async () => {
    vi.useFakeTimers();
    try {
      const slow = fakeChild(11);
      const timed = startWith(slow, { timeoutMs: 1000 });
      vi.advanceTimersByTime(1001);
      expect(timed.kill).toHaveBeenCalledExactlyOnceWith(11);
      timed.run.stop(); // a second stop is a no-op
      expect(timed.kill).toHaveBeenCalledOnce();
      slow.emit('close', 1);
      expect(await timed.run.exit).toMatchObject({ timedOut: true, aborted: false });

      const controller = new AbortController();
      const aborted = fakeChild(12);
      const abortable = startWith(aborted, { signal: controller.signal });
      controller.abort();
      expect(abortable.kill).toHaveBeenCalledExactlyOnceWith(12);
      aborted.emit('close', 1);
      expect(await abortable.run.exit).toMatchObject({ aborted: true });

      const already = new AbortController();
      already.abort();
      const early = startWith(fakeChild(13), { signal: already.signal });
      expect(early.kill).toHaveBeenCalledExactlyOnceWith(13);

      const finished = fakeChild(14);
      const done = startWith(finished);
      finished.emit('close', 0);
      await done.run.exit;
      done.run.stop(); // the pid may belong to something else by now
      expect(done.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('killTree', () => {
  it('asks taskkill for the whole tree on Windows', () => {
    const killer = new EventEmitter();
    const run = vi.fn(() => killer) as unknown as typeof spawn;
    killTree(7, 'win32', run);
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '7', '/T', '/F'], expect.any(Object));
    expect(() => killer.emit('error', new Error('no taskkill'))).not.toThrow();
  });

  it('signals the process group elsewhere, and ignores a group that is already gone', () => {
    const signal = vi.fn();
    killTree(7, 'linux', undefined, signal);
    expect(signal).toHaveBeenCalledWith(-7, 'SIGKILL');
    expect(() =>
      killTree(7, 'linux', undefined, () => {
        throw new Error('ESRCH');
      }),
    ).not.toThrow();
  });
});

describe('CLI specs', () => {
  const parse = (id: keyof typeof CLI_SPECS) => CLI_SPECS[id].createParser();
  const line = (value: unknown) => JSON.stringify(value);

  it('validates model ids', () => {
    expect(isValidModelId('claude-sonnet-5-5')).toBe(true);
    expect(isValidModelId('gpt-5:high')).toBe(true);
    expect(isValidModelId('a b')).toBe(false);
    expect(isValidModelId('')).toBe(false);
  });

  it('builds each CLI with and without a model and instruction', () => {
    expect(CLI_SPECS.claude.build({ prompt: 'p', instruction: '  ' }, undefined)).toMatchObject({
      files: { 'system.txt': 'You are a helpful assistant.' },
    });
    expect(CLI_SPECS.claude.build({ prompt: 'p' }, 'm').args.slice(-2)).toEqual(['--model', 'm']);
    expect(CLI_SPECS.claude.build({ prompt: 'p' }, undefined).args).not.toContain('--model');
    expect(CLI_SPECS.codex.build({ prompt: 'p' }, 'm').args).toEqual(
      expect.arrayContaining(['--model', 'm']),
    );
    expect(CLI_SPECS.codex.build({ prompt: 'p' }, undefined)).toMatchObject({ stdin: 'p' });
    expect(CLI_SPECS.gemini.build({ prompt: 'p', instruction: 'i' }, 'g')).toMatchObject({
      args: ['--model', 'g'],
      stdin: 'i\n\n---\n\np',
    });
    expect(CLI_SPECS.gemini.build({ prompt: 'p' }, undefined).args).toEqual([]);
  });

  it('reads Claude partial messages, the final result and its usage', () => {
    const claude = parse('claude');
    expect(claude('not json')).toEqual([]);
    // Valid JSON that is not an object is no event either.
    expect(claude('123')).toEqual([]);
    expect(claude('null')).toEqual([]);
    expect(claude(line({ type: 'system' }))).toEqual([]);
    expect(
      claude(
        line({ type: 'stream_event', event: { type: 'message_start', message: { model: 'm1' } } }),
      ),
    ).toEqual([]);
    // A message_start without a model keeps the one already known.
    claude(line({ type: 'stream_event', event: { type: 'message_start', message: {} } }));
    const delta = (text: string, extra: object = {}, type = 'text_delta') =>
      line({
        type: 'stream_event',
        ...extra,
        event: { type: 'content_block_delta', delta: { type, text } },
      });
    expect(claude(delta('Oi'))).toEqual([{ type: 'delta', text: 'Oi' }]);
    expect(claude(delta(''))).toEqual([]);
    expect(claude(delta('x', { parent_tool_use_id: 'sub' }))).toEqual([]);
    expect(claude(delta('x', {}, 'thinking_delta'))).toEqual([]);
    expect(claude(line({ type: 'stream_event', event: { type: 'content_block_stop' } }))).toEqual(
      [],
    );
    expect(
      claude(
        line({
          type: 'result',
          subtype: 'success',
          result: 'Oi',
          usage: {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          },
        }),
      ),
    ).toEqual([
      { type: 'final', text: 'Oi' },
      { type: 'usage', inputTokens: 6, outputTokens: 4, model: 'm1' },
    ]);
  });

  it('reads a Claude result with no usage, and the ways Claude reports an error', () => {
    expect(parse('claude')(line({ type: 'result', subtype: 'success' }))).toEqual([
      { type: 'final', text: '' },
      { type: 'usage', inputTokens: 0, outputTokens: 0 },
    ]);
    const claude = parse('claude');
    expect(claude(line({ type: 'result', is_error: true, result: 'boom' }))).toEqual([
      { type: 'error', message: 'boom' },
    ]);
    expect(claude(line({ type: 'result', subtype: 'error_max_turns' }))).toEqual([
      { type: 'error', message: 'error_max_turns' },
    ]);
    expect(claude(line({ type: 'result', is_error: true }))).toEqual([
      { type: 'error', message: 'Claude reported an error.' },
    ]);
  });

  it('reads Codex messages, usage and failures', () => {
    const codex = parse('codex');
    const item = (value: object) => line({ type: 'item.completed', item: value });
    expect(codex(item({ type: 'command_execution' }))).toEqual([]);
    expect(codex(item({ type: 'agent_message', text: '' }))).toEqual([]);
    expect(codex(line({ type: 'turn.completed' }))).toEqual([
      { type: 'usage', inputTokens: 0, outputTokens: 0 },
    ]);
    expect(
      codex(line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } })),
    ).toEqual([{ type: 'usage', inputTokens: 5, outputTokens: 2 }]);
    expect(codex(line({ type: 'error', message: 'offline' }))).toEqual([
      { type: 'error', message: 'offline' },
    ]);
    expect(codex(line({ type: 'turn.failed' }))).toEqual([
      { type: 'error', message: 'Codex failed.' },
    ]);
    expect(codex(line({ type: 'thread.started' }))).toEqual([]);
  });

  it('turns every Gemini chunk into a delta', () => {
    const gemini = parse('gemini');
    expect(gemini('')).toEqual([]);
    expect(gemini('texto')).toEqual([{ type: 'delta', text: 'texto' }]);
  });
});

describe('cli-config', () => {
  it('reads the operator switch and the integration auth mode', () => {
    expect(isLlmCliEnabled({ ADK_LLM_CLI: 'true' })).toBe(true);
    expect(isLlmCliEnabled({ ADK_LLM_CLI: ' YES ' })).toBe(true);
    expect(isLlmCliEnabled({ ADK_LLM_CLI: 'false' })).toBe(false);
    expect(isLlmCliEnabled({})).toBe(false);
    expect(llmAuthMode({ authMode: 'cli' })).toBe('cli');
    expect(llmAuthMode({ authMode: 'api_key' })).toBe('api_key');
    expect(llmAuthMode({})).toBe('api_key');
  });
});

describe('CliLlmProvider edge cases', () => {
  function runOf(
    lines: string[],
    exit: Partial<CliExit> = {},
    failWith?: Error,
  ): (options: CliRunOptions) => CliRun {
    return () => ({
      output: (async function* () {
        for (const item of lines) yield item;
        if (failWith) throw failWith;
      })(),
      exit: Promise.resolve({ ...exited, ...exit }),
      stop: () => undefined,
    });
  }

  it('answers without usage or model for a plain-text CLI', async () => {
    const provider = new CliLlmProvider({ cli: 'gemini', start: runOf(['Olá', ' mundo']) });
    expect(await provider.complete({ prompt: 'x' })).toEqual({
      provider: 'Gemini CLI',
      text: 'Olá mundo',
    });
  });

  it('reports failures in the way each one is told', async () => {
    const empty = new CliLlmProvider({ cli: 'claude', start: runOf([]) });
    await expect(empty.complete({ prompt: 'x' })).rejects.toMatchObject({
      code: 'FAILED',
      message: 'Claude CLI failed.',
    });

    const reported = new CliLlmProvider({
      cli: 'claude',
      start: runOf([JSON.stringify({ type: 'result', is_error: true, result: 'quota exceeded' })]),
    });
    await expect(reported.complete({ prompt: 'x' })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: 'quota exceeded',
    });

    const missing = new CliLlmProvider({ cli: 'codex', start: runOf([], { exitCode: 127 }) });
    await expect(missing.complete({ prompt: 'x' })).rejects.toMatchObject({
      code: 'NOT_INSTALLED',
    });

    const enoent = new CliLlmProvider({
      cli: 'codex',
      start: runOf([], {}, new Error('"codex" could not be started: spawn codex ENOENT')),
    });
    await expect(enoent.complete({ prompt: 'x' })).rejects.toMatchObject({ code: 'NOT_INSTALLED' });

    const crashed = new CliLlmProvider({
      cli: 'codex',
      start: runOf([], {}, new Error('pipe broke')),
    });
    await expect(crashed.complete({ prompt: 'x' })).rejects.toThrow('pipe broke');

    const killed = new CliLlmProvider({
      cli: 'claude',
      start: runOf([], { aborted: true, exitCode: 1 }),
    });
    await expect(killed.complete({ prompt: 'x' })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps at most four CLI processes running and lets a queued request be cancelled', async () => {
    const releases: Array<() => void> = [];
    let started = 0;
    const start = (): CliRun => {
      started += 1;
      let release!: () => void;
      const finished = new Promise<void>((resolve) => (release = resolve));
      releases.push(release);
      return {
        output: (async function* () {
          await finished;
          yield success;
        })(),
        exit: finished.then(() => exited),
        stop: () => undefined,
      };
    };
    const provider = new CliLlmProvider({ cli: 'claude', start });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

    const running = Array.from({ length: 4 }, () => provider.complete({ prompt: 'x' }));
    // Queued behind the four, with a signal that never fires: it must start once a slot frees.
    running.push(provider.complete({ prompt: 'x' }, new AbortController().signal));
    const cancel = new AbortController();
    const cancelled = provider.complete({ prompt: 'x' }, cancel.signal);
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await settle();
    expect(started).toBe(4);

    cancel.abort();
    await cancelledResult;
    releases[0]!();
    await settle();
    expect(started).toBe(5); // the fifth took the free slot; the cancelled one never started

    for (const release of releases) release();
    await Promise.all(running);
    expect(started).toBe(5);
  });
});

describe('detectCli', () => {
  const runOf =
    (output: string[], exit: Partial<CliExit> = {}, failWith?: Error) =>
    (): CliRun => ({
      output: (async function* () {
        for (const item of output) yield item;
        if (failWith) throw failWith;
      })(),
      exit: Promise.resolve({ ...exited, ...exit }),
      stop: () => undefined,
    });

  it('reports the installed version', async () => {
    expect(await detectCli('claude', runOf(['2.1.318 (Claude Code)\n', 'more']))).toEqual({
      id: 'claude',
      label: 'Claude',
      command: 'claude',
      installed: true,
      version: '2.1.318 (Claude Code)',
    });
  });

  it('is installed even when the CLI prints no version', async () => {
    expect(await detectCli('codex', runOf([]))).toEqual({
      id: 'codex',
      label: 'Codex',
      command: 'codex',
      installed: true,
    });
  });

  it('is not installed when the command fails or cannot start', async () => {
    expect(await detectCli('gemini', runOf([], { exitCode: 1 }))).toMatchObject({
      installed: false,
    });
    expect(await detectCli('gemini', runOf([], {}, new Error('ENOENT')))).toMatchObject({
      installed: false,
    });
  });

  it('checks the real machine by default without throwing', async () => {
    const status = await detectCli('claude');
    expect(typeof status.installed).toBe('boolean');
  });
});
