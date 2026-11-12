import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';

export interface ServiceOptions {
  readonly name: string;
  readonly script: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly environment: Record<string, string>;
  readonly logFile: string;
  /** Called when the process ends without having been asked to. */
  readonly onUnexpectedExit: (name: string, code: number | null) => void;
}

/**
 * A Node process running one of the bundled servers. It uses Electron's own Node runtime
 * (ELECTRON_RUN_AS_NODE), so the user does not need Node.js installed.
 */
export class Service {
  private child: ChildProcess | undefined;
  private stopping = false;

  public constructor(private readonly options: ServiceOptions) {}

  public start(): void {
    const log = createWriteStream(this.options.logFile, { flags: 'a' });
    const child = spawn(process.execPath, [this.options.script, ...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('exit', (code) => {
      log.end();
      if (!this.stopping) this.options.onUnexpectedExit(this.options.name, code);
    });
    this.child = child;
  }

  public async stop(timeoutMs = 8000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

/** Polls `url` until it answers with a success status, or fails after `timeoutMs`. */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`${url} did not answer in ${timeoutMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
