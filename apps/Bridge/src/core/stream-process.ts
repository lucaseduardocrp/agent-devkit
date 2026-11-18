import { spawn } from 'node:child_process';
import { CliError, type Invocation } from './types.js';

export interface StreamOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** The whole environment of the process: never the container's. */
  readonly env: NodeJS.ProcessEnv;
  /** Run as this OS user (needs the bridge to be root). */
  readonly uid?: number;
  readonly gid?: number;
  /** `true` hands over whole lines (JSONL); `false` hands over raw stdout chunks. */
  readonly lines: boolean;
}

export interface StreamExit {
  readonly exitCode: number;
  /** The end of what the process wrote to stderr. */
  readonly stderr: string;
  /** Why the bridge stopped it, when it did. */
  readonly stopped: 'timeout' | 'cancelled' | null;
}

export interface StreamRun {
  /** Stdout as it is written. Ends when the process closes; throws when it cannot start. */
  readonly output: AsyncIterable<string>;
  /** Resolves (never rejects) once the process is gone. */
  readonly exit: Promise<StreamExit>;
  /** Stops the process and everything it started. Safe at any time. */
  readonly stop: () => void;
}

/** Starts one invocation. Injected into the LLM host so tests do not spawn real processes. */
export type ProcessStreamer = (invocation: Invocation, options: StreamOptions) => StreamRun;

const STDERR_TAIL = 4000;
const posix = process.platform !== 'win32';

/** A queue that an `AsyncIterable` reads while the process keeps pushing into it. */
class ChunkQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;
  private failure: Error | undefined;

  push(chunk: string): void {
    this.items.push(chunk);
    this.wake();
  }

  close(error?: Error): void {
    this.closed = true;
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const resume = this.waiting;
    this.waiting = undefined;
    resume?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

export const streamProcess: ProcessStreamer = (invocation, options) => {
  const queue = new ChunkQueue();
  // Empty values would hide a CLI's saved login.
  const env = Object.fromEntries(
    Object.entries({ ...options.env, ...invocation.env }).filter(
      ([, value]) => value !== undefined && value !== '',
    ),
  );
  const child = spawn(invocation.command, [...invocation.args], {
    cwd: options.cwd,
    env,
    ...(options.uid !== undefined ? { uid: options.uid, gid: options.gid ?? options.uid } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Its own process group, so a timeout or a cancel also stops what the CLI started.
    detached: posix,
  });

  let stopped: StreamExit['stopped'] = null;
  let gone = false;
  let stderr = '';
  let pending = '';
  const kill = (): void => {
    // After the process is gone its pid may belong to something else.
    if (gone || child.pid === undefined) return;
    try {
      process.kill(posix ? -child.pid : child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  };
  const stopFor = (why: 'timeout' | 'cancelled'): void => {
    stopped ??= why;
    kill();
  };

  const timer = setTimeout(() => stopFor('timeout'), options.timeoutMs);
  const onAbort = (): void => stopFor('cancelled');
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = (): void => {
    gone = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (!options.lines) return queue.push(chunk);
    const parts = (pending + chunk).split(/\r?\n/);
    pending = parts.pop() as string;
    for (const line of parts) if (line) queue.push(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });

  const exit = new Promise<StreamExit>((resolve) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      queue.close(
        new CliError(
          error.code === 'ENOENT'
            ? `"${invocation.command}" is not installed in this container.`
            : error.message,
        ),
      );
      resolve({ exitCode: 127, stderr: error.message, stopped });
    });
    child.on('close', (code) => {
      cleanup();
      if (pending) queue.push(pending);
      pending = '';
      queue.close();
      resolve({ exitCode: code ?? 1, stderr, stopped });
    });
  });

  child.stdin.on('error', () => undefined); // the CLI may exit before reading its input
  child.stdin.end(invocation.stdin ?? '');
  return { output: queue, exit, stop: kill };
};
