import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { ImageAttachment } from '../shared/image-attachment.js';

export type IssueStatus =
  'backlog' | 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'cancelled';
export type IssuePriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Issue {
  id: string;
  workspaceId: string;
  number: number;
  title: string;
  description: string;
  attachments?: ImageAttachment[];
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  pbiItemId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueComment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface InboxState {
  issueId: string;
  userId: string;
  readAt: Date | null;
  archivedAt: Date | null;
}

export type IssueChanges = Partial<
  Pick<
    Issue,
    | 'title'
    | 'description'
    | 'attachments'
    | 'status'
    | 'priority'
    | 'assigneeAgentId'
    | 'assigneeUserId'
    | 'pbiItemId'
  >
>;

export interface IssueStore {
  list(workspaceId: string): Promise<Issue[]>;
  get(workspaceId: string, issueId: string): Promise<Issue | null>;
  create(
    workspaceId: string,
    actorId: string,
    changes: IssueChanges & { title: string },
  ): Promise<Issue>;
  update(workspaceId: string, issueId: string, changes: IssueChanges): Promise<Issue | null>;
  remove(workspaceId: string, issueId: string): Promise<boolean>;
  comments(issueId: string): Promise<IssueComment[]>;
  addComment(issueId: string, actorId: string, body: string): Promise<IssueComment>;
  inboxStates(workspaceId: string, userId: string): Promise<InboxState[]>;
  setInboxState(
    issueId: string,
    userId: string,
    changes: Pick<InboxState, 'readAt' | 'archivedAt'>,
  ): Promise<InboxState>;
}

export class InMemoryIssueStore implements IssueStore {
  private readonly issues = new Map<string, Issue>();
  private readonly commentsByIssue = new Map<string, IssueComment[]>();
  private readonly states = new Map<string, InboxState>();
  private readonly counters = new Map<string, number>();

  list(workspaceId: string): Promise<Issue[]> {
    return Promise.resolve(
      [...this.issues.values()]
        .filter((issue) => issue.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    );
  }
  get(workspaceId: string, issueId: string): Promise<Issue | null> {
    const issue = this.issues.get(issueId);
    return Promise.resolve(issue?.workspaceId === workspaceId ? issue : null);
  }
  create(
    workspaceId: string,
    actorId: string,
    changes: IssueChanges & { title: string },
  ): Promise<Issue> {
    const now = new Date();
    const number = this.counters.get(workspaceId) ?? 1;
    this.counters.set(workspaceId, number + 1);
    const issue: Issue = {
      id: crypto.randomUUID(),
      workspaceId,
      number,
      title: changes.title,
      description: changes.description ?? '',
      attachments: changes.attachments ?? [],
      status: changes.status ?? 'todo',
      priority: changes.priority ?? 'medium',
      assigneeAgentId: changes.assigneeAgentId ?? null,
      assigneeUserId: changes.assigneeUserId ?? null,
      pbiItemId: changes.pbiItemId ?? null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    this.issues.set(issue.id, issue);
    return Promise.resolve(issue);
  }
  async update(workspaceId: string, issueId: string, changes: IssueChanges): Promise<Issue | null> {
    const issue = await this.get(workspaceId, issueId);
    if (!issue) return null;
    const updated = { ...issue, ...changes, updatedAt: new Date() };
    this.issues.set(issueId, updated);
    return updated;
  }
  async remove(workspaceId: string, issueId: string): Promise<boolean> {
    if (!(await this.get(workspaceId, issueId))) return false;
    this.issues.delete(issueId);
    this.commentsByIssue.delete(issueId);
    for (const key of this.states.keys())
      if (key.startsWith(`${issueId}:`)) this.states.delete(key);
    return true;
  }
  comments(issueId: string): Promise<IssueComment[]> {
    return Promise.resolve(this.commentsByIssue.get(issueId) ?? []);
  }
  addComment(issueId: string, actorId: string, body: string): Promise<IssueComment> {
    const comment = {
      id: crypto.randomUUID(),
      issueId,
      authorId: actorId,
      body,
      createdAt: new Date(),
    };
    this.commentsByIssue.set(issueId, [...(this.commentsByIssue.get(issueId) ?? []), comment]);
    const issue = this.issues.get(issueId);
    if (issue) this.issues.set(issueId, { ...issue, updatedAt: comment.createdAt });
    return Promise.resolve(comment);
  }
  async inboxStates(workspaceId: string, userId: string): Promise<InboxState[]> {
    const ids = new Set((await this.list(workspaceId)).map((issue) => issue.id));
    return [...this.states.values()].filter(
      (state) => state.userId === userId && ids.has(state.issueId),
    );
  }
  setInboxState(
    issueId: string,
    userId: string,
    changes: Pick<InboxState, 'readAt' | 'archivedAt'>,
  ): Promise<InboxState> {
    const state = { issueId, userId, ...changes };
    this.states.set(`${issueId}:${userId}`, state);
    return Promise.resolve(state);
  }
}

export class PrismaIssueStore implements IssueStore {
  constructor(private readonly db: PrismaClient) {}
  async list(workspaceId: string): Promise<Issue[]> {
    const rows = await this.db.issueRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((row) => {
      const issue = row as unknown as Issue;
      return { ...issue, attachments: row.attachments as unknown as ImageAttachment[] };
    });
  }
  async get(workspaceId: string, issueId: string): Promise<Issue | null> {
    const row = await this.db.issueRecord.findFirst({
      where: { id: issueId, workspaceId },
    });
    if (!row) return null;
    const issue = row as unknown as Issue;
    return { ...issue, attachments: row.attachments as unknown as ImageAttachment[] };
  }
  async create(
    workspaceId: string,
    actorId: string,
    changes: IssueChanges & { title: string },
  ): Promise<Issue> {
    return this.db.$transaction(async (tx) => {
      const counter = await tx.issueCounterRecord.upsert({
        where: { workspaceId },
        create: { workspaceId, nextNumber: 2 },
        update: { nextNumber: { increment: 1 } },
      });
      const row = await tx.issueRecord.create({
        data: {
          workspaceId,
          number: counter.nextNumber - 1,
          title: changes.title,
          description: changes.description ?? '',
          attachments: (changes.attachments ?? []) as unknown as Prisma.InputJsonValue,
          status: changes.status ?? 'todo',
          priority: changes.priority ?? 'medium',
          assigneeAgentId: changes.assigneeAgentId,
          assigneeUserId: changes.assigneeUserId,
          pbiItemId: changes.pbiItemId,
          createdBy: actorId,
        },
      });
      const issue = row as unknown as Issue;
      return { ...issue, attachments: changes.attachments ?? [] };
    });
  }
  async update(workspaceId: string, issueId: string, changes: IssueChanges): Promise<Issue | null> {
    const result = await this.db.issueRecord.updateMany({
      where: { id: issueId, workspaceId },
      data: {
        ...changes,
        attachments: changes.attachments as unknown as Prisma.InputJsonValue | undefined,
      },
    });
    return result.count ? this.get(workspaceId, issueId) : null;
  }
  async remove(workspaceId: string, issueId: string): Promise<boolean> {
    const result = await this.db.issueRecord.deleteMany({ where: { id: issueId, workspaceId } });
    return result.count > 0;
  }
  async comments(issueId: string): Promise<IssueComment[]> {
    return this.db.issueCommentRecord.findMany({
      where: { issueId },
      orderBy: { createdAt: 'asc' },
    });
  }
  async addComment(issueId: string, actorId: string, body: string): Promise<IssueComment> {
    return this.db.$transaction(async (tx) => {
      const comment = await tx.issueCommentRecord.create({
        data: { issueId, authorId: actorId, body },
      });
      await tx.issueRecord.update({ where: { id: issueId }, data: { updatedAt: new Date() } });
      return comment;
    });
  }
  async inboxStates(workspaceId: string, userId: string): Promise<InboxState[]> {
    return this.db.issueInboxRecord.findMany({ where: { userId, issue: { workspaceId } } });
  }
  async setInboxState(
    issueId: string,
    userId: string,
    changes: Pick<InboxState, 'readAt' | 'archivedAt'>,
  ): Promise<InboxState> {
    return this.db.issueInboxRecord.upsert({
      where: { issueId_userId: { issueId, userId } },
      create: { issueId, userId, ...changes },
      update: changes,
    });
  }
}
