import type {
  DeliveryResult,
  NotificationData,
  NotificationEvent,
  NotificationMessage,
  Recipient,
} from '../domain/notification.js';
import type { NotificationChannelRegistry } from './channel.js';
import { findNotificationEvent } from './event-catalog.js';
import type { NotificationOutbox, PendingDelivery } from './outbox.js';
import {
  issueNotificationData,
  issueRoleUserIds,
  type IssueRole,
  type NotifiableIssue,
} from './issue-notifications.js';
import type { NotificationRuleStore } from './rule-store.js';
import { renderTemplate } from './template.js';

/** Finds the people to notify. Null for someone who is not (or no longer) a member. */
export interface RecipientDirectory {
  find(workspaceId: string, userId: string): Promise<Recipient | null>;
}

export interface NotificationServiceOptions {
  readonly channels: NotificationChannelRegistry;
  readonly rules: NotificationRuleStore;
  readonly directory: RecipientDirectory;
  /** Shown as `{{workspace.name}}`. */
  readonly workspaceName?: (workspaceId: string) => Promise<string | null>;
  /** Where messages send people to; the web app. */
  readonly appUrl?: string;
  /**
   * Where deliveries are kept until a worker sends them. Without one they are sent on the spot,
   * which a restart can interrupt.
   */
  readonly outbox?: NotificationOutbox;
  /** Something was just queued: the worker can look now. */
  readonly onQueued?: () => void;
  readonly log?: (message: string, error?: unknown) => void;
}

/** A message sent straight to people, without a rule: a workflow action, a test. */
export interface DirectNotification {
  readonly workspaceId: string;
  readonly actorId?: string;
  readonly userIds: readonly string[];
  readonly channels: readonly string[];
  /** Where the message sends people to; the app when omitted. */
  readonly url?: string;
  readonly subject: string;
  readonly message: string;
  /** Extra values for the templates, on top of the ones every notification has. */
  readonly data?: NotificationData;
  /** Send now and report how it went, instead of queueing: to check that a channel works. */
  readonly immediate?: boolean;
}

/** A message about an issue, addressed to people and/or to the roles they hold on it. */
export interface IssueNotification extends Omit<DirectNotification, 'data'> {
  readonly issue: NotifiableIssue;
  readonly roles?: readonly IssueRole[];
}

const MAX_REASON = 300;

/**
 * Turns what happens in the product into messages to people. It never throws: a notification
 * that cannot be delivered must not fail the issue update or the workflow run that caused it, so
 * every outcome comes back as a result to look at (or ignore).
 */
export class NotificationService {
  constructor(private readonly options: NotificationServiceOptions) {}

  /** The channels people can choose, and whether each can deliver in this workspace now. */
  async channels(
    workspaceId: string,
  ): Promise<{ id: string; label: string; available: boolean }[]> {
    return Promise.all(
      this.options.channels.list().map(async (channel) => ({
        id: channel.id,
        label: channel.label,
        available: await channel.isAvailable(workspaceId).catch(() => false),
      })),
    );
  }

  /** An event happened: tell the people its rules point at. */
  async dispatch(event: NotificationEvent): Promise<DeliveryResult[]> {
    try {
      const definition = findNotificationEvent(event.type);
      if (!definition) return [];
      const rules = await this.options.rules.listForEvent(event.workspaceId, event.type);
      const results: DeliveryResult[] = [];
      for (const rule of rules) {
        const userIds = new Set<string>(rule.recipients.userIds);
        // Whoever caused the event is not told about their own action.
        if (rule.recipients.subject && event.subjectUserId && event.subjectUserId !== event.actorId)
          userIds.add(event.subjectUserId);
        results.push(
          ...(await this.deliver({
            workspaceId: event.workspaceId,
            userIds: [...userIds],
            channels: rule.channels,
            subject: rule.subject || definition.defaultSubject,
            message: rule.message || definition.defaultMessage,
            data: event.data,
            ...(event.url ? { url: event.url } : {}),
            ...(event.actorId ? { actorId: event.actorId } : {}),
          })),
        );
      }
      return results;
    } catch (error) {
      this.log('[Notifications] Could not dispatch an event:', error);
      return [];
    }
  }

  /** Sends a message straight to people, without a rule. */
  async send(notification: DirectNotification): Promise<DeliveryResult[]> {
    try {
      return await this.deliver(notification);
    } catch (error) {
      this.log('[Notifications] Could not send a notification:', error);
      return [];
    }
  }

