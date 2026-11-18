import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmPort, LlmRequest, LlmResponse } from '../../application/agent-ports.js';
import { cliEnvironment, startCli, type CliRun, type CliRunOptions } from './cli-process.js';
import {
  attachmentProblem,
  CLI_SPECS,
  isValidModelId,
  type CliId,
  type CliSpec,
} from './cli-specs.js';

export type CliLlmErrorCode =
  | 'NOT_INSTALLED'
  | 'NOT_AUTHENTICATED'
  | 'TIMEOUT'
  | 'UNSUPPORTED'
  | 'QUOTA_EXCEEDED'
  | 'BRIDGE_UNAVAILABLE'
  | 'FAILED';

/** A failure of a provider CLI, kept apart from HTTP errors so callers can explain it properly. */
export class CliLlmError extends Error {
  public constructor(
    public readonly code: CliLlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CliLlmError';
  }
}

export interface CliLlmOptions {
  readonly cli: CliId;
  /** A model the CLI understands. Left out, the CLI uses its own default. */
  readonly model?: string;
  /** Lets the CLI use the ADK's MCP tools, with this much of the user's access. */
  readonly mcpAccess?: 'standard' | 'read' | 'full';
  readonly timeoutMs?: number;
  /**
   * Where this CLI keeps its login, so one machine can hold several accounts of the same provider.
   * Left out, the CLI uses the login of the user that runs the API. Only Claude and Codex have one.
   */
  readonly configDir?: string;
  /** Replaced in tests. */
  readonly start?: (options: CliRunOptions) => CliRun;
  readonly platform?: NodeJS.Platform;
}

/** What a CLI run hands over: the text as it is written, and the usage once it is known. */
export type CliStreamItem =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly model?: string;
    };

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_CONCURRENT_RUNS = 4;

/** Reads a whole CLI run into one `LlmResponse`. Shared by the local and the Bridge transport. */
export async function collectCompletion(
  items: AsyncIterable<CliStreamItem>,
  provider: string,
  defaultModel?: string,
): Promise<LlmResponse> {
  let text = '';
  let usage: LlmResponse['usage'];
  let model = defaultModel;
  for await (const item of items) {
    if (item.type === 'delta') text += item.text;
    else {
      usage = { inputTokens: item.inputTokens, outputTokens: item.outputTokens };
      model = item.model ?? model;
    }
  }
  return { provider, text, ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}

/** CLIs are heavy processes: a burst of requests must queue instead of forking dozens of them. */
class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.active >= MAX_CONCURRENT_RUNS) {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          // Still queued (a woken waiter has already dropped this listener).
          this.waiting.splice(this.waiting.indexOf(wake), 1);
          reject(abortError(signal));
        };
        this.waiting.push(wake);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

const gate = new Gate();

function abortError(signal?: AbortSignal): Error {
  const error = new Error('The request was aborted.', { cause: signal?.reason });
  error.name = 'AbortError';
  return error;
}

/** The variable each CLI reads the folder of its login from. Gemini has none. */
const CONFIG_DIR_ENV: Readonly<Partial<Record<CliId, string>>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/** What shows the account a CLI is signed in with. */
const ACCOUNT_ARGS: Readonly<Partial<Record<CliId, readonly string[]>>> = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
};

