import { Router, type Request } from 'express';
import { z } from 'zod';
import { ApplicationError } from '../../shared/errors.js';
import type { IssueStore } from '../../modules/issues/issue-store.js';
import type { NotificationChannelRegistry } from '../../modules/notifications/application/channel.js';
import {
  NOTIFICATION_EVENTS,
  findNotificationEvent,
} from '../../modules/notifications/application/event-catalog.js';
import type { NotificationService } from '../../modules/notifications/application/notification-service.js';
import type { NotificationRuleStore } from '../../modules/notifications/application/rule-store.js';
import type { NotificationRuleInput } from '../../modules/notifications/domain/notification.js';
import type { NotificationContactStore } from '../../modules/notifications/application/contact-store.js';
import { requireAuth, requireWorkspaceRole } from './auth-middleware.js';
import type { RequestContextResolver } from './compatibility-routes.js';
import { parseBody, parseQuery } from './validation.js';

const userIds = z.array(z.string().uuid()).max(50);
const channelIds = z.array(z.string().trim().min(1).max(50)).min(1).max(10);
const ruleFields = z.object({
  name: z.string().trim().min(1).max(200),
  enabled: z.boolean().default(true),
  event: z.string().trim().min(1).max(100),
  channels: channelIds,
  recipients: z.object({ subject: z.boolean().default(false), userIds: userIds.default([]) }),
  subject: z.string().max(200).default(''),
  message: z.string().max(5000).default(''),
});
const sendFields = z.object({
  userIds: userIds.default([]),
  roles: z
    .array(z.enum(['assignee', 'proofreader']))
    .max(2)
    .default([]),
  channels: channelIds,
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
  issueId: z.string().uuid(),
});
// One page of the people list: where to start, how many, and what the name or e-mail has.
const peopleQuery = z.object({
  search: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});
const testFields = z.object({ channel: z.string().trim().min(1).max(50) });
// An empty address removes the contact of that channel.
const contactFields = z.object({
  contacts: z.record(z.string().trim().min(1).max(50), z.string().trim().max(320)),
});

export interface NotificationRoutesDependencies {
  readonly service: NotificationService;
  readonly rules: NotificationRuleStore;
  readonly channels: NotificationChannelRegistry;
  readonly issues: Pick<IssueStore, 'get'>;
  /** Whether a user is a member of the workspace (rules can only name members). */
  readonly isMember: (workspaceId: string, userId: string) => Promise<boolean>;
  /** Where each member is reached on each channel; managed by the workspace admins. */
  readonly contacts: NotificationContactStore;
  /** One page of the workspace's people, found by name or e-mail. */
  readonly people: (
    workspaceId: string,
    query: { readonly search: string; readonly offset: number; readonly limit: number },
  ) => Promise<{
    readonly people: readonly {
      readonly id: string;
      readonly name: string;
      readonly email: string;
    }[];
    readonly total: number;
  }>;
}

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}

function actorId(request: Request): string {
  const id = request.context?.actorId;
  if (!id) throw new ApplicationError('UNAUTHENTICATED', 'Sign in to continue.', 401);
  return id;
}