  /**
   * The address that opens an issue in the app: the workspace and the issue travel in the link,
   * so it works for whoever follows it (after signing in). Undefined when no app address is set.
   */
  issueUrl(workspaceId: string, issueId: string): string | undefined {
    const base = this.options.appUrl?.replace(/\/+$/, '');
    if (!base) return undefined;
    return `${base}/?${new URLSearchParams({ workspace: workspaceId, issue: issueId }).toString()}`;
  }

  /** A message about an issue; its values fill the template and its roles name recipients. */
  sendForIssue(notification: IssueNotification): Promise<DeliveryResult[]> {
    const { issue, roles = [], ...rest } = notification;
    const url = this.issueUrl(rest.workspaceId, issue.id);
    return this.send({
      ...rest,
      ...(url ? { url } : {}),
      userIds: [...rest.userIds, ...issueRoleUserIds(issue, roles)],
      data: issueNotificationData(issue),
    });
  }

  private async deliver(notification: DirectNotification): Promise<DeliveryResult[]> {
    const { workspaceId } = notification;
    const shared: Record<string, string> = {
      ...notification.data,
      'workspace.name': (await this.options.workspaceName?.(workspaceId).catch(() => null)) ?? '',
    };
    if (!shared['actor.name'])
      shared['actor.name'] = notification.actorId
        ? ((await this.options.directory.find(workspaceId, notification.actorId))?.name ??
          'Someone')
        : 'Someone';

    const results: DeliveryResult[] = [];
    // With an outbox, what can be delivered is written down first and sent by the worker.
    const queue: PendingDelivery[] | undefined =
      this.options.outbox && !notification.immediate ? [] : undefined;
    for (const userId of new Set(notification.userIds)) {
      const recipient = await this.options.directory.find(workspaceId, userId);
      if (!recipient) {
        for (const channel of notification.channels)
          results.push({
            channel,
            userId,
            status: 'skipped',
            reason: 'Not a member of the workspace.',
          });
        continue;
      }
      const data = { ...shared, 'recipient.name': recipient.name };
      const message: NotificationMessage = {
        title: renderTemplate(notification.subject, data),
        text: renderTemplate(notification.message, data),
        ...((notification.url ?? this.options.appUrl)
          ? { url: notification.url ?? this.options.appUrl! }
          : {}),
      };
      for (const channelId of new Set(notification.channels))
        results.push(await this.deliverOn(channelId, workspaceId, recipient, message, queue));
    }
    return queue?.length ? this.enqueue(queue, results) : results;
  }

  /** Saves the deliveries; when that fails, none of them is on its way, and the results say so. */
  private async enqueue(
    queue: readonly PendingDelivery[],
    results: DeliveryResult[],
  ): Promise<DeliveryResult[]> {
    try {
      await this.options.outbox!.enqueue(queue);
      this.options.onQueued?.();
      return results;
    } catch (error) {
      this.log('[Notifications] Could not queue the deliveries:', error);
      return results.map((result) =>
        result.status === 'queued'
          ? { ...result, status: 'failed', reason: 'Could not be queued.' }
          : result,
      );
    }
  }

  private async deliverOn(
    channelId: string,
    workspaceId: string,
    recipient: Recipient,
    message: NotificationMessage,
    queue?: PendingDelivery[],
  ): Promise<DeliveryResult> {
    const base = { channel: channelId, userId: recipient.userId };
    const channel = this.options.channels.get(channelId);
    if (!channel) return { ...base, status: 'skipped', reason: 'Unknown channel.' };
    try {
      if (!(await channel.isAvailable(workspaceId)))
        return { ...base, status: 'skipped', reason: 'The channel is not set up.' };
      if (queue) {
        queue.push({ workspaceId, channel: channelId, recipient, message });
        return { ...base, status: 'queued' };
      }
      await channel.send({ workspaceId, recipient, message });
      return { ...base, status: 'sent' };
    } catch (error) {
      this.log(`[Notifications] ${channelId} could not deliver to ${recipient.userId}:`, error);
      const reason = error instanceof Error ? error.message : 'Delivery failed.';
      return { ...base, status: 'failed', reason: reason.slice(0, MAX_REASON) };
    }
  }

  private log(message: string, error?: unknown): void {
    (this.options.log ?? ((text, cause) => console.error(text, cause)))(message, error);
  }
}
