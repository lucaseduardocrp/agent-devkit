import { ApplicationError } from '../../shared/errors.js';
import {
  ACTIVE_SESSION_STATUSES,
  MAX_EVENTS,
  buildPipeline,
  nextChangeStatus,
  sessionDirectives,
  slugify,
  templateArtifacts,
  worktreeBranch,
  type ArtifactKind,
  type ChangeAction,
  type ChangeArtifact,
  type ChangeFramework,
  type DevChange,
  type DevSession,
  type DiffFile,
  type PipelineItem,
  type PipelineStage,
  type RepositoryRef,
  type ReviewComment,
  type SessionBody,
  type SessionCli,
  type SessionDirectives,
  type SessionEvent,
  type SessionEventKind,
  type SessionStatus,
  type SessionSubagent,
} from './development.js';
import type { DevelopmentStore } from './development-store.js';

/** The Git providers a session can work in, named as the repository references name them. */
export type RepositoryProvider = RepositoryRef['provider'];

/**
 * Repository listing of the connected Git providers. The E2E script repository already speaks to
 * the workspace integrations, so Development browses repositories through it, as Design does.
 */
export interface RepositoryBrowser {
  listRepositories(workspaceId: string): Promise<{
    repositories: readonly {
      id: string;
      provider: string;
      name: string;
      defaultBranch: string;
      webUrl?: string;
    }[];
    warnings: readonly { provider: string; code: string }[];
  }>;
  listBranches(
    workspaceId: string,
    provider: string,
    repositoryId: string,
  ): Promise<readonly { name: string; isDefault: boolean }[]>;
}

/** Sessions no agent is working on, that a new chat message sends back to the queue. */
const RESUMABLE_STATUSES: readonly SessionStatus[] = ['waiting_review', 'failed', 'cancelled'];

const isProvider = (provider: string): provider is RepositoryProvider =>
  provider === 'github' || provider === 'azure_devops';

/** Who is acting: a member in the app, or the runner/assistant using that member's token. */
export interface Actor {
  id: string | null;
  name: string;
}

export interface ArtifactInput {
  id?: string;
  kind: ArtifactKind;
  path: string;
  content: string;
}
export interface ChangeInput {
  title: string;
  slug?: string;
  summary?: string;
  framework?: ChangeFramework;
  artifacts?: ArtifactInput[];
  repository?: RepositoryRef | null;
  specificationId?: string | null;
}
export type ChangeUpdate = Partial<Omit<ChangeInput, 'slug' | 'framework'>>;

export interface SessionInput {
  title: string;
  prompt: string;
  changeId?: string;
  pbiItemId?: string;
  issueId?: string;
  cli?: SessionCli;
  agentId?: string;
  agentIds?: string[];
  repository?: RepositoryRef;
  baseBranch?: string;
  windowTokens?: number;
  compactAtPercent?: number;
  maxSubagents?: number;
}
export interface SessionReport {
  events?: { kind: SessionEventKind; text: string; subagentId?: string }[];
  usedTokens?: number;
  subagents?: SessionSubagent[];
  worktreePath?: string;
}
export interface SessionBrief {
  session: DevSession;
  change: DevChange | null;
  /** Review comments still open: what a new attempt has to address. */
  feedback: ReviewComment[];
  worktree: DevSession['worktree'] & { command: string };
  instructions: string[];
}

function found<T>(value: T | null, code: string, message: string): T {
  if (!value) throw new ApplicationError(code, message, 404);
  return value;
}
const changeFound = (change: DevChange | null) =>
  found(change, 'DEVELOPMENT_CHANGE_NOT_FOUND', 'Change not found.');
const sessionFound = (session: DevSession | null) =>
  found(session, 'DEVELOPMENT_SESSION_NOT_FOUND', 'Session not found.');

function event(kind: SessionEventKind, text: string, subagentId: string | null = null) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), kind, text, subagentId };
}
const withId = (artifact: ArtifactInput): ChangeArtifact => ({
  ...artifact,
  id: artifact.id ?? crypto.randomUUID(),
});

