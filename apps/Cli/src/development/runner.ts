import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENT_CLIS, Progress, type Autonomy, type Invocation } from './agent-clis.js';
import type { Git } from './git.js';
import type { StreamOptions, StreamResult } from './process.js';

/**
 * The part of the ADK API client the runner uses. It is declared here so this folder depends on
 * nothing but Node, and the desktop app can embed it as it is (apps/Desktop/src/vendor).
 */
export interface RunnerApi {
  request<T>(request: {
    readonly method: 'GET' | 'POST' | 'PUT';
    readonly path: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  }): Promise<T>;
}

interface RepositoryDto {
  readonly id: string;
  readonly name: string;
}
interface ArtifactDto {
  readonly id: string;
  readonly kind: string;
  readonly path: string;
  readonly content: string;
}
interface ChangeDto {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly artifacts: readonly ArtifactDto[];
}
interface CommentDto {
  readonly authorName: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly body: string;
}
export interface SessionDto {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly cli: string;
  readonly attempt: number;
  readonly repository: RepositoryDto | null;
  readonly worktree: { readonly branch: string; readonly baseBranch: string };
  readonly context: { readonly compactAtPercent: number };
  readonly maxSubagents: number;
}
interface BriefDto {
  readonly session: SessionDto;
  readonly change: ChangeDto | null;
  readonly feedback: readonly CommentDto[];
}
interface Directives {
  readonly cancel: boolean;
}

export type DevelopmentRunnerEvent =
  | { readonly type: 'claimed'; readonly session: SessionDto }
  | { readonly type: 'worktree'; readonly path: string; readonly state: 'reused' | 'created' }
  | {
      readonly type: 'finished';
      readonly session: SessionDto;
      readonly outcome: 'succeeded' | 'failed';
      readonly files: number;
      readonly error: string | null;
    }
  | { readonly type: 'cancelled'; readonly session: SessionDto }
  | { readonly type: 'offline'; readonly message: string; readonly retryInMs: number };

export type RunAgent = (
  invocation: Invocation,
  options: Pick<StreamOptions, 'cwd' | 'stdin' | 'signal' | 'onLine'>,
) => Promise<StreamResult>;

export interface DevelopmentRunnerOptions {
  readonly api: RunnerApi;
  /** Shown in ADK as who is working on the session. */
  readonly runnerName: string;
  readonly repoRoot: string;
  /** Address of the repository's origin; sessions of another repository are left alone. */
  readonly remoteUrl: string;
  /** Folder the worktrees are created in, one per session branch. */
  readonly worktreesDir: string;
  readonly git: Pick<Git, 'ensureWorktree' | 'diff'>;
  readonly runAgent: RunAgent;
  readonly autonomy: Autonomy;
  /** Only this session, instead of whatever is queued. */
  readonly sessionId?: string;
  /** Also take sessions whose repository does not match this one. */
  readonly anyRepository?: boolean;
  readonly reportMs?: number;
  readonly idleMs?: number;
  readonly onEvent?: (event: DevelopmentRunnerEvent) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The HTTP status of a failed API call; undefined for any other error. */
export function statusOf(error: unknown): number | undefined {
  const status = typeof error === 'object' && error !== null && 'status' in error && error.status;
  return typeof status === 'number' ? status : undefined;
}
const isAuthError = (error: unknown) => [401, 403].includes(statusOf(error) ?? 0);
/** Ids come from ADK; '.' and '..' would become another route when the URL is resolved. */
const segment = (id: string) => encodeURIComponent(id).replace(/^\.+$/, '_');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Whether a session's repository is the one this runner was started in. */
export function matchesRepository(remoteUrl: string, repository: RepositoryDto | null): boolean {
  if (!repository) return true;
  const url = remoteUrl.toLowerCase().replace(/\.git$/, '');
  return [repository.id, repository.name].some(
    (name) => name && url.endsWith(`/${name.toLowerCase()}`),
  );
}

/** Where an artifact goes inside the worktree, or null for a path that would leave it. */
export function artifactFile(worktree: string, artifactPath: string): string | null {
  const root = path.resolve(worktree);
  const file = path.resolve(root, artifactPath);
  return file.startsWith(root + path.sep) ? file : null;
}

/** The instructions the coding agent starts from. */
export function buildPrompt(brief: BriefDto, worktree: string): string {
  const { session, change, feedback } = brief;
  const lines = [
    `You are working on the task below inside the git worktree at ${worktree}, on branch ${session.worktree.branch}.`,
    '',
    'Rules:',
    `- Change files only inside this folder. Do not switch branches, merge or push: a person reviews your work before it reaches ${session.worktree.baseBranch}.`,
    `- Delegate independent work to at most ${session.maxSubagents} subagents at a time.`,
    '- When you are done, reply with a short summary of what you changed and how you checked it.',
  ];
  if (change)
    lines.push(
      `- This task implements the change "${change.title}" (${change.slug}). Read its artifacts first and follow them:`,
      ...change.artifacts.map((artifact) => `  - ${artifact.path} (${artifact.kind})`),
      '- Tick each task off in the tasks file (`- [x]`) as you finish it.',
    );
  if (feedback.length)
    lines.push(
      '',
      `A reviewer asked for changes on attempt ${session.attempt - 1}. Address every comment before anything else:`,
      ...feedback.map(
        (comment) =>
          `- ${comment.authorName}${comment.path ? ` on ${comment.path}${comment.line ? `:${comment.line}` : ''}` : ''}: ${comment.body}`,
      ),
    );
  lines.push('', 'Task:', session.prompt);
  return lines.join('\n');
}

/**
 * Executes the signed-in user's development sessions on this computer: claims a queued session,
 * creates its git worktree, drives the coding CLI in it, reports progress while it runs and sends
 * the diff for review. ADK never touches the repository; every connection is outbound HTTPS.
 */
export class DevelopmentRunner {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  public constructor(private readonly options: DevelopmentRunnerOptions) {
    this.sleep = options.sleep ?? wait;
  }

