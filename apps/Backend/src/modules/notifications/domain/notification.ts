/**
 * Notifications are three separate ideas, so each one can grow without touching the others:
 *  - an EVENT says what happened (an issue was assigned to someone);
 *  - a RULE says what to do about it (tell this person, on these channels, with this text);
 *  - a CHANNEL says how to deliver it (e-mail today; Teams, Discord... tomorrow).
 */

/** A person a notification is addressed to. Channels pick what they need from it. */
export interface Recipient {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  /**
   * Where each channel reaches this person ({ email: 'ana@work.com' }), when an admin set it.
   * A channel falls back to what it can derive from the account (the e-mail) when it has none.
   */
  readonly addresses?: Readonly<Record<string, string>>;
}

/** One address of a person on a channel, as an admin configured it. */
export interface NotificationContact {
  readonly userId: string;
  readonly channel: string;
  readonly address: string;
}

/** What a channel delivers. Plain text first, so any channel can show it. */
export interface NotificationMessage {
  readonly title: string;
  readonly text: string;
  /** Where the recipient can act on it; channels that support links show it. */
  readonly url?: string;
}

/** The facts of an event, as the strings a template can use (`{{issue.title}}`). */
export type NotificationData = Readonly<Record<string, string>>;

export interface NotificationEvent {
  /** A key of the event catalog, e.g. `issue.assigned`. */
  readonly type: string;
  readonly workspaceId: string;
  /** Who caused it; they are not told about their own action. */
  readonly actorId?: string;
  /** The person the event is about (the new assignee), reachable as the "subject" recipient. */
  readonly subjectUserId?: string;
  /** Where the people told about it can act on it (a link to the issue); the app otherwise. */
  readonly url?: string;
  readonly data: NotificationData;
}

export interface NotificationRecipients {
  /** Also tell the person the event is about. */
  readonly subject: boolean;
  /** And these members of the workspace. */
  readonly userIds: readonly string[];
}

/** "When this happens, tell these people through these channels." */
export interface NotificationRule {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly enabled: boolean;
  /** A key of the event catalog. */
  readonly event: string;
  /** Ids of registered channels. */
  readonly channels: readonly string[];
  readonly recipients: NotificationRecipients;
  /** Templates; the event's own wording is used when empty. */
  readonly subject: string;
  readonly message: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type NotificationRuleInput = Pick<
  NotificationRule,
  'name' | 'enabled' | 'event' | 'channels' | 'recipients' | 'subject' | 'message'
>;

/** How one delivery ended; reported, never thrown. */
export interface DeliveryResult {
  readonly channel: string;
  readonly userId: string;
  /**
   * `queued`: saved to be delivered (and retried) in the background, so it survives a restart;
   * the others are final. `sent` only comes from a delivery made on the spot.
   */
  readonly status: 'sent' | 'queued' | 'failed' | 'skipped';
  /** Why it failed or was skipped. */
  readonly reason?: string;
}
