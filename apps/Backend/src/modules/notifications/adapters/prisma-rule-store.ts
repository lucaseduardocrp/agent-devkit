import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type { NotificationRuleStore } from '../application/rule-store.js';
import type {
  NotificationRecipients,
  NotificationRule,
  NotificationRuleInput,
} from '../domain/notification.js';

type Row = Awaited<ReturnType<PrismaClient['notificationRuleRecord']['findFirstOrThrow']>>;

/** Stored JSON can never widen what a rule does: only the known shapes are read back. */
function recipientsOf(value: unknown): NotificationRecipients {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    subject: raw['subject'] === true,
    userIds: Array.isArray(raw['userIds'])
      ? raw['userIds'].filter((id): id is string => typeof id === 'string')
      : [],
  };
}

function toRule(row: Row): NotificationRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    event: row.event,
    channels: Array.isArray(row.channels)
      ? row.channels.filter((id): id is string => typeof id === 'string')
      : [],
    recipients: recipientsOf(row.recipients),
    subject: row.subject,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const fields = (input: NotificationRuleInput) => ({
  name: input.name,
  enabled: input.enabled,
  event: input.event,
  channels: [...input.channels] as Prisma.InputJsonValue,
  recipients: {
    subject: input.recipients.subject,
    userIds: [...input.recipients.userIds],
  } as Prisma.InputJsonValue,
  subject: input.subject,
  message: input.message,
});

export class PrismaNotificationRuleStore implements NotificationRuleStore {
  constructor(private readonly db: PrismaClient) {}

  async list(workspaceId: string): Promise<NotificationRule[]> {
    const rows = await this.db.notificationRuleRecord.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRule);
  }

  async listForEvent(workspaceId: string, event: string): Promise<NotificationRule[]> {
    const rows = await this.db.notificationRuleRecord.findMany({
      where: { workspaceId, event, enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toRule);
  }

  async get(workspaceId: string, id: string): Promise<NotificationRule | null> {
    const row = await this.db.notificationRuleRecord.findFirst({ where: { id, workspaceId } });
    return row ? toRule(row) : null;
  }

  async save(
    workspaceId: string,
    id: string | null,
    input: NotificationRuleInput,
  ): Promise<NotificationRule | null> {
    if (!id) {
      return toRule(
        await this.db.notificationRuleRecord.create({ data: { workspaceId, ...fields(input) } }),
      );
    }
    const { count } = await this.db.notificationRuleRecord.updateMany({
      where: { id, workspaceId },
      data: fields(input),
    });
    return count === 0 ? null : this.get(workspaceId, id);
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    const { count } = await this.db.notificationRuleRecord.deleteMany({
      where: { id, workspaceId },
    });
    return count > 0;
  }
}