// Control characters are rejected on purpose: this value ends up in a process environment.
// eslint-disable-next-line no-control-regex
const CONFIG_DIR = /^(?:[A-Za-z]:[\\/]|\/)[^\u0000-\u001f"'`$%|&;<>*?]{1,300}$/;

/** A folder given by a person ends up in a process environment: it must be an absolute, plain path. */
export function isValidConfigDir(dir: string): boolean {
  return CONFIG_DIR.test(dir) && !dir.split(/[\\/]/).includes('..');
}

/** Whether this CLI can be pointed at another login folder. */
export function supportsConfigDir(id: CliId): boolean {
  return CONFIG_DIR_ENV[id] !== undefined;
}

const QUOTA_FAILURE =
  /credit balance|insufficient (?:credit|quota|funds)|quota (?:exceeded|exhausted)|usage limit|rate limit|out of credits|billing|\b429\b/i;

const AUTH_FAILURE =
  /\/login|not logged in|log ?in|authenticat|unauthori[sz]ed|invalid api key|\b401\b/i;

function failureOf(spec: CliSpec, detail: string): CliLlmError {
  const message = detail.trim().slice(-800) || `${spec.label} CLI failed.`;
  if (QUOTA_FAILURE.test(message)) return new CliLlmError('QUOTA_EXCEEDED', message);
  return AUTH_FAILURE.test(message)
    ? new CliLlmError(
        'NOT_AUTHENTICATED',
        `${spec.label} CLI is not signed in on the server. Run \`${spec.command}\` there and log in. (${message})`,
      )
    : new CliLlmError('FAILED', message);
}

/**
 * An LLM that is a provider CLI (Claude Code, Codex, Gemini) instead of an HTTP API. It answers
 * the same `LlmPort` as the API-key providers, so agents, chats and generators use it unchanged;
 * the difference is only where the tokens come from, and that `stream()` is a real stream.
 */
export class CliLlmProvider implements LlmPort {
  public readonly provider: string;
  public readonly readsFiles = true;
  public readonly mcpAccess: 'standard' | 'read' | 'full' | undefined;
  private readonly spec: CliSpec;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private readonly configDir: string | undefined;
  private readonly start: (options: CliRunOptions) => CliRun;
  private readonly platform: NodeJS.Platform;

  public constructor(options: CliLlmOptions) {
    this.spec = CLI_SPECS[options.cli];
    this.provider = `${this.spec.label} CLI`;
    const model = options.model?.trim();
    if (model && !isValidModelId(model)) {
      throw new CliLlmError(
        'UNSUPPORTED',
        'The CLI model id contains characters that are not allowed.',
      );
    }
    this.model = model || undefined;
    const configDir = options.configDir?.trim();
    if (configDir && !isValidConfigDir(configDir)) {
      throw new CliLlmError(
        'UNSUPPORTED',
        'The CLI login folder must be an absolute path without special characters.',
      );
    }
    this.configDir = configDir && supportsConfigDir(options.cli) ? configDir : undefined;
    // A CLI whose MCP config lives in the user's HOME is not given tools here: writing that file
    // would change the HOME of whoever runs the API.
    this.mcpAccess = this.spec.mcp === 'inline' ? options.mcpAccess : undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.start = options.start ?? startCli;
    this.platform = options.platform ?? process.platform;
  }

  public async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    return collectCompletion(this.run(request, signal), this.provider, this.model);
  }

  public async *stream(request: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    for await (const item of this.run(request, signal)) {
      if (item.type === 'delta') yield item.text;
    }
  }

  private async *run(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<CliStreamItem> {
    const problem = attachmentProblem(this.spec, request);
    if (problem) throw new CliLlmError('UNSUPPORTED', problem);
    signal?.throwIfAborted();
    const release = await gate.acquire(signal);
    // An empty directory of its own: a CLI that looks around finds nothing of ADK's, and the
    // system prompt file (which can be long and free-form) never goes through a command line.
    const workdir = await mkdtemp(join(tmpdir(), 'adk-cli-'));
    let run: CliRun | undefined;
    try {
      const invocation = this.spec.build(
        {
          prompt: request.prompt,
          instruction: request.instruction,
          // Only a provider that was allowed tools hands the CLI an MCP server.
          ...(this.mcpAccess && request.mcp ? { mcp: request.mcp } : {}),
          ...(request.images?.length ? { images: request.images } : {}),
          ...(request.files?.length ? { files: request.files } : {}),
        },
        this.model,
      );
      for (const [name, content] of Object.entries(invocation.files)) {
        await writeFile(
          join(workdir, name),
          typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'),
        );
      }
      run = this.start({
        command: this.spec.command,
        args: invocation.args,
        stdin: invocation.stdin,
        cwd: workdir,
        env: cliEnvironment({
          ...invocation.env,
          ...configDirEnv(this.spec.id, this.configDir),
        }),
        ...(signal ? { signal } : {}),
        timeoutMs: this.timeoutMs,
        lines: this.spec.jsonLines,
        platform: this.platform,
      });

      const parse = this.spec.createParser();
      let produced = false;
      let final = '';
      let failure = '';
      try {
        for await (const chunk of run.output) {
          for (const event of parse(chunk)) {
            if (event.type === 'delta') {
              produced = true;
              yield event;
            } else if (event.type === 'final') final = event.text;
            else if (event.type === 'error') failure = event.message;
            else yield event;
          }
        }
      } catch (error) {
        if (isEnoent(error)) {
          throw new CliLlmError(
            'NOT_INSTALLED',
            `The ${this.spec.label} CLI ("${this.spec.command}") is not installed on the server.`,
          );
        }
        throw error;
      }

      const exit = await run.exit;
      if (exit.aborted) throw abortError(signal);
      if (exit.timedOut) {
        throw new CliLlmError(
          'TIMEOUT',
          `${this.spec.label} CLI timed out after ${Math.round(this.timeoutMs / 1000)}s.`,
        );
      }
      if (exit.exitCode === 127 || /not recognized|command not found|ENOENT/i.test(exit.stderr)) {
        throw new CliLlmError(
          'NOT_INSTALLED',
          `The ${this.spec.label} CLI ("${this.spec.command}") is not installed on the server.`,
        );
      }
      if (exit.exitCode !== 0 || (!produced && !final)) {
        throw failureOf(this.spec, failure || exit.stderr);
      }
      // A CLI that never streams (or a result with no deltas before it) still answers.
      if (!produced && final) yield { type: 'delta', text: final };
    } finally {
      run?.stop();
      release();
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function configDirEnv(id: CliId, configDir: string | undefined): Record<string, string> {
  const name = CONFIG_DIR_ENV[id];
  return name && configDir ? { [name]: configDir } : {};
}

function isEnoent(error: unknown): boolean {
  return /ENOENT|could not be started/.test(String(error));
}

export interface CliStatus {
  readonly id: CliId;
  readonly label: string;
  readonly command: string;
  readonly installed: boolean;
  readonly version?: string;
}

/** Whether a provider CLI can be started on this machine, and which version it reports. */
export async function detectCli(
  id: CliId,
  start: (options: CliRunOptions) => CliRun = startCli,
): Promise<CliStatus> {
  const spec = CLI_SPECS[id];
  const base = { id, label: spec.label, command: spec.command };
  const workdir = await mkdtemp(join(tmpdir(), 'adk-cli-'));
  try {
    const run = start({
      command: spec.command,
      args: spec.versionArgs,
      stdin: '',
      cwd: workdir,
      env: cliEnvironment(),
      timeoutMs: 10_000,
      lines: false,
    });
    let output = '';
    try {
      for await (const chunk of run.output) output += chunk;
    } catch {
      return { ...base, installed: false };
    }
    const exit = await run.exit;
    if (exit.exitCode !== 0) return { ...base, installed: false };
    const version = output.trim().split(/\r?\n/)[0]?.slice(0, 80);
    return { ...base, installed: true, ...(version ? { version } : {}) };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The account a CLI is signed in with (as the CLI itself reports it) when it uses `configDir`,
 * or its default login. Best effort: a CLI without such a command, or that fails, gives `null`.
 */
export async function cliAccount(
  id: CliId,
  configDir?: string,
  start: (options: CliRunOptions) => CliRun = startCli,
): Promise<string | null> {
  const args = ACCOUNT_ARGS[id];
  if (!args) return null;
  const spec = CLI_SPECS[id];
  const workdir = await mkdtemp(join(tmpdir(), 'adk-cli-'));
  try {
    const run = start({
      command: spec.command,
      args,
      stdin: '',
      cwd: workdir,
      env: cliEnvironment(configDirEnv(id, configDir)),
      timeoutMs: 15_000,
      lines: false,
    });
    let output = '';
    try {
      for await (const chunk of run.output) output += chunk;
    } catch {
      return null;
    }
    const exit = await run.exit;
    if (exit.exitCode !== 0) return null;
    return summarizeAccount(output);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Turns what an auth status command prints (JSON or text) into one short line. */
export function summarizeAccount(output: string): string | null {
  const text = output.trim();
  if (!text) return null;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const parts = [data['email'], data['orgName'] ?? data['organization'], data['subscriptionType']]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map((part) => part.slice(0, 80));
    if (parts.length) return parts.join(' · ');
  } catch {
    // plain text: use its first line
  }
  return text.split(/\r?\n/)[0]!.slice(0, 120);
}