export class DevelopmentService {
  constructor(
    private readonly store: DevelopmentStore,
    private readonly repositories?: RepositoryBrowser,
  ) {}

  /** The repositories of every connected Git provider, for choosing where a session works. */
  async listRepositories(workspaceId: string) {
    if (!this.repositories) return { repositories: [], warnings: [] };
    const { repositories, warnings } = await this.repositories.listRepositories(workspaceId);
    return {
      repositories: repositories.flatMap((repository) =>
        isProvider(repository.provider) ? [{ ...repository, provider: repository.provider }] : [],
      ),
      warnings: warnings.flatMap((warning) =>
        isProvider(warning.provider) ? [{ ...warning, provider: warning.provider }] : [],
      ),
    };
  }

  async listBranches(workspaceId: string, provider: RepositoryProvider, repositoryId: string) {
    if (!this.repositories) return [];
    return this.repositories.listBranches(workspaceId, provider, repositoryId);
  }

  listChanges(workspaceId: string): Promise<DevChange[]> {
    return this.store.listChanges(workspaceId);
  }

  async getChange(workspaceId: string, id: string): Promise<DevChange> {
    return changeFound(await this.store.getChange(workspaceId, id));
  }

  async createChange(workspaceId: string, input: ChangeInput, actor: Actor): Promise<DevChange> {
    const slug = slugify(input.slug ?? input.title);
    if ((await this.store.listChanges(workspaceId)).some((change) => change.slug === slug))
      throw new ApplicationError(
        'DEVELOPMENT_CHANGE_SLUG_TAKEN',
        'A change with this identifier already exists.',
        409,
      );
    const framework = input.framework ?? 'openspec';
    return this.store.createChange(workspaceId, {
      slug,
      title: input.title,
      summary: input.summary ?? '',
      framework,
      status: 'draft',
      artifacts: input.artifacts?.map(withId) ?? templateArtifacts(framework, slug),
      repository: input.repository ?? null,
      specificationId: input.specificationId ?? null,
      createdBy: actor.id,
      decidedBy: null,
      decidedAt: null,
    });
  }

  async updateChange(workspaceId: string, id: string, input: ChangeUpdate): Promise<DevChange> {
    const change = await this.getChange(workspaceId, id);
    if (change.status === 'archived' || change.status === 'rejected')
      throw new ApplicationError(
        'DEVELOPMENT_CHANGE_LOCKED',
        'Archived and rejected changes cannot be edited.',
        409,
      );
    return changeFound(
      await this.store.updateChange(workspaceId, id, {
        ...change,
        ...input,
        artifacts: input.artifacts?.map(withId) ?? change.artifacts,
      }),
    );
  }

  /** Moves a change through its lifecycle; approval and archiving are the human gates. */
  async transitionChange(
    workspaceId: string,
    id: string,
    action: ChangeAction,
    actor: Actor,
  ): Promise<DevChange> {
    const change = await this.getChange(workspaceId, id);
    const status = nextChangeStatus(change.status, action);
    if (!status)
      throw new ApplicationError(
        'DEVELOPMENT_CHANGE_INVALID_TRANSITION',
        `A ${change.status} change cannot be moved with "${action}".`,
        409,
        [],
        { status: change.status, action },
      );
    if (action === 'archive' && (await this.activeSessions(workspaceId, id)).length)
      throw new ApplicationError(
        'DEVELOPMENT_CHANGE_HAS_ACTIVE_SESSIONS',
        'Finish or cancel the sessions of this change before archiving it.',
        409,
      );
    const decision =
      action === 'approve' || action === 'reject'
        ? { decidedBy: actor.id, decidedAt: new Date().toISOString() }
        : action === 'reopen'
          ? { decidedBy: null, decidedAt: null }
          : {};
    return changeFound(
      await this.store.updateChange(workspaceId, id, { ...change, ...decision, status }),
    );
  }

  async removeChange(workspaceId: string, id: string): Promise<void> {
    await this.getChange(workspaceId, id);
    if ((await this.sessionsOf(workspaceId, id)).length)
      throw new ApplicationError(
        'DEVELOPMENT_CHANGE_HAS_SESSIONS',
        'Delete the sessions of this change before deleting it.',
        409,
      );
    await this.store.removeChange(workspaceId, id);
  }

