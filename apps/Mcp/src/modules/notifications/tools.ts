import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { McpModule } from '../../core/registry.js';
import { defineTool, json } from '../../core/tool.js';
import { id } from '../shared.js';

const channelIds = z
  .array(z.string().trim().min(1).max(50))
  .min(1)
  .max(10)
  .describe('Ids of notification channels, e.g. ["email"] (see notifications_list_channels).');
const memberIds = z
  .array(z.string().uuid())
  .max(50)
  .describe('User ids of members of the workspace (see workspaces_list_members).');

const ruleInput = {
  name: z.string().trim().min(1).max(200).describe('Rule name, e.g. "Tell the assignee".'),
  event: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('What triggers it: a key from notifications_list_events, e.g. issue.assigned.'),
  channels: channelIds,
  notifySubject: z
    .boolean()
    .default(false)
    .describe(
      'Also tell the person the event is about (the new assignee, the chosen proofreader). Not told when they did it themselves.',
    ),
  userIds: memberIds
    .default([])
    .describe('More members to tell, besides the person the event is about.'),
  enabled: z.boolean().default(true),
  subject: z
    .string()
    .max(200)
    .default('')
    .describe(
      'Subject/title template, e.g. "Please review {{issue.title}}". Blank uses the event wording.',
    ),
  message: z
    .string()
    .max(5000)
    .default('')
    .describe(
      'Message template using the placeholders of the event. Blank uses the event wording.',
    ),
};

export const notificationsModule: McpModule = {
  toolset: 'notifications',
  tools: [
    defineTool({
      name: 'notifications_list_channels',
      title: 'List notification channels',
      description:
        'Lists the ways ADK can notify people (e-mail today; others as they are added), and whether each is set up and can deliver in the active workspace.',
      toolset: 'notifications',
      access: 'read',
      routes: ['GET /notifications/channels'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/notifications/channels' })),
    }),
    defineTool({
      name: 'notifications_list_events',
      title: 'List notification events',
      description:
        'Lists the events a notification rule can listen to (an issue assigned to a person, a person chosen as proofreader...), with the placeholders their templates accept and their default wording.',
      toolset: 'notifications',
      access: 'read',
      routes: ['GET /notifications/events'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/notifications/events' })),
    }),
    defineTool({
      name: 'notifications_list_rules',
      title: 'List notification rules',
      description:
        'Lists the notification rules of the workspace: for each, the event, the channels, who is told and the wording.',
      toolset: 'notifications',
      access: 'read',
      routes: ['GET /notifications/rules'],
      input: {},
      run: async (_, { api }) =>
        json(await api.request({ method: 'GET', path: '/notifications/rules' })),
    }),
    defineTool({
      name: 'notifications_save_rule',
      title: 'Create or edit a notification rule',
      description:
        'Creates a rule ("when this happens, tell these people through these channels"), or replaces the one given in ruleId. Example: event issue.assigned, channels ["email"], notifySubject true tells whoever an issue is assigned to by e-mail. Channels and events come from notifications_list_channels and notifications_list_events; people must be members of the workspace. Requires access to Integrations.',
      toolset: 'notifications',
      access: 'write',
      routes: ['POST /notifications/rules', 'PUT /notifications/rules/:id'],
      input: {
        ruleId: id('Rule to replace; omit to create a new one.').optional(),
        ...ruleInput,
      },
      run: async ({ ruleId, notifySubject, userIds, ...rule }, { api }) =>
        json(
          await api.request({
            method: ruleId ? 'PUT' : 'POST',
            path: ruleId ? `/notifications/rules/${segment(ruleId)}` : '/notifications/rules',
            body: { ...rule, recipients: { subject: notifySubject, userIds } },
          }),
        ),
    }),
    defineTool({
      name: 'notifications_delete_rule',
      title: 'Delete a notification rule',
      description: 'Deletes a notification rule. People stop being told about that event.',
      toolset: 'notifications',
      access: 'destructive',
      routes: ['DELETE /notifications/rules/:id'],
      input: { ruleId: id('Rule id (see notifications_list_rules).') },
      run: async ({ ruleId }, { api }) =>
        json(
          await api.request({ method: 'DELETE', path: `/notifications/rules/${segment(ruleId)}` }),
        ),
    }),
    defineTool({
      name: 'notifications_send',
      title: 'Send a notification about an issue',
      description:
        'Sends a message about an issue to people and/or to the roles they hold on it (assignee, proofreader), on the chosen channels. This is the "notify" action of a workflow: when a run reaches an action node of the notifications module, call it with that node\'s notification settings (channels, userIds, roles, subject, message) and the issue of the run; when the node leaves the message blank, use the result of the previous step. Templates accept {{issue.number}}, {{issue.title}}, {{issue.status}}, {{issue.priority}}, {{actor.name}}, {{recipient.name}} and {{workspace.name}}. Returns how each delivery ended (sent, failed or skipped); a failed delivery does not fail the run.',
      toolset: 'notifications',
      access: 'write',
      routes: ['POST /notifications/send'],
      input: {
        issueId: z.string().uuid().describe('The issue the message is about.'),
        channels: channelIds,
        userIds: memberIds.default([]),
        roles: z
          .array(z.enum(['assignee', 'proofreader']))
          .max(2)
          .default([])
          .describe('Also tell whoever holds these roles on the issue.'),
        subject: z.string().trim().min(1).max(200),
        message: z.string().trim().min(1).max(5000),
      },
      run: async (body, { api }) =>
        json(await api.request({ method: 'POST', path: '/notifications/send', body })),
    }),
    defineTool({
      name: 'notifications_test',
      title: 'Send a test notification',
      description:
        'Sends a test message to the signed-in user on a channel, to check that it works before relying on it.',
      toolset: 'notifications',
      access: 'write',
      routes: ['POST /notifications/test'],
      input: { channel: z.string().trim().min(1).max(50).describe('Channel id, e.g. "email".') },
      run: async (body, { api }) =>
        json(await api.request({ method: 'POST', path: '/notifications/test', body })),
    }),
  ],
};
