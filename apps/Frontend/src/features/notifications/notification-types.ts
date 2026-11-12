/** A way to reach people (e-mail today); `available` is whether it can deliver in this workspace. */
export interface NotificationChannelDto {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

/** An event a rule can listen to, as the server describes it. */
export interface NotificationEventDto {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** What the person the event is about is called ("The person it was assigned to"). */
  readonly subjectLabel?: string;
  /** Names a text may use, e.g. `issue.title`. */
  readonly placeholders: readonly string[];
  readonly defaultSubject: string;
  readonly defaultMessage: string;
}

export interface NotificationRuleDto {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly event: string;
  readonly channels: readonly string[];
  readonly recipients: {
    readonly subject: boolean;
    readonly userIds: readonly string[];
  };
  readonly subject: string;
  readonly message: string;
}

/** What a rule is created or edited with. */
export type NotificationRuleInput = Omit<NotificationRuleDto, 'id'>;

/** How one delivery ended; `queued` means it is saved and on its way. */
export interface NotificationDeliveryResultDto {
  readonly channel: string;
  readonly userId: string;
  readonly status: 'sent' | 'queued' | 'failed' | 'skipped';
  readonly reason?: string;
}

/** A member of the workspace a notification can be addressed to. */
export interface NotificationMemberOption {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

/** A person of the list on the Notifications screen, with where they are reached (admins only). */
export interface NotificationPersonDto extends NotificationMemberOption {
  /** Address by channel id; empty for anyone who cannot see addresses. */
  readonly contacts: Readonly<Record<string, string>>;
}

/** One page of the people, and how many there are in all for the search. */
export interface NotificationPeoplePage {
  readonly people: readonly NotificationPersonDto[];
  readonly total: number;
}

/** Where an admin reaches a member on one channel (an e-mail, a chat id). */
export interface NotificationContactDto {
  readonly userId: string;
  readonly channel: string;
  readonly address: string;
}

/** Who to tell, how and what to say, as a workflow node keeps it. */
export interface NotificationNodeConfig {
  readonly channels: readonly string[];
  readonly userIds: readonly string[];
  readonly roles: readonly ('assignee' | 'proofreader')[];
  readonly subject: string;
  readonly message: string;
}

/** What the editor can offer to choose from, when it could be loaded. */
export interface NotificationOptions {
  readonly channels: readonly NotificationChannelDto[];
  readonly members: readonly NotificationMemberOption[];
  /** The options could not be loaded (the member may lack access to Integrations). */
  readonly failed: boolean;
}

export const EMPTY_NOTIFICATION_OPTIONS: NotificationOptions = {
  channels: [],
  members: [],
  failed: false,
};

export const EMPTY_NOTIFICATION_CONFIG: NotificationNodeConfig = {
  channels: [],
  userIds: [],
  roles: [],
  subject: '',
  message: '',
};
