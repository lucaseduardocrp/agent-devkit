import { spawn, type ChildProcess } from 'node:child_process';
import {
  SCRIPT_HOST_SOURCE,
  scriptChildArguments,
  scriptChildEnvironment,
} from './script-runtime.js';
import type { ScriptLog } from './types.js';

// Scripts are user code: they never run in the calling process. A child Node process with an
// empty environment, the permission model (no file system, child processes or workers), no code
// generation in its main realm and a memory cap runs them in a vm context; anything that needs
// the network (`adk.sendRequest`) goes back to the parent, which applies the run's guard and
// network settings. Everything the child sends back is treated as untrusted and re-validated.

export interface ScriptVariables {
  readonly environment: Readonly<Record<string, string>>;
  readonly collection: Readonly<Record<string, string>>;
  /** Set by captures and `adk.setVar`; kept for the user's next sends. */
  readonly runtime: Readonly<Record<string, string>>;
  readonly folder: Readonly<Record<string, string>>;
  readonly request: Readonly<Record<string, string>>;
  /** Columns of the current data row (data-driven runs). */
  readonly data: Readonly<Record<string, string>>;
}

export interface ScriptRequestView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Text of the body (JSON as text); undefined when there is none. */
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly authType: string;
}

export interface ScriptResponseView {
  readonly status: number | null;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
  readonly sizeBytes: number;
}

export interface ScriptInput {
  readonly phase: 'pre-request' | 'post-response' | 'tests';
  /** Label for logs and errors, e.g. `collection pre-request` or `request tests`. */
  readonly source: string;
  readonly code: string;
  readonly request: ScriptRequestView;
  readonly response?: ScriptResponseView;
  readonly variables: ScriptVariables;
  readonly environmentName?: string;
  readonly collectionName: string;
  readonly iteration?: { readonly index: number; readonly total: number };
}

export interface ScriptOutput {
  /** The request after the script (pre-request scripts may change it). */
  readonly request: ScriptRequestView;
  /** The variable sets after the script (full maps). */
  readonly variables: Pick<ScriptVariables, 'environment' | 'collection' | 'runtime' | 'request'>;
  readonly tests: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly error?: string;
  }[];
  readonly logs: readonly ScriptLog[];
  /** `adk.setNextRequest(name)`: undefined when not called, null to stop the run. */
  readonly nextRequest?: string | null;
  readonly skipRequest: boolean;
  readonly stopExecution: boolean;
  /** The script threw or timed out. */
  readonly error?: string;
}

/** What scripts may ask of the parent process. */
export interface ScriptHost {
  sendRequest(input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly timeoutMs?: number;
  }): Promise<{
    readonly status: number;
    readonly statusText: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly durationMs: number;
  }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_MB = 128;
const STARTUP_TIMEOUT_MS = 15_000;
// The child stops a synchronous loop itself (keeping the outputs so far); the parent's kill is the
// backstop for everything else, so it waits a little longer than the child's own timeout.
const KILL_GRACE_MS = 500;
const MAX_SENDS_PER_SCRIPT = 100;
const LIMITS = {
  logs: 200,
  logSize: 10_000,
  tests: 500,
  name: 1_000,
  error: 10_000,
  entries: 2_000,
  key: 1_000,
  value: 1_000_000,
  url: 65_536,
  method: 32,
  body: 10_000_000,
} as const;
const LOG_LEVELS: ReadonlySet<string> = new Set(['log', 'info', 'warn', 'error', 'debug']);

type Message = Readonly<Record<string, unknown>>;

interface Child {
  readonly process: ChildProcess;
  readonly ready: Promise<void>;
  stderr: string;
  exited: boolean;
  onMessage?: (message: Message) => void;
  onExit?: () => void;
}

/** One isolated child process per run, reused by every script of the run. */
export class ScriptSandbox {
  readonly #host: ScriptHost;
  readonly #timeoutMs: number;
  readonly #memoryMb: number;
  #child?: Child;
  #queue: Promise<unknown> = Promise.resolve();
  #sequence = 0;
  #closed = false;

  constructor(options: {
    readonly host: ScriptHost;
    /** Per script; 10 s by default. */
    readonly timeoutMs?: number;
    /** Heap of the child process; 128 MB by default. */
    readonly memoryMb?: number;
  }) {
    this.#host = options.host;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#memoryMb = options.memoryMb ?? DEFAULT_MEMORY_MB;
  }

