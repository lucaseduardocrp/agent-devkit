import { spawn } from 'node:child_process';

export interface StreamOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly onLine: (line: string) => void;
  /** Overridden in tests; decides whether the command goes through the shell. */
  readonly platform?: NodeJS.Platform;
  readonly kill?: (pid: number) => void;
}

export interface StreamResult {
  readonly exitCode: number;
  /** The end of what the process wrote to stderr, for the failure message. */
  readonly stderr: string;
}

const STDERR_TAIL = 4000;

/** Stops a process and everything it started. */
export function killTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: readonly string[]) => unknown = spawn,
  signal: (pid: number) => void = process.kill.bind(process),
): void {
  if (platform === 'win32') {
    run('taskkill', ['/pid', String(pid), '/T', '/F']);
    return;
  }
  try {
    // The process leads its own group (see `detached` below): the negative pid reaches all of it.
    signal(-pid);
  } catch {
    // Already gone.
  }
}

/**
 * Runs a command and hands over its output line by line while it runs. Aborting the signal stops
 * the whole process tree. A missing command rejects; any exit code resolves.
 */
export function runStreaming(
  command: string,
  args: readonly string[],
  options: StreamOptions,
): Promise<StreamResult> {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? ((pid: number) => killTree(pid, platform));
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // npm installs CLIs on Windows as .cmd files, which only the shell can start.
      shell: platform === 'win32',
      detached: platform !== 'win32',
      windowsHide: true,
    });
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop()!;
      for (const line of lines) options.onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const stop = () => kill(child.pid!);
    if (options.signal?.aborted) stop();
    options.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', stop);
      reject(new Error(`"${command}" could not be started: ${error.message}`));
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', stop);
      if (pending) options.onLine(pending);
      /* v8 ignore next -- a process killed by a signal has no code; which one applies depends on the OS */
      resolve({ exitCode: code ?? 1, stderr });
    });
    // A CLI that exits early closes its stdin; that failure shows up as its exit code instead.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.stdin ?? '');
  });
}
