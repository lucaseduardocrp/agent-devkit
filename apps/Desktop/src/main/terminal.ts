import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { killTree } from '../vendor/development/process.js';

export type TerminalEvent =
  | { readonly type: 'output'; readonly text: string }
  /** The command ended; `cwd` is the folder the next one runs in. */
  | { readonly type: 'exit'; readonly code: number; readonly cwd: string };

export interface ShellCommand {
  readonly command: string;
  readonly args: readonly string[];
}

// PowerShell answers 1 for any failed program; this hands over the program's own exit code.
const POWERSHELL_EXIT =
  '; $adkOk = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $adkOk) { exit 1 }';

/** How one line is handed to the system's shell: PowerShell on Windows, the user's shell elsewhere. */
export function shellCommand(
  line: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCommand {
  return platform === 'win32'
    ? {
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-Command', line + POWERSHELL_EXIT],
      }
    : { command: env['SHELL'] || '/bin/sh', args: ['-c', line] };
}

export interface TerminalOptions {
  readonly platform?: NodeJS.Platform;
  readonly shell?: (line: string) => ShellCommand;
  readonly kill?: (pid: number) => void;
}

/**
 * The terminal of a session: runs one command line at a time in the session's worktree and hands
 * over its output as it comes. It is not a pseudo-terminal, so commands cannot ask for input;
 * `cd` is followed here, because every line runs in a shell of its own.
 */
export class Terminal {
  private child: ChildProcess | undefined;
  private readonly platform: NodeJS.Platform;

  public constructor(
    private cwd: string,
    private readonly emit: (event: TerminalEvent) => void,
    private readonly options: TerminalOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
  }

  public get folder(): string {
    return this.cwd;
  }

  private exit(code: number): void {
    this.emit({ type: 'exit', code, cwd: this.cwd });
  }

  private async changeFolder(argument: string): Promise<void> {
    const target = resolve(this.cwd, argument.replace(/^(["'])(.*)\1$/, '$2'));
    const isFolder = await stat(target).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!isFolder) {
      this.emit({ type: 'output', text: `cd: ${argument}: no such folder\n` });
      return this.exit(1);
    }
    this.cwd = target;
    this.exit(0);
  }

  /** Runs a line; false while the previous one is still running. */
  public async run(line: string): Promise<boolean> {
    if (this.child) return false;
    const command = line.trim();
    if (!command) {
      this.exit(0);
      return true;
    }
    const cd = /^cd\s+(.+)$/.exec(command);
    if (cd) {
      await this.changeFolder(cd[1]!);
      return true;
    }
    const shell = (
      this.options.shell ?? ((text: string) => shellCommand(text, this.platform, process.env))
    )(command);
    const child = spawn(shell.command, [...shell.args], {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Stopping must reach what the command started (see killTree).
      detached: this.platform !== 'win32',
      windowsHide: true,
    });
    this.child = child;
    const output = (chunk: Buffer) => this.emit({ type: 'output', text: chunk.toString('utf8') });
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    const finish = (code: number) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.exit(code);
    };
    child.once('error', (error) => {
      this.emit({ type: 'output', text: `${error.message}\n` });
      finish(1);
    });
    /* v8 ignore next -- a process killed by a signal has no code; which one applies depends on the OS */
    child.once('close', (code) => finish(code ?? 1));
    return true;
  }

  /** Stops the running command and everything it started. */
  public stop(): void {
    const pid = this.child?.pid;
    if (pid) (this.options.kill ?? ((id: number) => killTree(id, this.platform)))(pid);
  }
}