  private request<T>(method: 'GET' | 'POST' | 'PUT', route: string, body?: unknown): Promise<T> {
    return this.options.api.request<T>({
      method,
      path: `/development${route}`,
      ...(body === undefined ? {} : { body }),
    });
  }

  /** Claims and executes one session; null when none is waiting for this runner. */
  public async poll(signal?: AbortSignal): Promise<SessionDto | null> {
    const { sessions } = await this.options.api.request<{ sessions: SessionDto[] }>({
      method: 'GET',
      path: '/development/sessions',
      query: { status: 'queued', mine: 'true' },
    });
    // The list is newest first: the one that waited longest goes first.
    const session = [...sessions]
      .reverse()
      .find(
        (item) =>
          (!this.options.sessionId || item.id === this.options.sessionId) &&
          (this.options.anyRepository ||
            matchesRepository(this.options.remoteUrl, item.repository)),
      );
    if (!session) return null;
    const worktree = path.join(
      this.options.worktreesDir,
      session.worktree.branch.replace(/[^A-Za-z0-9._-]+/g, '-'),
    );
    const route = `/sessions/${segment(session.id)}`;
    try {
      await this.request('POST', `${route}/claim`, {
        runner: this.options.runnerName,
        worktreePath: worktree,
      });
    } catch (error) {
      // Another runner of the same person took it first.
      if (statusOf(error) === 409) return null;
      throw error;
    }
    this.options.onEvent?.({ type: 'claimed', session });
    try {
      await this.work(session, route, worktree, signal);
    } catch (error) {
      await this.complete(session, route, 0, message(error));
    }
    return session;
  }

  private async work(
    session: SessionDto,
    route: string,
    worktree: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const brief = await this.request<BriefDto>('GET', `${route}/brief`);
    const cli = AGENT_CLIS[session.cli];
    if (!cli) throw new Error(`This runner does not know the "${session.cli}" CLI.`);
    const state = await this.options.git.ensureWorktree(this.options.repoRoot, {
      ...session.worktree,
      path: worktree,
    });
    this.options.onEvent?.({ type: 'worktree', path: worktree, state });
    if (brief.change) await writeArtifacts(worktree, brief.change.artifacts);

    const progress = new Progress(worktree);
    progress.add('status', `Worktree ${state}: ${path.basename(worktree)}`);
    const stop = new AbortController();
    const forward = () => stop.abort();
    if (signal?.aborted) forward();
    signal?.addEventListener('abort', forward, { once: true });
    let cancelled = false;
    const report = async () => {
      const payload = progress.take();
      if (!payload) return;
      const { directives } = await this.request<{ directives: Directives }>(
        'POST',
        `${route}/report`,
        payload,
      );
      // A person cancelled the session in ADK: stop the agent, leave the worktree as it is.
      if (directives.cancel) {
        cancelled = true;
        stop.abort();
      }
    };
    // Reports go out one at a time; a failed one is retried with the next batch.
    let sending = Promise.resolve();
    const tick = () => {
      sending = sending.then(report).catch(() => undefined);
    };
    const timer = setInterval(tick, this.options.reportMs ?? 3_000);
    let result: StreamResult;
    try {
      result = await this.options.runAgent(
        cli.invocation(this.options.autonomy, session.context.compactAtPercent),
        {
          cwd: worktree,
          stdin: buildPrompt(brief, worktree),
          signal: stop.signal,
          onLine: (line) => cli.parse(line, progress),
        },
      );
    } finally {
      clearInterval(timer);
      signal?.removeEventListener('abort', forward);
    }
    tick();
    await sending;
    if (cancelled) {
      this.options.onEvent?.({ type: 'cancelled', session });
      return;
    }
    if (signal?.aborted) throw new Error('The runner was stopped before the agent finished.');

    if (brief.change) await this.syncArtifacts(worktree, brief.change);
    const files = await this.options.git.diff(worktree, session.worktree.baseBranch);
    await this.request('PUT', `${route}/diff`, { files });
    const error =
      progress.error ??
      (result.exitCode === 0
        ? null
        : result.stderr.trim() || `The ${session.cli} CLI exited with code ${result.exitCode}.`);
    await this.complete(session, route, files.length, error, progress.summary);
  }

