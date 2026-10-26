import { describe, expect, it } from 'vitest';
import { InMemoryAgentRepository } from '../src/modules/agents/adapters/in-memory-agent-repository.js';
import { CustomAgent, type AgentRole } from '../src/modules/agents/domain/agent-entity.js';
import {
  InMemoryApiTestStore,
  type NewApiRun,
} from '../src/modules/apitests/application/api-test-store.js';
import { InMemoryE2eRunnerTaskStore } from '../src/modules/e2e/application/runner-tasks.js';
import { InMemoryAuthRepository } from '../src/modules/identity/adapters/in-memory-auth-repository.js';
import { InMemoryWorkspaceRepository } from '../src/modules/workspaces/adapters/in-memory-workspace-repository.js';

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('in-memory queues hand out the oldest queued work first', () => {
  it('claims API test runs in creation order', async () => {
    const store = new InMemoryApiTestStore();
    const run: NewApiRun = {
      workspaceId: 'w1',
      kind: 'integration',
      collectionId: 'c1',
      scenarioId: null,
      environmentId: null,
      itemIds: [],
      name: 'run',
      target: 'remote',
      requestedBy: 'u1',
      payload: '{}',
    };
    const first = await store.createRun(run);
    await later(2);
    const second = await store.createRun(run);
    expect((await store.claimRemote('worker'))?.id).toBe(first.id);
    expect((await store.claimRemote('worker'))?.id).toBe(second.id);
  });

  it('claims local runner tasks in creation order', async () => {
    const tasks = new InMemoryE2eRunnerTaskStore();
    const input = {
      workspaceId: 'ws',
      creationId: 'c1',
      testId: null,
      userId: 'user',
      kind: 'explore' as const,
      payload: '{}',
    };
    const createdAfter = new Date(Date.now() - 1000);
    const first = await tasks.create(input);
    await later(2);
    const second = await tasks.create(input);
    const scope = { workspaceId: 'ws', userId: 'user', createdAfter };
    const runner = { id: 'r1', label: 'Laptop' };
    expect((await tasks.claim(scope, runner))?.id).toBe(first.id);
    expect((await tasks.claim(scope, runner))?.id).toBe(second.id);
  });
});

describe('InMemoryAuthRepository', () => {
  it('finds the newest unconsumed code', async () => {
    const repository = new InMemoryAuthRepository();
    const code = (codeHash: string) =>
      repository.createAuthCode({
        email: 'Ana@Example.com',
        purpose: 'RESET_PASSWORD',
        codeHash,
        expiresAt: new Date(Date.now() + 60_000),
      });
    await code('old');
    await later(2);
    await code('new');
    expect(
      (await repository.findLatestAuthCode('ana@example.com', 'RESET_PASSWORD'))?.codeHash,
    ).toBe('new');
  });
});

describe('InMemoryAgentRepository', () => {
  it('lists the agents of one workspace, filtered by role', async () => {
    const repository = new InMemoryAgentRepository();
    const agent = (id: string, role: AgentRole) =>
      repository.save(
        new CustomAgent({
          id,
          workspaceId: 'ws-1',
          name: id,
          slug: id,
          description: '',
          role,
          instructions: 'Do the work.',
        }),
      );
    await agent('qa', 'QA');
    await agent('docs', 'DOCUMENTATION');
    await repository.save(
      new CustomAgent({
        id: 'elsewhere',
        workspaceId: 'ws-2',
        name: 'Elsewhere',
        slug: 'elsewhere',
        description: '',
        role: 'QA',
        instructions: 'Do the work.',
      }),
    );
    expect((await repository.listByWorkspace('ws-1', 'QA')).map((item) => item.id)).toEqual(['qa']);
  });
});

describe('InMemoryWorkspaceRepository', () => {
  it('skips memberships whose workspace no longer exists', async () => {
    const repository = new InMemoryWorkspaceRepository();
    const workspace = await repository.createWorkspace({
      name: 'Kept',
      slug: 'kept',
      ownerId: 'u1',
    });
    await repository.addMember({ workspaceId: workspace.id, userId: 'u1', role: 'ADMIN' });
    await repository.addMember({ workspaceId: 'gone', userId: 'u1', role: 'MEMBER' });
    expect((await repository.listUserWorkspaces('u1')).map((entry) => entry.workspace.id)).toEqual([
      workspace.id,
    ]);
  });
});
