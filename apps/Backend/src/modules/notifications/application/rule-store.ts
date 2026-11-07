import type { NotificationRule, NotificationRuleInput } from '../domain/notification.js';

export interface NotificationRuleStore {
  list(workspaceId: string): Promise<NotificationRule[]>;
  /** The enabled rules that listen to an event; read on every event, so it must stay cheap. */
  listForEvent(workspaceId: string, event: string): Promise<NotificationRule[]>;
  get(workspaceId: string, id: string): Promise<NotificationRule | null>;
  /** Null when `id` is given but does not exist in the workspace. */
  save(
    workspaceId: string,
    id: string | null,
    input: NotificationRuleInput,
  ): Promise<NotificationRule | null>;
  delete(workspaceId: string, id: string): Promise<boolean>;
}

export class InMemoryNotificationRuleStore implements NotificationRuleStore {
  private readonly rules = new Map<string, NotificationRule>();

  list(workspaceId: string): Promise<NotificationRule[]> {
    return Promise.resolve(
      [...this.rules.values()]
        .filter((rule) => rule.workspaceId === workspaceId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    );
  }

  async listForEvent(workspaceId: string, event: string): Promise<NotificationRule[]> {
    return (await this.list(workspaceId)).filter((rule) => rule.enabled && rule.event === event);
  }

  get(workspaceId: string, id: string): Promise<NotificationRule | null> {
    const rule = this.rules.get(id);
    return Promise.resolve(rule && rule.workspaceId === workspaceId ? rule : null);
  }

  save(
    workspaceId: string,
    id: string | null,
    input: NotificationRuleInput,
  ): Promise<NotificationRule | null> {
    const existing = id ? this.rules.get(id) : undefined;
    if (id && (!existing || existing.workspaceId !== workspaceId)) return Promise.resolve(null);
    const now = new Date();
    const rule: NotificationRule = {
      ...input,
      id: existing?.id ?? crypto.randomUUID(),
      workspaceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    return Promise.resolve(rule);
  }

  delete(workspaceId: string, id: string): Promise<boolean> {
    const rule = this.rules.get(id);
    if (!rule || rule.workspaceId !== workspaceId) return Promise.resolve(false);
    this.rules.delete(id);
    return Promise.resolve(true);
  }
}
