import type * as ChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromiumInstalled,
  createLocalBrowser,
  installChromium,
  loadRunnerIdentity,
  prepareWorkspaceRoot,
  playwrightPackageRoot,
} from '../src/e2e/local-runner/playwright-setup.js';
import {
  defaultBrowsersPath,
  PlaywrightE2eRunner,
} from '../src/vendor/e2e/adapters/playwright-runner.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-runner-setup-'));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function fakeChild() {
  const child = new EventEmitter();
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  return child;
}

describe('Chromium download', () => {
  it('runs the Playwright CLI of the package and reports its exit code', async () => {
    const child = fakeChild();
    const finished = installChromium('/opt/adk');
    child.emit('exit', 0);
    expect(await finished).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join('/opt/adk', 'node_modules', '@playwright', 'test', 'cli.js'),
        'install',
        'chromium',
      ],
      { stdio: 'inherit' },
    );
    const failed = fakeChild();
    const second = installChromium('/opt/adk');
    failed.emit('exit', 3);
    expect(await second).toBe(3);
  });

  it('counts a process killed by a signal as a failure', async () => {
    const child = fakeChild();
    const finished = installChromium();
    child.emit('exit', null);
    expect(await finished).toBe(1);
  });

  it('rejects when the process cannot start', async () => {
    const child = fakeChild();
    const finished = installChromium();
    child.emit('error', new Error('spawn ENOENT'));
    await expect(finished).rejects.toThrow('ENOENT');
  });
});

describe('local browser setup', () => {
  it('creates the Playwright runner on top of a prepared run folder', async () => {
    const home = await tempDir();
    const local = await createLocalBrowser({ ADK_RUNNER_HOME: home });
    expect(local).toBeInstanceOf(PlaywrightE2eRunner);
    const stat = await fs.stat(path.join(home, 'runs', 'package.json'));
    expect(stat.isFile()).toBe(true);
  });

  it('links with a junction on Windows', async () => {
    const home = await tempDir();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const symlink = vi.spyOn(fs, 'symlink').mockResolvedValue(undefined);
    await prepareWorkspaceRoot(home, playwrightPackageRoot());
    expect(symlink).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'junction');
  });

  it('links with a directory symlink on platforms other than Windows', async () => {
    const home = await tempDir();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const symlink = vi.spyOn(fs, 'symlink').mockResolvedValue(undefined);
    await prepareWorkspaceRoot(home, playwrightPackageRoot());
    expect(symlink).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'dir');
  });

  it('names the runner after the computer, and falls back when it has no name', async () => {
    const home = await tempDir();
    vi.spyOn(os, 'hostname').mockReturnValue('');
    expect((await loadRunnerIdentity(home, '1.0.0')).name).toBe('computer');
    vi.spyOn(os, 'hostname').mockReturnValue('x'.repeat(150));
    expect((await loadRunnerIdentity(home, '1.0.0')).name).toHaveLength(100);
  });

  it('looks for Chromium in the default browsers folder of the user', async () => {
    const home = await tempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    expect(await chromiumInstalled({})).toBe(false);
    await fs.mkdir(path.join(defaultBrowsersPath(process.platform, home), 'chromium-1200'), {
      recursive: true,
    });
    expect(await chromiumInstalled({})).toBe(true);
  });
});