  /** Scripts of a run are executed one at a time, in call order. */
  run(input: ScriptInput): Promise<ScriptOutput> {
    const next = this.#queue.then(() => this.#execute(input));
    this.#queue = next;
    return next;
  }

  close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    if (!child || child.exited) return Promise.resolve();
    this.#child = undefined;
    return new Promise((resolve) => {
      child.process.once('exit', () => resolve());
      child.process.kill('SIGKILL');
    });
  }

  async #execute(input: ScriptInput): Promise<ScriptOutput> {
    if (this.#closed) return failed(input, 'Script sandbox is closed');
    let child: Child;
    try {
      child = this.#ensureChild();
      await child.ready;
    } catch (error) {
      // `ready` only rejects with the Errors created below.
      return failed(input, (error as Error).message);
    }
    const id = ++this.#sequence;
    return new Promise((resolve) => {
      let sends = 0;
      const finish = (output: ScriptOutput) => {
        clearTimeout(timer);
        child.onMessage = undefined;
        child.onExit = undefined;
        resolve(output);
      };
      const timer = setTimeout(() => {
        this.#discard(child);
        finish(failed(input, `Script timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs + KILL_GRACE_MS);
      child.onExit = () => finish(failed(input, this.#exitReason(child)));
      child.onMessage = (message) => {
        if (message.id !== id) return;
        if (message.type === 'done') finish(readOutput(input, message));
        else if (message.type === 'send') void this.#relay(child, id, message, ++sends);
      };
      child.process.send({ type: 'run', id, input, timeoutMs: this.#timeoutMs }, ignore);
    });
  }

  #ensureChild(): Child {
    if (this.#child && !this.#child.exited) return this.#child;
    const process_ = spawn(process.execPath, scriptChildArguments(this.#memoryMb), {
      env: scriptChildEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let markReady: () => void = ignore;
    let markFailed: (error: Error) => void = ignore;
    const child: Child = {
      process: process_,
      ready: new Promise<void>((resolve, reject) => {
        markReady = resolve;
        markFailed = reject;
      }),
      stderr: '',
      exited: false,
    };
    // Rejections are read by `await child.ready`; avoid an unhandled one for an idle child.
    child.ready.catch(ignore);
    const startup = setTimeout(() => {
      markFailed(new Error('Script sandbox did not start'));
      this.#discard(child);
    }, STARTUP_TIMEOUT_MS);
    process_.stderr?.on('data', (chunk: Buffer) => {
      child.stderr = (child.stderr + chunk.toString()).slice(-8_000);
    });
    process_.on('message', (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === 'ready') {
        clearTimeout(startup);
        if (message.isolated === true) markReady();
        else {
          markFailed(new Error('Script sandbox could not enable the Node.js permission model'));
          this.#discard(child);
        }
        return;
      }
      child.onMessage?.(message);
    });
    const onExit = () => {
      /* v8 ignore next -- Node may emit 'exit' after 'error' (a failed spawn or kill); only the first counts. */
      if (child.exited) return;
      child.exited = true;
      clearTimeout(startup);
      if (this.#child === child) this.#child = undefined;
      markFailed(new Error(this.#exitReason(child)));
      child.onExit?.();
    };
    process_.on('exit', onExit);
    process_.on('error', onExit);
    // An idle sandbox must not keep the caller's process alive; runs hold their own timers.
    process_.unref();
    (process_.channel as { unref?: () => void } | undefined)?.unref?.();
    (process_.stderr as { unref?: () => void } | null)?.unref?.();
    process_.send({ source: SCRIPT_HOST_SOURCE }, ignore);
    this.#child = child;
    return child;
  }

  #discard(child: Child): void {
    // Runs are serialized through #queue, so the child being discarded is always the current
    // one; this only guards against a close() that already cleared it concurrently.
    /* v8 ignore next */
    if (this.#child === child) this.#child = undefined;
    child.process.kill('SIGKILL');
  }

  #exitReason(child: Child): string {
    if (/heap out of memory|Allocation failed/i.test(child.stderr)) {
      return `Script ran out of memory (limit ${this.#memoryMb} MB)`;
    }
    return 'Script process exited unexpectedly';
  }

  async #relay(child: Child, id: number, message: Message, count: number): Promise<void> {
    let reply: Record<string, unknown>;
    const request = readSendRequest(message.request);
    if (count > MAX_SENDS_PER_SCRIPT) {
      reply = { error: `A script may send at most ${MAX_SENDS_PER_SCRIPT} requests` };
    } else if (!request) {
      reply = { error: 'Invalid request: method and url are required' };
    } else {
      try {
        const response = await this.#host.sendRequest(request);
        reply = {
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: { ...response.headers },
            body: response.body.slice(0, LIMITS.body),
            durationMs: response.durationMs,
          },
        };
      } catch (error) {
        reply = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!child.exited && child.process.connected) {
      child.process.send(
        { type: 'send-result', id, requestId: message.requestId, ...reply },
        ignore,
      );
    }
  }
}

function ignore(): void {}

function isRecord(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

/** A record of strings from the child, bounded in size. */
function readRecord(
  value: unknown,
  limit: number = LIMITS.value,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .slice(0, LIMITS.entries)
    .map(([key, item]) => [key.slice(0, LIMITS.key), item.slice(0, limit)] as const);
  // fromEntries defines own properties, so a `__proto__` key cannot change a prototype.
  return Object.fromEntries(entries);
}

function readSendRequest(value: unknown): Parameters<ScriptHost['sendRequest']>[0] | undefined {
  if (!isRecord(value)) return undefined;
  const method = text(value.method, LIMITS.method);
  const url = text(value.url, LIMITS.url);
  if (!method || !url) return undefined;
  const body = text(value.body, LIMITS.body);
  const timeoutMs =
    typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
      ? value.timeoutMs
      : undefined;
  return {
    method,
    url,
    headers: readRecord(value.headers, LIMITS.url) ?? {},
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function readRequest(input: ScriptInput, value: unknown): ScriptRequestView {
  // Only pre-request scripts may change the request.
  if (input.phase !== 'pre-request' || !isRecord(value)) return input.request;
  const body = text(value.body, LIMITS.body);
  const timeoutMs =
    typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs >= 0
      ? value.timeoutMs
      : undefined;
  const { body: _body, timeoutMs: _timeout, ...rest } = input.request;
  return {
    ...rest,
    method: text(value.method, LIMITS.method) || input.request.method,
    url: text(value.url, LIMITS.url) ?? input.request.url,
    headers: readRecord(value.headers, LIMITS.url) ?? input.request.headers,
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function readTests(value: unknown): ScriptOutput['tests'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .slice(0, LIMITS.tests)
    .map((test) => {
      const error = text(test.error, LIMITS.error);
      return {
        name: text(test.name, LIMITS.name) ?? '',
        passed: test.passed === true,
        ...(error === undefined ? {} : { error }),
      };
    });
}

function readLogs(source: string, value: unknown): ScriptLog[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .slice(0, LIMITS.logs)
    .map((log) => ({
      level: (LOG_LEVELS.has(log.level as string) ? log.level : 'log') as ScriptLog['level'],
      message: text(log.message, LIMITS.logSize + 100) ?? '',
      source,
    }));
}

function readOutput(input: ScriptInput, message: Message): ScriptOutput {
  const output = isRecord(message.output) ? message.output : {};
  const variables = isRecord(output.variables) ? output.variables : {};
  const error = text(message.error, LIMITS.error);
  const next =
    output.hasNextRequest === true
      ? {
          nextRequest:
            output.nextRequest === null ? null : (text(output.nextRequest, LIMITS.name) ?? null),
        }
      : {};
  return {
    request: readRequest(input, output.request),
    variables: {
      environment: readRecord(variables.environment) ?? input.variables.environment,
      collection: readRecord(variables.collection) ?? input.variables.collection,
      runtime: readRecord(variables.runtime) ?? input.variables.runtime,
      request: readRecord(variables.request) ?? input.variables.request,
    },
    tests: readTests(output.tests),
    logs: readLogs(input.source, output.logs),
    ...next,
    skipRequest: output.skipRequest === true,
    stopExecution: output.stopExecution === true,
    ...(error === undefined ? {} : { error: `${input.source}: ${error}` }),
  };
}

/** Output of a script that never reported back: the input unchanged plus the error. */
function failed(input: ScriptInput, error: string): ScriptOutput {
  return readOutput(input, { error });
}