  async listSessions(
    workspaceId: string,
    filter: { status?: SessionStatus; createdBy?: string | null } = {},
  ): Promise<DevSession[]> {
    return (await this.store.listSessions(workspaceId)).filter(
      (session) =>
        (!filter.status || session.status === filter.status) &&
        (filter.createdBy === undefined || session.createdBy === filter.createdBy),
    );
  }

  async getSession(workspaceId: string, id: string): Promise<DevSession> {
    return sessionFound(await this.store.getSession(workspaceId, id));
  }

  /** Queues work for a runner. A session of a change only starts once the change is approved. */
  async createSession(workspaceId: string, input: SessionInput, actor: Actor): Promise<DevSession> {
    const change = input.changeId ? await this.getChange(workspaceId, input.changeId) : null;
    if (change && change.status !== 'approved')
      throw new ApplicationError(
        'DEVELOPMENT_CHANGE_NOT_APPROVED',
        'The change must be approved before agents start working on it.',
        409,
      );
    const repository = input.repository ?? change?.repository ?? null;
    return this.store.createSession(workspaceId, {
      changeId: change?.id ?? null,
      pbiItemId: input.pbiItemId ?? null,
      issueId: input.issueId ?? null,
      title: input.title,
      prompt: input.prompt,
      cli: input.cli ?? 'claude',
      agentId: input.agentId ?? input.agentIds?.[0] ?? null,
      agentIds: input.agentIds ?? (input.agentId ? [input.agentId] : []),
      status: 'queued',
      attempt: 1,
      repository,
      worktree: {
        branch: worktreeBranch(change?.slug ?? input.title),
        baseBranch: input.baseBranch ?? repository?.baseBranch ?? 'main',
        path: null,
      },
      context: {
        windowTokens: input.windowTokens ?? 200_000,
        usedTokens: 0,
        compactAtPercent: input.compactAtPercent ?? 80,
        compactions: 0,
      },
      maxSubagents: input.maxSubagents ?? 3,
      subagents: [],
      events: [event('status', 'Session queued.')],
      diff: [],
      comments: [],
      summary: '',
      error: null,
      runner: null,
      createdBy: actor.id,
      reviewedBy: null,
    });
  }

  /** Everything a runner needs to start (or resume) the work of a session. */
  async brief(workspaceId: string, id: string): Promise<SessionBrief> {
    const session = await this.getSession(workspaceId, id);
    const { branch, baseBranch } = session.worktree;
    return {
      session,
      change: session.changeId ? await this.store.getChange(workspaceId, session.changeId) : null,
      feedback: session.comments.filter((comment) => !comment.resolved),
      worktree: {
        ...session.worktree,
        command: `git worktree add -b ${branch} ../${branch.replace('/', '-')} ${baseBranch}`,
      },
      instructions: [
        `Work only inside the git worktree of branch ${branch}; never commit to ${baseBranch} or push without being asked.`,
        'When the session belongs to a change, follow its proposal, design and spec deltas, and tick each task off as it is done.',
        `Delegate independent work to at most ${session.maxSubagents} subagents at a time and report each one.`,
        `Report the context usage after every step; when the answer says "compact", summarize the conversation before going on (limit: ${session.context.compactAtPercent}% of ${session.context.windowTokens} tokens).`,
        'When the answer says "cancel", stop immediately and leave the worktree as it is.',
        'Address every open review comment listed under "feedback" before anything else.',
        'When done, submit the diff against the base branch and complete the session: a person reviews it before it is merged.',
      ],
    };
  }

  async claim(
    workspaceId: string,
    id: string,
    input: { runner: string; worktreePath?: string },
  ): Promise<DevSession> {
    const session = this.inState(await this.getSession(workspaceId, id), 'queued');
    return this.save(session, {
      status: 'running',
      runner: input.runner,
      worktree: { ...session.worktree, path: input.worktreePath ?? session.worktree.path },
      events: this.events(session, event('status', `Claimed by runner ${input.runner}.`)),
    });
  }

