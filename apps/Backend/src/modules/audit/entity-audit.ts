import { randomUUID } from 'node:crypto';
import { auditRequest, type AuditAction, type AuditEvent, type AuditPersistence } from './audit.js';
import type { IssueChanges, IssueStore, Issue } from '../issues/issue-store.js';

export type EntitySnapshot = Record<string, unknown>;
export interface EntityChange {
  entityType: 'pbi' | 'issue' | 'release_note';
  entityId: string;
  action: AuditAction;
  before: EntitySnapshot | null;
  after: EntitySnapshot | null;
}

// Large pulls are appended in several transactions to stay within statement limits.
const chunkSize = 500;

/**
 * Records per-entity history for high-volume entities (PBIs, issues). Unlike the content
 * audit, it does not snapshot the whole workspace on each mutation: callers pass the
 * entity state before and after the change.
 */
export class EntityAuditLog {
  public constructor(private readonly persistence: AuditPersistence) {}

  public async record(workspaceId: string, changes: readonly EntityChange[]): Promise<void> {
    const request = auditRequest.getStore();
    const context = request?.context();
    const events: AuditEvent[] = changes.map((change) => ({
      id: randomUUID(),
      workspaceId,
      entityType: change.entityType,
      entityId: change.entityId,
      action: change.action,
      actorId: context?.actorId ?? null,
      actorName: context?.actorName ?? null,
      actorEmail: context?.actorEmail ?? null,
      requestId: context?.requestId ?? 'system',
      operation: request?.operation ?? 'system',
      occurredAt: new Date().toISOString(),
      before: change.before,
      after: change.after,
    }));
    for (let index = 0; index < events.length; index += chunkSize) {
      const chunk = events.slice(index, index + chunkSize);
      await this.persistence.run(workspaceId, (unit) => unit.append(chunk));
    }
  }
}

/**
 * Builds an update change containing only the fields that differ. `title` is always kept
 * so history entries remain identifiable. Returns null when nothing changed.
 */
export function diffChange(
  entityType: EntityChange['entityType'],
  entityId: string,
  before: EntitySnapshot,
  after: EntitySnapshot,
): EntityChange | null {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  if (!keys.length) return null;
  const pick = (snapshot: EntitySnapshot) =>
    Object.fromEntries(
      ['title', ...keys.filter((key) => key !== 'title')]
        .filter((key) => snapshot[key] !== undefined)
        .map((key) => [key, snapshot[key]]),
    );
  return { entityType, entityId, action: 'update', before: pick(before), after: pick(after) };
}

export function issueSnapshot(issue: Issue): EntitySnapshot {
  return {
    title: issue.title,
    number: issue.number,
    status: issue.status,
    priority: issue.priority,
    description: issue.description,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    pbiItemId: issue.pbiItemId,
  };
}

/** Wraps an issue store so every mutation, including agent run updates, is audited. */
export function auditedIssueStore(store: IssueStore, audit: EntityAuditLog): IssueStore {
  return {
    list: (workspaceId) => store.list(workspaceId),
    get: (workspaceId, issueId) => store.get(workspaceId, issueId),
    comments: (issueId) => store.comments(issueId),
    inboxStates: (workspaceId, userId) => store.inboxStates(workspaceId, userId),
    setInboxState: (issueId, userId, changes) => store.setInboxState(issueId, userId, changes),
    async create(workspaceId, actorId, changes) {
      const issue = await store.create(workspaceId, actorId, changes);
      await audit.record(workspaceId, [
        {
          entityType: 'issue',
          entityId: issue.id,
          action: 'create',
          before: null,
          after: issueSnapshot(issue),
        },
      ]);
      return issue;
    },
    async update(workspaceId, issueId, changes: IssueChanges) {
      const before = await store.get(workspaceId, issueId);
      const after = await store.update(workspaceId, issueId, changes);
      const change =
        before && after
          ? diffChange('issue', issueId, issueSnapshot(before), issueSnapshot(after))
          : null;
      if (change) await audit.record(workspaceId, [change]);
      return after;
    },
    async remove(workspaceId, issueId) {
      const before = await store.get(workspaceId, issueId);
      const removed = await store.remove(workspaceId, issueId);
      if (removed && before)
        await audit.record(workspaceId, [
          {
            entityType: 'issue',
            entityId: issueId,
            action: 'delete',
            before: issueSnapshot(before),
            after: null,
          },
        ]);
      return removed;
    },
    async addComment(issueId, actorId, body) {
      const comment = await store.addComment(issueId, actorId, body);
      const workspaceId = auditRequest.getStore()?.context()?.workspaceId;
      if (workspaceId) {
        const issue = await store.get(workspaceId, issueId);
        if (issue)
          await audit.record(workspaceId, [
            {
              entityType: 'issue',
              entityId: issueId,
              action: 'comment',
              before: null,
              after: { title: issue.title, comment: body },
            },
          ]);
      }
      return comment;
    },
  };
}
