import { pbkdf2Sync } from 'node:crypto';
import { chmodSync, chownSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliRegistry, type CliExecutor } from '../core/cli-registry.js';
import { createStreamRedactor, redactSecrets, SECURITY_POLICY } from '../core/guard.js';
import type { ProcessStreamer, StreamRun } from '../core/stream-process.js';
import { CliError } from '../core/types.js';
import {
  attachmentProblem,
  CLI_SPECS,
  isValidMcpServer,
  isValidModelId,
  type CliFile,
  type CliId,
  type CliImage,
} from '../vendor/cli-specs.js';
import type { CredentialStore } from './credential-store.js';
import type { Sandbox } from './sandbox.js';

export type LlmErrorCode =
  'NOT_INSTALLED' | 'NOT_AUTHENTICATED' | 'TIMEOUT' | 'UNSUPPORTED' | 'FAILED';

/** A failure the ADK API can show its user. The message never holds a secret. */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmInput {
  readonly workspaceId: string;
  readonly cli: string;
  readonly prompt: string;
  readonly instruction?: string;
  readonly model?: string;
  /** The workspace's token for this CLI. Optional once it has been given before. */
  readonly credential?: string;
  /** The ADK's MCP server for this run: the CLI uses its tools as the user who asked. */
  readonly mcp?: { readonly name: string; readonly url: string; readonly token: string };
  /** Images and files that go with the prompt, as base64. */
  readonly images?: readonly CliImage[];
  readonly files?: readonly CliFile[];
}

export type LlmEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly model?: string;
    };

export interface LlmCliStatus {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly installed: boolean;
  readonly version?: string;
  /** Whether this workspace already handed over a token for the CLI. */
  readonly signedIn: boolean;
  /** Where the user gets the token the CLI accepts. */
  readonly hint?: string;
}

export interface LlmHostOptions {
  readonly registry: CliRegistry;
  readonly executor: CliExecutor;
  readonly sandbox: Sandbox;
  readonly credentials: CredentialStore;
  readonly stream: ProcessStreamer;
  readonly timeoutMs: number;
  /** Secrets of the bridge itself, masked in anything that leaves (its tokens and keys). */
  readonly ownSecrets: () => readonly string[];
}

const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CONCURRENT_RUNS = 4;
const AUTH_FAILURE =
  /\/login|not logged in|log ?in|authenticat|unauthori[sz]ed|invalid api key|\b401\b/i;