  /** Progress from the runner. The answer tells it to compact, stop or go on. */
  async report(
    workspaceId: string,
    id: string,
    input: SessionReport,
  ): Promise<{ session: DevSession; directives: SessionDirectives }> {
    const current = await this.getSession(workspaceId, id);
    // A cancelled session is not an error for the runner: it is how it learns it must stop.
    if (current.status === 'cancelled')
      return { session: current, directives: sessionDirectives(current) };
    const session = this.inState(current, 'running');
    const added = (input.events ?? []).map((item) =>
      event(item.kind, item.text, item.subagentId ?? null),
    );
    const saved = await this.save(session, {
      events: this.events(session, ...added),
      subagents: input.subagents ?? session.subagents,
      worktree: { ...session.worktree, path: input.worktreePath ?? session.worktree.path },
      context: {
        ...session.context,
        usedTokens: input.usedTokens ?? session.context.usedTokens,
        compactions:
          session.context.compactions + added.filter((item) => item.kind === 'compaction').length,
      },
    });
    return { session: saved, directives: sessionDirectives(saved) };
  }

  async submitDiff(workspaceId: string, id: string, files: DiffFile[]): Promise<DevSession> {
    const session = this.inState(await this.getSession(workspaceId, id), 'running');
    return this.save(session, {
      diff: files,
      events: this.events(session, event('tool', `Diff submitted: ${files.length} file(s).`)),
    });
  }

  /** The runner finished: success waits for a human review, failure stops the session. */
  async complete(
    workspaceId: string,
    id: string,
    input: { outcome: 'succeeded' | 'failed'; summary?: string; error?: string },
  ): Promise<DevSession> {
    const session = this.inState(await this.getSession(workspaceId, id), 'running');
    const failed = input.outcome === 'failed';
    return this.save(session, {
      status: failed ? 'failed' : 'waiting_review',
      summary: input.summary ?? session.summary,
      error: failed ? (input.error ?? 'The runner reported a failure.') : null,
      events: this.events(
        session,
        event('status', failed ? 'Session failed.' : 'Work finished; waiting for review.'),
      ),
    });
  }

  async cancel(workspaceId: string, id: string, actor: Actor): Promise<DevSession> {
    const session = this.inState(
      await this.getSession(workspaceId, id),
      ...ACTIVE_SESSION_STATUSES,
    );
    return this.save(session, {
      status: 'cancelled',
      events: this.events(session, event('status', `Cancelled by ${actor.name}.`)),
    });
  }

  async retry(workspaceId: string, id: string, actor: Actor): Promise<DevSession> {
    const session = this.inState(await this.getSession(workspaceId, id), 'failed', 'cancelled');
    return this.requeue(session, event('status', `Queued again by ${actor.name}.`));
  }

  /** The human gate after the agents: approve the diff, or send it back with the open comments. */
  async review(
    workspaceId: string,
    id: string,
    input: { verdict: 'approve' | 'request_changes'; note?: string },
    actor: Actor,
  ): Promise<DevSession> {
    const session = this.inState(await this.getSession(workspaceId, id), 'waiting_review');
    if (input.verdict === 'approve')
      return this.save(session, {
        status: 'approved',
        reviewedBy: actor.id,
        events: this.events(session, event('status', `Approved by ${actor.name}.`)),
      });
    const note = input.note ? `: ${input.note}` : '.';
    return this.requeue(
      { ...session, reviewedBy: actor.id },
      event('feedback', `Changes requested by ${actor.name}${note}`),
    );
  }

