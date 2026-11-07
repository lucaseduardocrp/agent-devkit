import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { NotificationContactStore } from '../application/contact-store.js';
import type { NotificationContact } from '../domain/notification.js';

export class PrismaNotificationContactStore implements NotificationContactStore {
  constructor(private readonly db: PrismaClient) {}

  async listForUsers(
    workspaceId: string,
    userIds: readonly string[],
  ): Promise<NotificationContact[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.notificationContactRecord.findMany({
      where: { workspaceId, userId: { in: [...userIds] } },
    });
    return rows.map(({ userId, channel, address }) => ({ userId, channel, address }));
  }

  async forUser(workspaceId: string, userId: string): Promise<Record<string, string>> {
    const rows = await this.db.notificationContactRecord.findMany({
      where: { workspaceId, userId },
    });
    return Object.fromEntries(rows.map((row) => [row.channel, row.address]));
  }

  async save(
    workspaceId: string,
    userId: string,
    changes: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    await this.db.$transaction(
      Object.entries(changes).map(([channel, address]) =>
        address === null
          ? this.db.notificationContactRecord.deleteMany({
              where: { workspaceId, userId, channel },
            })
          : this.db.notificationContactRecord.upsert({
              where: { workspaceId_userId_channel: { workspaceId, userId, channel } },
              create: { workspaceId, userId, channel, address },
              update: { address },
            }),
      ),
    );
  }
}