/** CLIs are heavy: a burst of requests queues here instead of forking dozens of them. */
class Gate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    while (this.active >= MAX_CONCURRENT_RUNS) {
      await new Promise<void>((resolve, reject) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          // Still queued (a woken waiter has already dropped this listener).
          this.waiting.splice(this.waiting.indexOf(wake), 1);
          reject(cancelled());
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

function cancelled(): Error {
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Answers the ADK's LLM requests with the AI CLIs installed here. Each workspace is an identity
 * of its own: private HOME, OS user and login, kept apart from every Telegram user and from every
 * other workspace. The CLI runs with no tools it could harm anything with (see the specs), in an
 * empty directory, and what it writes is masked for secrets before it leaves.
 */
export class LlmHost {
  private readonly gate = new Gate();

  constructor(private readonly options: LlmHostOptions) {}

  private specFor(cli: string): {
    id: CliId;
    adapter: NonNullable<ReturnType<CliRegistry['get']>>;
  } {
    const adapter = this.options.registry.get(cli);
    const spec = (CLI_SPECS as Record<string, unknown>)[cli.toLowerCase()];
    if (!adapter || !spec) throw new LlmError('UNSUPPORTED', `"${cli}" cannot answer for the ADK.`);
    return { id: adapter.id as CliId, adapter };
  }

  private identityOf(workspaceId: string): string {
    if (!WORKSPACE_ID.test(workspaceId))
      throw new LlmError('UNSUPPORTED', 'The workspace id is not valid.');
    return `llm:${workspaceId}`;
  }

  /** The CLIs that can answer, whether each is installed, and whether the workspace has a token. */
  async clis(workspaceId: string): Promise<LlmCliStatus[]> {
    const identity = this.identityOf(workspaceId);
    const runtime = this.options.sandbox.resolve(identity, 'claude');
    const statuses: LlmCliStatus[] = [];
    for (const id of Object.keys(CLI_SPECS) as CliId[]) {
      const adapter = this.options.registry.get(id);
      if (!adapter) continue;
      const version = await this.options.executor.probe(adapter, runtime.cwd);
      statuses.push({
        id,
        label: CLI_SPECS[id].label,
        command: CLI_SPECS[id].command,
        installed: version !== null,
        ...(version ? { version } : {}),
        signedIn: this.options.credentials.has(identity, id),
        ...(adapter.auth ? { hint: adapter.auth.hint } : {}),
      });
    }
    return statuses;
  }

  /** Stores the workspace's token for the CLI, replacing the previous one when it changed. */
  private applyCredential(identity: string, id: CliId, secret: string | undefined): void {
    const { credentials, sandbox } = this.options;
    const adapter = this.options.registry.get(id)!;
    if (secret?.trim()) {
      const credential = adapter.auth?.classify(secret.trim());
      if (!credential) {
        throw new LlmError(
          'NOT_AUTHENTICATED',
          `That is not a token ${CLI_SPECS[id].label} accepts. ${adapter.auth?.hint ?? ''}`.trim(),
        );
      }
      const fingerprint = pbkdf2Sync(
        secret.trim(),
        `llm-fingerprint:${identity}:${id}`,
        210_000,
        32,
        'sha256',
      ).toString('hex');
      if (credentials.getFingerprint(identity, id) !== fingerprint) {
        credentials.clear(identity, id);
        // A login file is written once and then kept fresh by the CLI: drop the old one.
        if (credential.kind === 'file') sandbox.forget(identity, credential.path);
        credentials.set(identity, id, credential);
        credentials.setFingerprint(identity, id, fingerprint);
      }
    }
    if (!credentials.has(identity, id)) {
      throw new LlmError(
        'NOT_AUTHENTICATED',
        `This workspace has no ${CLI_SPECS[id].label} token yet. ${adapter.auth?.hint ?? ''}`.trim(),
      );
    }
  }

  async *stream(input: LlmInput, signal?: AbortSignal): AsyncGenerator<LlmEvent> {
    const { credentials, sandbox } = this.options;
    const identity = this.identityOf(input.workspaceId);
    const { id, adapter } = this.specFor(input.cli);
    const spec = CLI_SPECS[id];
    if (input.mcp && !isValidMcpServer(input.mcp))
      throw new LlmError('UNSUPPORTED', 'The MCP server is not valid.');
    const model = input.model?.trim() || undefined;
    if (model && !isValidModelId(model))
      throw new LlmError('UNSUPPORTED', 'The model id contains characters that are not allowed.');
    const problem = attachmentProblem(spec, input);
    if (problem) throw new LlmError('UNSUPPORTED', problem);
    this.applyCredential(identity, id, input.credential);
    signal?.throwIfAborted();

    const release = await this.gate.acquire(signal);
    // A CLI that reads its MCP servers from a file in its HOME (Gemini) gets that file here, in
    // this workspace's own HOME, rewritten on every run so a run without tools has none left.
    const managedFiles =
      spec.mcp === 'home' ? adapter.mcpFiles?.(input.mcp ? [input.mcp] : []) : undefined;
    const runtime = sandbox.resolve(identity, id, managedFiles);
    // An empty directory of its own, so a CLI that looks around finds nothing but its prompt file.
    const workdir = mkdtempSync(join(runtime.cwd, 'llm-'));
    let run: StreamRun | undefined;
    try {
      const own = (path: string, mode: number): void => {
        chmodSync(path, mode);
        if (runtime.uid !== undefined) chownSync(path, runtime.uid, runtime.gid ?? runtime.uid);
      };
      own(workdir, 0o700);
      // The standing rules against prompt injection go with every run, ahead of the agent's own.
      const instruction = [SECURITY_POLICY, input.instruction?.trim()].filter(Boolean).join('\n\n');
      const invocation = spec.build(
        {
          prompt: input.prompt,
          instruction,
          ...(input.mcp ? { mcp: input.mcp } : {}),
          ...(input.images?.length ? { images: input.images } : {}),
          ...(input.files?.length ? { files: input.files } : {}),
        },
        model,
      );
      for (const [name, content] of Object.entries(invocation.files)) {
        const file = join(workdir, name);
        writeFileSync(
          file,
          typeof content === 'string' ? content : Buffer.from(content.base64, 'base64'),
        );
        own(file, 0o600);
      }
      run = this.options.stream(
        {
          command: spec.command,
          args: invocation.args,
          stdin: invocation.stdin,
          // Claude strips its own credentials from the environment of the commands it runs.
          env: {
            ...(id === 'claude' ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}),
            ...invocation.env,
          },
        },
        {
          cwd: workdir,
          env: runtime.env,
          uid: runtime.uid,
          gid: runtime.gid,
          timeoutMs: this.options.timeoutMs,
          signal,
          lines: spec.jsonLines,
        },
      );

      const secrets = [
        ...credentials.secretsOf(identity),
        ...this.options.ownSecrets(),
        ...(input.mcp ? [input.mcp.token] : []),
      ];
      const redactor = createStreamRedactor(secrets);
      const parse = spec.createParser();
      let produced = false;
      let final = '';
      let failure = '';
      try {
        for await (const chunk of run.output) {
          for (const event of parse(chunk)) {
            if (event.type === 'delta') {
              produced = true;
              const safe = redactor.push(event.text);
              if (safe) yield { type: 'delta', text: safe };
            } else if (event.type === 'final') final = event.text;
            else if (event.type === 'error') failure = event.message;
            else yield event;
          }
        }
      } catch (error) {
        // Only the runner throws here: the CLI could not be started.
        if (error instanceof CliError && /not installed/.test(error.message))
          throw new LlmError('NOT_INSTALLED', error.message);
        throw error;
      }

      const exit = await run.exit;
      if (exit.stopped === 'cancelled') throw cancelled();
      if (exit.stopped === 'timeout') {
        throw new LlmError(
          'TIMEOUT',
          `${spec.label} CLI timed out after ${Math.round(this.options.timeoutMs / 1000)}s.`,
        );
      }
      if (exit.exitCode !== 0 || (!produced && !final)) {
        throw failureOf(spec.label, redactSecrets(failure || exit.stderr, secrets).text);
      }
      // A CLI that never streams (or a result with no deltas before it) still answers.
      const rest = (!produced && final ? redactor.push(final) : '') + redactor.flush();
      if (rest) yield { type: 'delta', text: rest };
    } finally {
      run?.stop();
      release();
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}

function failureOf(label: string, detail: string): LlmError {
  const message = detail.trim().slice(-800) || `${label} CLI failed.`;
  return AUTH_FAILURE.test(message)
    ? new LlmError(
        'NOT_AUTHENTICATED',
        `${label} CLI could not sign in with the workspace token. (${message})`,
      )
    : new LlmError('FAILED', message);
}
