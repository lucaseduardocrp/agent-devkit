import type { NotificationMessage, Recipient } from '../domain/notification.js';

export interface NotificationDelivery {
  readonly workspaceId: string;
  readonly recipient: Recipient;
  readonly message: NotificationMessage;
}

/**
 * A way to reach people. To support a new one (Teams, Discord, Slack, SMS...), implement this and
 * register it; rules, events and workflow actions pick it up by `id` with no other change.
 */
export interface NotificationChannel {
  /** Stable key stored in rules, e.g. `email`. */
  readonly id: string;
  /** Name shown to people choosing it. */
  readonly label: string;
  /**
   * Whether it can deliver right now (e.g. its service is configured). A channel that is not
   * available is reported as skipped instead of failing the event.
   */
  isAvailable(workspaceId: string): Promise<boolean>;
  /**
   * Checks an address an admin typed for this channel; returns why it is not valid, or null.
   * Without it any text is accepted (a chat id, a handle).
   */
  validateAddress?(address: string): string | null;
  /** Throws when it cannot deliver; the service turns that into a failed result. */
  send(delivery: NotificationDelivery): Promise<void>;
}

export class NotificationChannelRegistry {
  private readonly channels = new Map<string, NotificationChannel>();

  constructor(channels: readonly NotificationChannel[] = []) {
    for (const channel of channels) this.register(channel);
  }

  register(channel: NotificationChannel): this {
    if (this.channels.has(channel.id))
      throw new Error(`Notification channel "${channel.id}" is already registered.`);
    this.channels.set(channel.id, channel);
    return this;
  }

  get(id: string): NotificationChannel | undefined {
    return this.channels.get(id);
  }

  list(): readonly NotificationChannel[] {
    return [...this.channels.values()];
  }
}
