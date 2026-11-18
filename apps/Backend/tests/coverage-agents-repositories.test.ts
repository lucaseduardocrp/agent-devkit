import { describe, expect, it } from 'vitest';
import {
  PrismaAgentRepository,
  type PrismaAgentClient,
} from '../src/modules/agents/adapters/prisma-agent-repository.js';
import {
  PrismaAgentWorkflowRepository,
  type PrismaAgentWorkflowClient,
} from '../src/modules/agents/adapters/prisma-agent-workflow-repository.js';
import { CustomAgent } from '../src/modules/agents/domain/agent-entity.js';
import type { AgentWorkflow } from '../src/modules/agents/domain/agent-workflow.js';

const updatedAt = new Date('2026-01-01T00:00:00.000Z');

const baseWorkflow = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  defaultAction: 'allow',
  steps: [],
  rules: [],
};

async function readWorkflow(definition: unknown): Promise<AgentWorkflow> {
  const client: PrismaAgentWorkflowClient = {
    agentWorkflowRecord: {
      findUnique: async () => ({ definition, updatedAt }),
      upsert: async () => ({ definition, updatedAt }),
    },
  };
  return new PrismaAgentWorkflowRepository(client).findByWorkspace('workspace');
}

const actionCanvas = (action: unknown) => ({
  nodes: [{ id: 'act', kind: 'action', x: 0, y: 0, action }],
  edges: [],
});

describe('PrismaAgentWorkflowRepository action configuration', () => {
  it('reads the notification of an action node, keeping only well-formed values', async () => {
    const workflow = await readWorkflow({
      ...baseWorkflow,
      canvas: actionCanvas({
        toolset: 'notifications',
        toolName: 'notifications_send',
        notification: {
          channels: ['email', 3],
          userIds: ['user-a', null],
          roles: ['assignee', 'proofreader', 'owner'],
          subject: 'Subject',
          message: 'Message',
        },
      }),
    });
    expect(workflow.canvas?.nodes[0]?.action).toEqual({
      toolset: 'notifications',
      toolName: 'notifications_send',
      notification: {
        channels: ['email'],
        userIds: ['user-a'],
        roles: ['assignee', 'proofreader'],
        subject: 'Subject',
        message: 'Message',
      },
    });
  });

  it('falls back to empty lists and texts when the notification fields are missing', async () => {
    const workflow = await readWorkflow({
      ...baseWorkflow,
      canvas: actionCanvas({
        toolset: 'notifications',
        notification: { channels: 'email', subject: 1, message: false },
      }),
    });
    expect(workflow.canvas?.nodes[0]?.action).toEqual({
      toolset: 'notifications',
      notification: { channels: [], userIds: [], roles: [], subject: '', message: '' },
    });
  });

  it('ignores a notification that is not an object and an action with an unknown toolset', async () => {
    const withoutNotification = await readWorkflow({
      ...baseWorkflow,
      canvas: actionCanvas({ toolset: 'issues', toolName: 'issues_comment', notification: 'x' }),
    });
    expect(withoutNotification.canvas?.nodes[0]?.action).toEqual({
      toolset: 'issues',
      toolName: 'issues_comment',
    });
    const unknown = await readWorkflow({
      ...baseWorkflow,
      canvas: actionCanvas({ toolset: 'nope', toolName: 'x' }),
    });
    expect(unknown.canvas?.nodes[0]).not.toHaveProperty('action');
    const notAnObject = await readWorkflow({ ...baseWorkflow, canvas: actionCanvas('issues') });
    expect(notAnObject.canvas?.nodes[0]).not.toHaveProperty('action');
  });
});

describe('PrismaAgentRepository sources and skills', () => {
  it('persists the hub source and skills on create and on update', async () => {
    const calls: { create: Record<string, unknown>; update: Record<string, unknown> }[] = [];
    const client: PrismaAgentClient = {
      agentRecord: {
        upsert: async (args) => {
          calls.push({
            create: args.create as unknown as Record<string, unknown>,
            update: args.update as unknown as Record<string, unknown>,
          });
          return {
            ...args.create,
            createdAt: updatedAt,
            updatedAt,
          } as never;
        },
        findUnique: async () => null,
        findMany: async () => [],
        delete: async () => ({}) as never,
      },
    };
    const source = {
      kind: 'hub-agent' as const,
      name: 'qa',
      version: '1.0.0',
      revision: 'abc',
    };
    const skills = [
      { name: 'design', description: 'When', instructions: 'Body', version: '1', revision: 'r1' },
    ];
    const agent = new CustomAgent({
      id: 'a-1',
      workspaceId: 'ws',
      name: 'QA',
      slug: 'qa',
      description: '',
      role: 'QA',
      instructions: 'Test it.',
      source,
      skills,
    });
    const saved = await new PrismaAgentRepository(client).save(agent);
    expect(calls[0]?.create).toMatchObject({ source, skills });
    expect(calls[0]?.update).toMatchObject({ source, skills });
    expect(saved.source).toEqual(source);
    expect(saved.skills).toEqual(skills);
  });
});
