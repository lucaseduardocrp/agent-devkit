import { spawn } from 'node:child_process';

export interface CliRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** The prompt. It always travels through stdin, so it never needs shell quoting. */
  readonly stdin: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  /** `true` hands over complete lines (JSONL); `false` hands over raw stdout chunks. */
  readonly lines: boolean;
  readonly platform?: NodeJS.Platform;
  /** Replaced in tests, to see how the process is started and stopped on any platform. */
  readonly spawnProcess?: typeof spawn;
  readonly kill?: (pid: number) => void;
}

export interface CliExit {
  readonly exitCode: number;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface CliRun {
  /** Stdout as it is written. Ends when the process closes, and throws if it cannot start. */
  readonly output: AsyncIterable<string>;
  /** Resolves (never rejects) when the process is gone. */
  readonly exit: Promise<CliExit>;
  /** Stops the process tree. Safe to call at any time. */
  readonly stop: () => void;
}

const STDERR_TAIL = 4000;

/** Variables a provider CLI needs to find its own login; nothing from ADK's configuration. */
const ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
] as const;

/**
 * The environment of a provider CLI. It is built from an allowlist on purpose: the API process
 * holds the database URL, the encryption key and API keys, and a CLI has no business with them.
 * Provider API keys are left out too, so a CLI keeps using the user's subscription login instead
 * of silently switching to metered billing.
 */
export function cliEnvironment(
  extra: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

/** Stops a process and everything it started. */
export function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawn = spawn,
  signal: (pid: number, signal: NodeJS.Signals) => void = process.kill.bind(process),
): void {
  if (platform === 'win32') {
    const killer = run('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => undefined);
    return;
  }
  try {
    // The child leads its own process group (see `detached` below): the negative pid reaches all.
    signal(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Command and arguments are fixed flags, file names and a validated model id: nothing else. */
const SAFE_ARGUMENT = /^[A-Za-z0-9_.:/\\[\]=,@+?&~-]*$/;

export function assertSafeArgument(argument: string): void {
  if (!SAFE_ARGUMENT.test(argument)) {
    throw new Error('A CLI argument contains characters that are not allowed.');
  }
}

/** A queue that an `AsyncIterable` can read while a producer keeps pushing into it. */
class ChunkQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private waiting: (() => void) | undefined;
  private closed = false;
  private failure: Error | undefined;

  public push(chunk: string): void {
    this.items.push(chunk);
    this.wake();
  }

  public close(error?: Error): void {
    this.closed = true;
    this.failure = error;
    this.wake();
  }

  private wake(): void {
    const resume = this.waiting;
    this.waiting = undefined;
    resume?.();
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<string> {
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

/**
 * Starts a provider CLI and exposes its stdout as it is produced. This is the one place that
 * spawns a process for the LLM adapters, so the safety rules live here: no shell metacharacters
 * reach a command line (the caller only passes fixed or validated arguments), the environment is
 * an allowlist, and the whole process tree dies on abort or timeout.
 */
export function startCli(options: CliRunOptions): CliRun {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? spawn;
  const kill = options.kill ?? ((pid: number) => killTree(pid, platform));
  const queue = new ChunkQueue();
  let timedOut = false;
  let aborted = false;
  let stderr = '';
  let pending = '';
  let stopped = false;

  for (const argument of [options.command, ...options.args]) assertSafeArgument(argument);
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    detached: platform !== 'win32',
    windowsHide: true,
  };
  // npm installs CLIs on Windows as .cmd shims, which only a shell can start. There the command
  // line is built here, every part quoted, because Node joins shell arguments without quoting
  // (an empty argument would vanish). Arguments were checked above, so nothing can break out.
  const child =
    platform === 'win32'
      ? spawnProcess([options.command, ...options.args].map((part) => `"${part}"`).join(' '), {
          ...spawnOptions,
          shell: true,
        })
      : spawnProcess(options.command, [...options.args], spawnOptions);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (child.pid !== undefined) kill(child.pid);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    stop();
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    if (!options.lines) {
      queue.push(chunk);
      return;
    }
    const parts = (pending + chunk).split(/\r?\n/);
    pending = parts.pop() as string;
    for (const line of parts) if (line) queue.push(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });

  const exit = new Promise<CliExit>((resolve) => {
    const finish = (exitCode: number): void => {
      // Past this point the pid may belong to another process: stop() must not touch it.
      stopped = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (pending) queue.push(pending);
      pending = '';
      queue.close();
      resolve({ exitCode, stderr, timedOut, aborted });
    };
    child.on('error', (error) => {
      stopped = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      queue.close(new Error(`"${options.command}" could not be started: ${error.message}`));
      resolve({ exitCode: 127, stderr: error.message, timedOut, aborted });
    });
    child.on('close', (code) => finish(code ?? 1));
  });

  // A CLI that exits early closes its stdin; that failure shows up as its exit code instead.
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.stdin);

  return { output: queue, exit, stop };
}
