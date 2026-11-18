import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import {
  EMPTY_AGENT_WORKFLOW,
  type AgentWorkflowCanvas,
  type AgentWorkflowNotificationConfig,
  type AgentWorkflowStep,
} from '../src/modules/agents/domain/agent-workflow.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { RunService } from '../src/modules/issues/run-service.js';
import { InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { PrismaNotificationRuleStore } from '../src/modules/notifications/adapters/prisma-rule-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const workspaceId = 'workspace-a';
const context = { requestId: 'test', workspaceId, ownerId: 'owner-a', actorId: 'user-a' };
const agentId = 'agent-a';
const ANA = '11111111-1111-4111-8111-111111111111';

const triage: AgentWorkflowStep = { id: 'triage', name: 'Triage', instructions: 'Triage it.' };
const notifyNode = (notification?: Partial<AgentWorkflowNotificationConfig>) => ({
  id: 'tell',
  kind: 'action' as const,
  x: 2,
  y: 0,
  action: {
    toolset: 'notifications' as const,
    toolName: 'notifications_send',
    ...(notification
      ? {
          notification: {
            channels: ['email'],
            userIds: [ANA],
            roles: [],
            subject: '',
            message: '',
            ...notification,
          },
        }
      : {}),
  },
});
const canvasWith = (node: ReturnType<typeof notifyNode>): AgentWorkflowCanvas => ({
  nodes: [
    { id: 'start', kind: 'trigger', x: 0, y: 0 },
    { id: 'triage', kind: 'step', x: 1, y: 0 },
    node,
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'triage' },
    { id: 'e2', from: 'triage', to: 'tell' },
  ],
});

