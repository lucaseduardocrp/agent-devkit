import { runProcess, type ProcessRunner } from './process-runner.js';
import { CliError, type CliAdapter, type CliOutput, type RunRequest } from './types.js';

/** The CLIs the bridge can drive, by id. */
export class CliRegistry {
  private readonly adapters = new Map<string, CliAdapter>();

  register(adapter: CliAdapter): this {
    if (this.adapters.has(adapter.id))
      throw new Error(`CLI "${adapter.id}" is already registered.`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  get(id: string): CliAdapter | undefined {
    return this.adapters.get(id.toLowerCase());
  }

  list(): CliAdapter[] {
    return [...this.adapters.values()];
  }
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** The complete environment of the CLI (the user's HOME and credentials). */
  readonly env?: NodeJS.ProcessEnv;
  readonly uid?: number;
  readonly gid?: number;
}

/** Runs a CLI adapter for a request: build the command, run it, read the answer. */
export class CliExecutor {
  constructor(private readonly options: { timeoutMs: number; run?: ProcessRunner }) {}

  async execute(
    adapter: CliAdapter,
    request: RunRequest,
    options: ExecuteOptions = {},
  ): Promise<CliOutput> {
    const result = await this.run()(adapter.buildInvocation(request), {
      cwd: request.cwd,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs,
      signal: options.signal,
      env: options.env,
      uid: options.uid,
      gid: options.gid,
    });
    return adapter.parseOutput(result);
  }

  /** The installed version, or null when the CLI is missing or broken. */
  async probe(adapter: CliAdapter, cwd: string): Promise<string | null> {
    try {
      const result = await this.run()(adapter.versionInvocation, { cwd, timeoutMs: 15_000 });
      if (result.exitCode !== 0) return null;
      return result.stdout.trim().split('\n')[0] || 'installed';
    } catch (error) {
      if (error instanceof CliError) return null;
      throw error;
    }
  }

  private run(): ProcessRunner {
    return this.options.run ?? runProcess;
  }
}
