/** An event people can attach rules to. */
export interface NotificationEventDefinition {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** What the person the event is about is called in the rule form ("the new assignee"). */
  readonly subjectLabel?: string;
  /** Names a template may use, e.g. `issue.title`. */
  readonly placeholders: readonly string[];
  readonly defaultSubject: string;
  readonly defaultMessage: string;
}

export const ISSUE_PLACEHOLDERS = [
  'issue.number',
  'issue.title',
  'issue.status',
  'issue.priority',
  'actor.name',
  'recipient.name',
  'workspace.name',
] as const;

/**
 * The events that can start a notification. Adding one is adding an entry here and publishing it
 * from where it happens; rules, channels and the API need no change.
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventDefinition[] = [
  {
    key: 'issue.assigned',
    label: 'Issue assigned to a person',
    description: 'An issue is assigned to a member of the workspace.',
    subjectLabel: 'The person it was assigned to',
    placeholders: ISSUE_PLACEHOLDERS,
    defaultSubject: 'Issue #{{issue.number}} was assigned to you',
    defaultMessage:
      '{{actor.name}} assigned you issue #{{issue.number}}: {{issue.title}} (priority {{issue.priority}}).',
  },
  {
    key: 'issue.proofreader_assigned',
    label: 'Person chosen as proofreader of an issue',
    description: 'A member of the workspace is chosen as the proofreader of an issue.',
    subjectLabel: 'The person chosen as proofreader',
    placeholders: ISSUE_PLACEHOLDERS,
    defaultSubject: 'You are the proofreader of issue #{{issue.number}}',
    defaultMessage:
      '{{actor.name}} chose you to proofread issue #{{issue.number}}: {{issue.title}}.',
  },
];

export function findNotificationEvent(key: string): NotificationEventDefinition | undefined {
  return NOTIFICATION_EVENTS.find((event) => event.key === key);
}
