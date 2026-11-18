import type { EventBus } from '../realtime/event-bus.js';
import type { IssueStore } from './issue-store.js';

/** What a stream sends about an issue: only which one changed; the client reads it from the API. */
export interface IssueEventPayload {
  readonly issueId: string;
}

/**
 * An issue store that tells the workspace whenever an issue is created, changed or removed, so the
 * open inboxes reload. Every writer goes through the store (API, runs, MCP), so they are covered in
 * one place. Reads and the per-user inbox state pass through untouched.
 */
export function eventingIssueStore(store: IssueStore, bus: EventBus): IssueStore {
  const announce = (workspaceId: string, issueId: string) =>
    bus.publish<IssueEventPayload>(workspaceId, 'issue', { issueId }, issueId);
  return {
    list: (workspaceId) => store.list(workspaceId),
    search: (workspaceId, options) => store.search(workspaceId, options),
    get: (workspaceId, issueId) => store.get(workspaceId, issueId),
    comments: (issueId) => store.comments(issueId),
    addComment: (issueId, actorId, body) => store.addComment(issueId, actorId, body),
    inboxStates: (workspaceId, userId) => store.inboxStates(workspaceId, userId),
    setInboxState: (issueId, userId, changes) => store.setInboxState(issueId, userId, changes),
    async create(workspaceId, actorId, changes) {
      const issue = await store.create(workspaceId, actorId, changes);
      announce(workspaceId, issue.id);
      return issue;
    },
    async update(workspaceId, issueId, changes) {
      const issue = await store.update(workspaceId, issueId, changes);
      if (issue) announce(workspaceId, issueId);
      return issue;
    },
    async remove(workspaceId, issueId) {
      const removed = await store.remove(workspaceId, issueId);
      if (removed) announce(workspaceId, issueId);
      return removed;
    },
  };
}
