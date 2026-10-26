import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromiumInstalled,
  createLocalBrowser,
  installChromium,
  loadRunnerIdentity,
  playwrightPackageRoot,
  prepareWorkspaceRoot,
} from '../src/e2e/local-runner/playwright-setup.js';
import { PlaywrightE2eRunner } from '../src/vendor/backend/modules/e2e/adapters/playwright-runner.js';

const spawned = vi.hoisted(() => [] as { args: unknown[]; child: EventEmitter }[]);
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: (...args: unknown[]) => {
    const child = new EventEmitter();
    spawned.push({ args, child });
    return child;
  },
}));

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-setup-test-'));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  spawned.splice(0);
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('Chromium download', () => {
  it('runs the bundled Playwright installer and reports its exit code', async () => {
    const done = installChromium('/pkg');
    expect(spawned[0]!.args).toEqual([
      process.execPath,
      [path.join('/pkg', 'node_modules', '@playwright', 'test', 'cli.js'), 'install', 'chromium'],
      { stdio: 'inherit' },
    ]);
    spawned[0]!.child.emit('exit', 0);
    await expect(done).resolves.toBe(0);

    const killed = installChromium('/pkg');
    spawned[1]!.child.emit('exit', null);
    await expect(killed).resolves.toBe(1);

    const missing = installChromium();
    spawned[2]!.child.emit('error', new Error('ENOENT'));
    await expect(missing).rejects.toThrow('ENOENT');
  });

  it('looks for Chromium in the default Playwright folder of this user', async () => {
    const home = await tempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(await chromiumInstalled({})).toBe(false);
  });
});

describe('local browser setup', () => {
  it('creates the Playwright runner with a prepared run folder', async () => {
    const home = await tempDir();
    const runner = await createLocalBrowser({ ADK_RUNNER_HOME: home });
    expect(runner).toBeInstanceOf(PlaywrightE2eRunner);
    await expect(fs.stat(path.join(home, 'runs', 'package.json'))).resolves.toBeTruthy();
  });

  it.each([
    ['linux', 'dir'],
    ['win32', 'junction'],
  ])('links Playwright on %s with a %s link', async (name, type) => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(name as NodeJS.Platform);
    const symlink = vi.spyOn(fs, 'symlink').mockResolvedValue(undefined);
    const home = await tempDir();
    await prepareWorkspaceRoot(home, playwrightPackageRoot());
    expect(symlink).toHaveBeenCalledWith(expect.any(String), expect.any(String), type);
    platform.mockRestore();
  });

  it('names the runner "computer" when the host name is empty', async () => {
    vi.spyOn(os, 'hostname').mockReturnValue('');
    expect((await loadRunnerIdentity(await tempDir(), '1.0.0')).name).toBe('computer');
  });
});
