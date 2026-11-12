import { hostname } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { Git } from '../vendor/development/git.js';
import { runStreaming } from '../vendor/development/process.js';
import { DevelopmentHost, type Credentials } from './development.js';
import { Terminal } from './terminal.js';
import {
  inside,
  listAllFiles,
  listDirectory,
  readTextFile,
  searchContent,
  writeTextFile,
} from './workspace-files.js';

export interface DevelopmentIpcOptions {
  readonly apiUrl: () => string;
  readonly userData: string;
  readonly log: (line: string) => void;
  /** Only the web app shown in the window may drive these calls. */
  readonly allowed: (event: IpcMainInvokeEvent) => boolean;
  readonly window: () => BrowserWindow | undefined;
}

type Handler = (...args: unknown[]) => Promise<object> | object;

const QUEUE_INTERVAL_MS = 5000;
const string = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Development > Code in the desktop app (see src/preload): the app executes the sessions itself,
 * with the runner of the CLI, and gives the web app the files, the changes and a terminal of each
 * session's worktree. Returns what stops the agents and commands when the app closes.
 */
export function handleDevelopmentCalls(options: DevelopmentIpcOptions): { stop(): void } {
  const git = new Git();
  const host = new DevelopmentHost({
    apiUrl: options.apiUrl,
    stateFile: join(options.userData, 'development.json'),
    runnerName: `Agent DevKit (${hostname()})`,
    git,
    runAgent: (invocation, streamOptions) =>
      runStreaming(invocation.command, invocation.args, { ...streamOptions, env: invocation.env }),
    log: options.log,
  });
  const loaded = host.load();
  const terminals = new Map<string, Terminal>();

  const terminal = (sessionId: string): Terminal => {
    const worktree = host.worktree(sessionId);
    let current = terminals.get(sessionId);
    if (!current) {
      current = new Terminal(worktree, (event) =>
        options.window()?.webContents.send('adk:dev-terminal', sessionId, event),
      );
      terminals.set(sessionId, current);
    }
    return current;
  };

  const handle = (channel: string, handler: Handler): void => {
    ipcMain.handle(`adk:dev-${channel}`, async (event, ...args: unknown[]) => {
      if (!options.allowed(event)) return { ok: false, error: 'Not allowed.' };
      try {
        await loaded;
        return { ok: true, ...(await handler(...args)) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
  };

  handle('connect', (input) => {
    const { token, workspaceId } = (input ?? {}) as Partial<Credentials>;
    host.connect(
      typeof token === 'string' && token
        ? { token, workspaceId: string(workspaceId) || null }
        : undefined,
    );
    void host.tick();
    return {};
  });
  handle('preferences', () => host.preferences());
  handle('pick-folder', async () => {
    const window = options.window();
    const picked = await (window
      ? dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }));
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return { path: null };
    return { path: await git.root(folder) };
  });
  handle('assign', async (sessionId, input) => {
    const { repoPath, autonomy } = (input ?? {}) as { repoPath?: unknown; autonomy?: unknown };
    const assignment = await host.assign(
      string(sessionId),
      string(repoPath),
      autonomy === 'auto' ? 'auto' : 'safe',
    );
    void host.tick();
    return { assignment };
  });
  handle('assignment', (sessionId) => ({ assignment: host.assignment(string(sessionId)) }));
  handle('files-list', async (sessionId, folder) => ({
    entries: await listDirectory(host.worktree(string(sessionId)), string(folder)),
  }));
  handle('files-read', async (sessionId, path) => ({
    file: await readTextFile(host.worktree(string(sessionId)), string(path)),
  }));
  handle('files-write', async (sessionId, path, content) => {
    await writeTextFile(host.worktree(string(sessionId)), string(path), string(content));
    return {};
  });
  handle('files-index', async (sessionId) => ({
    files: await listAllFiles(host.worktree(string(sessionId))),
  }));
  handle('files-search', async (sessionId, query) => ({
    matches: await searchContent(host.worktree(string(sessionId)), string(query)),
  }));
  handle('files-path', (sessionId, path) => ({
    path: inside(host.worktree(string(sessionId)), string(path)),
  }));
  handle('files-reveal', (sessionId, path) => {
    shell.showItemInFolder(inside(host.worktree(string(sessionId)), string(path)));
    return {};
  });
  handle('files-open', async (sessionId, path, target) => {
    const file = inside(host.worktree(string(sessionId)), string(path));
    if (target !== 'vscode') {
      const failed = await shell.openPath(file);
      if (failed) throw new Error(failed);
      return {};
    }
    // The `code` command opens the file in VS Code when it is on the PATH.
    spawn('code', [file], { shell: process.platform === 'win32', detached: true, stdio: 'ignore' })
      .on('error', (error) => options.log(`[development] Could not open VS Code: ${error.message}`))
      .unref();
    return {};
  });
  handle('branches', async (sessionId) => ({
    branches: await git.branches(host.worktree(string(sessionId))),
  }));
  handle('changes', async (sessionId, baseBranch, choice) => {
    const worktree = host.worktree(string(sessionId));
    const { against, commit } = (choice ?? {}) as { against?: unknown; commit?: unknown };
    const base = string(against) || string(baseBranch);
    return {
      files: string(commit)
        ? await git.commitDiff(worktree, string(commit))
        : await git.diff(worktree, base),
      commits: await git.history(worktree),
    };
  });
  handle('revert', async (sessionId, baseBranch, path) => {
    const worktree = host.worktree(string(sessionId));
    if (string(path)) await git.revertFile(worktree, string(baseBranch), string(path));
    else await git.revertAll(worktree, string(baseBranch));
    return {};
  });
  handle('terminal-folder', (sessionId) => ({ cwd: terminal(string(sessionId)).folder }));
  handle('terminal-run', async (sessionId, line) => ({
    started: await terminal(string(sessionId)).run(string(line)),
  }));
  handle('terminal-stop', (sessionId) => {
    terminals.get(string(sessionId))?.stop();
    return {};
  });

  const timer = setInterval(() => void host.tick(), QUEUE_INTERVAL_MS);
  return {
    stop() {
      clearInterval(timer);
      host.stop();
      for (const current of terminals.values()) current.stop();
    },
  };
}
