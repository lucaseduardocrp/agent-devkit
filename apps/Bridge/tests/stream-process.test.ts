import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStreamRedactor, REDACTED } from '../src/core/guard.js';
import { streamProcess } from '../src/core/stream-process.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function script(source: string): { command: string; cwd: string; args: string[] } {
  dir = mkdtempSync(join(tmpdir(), 'bridge-stream-'));
  const file = join(dir, 'fake.mjs');
  writeFileSync(file, source);
  return { command: process.execPath, cwd: dir, args: [file] };
}

async function drain(output: AsyncIterable<string>): Promise<string[]> {
  const all: string[] = [];
  for await (const chunk of output) all.push(chunk);
  return all;
}

describe('streamProcess', () => {
  it('hands over stdout while the process runs, and writes the prompt to stdin', async () => {
    const { command, cwd, args } = script(`
      let input = '';
      process.stdin.on('data', (c) => (input += c)).on('end', async () => {
        process.stdout.write('first:' + input.trim() + '\\n');
        await new Promise((r) => setTimeout(r, 400));
        process.stdout.write('second\\n\\nthird');
      });
    `);
    const startedAt = Date.now();
    const run = streamProcess(
      { command, args, stdin: 'hello' },
      { cwd, env: {}, timeoutMs: 10_000, lines: true },
    );
    let firstAt = 0;
    const lines: string[] = [];
    for await (const line of run.output) {
      firstAt ||= Date.now() - startedAt;
      lines.push(line);
    }
    expect(lines).toEqual(['first:hello', 'second', 'third']);
    expect(firstAt).toBeLessThan(350); // before the process ended
    expect(await run.exit).toMatchObject({ exitCode: 0, stopped: null });
  });

  it('hands over raw chunks, keeps the end of stderr and reports the exit code', async () => {
    const { command, cwd, args } = script(`
      process.stdout.write('texto ');
      process.stdout.write('puro');
      process.stderr.write('x'.repeat(5000) + 'fim');
      process.exit(3);
    `);
    const run = streamProcess({ command, args }, { cwd, env: {}, timeoutMs: 10_000, lines: false });
    expect((await drain(run.output)).join('')).toBe('texto puro');
    const exit = await run.exit;
    expect(exit.exitCode).toBe(3);
    expect(exit.stderr).toHaveLength(4000);
    expect(exit.stderr.endsWith('fim')).toBe(true);
  });

  it('gives the process only the environment it is handed, plus the invocation own', async () => {
    const { command, cwd, args } = script(
      `console.log(JSON.stringify({ a: process.env.A, b: process.env.B, secret: process.env.BRIDGE_SECRET ?? null, empty: 'E' in process.env }))`,
    );
    process.env['BRIDGE_SECRET'] = 'must-not-leak';
    try {
      const run = streamProcess(
        { command, args, env: { B: 'from-invocation', E: '' } },
        {
          cwd,
          env: { A: 'from-options', PATH: process.env['PATH'] },
          timeoutMs: 10_000,
          lines: true,
        },
      );
      expect(JSON.parse((await drain(run.output))[0]!)).toEqual({
        a: 'from-options',
        b: 'from-invocation',
        secret: null,
        empty: false,
      });
    } finally {
      delete process.env['BRIDGE_SECRET'];
    }
  });

  it('kills the process when the signal aborts, and never twice', async () => {
    const { command, cwd, args } = script(`setInterval(() => {}, 1000); console.log('up');`);
    const controller = new AbortController();
    const run = streamProcess(
      { command, args },
      { cwd, env: {}, timeoutMs: 30_000, signal: controller.signal, lines: true },
    );
    for await (const line of run.output) {
      expect(line).toBe('up');
      controller.abort();
      run.stop();
    }
    expect(await run.exit).toMatchObject({ stopped: 'cancelled' });
    run.stop(); // after it is gone: nothing to kill
  });

  it('kills a process that is already cancelled when it starts', async () => {
    const { command, cwd, args } = script(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    controller.abort();
    const run = streamProcess(
      { command, args },
      { cwd, env: {}, timeoutMs: 30_000, signal: controller.signal, lines: true },
    );
    expect(await run.exit).toMatchObject({ stopped: 'cancelled' });
  });

  it('stops a process that runs past its time limit', async () => {
    const { command, cwd, args } = script(`setInterval(() => {}, 1000);`);
    const run = streamProcess({ command, args }, { cwd, env: {}, timeoutMs: 200, lines: true });
    expect(await run.exit).toMatchObject({ stopped: 'timeout' });
  });

  it('fails the reader when the command is not installed, and with another error otherwise', async () => {
    const missing = streamProcess(
      { command: 'adk-definitely-not-a-cli', args: [] },
      { cwd: tmpdir(), env: {}, timeoutMs: 5000, lines: true },
    );
    await expect(drain(missing.output)).rejects.toThrow('is not installed in this container');
    expect(await missing.exit).toMatchObject({ exitCode: 127 });
    missing.stop();

    const denied = streamProcess(
      { command: process.execPath, args: [] },
      { cwd: join(tmpdir(), 'adk-no-such-directory'), env: {}, timeoutMs: 5000, lines: true },
    );
    await expect(drain(denied.output)).rejects.toThrow();
  });

  it('resumes a reader that was already waiting', async () => {
    const { command, cwd, args } = script(`setTimeout(() => console.log('late'), 150);`);
    const run = streamProcess({ command, args }, { cwd, env: {}, timeoutMs: 10_000, lines: true });
    expect(await drain(run.output)).toEqual(['late']);
  });
});

describe('createStreamRedactor', () => {
  const secret = 'sk-ant-oat-secret-token-0123456789';
  const run = (pieces: string[], secrets: string[] = [secret]) => {
    const redactor = createStreamRedactor(secrets);
    return pieces.map((piece) => redactor.push(piece)).concat(redactor.flush());
  };

  it('holds the tail back and sends everything by the end', () => {
    const pieces = ['a'.repeat(300), 'b'.repeat(300)];
    const out = run(pieces);
    expect(out.join('')).toBe(pieces.join(''));
    expect(out[0]!.length).toBeLessThan(300); // the end of the first piece waits for the next
  });

  it('masks a secret split across pieces, before any part of it is sent', () => {
    const half = Math.floor(secret.length / 2);
    const out = run([
      'x'.repeat(400) + secret.slice(0, half),
      secret.slice(half) + 'y'.repeat(400),
    ]);
    const all = out.join('');
    expect(all).not.toContain(secret.slice(0, 20));
    expect(all).toContain(REDACTED);
    expect(all.startsWith('x'.repeat(400))).toBe(true);
    expect(all.endsWith('y'.repeat(400))).toBe(true);
  });

  it('holds back as much as the longest secret needs', () => {
    const long = 'z'.repeat(1000);
    const out = run(['q'.repeat(900) + long.slice(0, 500), long.slice(500)], [long]);
    expect(out.join('')).not.toContain('zzzzzzzzzz');
    expect(out.join('')).toContain(REDACTED);
  });

  it('sends nothing for text shorter than the hold, then everything on flush', () => {
    const redactor = createStreamRedactor([]);
    expect(redactor.push('hello')).toBe('');
    expect(redactor.flush()).toBe('hello');
    expect(redactor.flush()).toBe('');
  });
});
