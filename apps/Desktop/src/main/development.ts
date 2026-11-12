import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Autonomy } from '../vendor/development/agent-clis.js';
import type { Git } from '../vendor/development/git.js';
import {
  DevelopmentRunner,
  formatDevelopmentEvent,
  statusOf,
  type DevelopmentRunnerOptions,
  type RunAgent,
  type RunnerApi,
} from '../vendor/development/runner.js';

/** Who the app executes sessions for: the person signed in to the web app in this window. */
export interface Credentials {
  readonly token: string;
  readonly workspaceId: string | null;
}

/** Where a session runs on this computer. */
export interface Assignment {
  /** The repository the session's worktree is created from. */
  readonly repoPath: string;
  readonly autonomy: Autonomy;
  /** Set once the worktree exists on disk. */
  readonly worktreePath: string | null;
}

export interface Preferences {
  readonly lastRepoPath: string | null;
  readonly autonomy: Autonomy;
}

interface State extends Preferences {
  readonly assignments: Readonly<Record<string, Assignment>>;
}

export class ApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const isAutonomy = (value: unknown): value is Autonomy => value === 'safe' || value === 'auto';
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** Reads what was saved, dropping anything that is not in the expected shape. */
export function parseState(raw: string): State {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) saved = parsed as Record<string, unknown>;
  } catch {
    // A damaged file starts over.
  }
  const assignments: Record<string, Assignment> = {};
  const entries =
    typeof saved['assignments'] === 'object' && saved['assignments'] !== null
      ? Object.entries(saved['assignments'] as Record<string, unknown>)
      : [];
  for (const [id, value] of entries) {
    const item = (typeof value === 'object' && value !== null ? value : {}) as Record<
      string,
      unknown
    >;
    const repoPath = text(item['repoPath']);
    if (repoPath)
      assignments[id] = {
        repoPath,
        autonomy: isAutonomy(item['autonomy']) ? item['autonomy'] : 'safe',
        worktreePath: text(item['worktreePath']),
      };
  }
  return {
    assignments,
    lastRepoPath: text(saved['lastRepoPath']),
    autonomy: isAutonomy(saved['autonomy']) ? saved['autonomy'] : 'safe',
  };
}