export function createNotificationsRouter(
  deps: NotificationRoutesDependencies,
  contextResolver?: RequestContextResolver,
): Router {
  const router = Router();
  const { service, rules, channels, issues } = deps;
  if (contextResolver)
    router.use('/notifications', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });

  /** Checks a rule against what exists: its event, its channels and its people. */
  async function validateRule(
    workspace: string,
    input: z.output<typeof ruleFields>,
  ): Promise<NotificationRuleInput> {
    const event = findNotificationEvent(input.event);
    if (!event)
      throw new ApplicationError('NOTIFICATION_EVENT_UNKNOWN', 'This event does not exist.', 400, [
        { field: 'event' },
      ]);
    const unknown = input.channels.filter((id) => !channels.get(id));
    if (unknown.length)
      throw new ApplicationError(
        'NOTIFICATION_CHANNEL_UNKNOWN',
        `Unknown channel: ${unknown.join(', ')}.`,
        400,
        [{ field: 'channels' }],
        { channels: unknown.join(', ') },
      );
    if (input.recipients.subject && !event.subjectLabel)
      throw new ApplicationError(
        'NOTIFICATION_RECIPIENT_INVALID',
        'This event has no person it is about.',
        400,
        [{ field: 'recipients.subject' }],
      );
    if (!input.recipients.subject && input.recipients.userIds.length === 0)
      throw new ApplicationError('NOTIFICATION_RECIPIENT_INVALID', 'Choose who to notify.', 400, [
        { field: 'recipients' },
      ]);
    for (const userId of input.recipients.userIds)
      if (!(await deps.isMember(workspace, userId)))
        throw new ApplicationError(
          'NOTIFICATION_RECIPIENT_INVALID',
          'Only members of the workspace can be notified.',
          400,
          [{ field: 'recipients.userIds' }],
        );
    return { ...input, recipients: { ...input.recipients } };
  }

  router.get('/notifications/channels', requireAuth, async (request, response, next) => {
    try {
      response.json({ channels: await service.channels(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });

  // The people of the workspace, a page at a time so a large workspace stays light. Where each
  // one is reached is personal data, so only admins get it.
  router.get('/notifications/people', requireAuth, async (request, response, next) => {
    try {
      const workspace = workspaceId(request);
      if (!request.context?.memberRole)
        throw new ApplicationError('FORBIDDEN', 'Workspace membership required.', 403);
      const query = parseQuery(peopleQuery, request);
      const page = await deps.people(workspace, query);
      const found =
        request.context.memberRole === 'ADMIN'
          ? await deps.contacts.listForUsers(
              workspace,
              page.people.map((person) => person.id),
            )
          : [];
      response.json({
        total: page.total,
        people: page.people.map((person) => ({
          userId: person.id,
          name: person.name,
          email: person.email,
          contacts: Object.fromEntries(
            found
              .filter((contact) => contact.userId === person.id)
              .map((contact) => [contact.channel, contact.address]),
          ),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/notifications/contacts/:userId',
    requireAuth,
    requireWorkspaceRole([]),
    async (request, response, next) => {
      try {
        const workspace = workspaceId(request);
        const parsedUser = z.string().uuid().safeParse(request.params['userId']);
        if (!parsedUser.success)
          throw new ApplicationError('NOTIFICATION_RECIPIENT_INVALID', 'Invalid user.', 400);
        const userId = parsedUser.data;
        const { contacts } = parseBody(contactFields, request);
        if (!(await deps.isMember(workspace, userId)))
          throw new ApplicationError(
            'NOTIFICATION_RECIPIENT_INVALID',
            'Only members of the workspace have contacts.',
            400,
          );
        const changes: Record<string, string | null> = {};
        for (const [channelId, address] of Object.entries(contacts)) {
          const channel = channels.get(channelId);
          if (!channel)
            throw new ApplicationError(
              'NOTIFICATION_CHANNEL_UNKNOWN',
              `Unknown channel: ${channelId}.`,
              400,
              [{ field: `contacts.${channelId}` }],
            );
          const invalid = address ? channel.validateAddress?.(address) : null;
          if (invalid)
            throw new ApplicationError(
              'NOTIFICATION_CONTACT_INVALID',
              invalid,
              400,
              [{ field: `contacts.${channelId}` }],
              { detail: invalid },
            );
          changes[channelId] = address || null;
        }
        await deps.contacts.save(workspace, userId, changes);
        response.json({
          contacts: await deps.contacts.listForUsers(workspace, [userId]),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/notifications/events', requireAuth, (_request, response) => {
    response.json({ events: NOTIFICATION_EVENTS });
  });

  router.get('/notifications/rules', requireAuth, async (request, response, next) => {
    try {
      response.json({ rules: await rules.list(workspaceId(request)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/notifications/rules', requireAuth, async (request, response, next) => {
    try {
      const workspace = workspaceId(request);
      const input = await validateRule(workspace, parseBody(ruleFields, request));
      response.status(201).json({ rule: await rules.save(workspace, null, input) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/notifications/rules/:id', requireAuth, async (request, response, next) => {
    try {
      const workspace = workspaceId(request);
      const input = await validateRule(workspace, parseBody(ruleFields, request));
      const rule = await rules.save(workspace, String(request.params['id']), input);
      if (!rule)
        throw new ApplicationError(
          'NOTIFICATION_RULE_NOT_FOUND',
          'Notification rule not found.',
          404,
        );
      response.json({ rule });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/notifications/rules/:id', requireAuth, async (request, response, next) => {
    try {
      if (!(await rules.delete(workspaceId(request), String(request.params['id']))))
        throw new ApplicationError(
          'NOTIFICATION_RULE_NOT_FOUND',
          'Notification rule not found.',
          404,
        );
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // A message about an issue sent on purpose: the workflow action in host runs, or a person.
  router.post('/notifications/send', requireAuth, async (request, response, next) => {
    try {
      const workspace = workspaceId(request);
      const body = parseBody(sendFields, request);
      const issue = await issues.get(workspace, body.issueId);
      if (!issue) throw new ApplicationError('ISSUE_NOT_FOUND', 'Issue not found.', 404);
      response.json({
        results: await service.sendForIssue({
          workspaceId: workspace,
          actorId: actorId(request),
          issue,
          roles: body.roles,
          userIds: body.userIds,
          channels: body.channels,
          subject: body.subject,
          message: body.message,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  // Sends a test message to the signed-in person, to check that a channel works.
  router.post('/notifications/test', requireAuth, async (request, response, next) => {
    try {
      const { channel } = parseBody(testFields, request);
      if (!channels.get(channel))
        throw new ApplicationError('NOTIFICATION_CHANNEL_UNKNOWN', 'Unknown channel.', 400);
      response.json({
        results: await service.send({
          workspaceId: workspaceId(request),
          actorId: actorId(request),
          userIds: [actorId(request)],
          channels: [channel],
          // The point is to see whether the channel works, so it is not queued.
          immediate: true,
          subject: 'ADK test notification',
          message:
            'This is a test: {{recipient.name}}, your {{workspace.name}} notifications work.',
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
