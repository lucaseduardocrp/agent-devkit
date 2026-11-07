import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
  ClaimedDelivery,
  NotificationOutbox,
  PendingDelivery,
} from '../application/outbox.js';
import type { NotificationMessage, Recipient } from '../domain/notification.js';

/** What makes a delivery due: waiting for its time, or held by a worker that died. */
const due = (now: Date) => ({
  OR: [
    { status: 'pending', nextAttemptAt: { lte: now } },
    { status: 'sending', claimedUntil: { lt: now } },
  ],
});

/** The outbox in Postgres, shared by every API process that uses the database. */
export class PrismaNotificationOutbox implements NotificationOutbox {
  constructor(private readonly db: PrismaClient) {}

  async enqueue(deliveries: readonly PendingDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;
    await this.db.notificationDeliveryRecord.createMany({
      data: deliveries.map((delivery) => ({
        workspaceId: delivery.workspaceId,
        channel: delivery.channel,
        recipient: { ...delivery.recipient },
        message: { ...delivery.message },
      })),
    });
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedDelivery[]> {
    const candidates = await this.db.notificationDeliveryRecord.findMany({
      where: due(now),
      orderBy: { nextAttemptAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    if (candidates.length === 0) return [];
    // The conditions are checked again as the rows are taken, so two workers never share one.
    const token = crypto.randomUUID();
    await this.db.notificationDeliveryRecord.updateMany({
      where: { id: { in: candidates.map((row) => row.id) }, ...due(now) },
      data: {
        status: 'sending',
        claimToken: token,
        claimedUntil: new Date(now.getTime() + leaseMs),
        attempts: { increment: 1 },
      },
    });
    const rows = await this.db.notificationDeliveryRecord.findMany({
      where: { claimToken: token, status: 'sending' },
    });
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      channel: row.channel,
      attempts: row.attempts,
      recipient: row.recipient as unknown as Recipient,
      message: row.message as unknown as NotificationMessage,
    }));
  }

  async markSent(id: string, at: Date): Promise<void> {
    await this.db.notificationDeliveryRecord.updateMany({
      where: { id },
      data: { status: 'sent', sentAt: at, claimToken: null, claimedUntil: null, lastError: null },
    });
  }

  async markRetry(id: string, at: Date, error: string): Promise<void> {
    await this.db.notificationDeliveryRecord.updateMany({
      where: { id },
      data: {
        status: 'pending',
        nextAttemptAt: at,
        claimToken: null,
        claimedUntil: null,
        lastError: error,
      },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db.notificationDeliveryRecord.updateMany({
      where: { id },
      data: { status: 'failed', claimToken: null, claimedUntil: null, lastError: error },
    });
  }

  async purge(before: Date): Promise<number> {
    const { count } = await this.db.notificationDeliveryRecord.deleteMany({
      where: {
        OR: [
          { status: 'sent', sentAt: { lt: before } },
          { status: 'failed', createdAt: { lt: before } },
        ],
      },
    });
    return count;
  }
}