/** The ADK API of this computer, called as the signed-in person. */
export function createApi(
  baseUrl: () => string,
  credentials: () => Credentials | undefined,
  fetcher: typeof fetch = fetch,
): RunnerApi {
  return {
    async request<T>(request: Parameters<RunnerApi['request']>[0]): Promise<T> {
      const current = credentials();
      if (!current) throw new ApiError(401, 'Not signed in.');
      const url = new URL(request.path, `${baseUrl()}/`);
      for (const [name, value] of Object.entries(request.query ?? {}))
        url.searchParams.set(name, value);
      const response = await fetcher(url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${current.token}`,
          ...(current.workspaceId ? { 'x-workspace-id': current.workspaceId } : {}),
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
      const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
      if (!response.ok)
        throw new ApiError(response.status, text(body?.message) ?? `HTTP ${response.status}`);
      return body as T;
    },
  };
}

export interface DevelopmentHostOptions {
  readonly apiUrl: () => string;
  /** Where the assignments are remembered between launches. */
  readonly stateFile: string;
  /** Shown in ADK as who is working on the session. */
  readonly runnerName: string;
  readonly git: Pick<Git, 'root' | 'ensureWorktree' | 'diff'>;
  readonly runAgent: RunAgent;
  readonly log: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly createRunner?: (options: DevelopmentRunnerOptions) => Pick<DevelopmentRunner, 'poll'>;
}

/** Worktrees go next to the repository, never inside it: the same place `devkit develop` uses. */
export const worktreesDir = (repoPath: string): string =>
  join(dirname(repoPath), '.adk-worktrees', basename(repoPath));

/**
 * Executes the Development sessions of the signed-in person on this computer, so the desktop app
 * needs no `devkit develop`: each session is given a repository folder, and whenever it is in
 * the queue (first run, retry or changes requested) the runner of the CLI is started for it.
 */
export class DevelopmentHost {
  private state: State = parseState('');
  private credentials: Credentials | undefined;
  private readonly api: RunnerApi;
  private readonly active = new Map<string, AbortController>();
  private ticking = false;

  public constructor(private readonly options: DevelopmentHostOptions) {
    this.api = createApi(options.apiUrl, () => this.credentials, options.fetch);
  }

  public async load(): Promise<void> {
    this.state = parseState(await readFile(this.options.stateFile, 'utf8').catch(() => ''));
  }

  private async save(state: State): Promise<void> {
    this.state = state;
    await mkdir(dirname(this.options.stateFile), { recursive: true });
    await writeFile(this.options.stateFile, JSON.stringify(state, null, 2), 'utf8');
  }

  /** Signs the runner in as the person using the window; `undefined` signs it out. */
  public connect(credentials: Credentials | undefined): void {
    this.credentials = credentials;
  }

  public preferences(): Preferences {
    return { lastRepoPath: this.state.lastRepoPath, autonomy: this.state.autonomy };
  }

  public assignment(sessionId: string): Assignment | null {
    return this.state.assignments[sessionId] ?? null;
  }

  /** The folder a session's files, changes and terminal are read from. */
  public worktree(sessionId: string): string {
    const path = this.assignment(sessionId)?.worktreePath;
    if (!path) throw new Error('This session has no worktree on this computer yet.');
    return path;
  }

  /** Gives a session its repository; it starts on the next tick if it is in the queue. */
  public async assign(sessionId: string, folder: string, autonomy: Autonomy): Promise<Assignment> {
    const repoPath = await this.options.git.root(folder);
    const assignment: Assignment = {
      repoPath,
      autonomy,
      worktreePath: this.assignment(sessionId)?.worktreePath ?? null,
    };
    await this.save({
      assignments: { ...this.state.assignments, [sessionId]: assignment },
      lastRepoPath: repoPath,
      autonomy,
    });
    return assignment;
  }

  /** Starts every queued session that has a folder and is not running here already. */
  public async tick(): Promise<void> {
    if (!this.credentials || this.ticking) return;
    this.ticking = true;
    try {
      const { sessions } = await this.api.request<{ sessions: { id: string }[] }>({
        method: 'GET',
        path: '/development/sessions',
        query: { status: 'queued', mine: 'true' },
      });
      for (const { id } of sessions) {
        const assignment = this.assignment(id);
        if (assignment && !this.active.has(id)) void this.execute(id, assignment);
      }
    } catch (error) {
      // The web app signs in again and reconnects; until then there is nobody to work for.
      if ([401, 403].includes(statusOf(error) ?? 0)) this.credentials = undefined;
      else this.options.log(`[development] ${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async execute(sessionId: string, assignment: Assignment): Promise<void> {
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const create =
      this.options.createRunner ??
      ((options: DevelopmentRunnerOptions) => new DevelopmentRunner(options));
    try {
      await create({
        api: this.api,
        runnerName: this.options.runnerName,
        repoRoot: assignment.repoPath,
        remoteUrl: '',
        worktreesDir: worktreesDir(assignment.repoPath),
        git: this.options.git,
        runAgent: this.options.runAgent,
        autonomy: assignment.autonomy,
        sessionId,
        // The person chose this folder for this session: there is nothing to match.
        anyRepository: true,
        onEvent: (event) => {
          this.options.log(formatDevelopmentEvent(event).replace('[devkit]', '[development]'));
          if (event.type !== 'worktree') return;
          this.save({
            ...this.state,
            assignments: {
              ...this.state.assignments,
              [sessionId]: { ...assignment, worktreePath: event.path },
            },
          }).catch((error: unknown) => this.options.log(`[development] ${String(error)}`));
        },
      }).poll(controller.signal);
    } catch (error) {
      this.options.log(`[development] Session ${sessionId}: ${String(error)}`);
    } finally {
      this.active.delete(sessionId);
    }
  }

  /** Stops the agents at work, as closing the app does. */
  public stop(): void {
    for (const controller of this.active.values()) controller.abort();
  }
}
