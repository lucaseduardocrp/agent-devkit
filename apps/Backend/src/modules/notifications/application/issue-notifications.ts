import type { Issue } from '../../issues/issue-store.js';
import type { NotificationData } from '../domain/notification.js';

/** The part of an issue a notification needs. */
export type NotifiableIssue = Pick<
  Issue,
  'id' | 'number' | 'title' | 'status' | 'priority' | 'assigneeUserId' | 'proofreaderUserId'
>;

/** Which people of an issue a notification can be addressed to by role. */
export type IssueRole = 'assignee' | 'proofreader';

/** The values of an issue for the templates (`{{issue.title}}`...). */
export function issueNotificationData(issue: NotifiableIssue): NotificationData {
  return {
    'issue.number': String(issue.number),
    'issue.title': issue.title,
    'issue.status': issue.status,
    'issue.priority': issue.priority,
  };
}

/** The users of an issue that hold the given roles; roles nobody holds are skipped. */
export function issueRoleUserIds(
  issue: NotifiableIssue,
  roles: readonly IssueRole[],
): readonly string[] {
  const ids: string[] = [];
  if (roles.includes('assignee') && issue.assigneeUserId) ids.push(issue.assigneeUserId);
  if (roles.includes('proofreader') && issue.proofreaderUserId) ids.push(issue.proofreaderUserId);
  return ids;
}