function setup(
  node: ReturnType<typeof notifyNode>,
  options: {
    results?: { channel: string; userId: string; status: string; reason?: string }[];
    withService?: boolean;
  } = {},
) {
  const issues = new InMemoryIssueStore();
  const gone = { value: false };
  const executeWorkflowStep = vi.fn().mockImplementation(() => {
    // Lets a test remove the issue after the step, just before the notification.
    if (gone.value) vi.spyOn(issues, 'get').mockResolvedValue(null);
    return {
      result: 'Result with {{braces}}',
      agent: { id: agentId },
      provider: 'OpenAI',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const agents = {
    getAgent: vi.fn().mockResolvedValue({ id: agentId, name: 'Agent A' }),
    getWorkflow: vi.fn().mockResolvedValue({
      ...EMPTY_AGENT_WORKFLOW,
      enabled: true,
      finalReview: false,
      steps: [triage],
      canvas: canvasWith(node),
    }),
    executeWorkflowStep,
  } as unknown as AgentService;
  const sendForIssue = vi.fn().mockResolvedValue(options.results ?? []);
  const runs = new RunService(
    new InMemoryRunStore(),
    issues,
    agents,
    undefined,
    undefined,
    undefined,
    undefined,
    options.withService === false ? undefined : { sendForIssue },
  );
  const start = async () => {
    const issue = await issues.create(workspaceId, 'user-a', {
      title: 'Ship the flow',
      assigneeAgentId: agentId,
      assigneeUserId: ANA,
    });
    const run = await runs.create(issue.id, context);
    await vi.waitFor(async () =>
      expect(['succeeded', 'failed']).toContain((await runs.get(workspaceId, run.id)).status),
    );
    return { issue, run: await runs.get(workspaceId, run.id) };
  };
  return { sendForIssue, start, gone };
}

const outputOfNode = (run: {
  workflowState: { results: readonly { stepId: string; output: string }[] } | null;
}) => run.workflowState!.results.find((result) => result.stepId === 'tell')?.output;

describe('the notifications_send action of a workflow', () => {
  it('tells the people of the node about the issue, with the previous result as the message', async () => {
    const { sendForIssue, start } = setup(notifyNode({ roles: ['assignee'] }), {
      results: [{ channel: 'email', userId: ANA, status: 'sent' }],
    });
    const { issue, run } = await start();

    expect(run.status).toBe('succeeded');
    expect(sendForIssue).toHaveBeenCalledWith({
      workspaceId,
      actorId: 'user-a',
      issue: expect.objectContaining({ id: issue.id }),
      roles: ['assignee'],
      userIds: [ANA],
      channels: ['email'],
      subject: 'Issue #{{issue.number}}: {{issue.title}}',
      // The previous result is text: its braces are not treated as a template.
      message: 'Result with { {braces}}',
    });
    expect(outputOfNode(run)).toBe('Notified: 1 sent, 0 queued, 0 failed, 0 skipped.');
  });

  it('uses the subject and message of the node when it has them', async () => {
    const { sendForIssue, start } = setup(
      notifyNode({ subject: 'Done: {{issue.title}}', message: 'It is {{issue.status}}.' }),
    );
    await start();
    expect(sendForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'Done: {{issue.title}}',
        message: 'It is {{issue.status}}.',
      }),
    );
  });

  it('says how each delivery ended without failing the run', async () => {
    const { start } = setup(notifyNode({}), {
      results: [
        { channel: 'email', userId: ANA, status: 'sent' },
        { channel: 'email', userId: 'b', status: 'failed', reason: 'SMTP is not configured.' },
        { channel: 'teams', userId: ANA, status: 'skipped', reason: 'The channel is not set up.' },
        { channel: 'teams', userId: 'b', status: 'skipped', reason: 'The channel is not set up.' },
      ],
    });
    const { run } = await start();
    expect(run.status).toBe('succeeded');
    expect(outputOfNode(run)).toBe(
      'Notified: 1 sent, 0 queued, 1 failed, 2 skipped (SMTP is not configured.; The channel is not set up.).',
    );
  });

  it('says what is on its way when deliveries are queued', async () => {
    const { start } = setup(notifyNode({}), {
      results: [
        { channel: 'email', userId: ANA, status: 'queued' },
        { channel: 'email', userId: 'b', status: 'queued' },
      ],
    });
    expect(outputOfNode((await start()).run)).toBe(
      'Notified: 0 sent, 2 queued, 0 failed, 0 skipped.',
    );
  });

  it('says so when there was no one to notify', async () => {
    const { start } = setup(notifyNode({ roles: ['proofreader'], userIds: [] }), { results: [] });
    expect(outputOfNode((await start()).run)).toBe('No one to notify.');
  });

  it('fails the run when the node is not set up, instead of skipping it quietly', async () => {
    for (const [node, expected] of [
      [notifyNode(undefined), 'at least one channel'],
      [notifyNode({ channels: [] }), 'at least one channel'],
      [notifyNode({ userIds: [], roles: [] }), 'people or roles'],
    ] as const) {
      const { run } = await setup(node).start();
      expect(run.status).toBe('failed');
      expect(run.error).toContain(expected);
    }
  });

  it('fails the run on a server that has no notifications', async () => {
    const { run } = await setup(notifyNode({}), { withService: false }).start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('not available on this server');
  });

  it('fails the run when the issue is gone', async () => {
    const ctx = setup(notifyNode({}));
    ctx.gone.value = true;
    const { run } = await ctx.start();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('no longer exists');
  });
});

describe('the notification settings of an action node', () => {
  async function app() {
    const server = createApp({
      requestContextResolver: () => ({
        requestId: 't',
        ownerId: 'ws',
        workspaceId: 'ws',
        actorId: 'user',
        memberRole: 'ADMIN',
      }),
    });
    return server;
  }
  const workflow = (notification: unknown) => ({
    enabled: true,
    steps: [{ id: 'triage', name: 'Triage', instructions: 'Triage it.' }],
    canvas: {
      nodes: [
        { id: 'start', kind: 'trigger', x: 0, y: 0 },
        { id: 'triage', kind: 'step', x: 1, y: 0 },
        {
          id: 'tell',
          kind: 'action',
          x: 2,
          y: 0,
          action: { toolset: 'notifications', toolName: 'notifications_send', notification },
        },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'triage' },
        { id: 'e2', from: 'triage', to: 'tell' },
      ],
    },
  });

  it('is accepted with its defaults and kept with the workflow', async () => {
    const server = await app();
    const saved = await request(server)
      .put('/agents/workflow')
      .send(workflow({ channels: ['email'], roles: ['proofreader'] }))
      .expect(200);
    expect(saved.body.workflow.canvas.nodes[2].action.notification).toEqual({
      channels: ['email'],
      userIds: [],
      roles: ['proofreader'],
      subject: '',
      message: '',
    });
    const read = await request(server).get('/agents/workflow').expect(200);
    expect(read.body.workflow.canvas.nodes[2].action.toolset).toBe('notifications');
  });

  it('refuses people that are not ids, and roles that do not exist', async () => {
    const server = await app();
    await request(server)
      .put('/agents/workflow')
      .send(workflow({ userIds: ['not-an-id'] }))
      .expect(400);
    await request(server)
      .put('/agents/workflow')
      .send(workflow({ roles: ['boss'] }))
      .expect(400);
  });
});