  private async complete(
    session: SessionDto,
    route: string,
    files: number,
    error: string | null,
    summary = '',
  ): Promise<void> {
    const outcome = error ? 'failed' : 'succeeded';
    await this.request('POST', `${route}/complete`, {
      outcome,
      ...(summary ? { summary: summary.slice(0, 20_000) } : {}),
      ...(error ? { error: error.slice(0, 4_000) } : {}),
    }).catch(() => undefined);
    this.options.onEvent?.({ type: 'finished', session, outcome, files, error });
  }

  /** Sends back what the agent changed in the artifacts, such as the tasks it ticked off. */
  private async syncArtifacts(worktree: string, change: ChangeDto): Promise<void> {
    let changed = false;
    const artifacts: ArtifactDto[] = [];
    for (const artifact of change.artifacts) {
      const file = artifactFile(worktree, artifact.path);
      const content = file ? await fs.readFile(file, 'utf8').catch(() => null) : null;
      if (content !== null && content !== artifact.content) changed = true;
      artifacts.push(content === null ? artifact : { ...artifact, content });
    }
    if (changed)
      await this.request('PUT', `/changes/${segment(change.id)}`, { artifacts }).catch(
        () => undefined,
      );
  }

  /** Serves sessions until the signal aborts; with `once`, until one session was executed. */
  public async serve(
    options: { readonly signal?: AbortSignal; readonly once?: boolean } = {},
  ): Promise<void> {
    let backoff = 0;
    while (!options.signal?.aborted) {
      try {
        const session = await this.poll(options.signal);
        backoff = 0;
        if (session && options.once) return;
        if (!session) await this.sleep(this.options.idleMs ?? 5_000, options.signal);
      } catch (error) {
        if (isAuthError(error)) throw error;
        backoff = Math.min(backoff ? backoff * 2 : 2_000, 30_000);
        this.options.onEvent?.({ type: 'offline', message: message(error), retryInMs: backoff });
        await this.sleep(backoff, options.signal);
      }
    }
  }
}

/** Puts the change's artifacts in the worktree, where the agent reads and updates them. */
async function writeArtifacts(worktree: string, artifacts: readonly ArtifactDto[]): Promise<void> {
  for (const artifact of artifacts) {
    const file = artifactFile(worktree, artifact.path);
    if (!file) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, artifact.content, 'utf8');
  }
}

/** One line for the terminal. */
export function formatDevelopmentEvent(event: DevelopmentRunnerEvent): string {
  switch (event.type) {
    case 'claimed':
      return `[devkit] Session "${event.session.title}" (${event.session.cli}, attempt ${event.session.attempt}) started on this computer.`;
    case 'worktree':
      return `[devkit] Worktree ${event.state}: ${event.path}`;
    case 'finished':
      return event.outcome === 'succeeded'
        ? `[devkit] Session "${event.session.title}" finished: ${event.files} changed file(s) sent for review in ADK.`
        : `[devkit] Session "${event.session.title}" failed: ${event.error}`;
    case 'cancelled':
      return `[devkit] Session "${event.session.title}" was cancelled in ADK; the agent was stopped.`;
    case 'offline':
      return `[devkit] ADK is unreachable (${event.message}); retrying development sessions in ${Math.round(event.retryInMs / 1000)} s.`;
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
