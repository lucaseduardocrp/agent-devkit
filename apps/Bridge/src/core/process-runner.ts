import { spawn } from 'node:child_process';
import { CliError, type Invocation, type ProcessResult } from './types.js';

export interface ProcessOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Output kept per stream; the rest is dropped so a runaway CLI cannot fill the memory. */
  readonly maxOutputBytes?: number;
  /** The whole environment of the process. Defaults to `safeEnv()`, never to the container's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Run as this OS user (needs the bridge to be root). */
  readonly uid?: number;
  readonly gid?: number;
}

/** What a CLI inherits from the container: nothing that holds a secret. */
const SAFE_ENV = [
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  // Windows needs these to start any process (development only).
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'TEMP',
  'TMP',
];

export function safeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SAFE_ENV) if (source[name]) env[name] = source[name]!;
  return env;
}

/** Runs one invocation. Injected into the executor so tests do not spawn real processes. */
export type ProcessRunner = (
  invocation: Invocation,
  options: ProcessOptions,
) => Promise<ProcessResult>;

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const posix = process.platform !== 'win32';

export const runProcess: ProcessRunner = (invocation, options) =>
  new Promise((resolve, reject) => {
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    // Empty values would hide a CLI's saved login.
    const env = Object.fromEntries(
      Object.entries({ ...(options.env ?? safeEnv()), ...invocation.env }).filter(
        ([, value]) => value !== undefined && value !== '',
      ),
    );
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: options.cwd,
      env,
      ...(options.uid !== undefined ? { uid: options.uid, gid: options.gid ?? options.uid } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so a timeout or /cancel also stops what the CLI started.
      detached: posix,
    });

    let stdout = '';
    let stderr = '';
    let reason: string | null = null;
    const collect = (current: string, chunk: Buffer): string =>
      current.length >= limit ? current : current + chunk.toString('utf8');
    child.stdout.on('data', (chunk: Buffer) => (stdout = collect(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = collect(stderr, chunk)));

    const stop = (why: string): void => {
      if (reason) return;
      reason = why;
      killTree(child.pid);
    };
    const timer = setTimeout(
      () => stop(`Timed out after ${Math.round(options.timeoutMs / 1000)} s.`),
      options.timeoutMs,
    );
    const onAbort = (): void => stop('Cancelled.');
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish();
      reject(
        new CliError(
          error.code === 'ENOENT'
            ? `"${invocation.command}" is not installed in this container.`
            : error.message,
        ),
      );
    });
    child.on('close', (code) => {
      finish();
      if (reason) reject(new CliError(reason));
      else resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.stdin.on('error', () => undefined); // the CLI may exit before reading its input
    child.stdin.end(invocation.stdin ?? '');
  });

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    // A negative pid signals the whole group created by `detached`.
    process.kill(posix ? -pid : pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}