describe('PrismaNotificationRuleStore', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const row = (patch: Record<string, unknown> = {}) => ({
    id: 'r1',
    workspaceId,
    name: 'Tell',
    enabled: true,
    event: 'issue.assigned',
    channels: ['email'],
    recipients: { subject: true, userIds: [ANA] },
    subject: 's',
    message: 'm',
    createdAt: now,
    updatedAt: now,
    ...patch,
  });
  const input = {
    name: 'Tell',
    enabled: true,
    event: 'issue.assigned',
    channels: ['email'],
    recipients: { subject: true, userIds: [ANA] },
    subject: 's',
    message: 'm',
  };

  function setup() {
    const record = {
      findMany: vi.fn().mockResolvedValue([row()]),
      findFirst: vi.fn().mockResolvedValue(row()),
      create: vi.fn().mockResolvedValue(row()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const store = new PrismaNotificationRuleStore({
      notificationRuleRecord: record,
    } as unknown as PrismaClient);
    return { record, store };
  }

  it('lists the rules of a workspace, or only the enabled ones of an event', async () => {
    const { record, store } = setup();
    expect(await store.list(workspaceId)).toEqual([
      expect.objectContaining({ id: 'r1', channels: ['email'] }),
    ]);
    expect(record.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    await store.listForEvent(workspaceId, 'issue.assigned');
    expect(record.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId, event: 'issue.assigned', enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('reads one rule, or nothing', async () => {
    const { record, store } = setup();
    expect(await store.get(workspaceId, 'r1')).toMatchObject({ name: 'Tell' });
    record.findFirst.mockResolvedValue(null);
    expect(await store.get(workspaceId, 'x')).toBeNull();
  });

  it('creates, updates and deletes inside the workspace', async () => {
    const { record, store } = setup();
    expect(await store.save(workspaceId, null, input)).toMatchObject({ id: 'r1' });
    expect(record.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId,
        channels: ['email'],
        recipients: { subject: true, userIds: [ANA] },
      }),
    });
    expect(await store.save(workspaceId, 'r1', input)).toMatchObject({ id: 'r1' });
    expect(record.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', workspaceId },
      data: expect.any(Object),
    });
    record.updateMany.mockResolvedValue({ count: 0 });
    expect(await store.save(workspaceId, 'other', input)).toBeNull();
    expect(await store.delete(workspaceId, 'r1')).toBe(true);
    record.deleteMany.mockResolvedValue({ count: 0 });
    expect(await store.delete(workspaceId, 'r1')).toBe(false);
  });

  it('reads stored JSON of the wrong shape as an empty rule, never as wider access', async () => {
    const { record, store } = setup();
    record.findMany.mockResolvedValue([
      row({ channels: 'email', recipients: null }),
      row({ channels: ['email', 7], recipients: { subject: 'yes', userIds: [ANA, 5] } }),
      row({ recipients: { subject: true, userIds: 'nope' } }),
    ]);
    const [broken, mixed, noList] = await store.list(workspaceId);
    expect(broken).toMatchObject({ channels: [], recipients: { subject: false, userIds: [] } });
    expect(mixed).toMatchObject({
      channels: ['email'],
      recipients: { subject: false, userIds: [ANA] },
    });
    expect(noList!.recipients).toEqual({ subject: true, userIds: [] });
  });
});
