import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  defaultBrowsersPath,
  PlaywrightE2eRunner,
} from '../../vendor/backend/modules/e2e/adapters/playwright-runner.js';

/** Folder that contains this package's `node_modules/@playwright/test` (global or local install). */
export function playwrightPackageRoot(): string {
  const manifest = createRequire(import.meta.url).resolve('@playwright/test/package.json');
  // <root>/node_modules/@playwright/test/package.json
  return path.dirname(path.dirname(path.dirname(path.dirname(manifest))));
}

/** Where the runner keeps throwaway run folders, next to the stored ADK session. */
export function runnerHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['ADK_RUNNER_HOME'] || path.join(os.homedir(), '.adk', 'e2e-runner');
}

/**
 * Prepares the run folder so generated specs resolve `@playwright/test` to this CLI's copy
 * (the same instance the test runner uses), even when the CLI is installed globally.
 */
export async function prepareWorkspaceRoot(home: string, packageRoot: string): Promise<string> {
  const workspaceRoot = path.join(home, 'runs');
  const scope = path.join(workspaceRoot, 'node_modules', '@playwright');
  const link = path.join(scope, 'test');
  const target = path.join(packageRoot, 'node_modules', '@playwright', 'test');
  await fs.mkdir(scope, { recursive: true });
  const current = await fs.realpath(link).catch(() => null);
  if (current !== (await fs.realpath(target))) {
    await fs.rm(link, { recursive: true, force: true });
    // Junctions need no special rights on Windows; elsewhere a directory symlink is used.
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  // Same module system as the backend package the workers run specs from.
  await fs.writeFile(
    path.join(workspaceRoot, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' })}\n`,
  );
  return workspaceRoot;
}

export async function createLocalBrowser(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlaywrightE2eRunner> {
  const packageRoot = playwrightPackageRoot();
  const workspaceRoot = await prepareWorkspaceRoot(runnerHome(env), packageRoot);
  return new PlaywrightE2eRunner({ packageRoot, workspaceRoot });
}

/** Downloads the Chromium build that matches the bundled Playwright version. */
export function installChromium(packageRoot = playwrightPackageRoot()): Promise<number> {
  const cli = path.join(packageRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export interface RunnerIdentity {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
}

/** A stable id per computer, so ADK shows the same runner across restarts. */
export async function loadRunnerIdentity(home: string, version: string): Promise<RunnerIdentity> {
  const file = path.join(home, 'runner.json');
  let id: string | undefined;
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { id?: unknown };
    if (typeof stored.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(stored.id)) id = stored.id;
  } catch {
    // First run on this computer.
  }
  if (!id) {
    id = `runner-${randomBytes(12).toString('hex')}`;
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ id })}\n`, { mode: 0o600 });
  }
  return {
    id,
    name: os.hostname().slice(0, 100) || 'computer',
    platform: process.platform,
    version,
  };
}

/** Whether a Chromium build is present where Playwright looks for browsers. */
export async function chromiumInstalled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const browsers =
    env['PLAYWRIGHT_BROWSERS_PATH'] || defaultBrowsersPath(process.platform, os.homedir());
  const entries = await fs.readdir(browsers).catch(() => [] as string[]);
  return entries.some((name) => name.startsWith('chromium'));
}

/** Downloads Chromium on the first run, so `devkit e2e setup` is optional. */
export async function ensureChromium(
  say: (line: string) => void,
  install: () => Promise<number> = installChromium,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (await chromiumInstalled(env)) return;
  say('[devkit] Downloading the test browser (Chromium) for the first run…');
  if ((await install()) !== 0)
    throw new Error('Could not download Chromium. Run "devkit e2e setup" and try again.');
}
