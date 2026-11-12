import type { NotificationContact } from '../domain/notification.js';

/** Where each person of a workspace is reached on each channel; set by the workspace admins. */
export interface NotificationContactStore {
  /** The contacts of some people (one page of the list on screen), not of the whole workspace. */
  listForUsers(workspaceId: string, userIds: readonly string[]): Promise<NotificationContact[]>;
  /** The channel → address map of one person; read on every delivery, so it must stay cheap. */
  forUser(workspaceId: string, userId: string): Promise<Record<string, string>>;
  /** Sets an address, or removes it when the value is null. Channels not named are untouched. */
  save(
    workspaceId: string,
    userId: string,
    changes: Readonly<Record<string, string | null>>,
  ): Promise<void>;
}

export class InMemoryNotificationContactStore implements NotificationContactStore {
  private readonly contacts = new Map<string, NotificationContact & { workspaceId: string }>();

  private key(workspaceId: string, userId: string, channel: string): string {
    return JSON.stringify([workspaceId, userId, channel]);
  }

  listForUsers(workspaceId: string, userIds: readonly string[]): Promise<NotificationContact[]> {
    const wanted = new Set(userIds);
    return Promise.resolve(
      [...this.contacts.values()]
        .filter((contact) => contact.workspaceId === workspaceId && wanted.has(contact.userId))
        .map(({ userId, channel, address }) => ({ userId, channel, address })),
    );
  }

  async forUser(workspaceId: string, userId: string): Promise<Record<string, string>> {
    return Object.fromEntries(
      (await this.listForUsers(workspaceId, [userId])).map((contact) => [
        contact.channel,
        contact.address,
      ]),
    );
  }

  save(
    workspaceId: string,
    userId: string,
    changes: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    for (const [channel, address] of Object.entries(changes)) {
      const key = this.key(workspaceId, userId, channel);
      if (address === null) this.contacts.delete(key);
      else this.contacts.set(key, { workspaceId, userId, channel, address });
    }
    return Promise.resolve();
  }
}