  async addComment(
    workspaceId: string,
    id: string,
    input: { body: string; path?: string; line?: number; author?: 'user' | 'agent' },
    actor: Actor,
  ): Promise<DevSession> {
    const session = await this.getSession(workspaceId, id);
    const comment: ReviewComment = {
      id: crypto.randomUUID(),
      author: input.author ?? 'user',
      authorName: actor.name,
      path: input.path ?? null,
      line: input.line ?? null,
      body: input.body,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    const comments = [...session.comments, comment];
    const place = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ''}` : null;
    if (comment.author === 'agent')
      // What the agent says (through MCP too) belongs to the worktree it works in.
      return this.save(session, {
        comments,
        events: this.events(
          session,
          place
            ? event('tool', `Commented on ${place}: ${comment.body}`)
            : event('message', comment.body),
        ),
      });
    if (place)
      return this.save(session, {
        comments,
        events: this.events(session, event('tool', `${actor.name} commented on ${place}.`)),
      });
    // A chat message: the agent only reads it on an attempt, so a session that is not working
    // goes back to the queue, and the person is told what happens to the message.
    if (RESUMABLE_STATUSES.includes(session.status))
      return this.requeue(
        { ...session, comments },
        event(
          'feedback',
          `Message from ${actor.name} sent to the agent; queued again for the next attempt.`,
        ),
      );
    return this.save(session, {
      comments,
      events: this.events(
        session,
        event(
          'feedback',
          session.status === 'approved'
            ? `Message from ${actor.name} recorded; the session is already approved, so the agent will not read it.`
            : `Message from ${actor.name} recorded; the agent reads it ${session.status === 'running' ? 'when it next checks the session brief' : 'when it claims the session'}.`,
        ),
      ),
    });
  }

  async resolveComment(
    workspaceId: string,
    id: string,
    commentId: string,
    resolved: boolean,
  ): Promise<DevSession> {
    const session = await this.getSession(workspaceId, id);
    if (!session.comments.some((comment) => comment.id === commentId))
      throw new ApplicationError('DEVELOPMENT_COMMENT_NOT_FOUND', 'Comment not found.', 404);
    return this.save(session, {
      comments: session.comments.map((comment) =>
        comment.id === commentId ? { ...comment, resolved } : comment,
      ),
      events: this.events(
        session,
        event('tool', `Review comment ${resolved ? 'resolved' : 'reopened'}.`),
      ),
    });
  }

  async removeSession(workspaceId: string, id: string): Promise<void> {
    const session = await this.getSession(workspaceId, id);
    if (session.status === 'running') throw this.invalidState(session);
    await this.store.removeSession(workspaceId, id);
  }

  async pipeline(workspaceId: string): Promise<Record<PipelineStage, PipelineItem[]>> {
    return buildPipeline(
      await this.store.listChanges(workspaceId),
      await this.store.listSessions(workspaceId),
    );
  }

  private async sessionsOf(workspaceId: string, changeId: string): Promise<DevSession[]> {
    return (await this.store.listSessions(workspaceId)).filter(
      (session) => session.changeId === changeId,
    );
  }

  private async activeSessions(workspaceId: string, changeId: string): Promise<DevSession[]> {
    return (await this.sessionsOf(workspaceId, changeId)).filter((session) =>
      ACTIVE_SESSION_STATUSES.includes(session.status),
    );
  }

  private invalidState(session: DevSession): ApplicationError {
    return new ApplicationError(
      'DEVELOPMENT_SESSION_INVALID_STATE',
      `This is not possible while the session is ${session.status}.`,
      409,
      [],
      { status: session.status },
    );
  }

  private inState(session: DevSession, ...statuses: SessionStatus[]): DevSession {
    if (!statuses.includes(session.status)) throw this.invalidState(session);
    return session;
  }

  private events(session: DevSession, ...added: SessionEvent[]): SessionEvent[] {
    return [...session.events, ...added].slice(-MAX_EVENTS);
  }

  /** Back to the queue for another attempt, with a clean context and no runner. */
  private requeue(session: DevSession, reason: SessionEvent): Promise<DevSession> {
    return this.save(session, {
      status: 'queued',
      attempt: session.attempt + 1,
      runner: null,
      error: null,
      subagents: [],
      context: { ...session.context, usedTokens: 0 },
      events: this.events(session, reason),
      reviewedBy: session.reviewedBy,
    });
  }

  private async save(session: DevSession, changes: Partial<SessionBody>): Promise<DevSession> {
    return sessionFound(
      await this.store.updateSession(session.workspaceId, session.id, { ...session, ...changes }),
    );
  }
}
