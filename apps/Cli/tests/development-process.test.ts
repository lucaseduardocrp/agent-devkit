import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killTree, runStreaming } from '../src/development/process.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A Node script in a temporary folder: real processes, no shell quoting to worry about. */
async function script(source: string): Promise<{ file: string; cwd: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-process-'));
  temporary.push(cwd);
  const file = path.join(cwd, 'script.cjs');
  await fs.writeFile(file, source);
  return { file, cwd };
}

// Without a shell the same call works on every OS; the shell is only needed for .cmd files.
const direct = { platform: 'linux' as const, kill: (pid: number) => process.kill(pid) };

describe('runStreaming', () => {
  it('hands over the output line by line with the exit code and the end of stderr', async () => {
    const { file, cwd } = await script(`
      let input = '';
      process.stdin.on('data', (chunk) => (input += chunk));
      process.stdin.on('end', () => {
        process.stdout.write('first\\r\\nsec');
        setTimeout(() => {
          process.stdout.write('ond\\n' + input + ' ' + process.env.ADK_TEST_VALUE);
          process.stderr.write('warning: careful');
          process.exitCode = 3;
        }, 30);
      });
    `);
    const lines: string[] = [];
    const result = await runStreaming(process.execPath, [file], {
      ...direct,
      cwd,
      env: { ADK_TEST_VALUE: 'from-env' },
      stdin: 'typed',
      signal: new AbortController().signal,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['first', 'second', 'typed from-env']);
    expect(result).toEqual({ exitCode: 3, stderr: 'warning: careful' });
  });

  it('runs through the platform default without input', async () => {
    const { file, cwd } = await script(`process.stdout.write('ok\\n');`);
    const lines: string[] = [];
    // On Windows the command goes through the shell, which needs the path quoted.
    const argument = process.platform === 'win32' ? `"${file}"` : file;
    const result = await runStreaming('node', [argument], {
      cwd,
      onLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['ok']);
    expect(result.exitCode).toBe(0);
  });

  it('stops the process when the signal aborts, during the run or before it', async () => {
    const { file, cwd } = await script(`
      process.stdout.write('started\\n');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const killed: number[] = [];
    const kill = (pid: number) => {
      killed.push(pid);
      process.kill(pid);
    };
    const running = runStreaming(process.execPath, [file], {
      platform: 'linux',
      kill,
      cwd,
      signal: controller.signal,
      onLine: () => controller.abort(),
    });
    expect((await running).exitCode).not.toBe(0);
    expect(killed).toHaveLength(1);

    const aborted = new AbortController();
    aborted.abort();
    const early = await runStreaming(process.execPath, [file], {
      platform: 'linux',
      kill,
      cwd,
      signal: aborted.signal,
      onLine: () => undefined,
    });
    expect(early.exitCode).not.toBe(0);
    expect(killed).toHaveLength(2);
  });

  it('stops the whole tree with the default kill of this platform', async () => {
    const { file, cwd } = await script(`
      process.stdout.write('started\\n');
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const argument = process.platform === 'win32' ? `"${file}"` : file;
    const result = await runStreaming('node', [argument], {
      cwd,
      signal: controller.signal,
      onLine: () => controller.abort(),
    });
    expect(result.exitCode).not.toBe(0);
  });

  it('rejects when the command cannot be started', async () => {
    await expect(
      runStreaming('adk-command-that-does-not-exist', [], {
        ...direct,
        cwd: os.tmpdir(),
        signal: new AbortController().signal,
        onLine: () => undefined,
      }),
    ).rejects.toThrow('"adk-command-that-does-not-exist" could not be started');
  });
});

describe('killTree', () => {
  it('uses taskkill on Windows and the process group elsewhere', () => {
    const run = vi.fn();
    const signal = vi.fn();
    killTree(123, 'win32', run, signal);
    expect(run).toHaveBeenCalledWith('taskkill', ['/pid', '123', '/T', '/F']);
    expect(signal).not.toHaveBeenCalled();

    killTree(123, 'linux', run, signal);
    expect(signal).toHaveBeenCalledWith(-123);
    expect(() =>
      killTree(123, 'linux', run, () => {
        throw new Error('ESRCH');
      }),
    ).not.toThrow();
  });
});
