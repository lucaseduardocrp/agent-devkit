import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaRunStore, InMemoryRunStore } from '../src/modules/issues/run-store.js';
import { PrismaIssueStore, InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { PrismaAuditPersistence } from '../src/modules/audit/prisma-audit.js';
import { EntityAuditLog, auditedIssueStore } from '../src/modules/audit/entity-audit.js';
import type { AuditPersistence } from '../src/modules/audit/audit.js';

const claimInput = {
  workspaceId: 'ws',
  issueId: 'issue-1',
  agentId: 'agent-1',
  actorId: 'user-1',
  ownerId: 'ws',
  mode: 'server' as const,
  prompt: 'Do it',
  attempt: 1,
};
const run = { id: 'run-1', ...claimInput };

function prismaRunDb() {
  const tx = {
    issueRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    agentRunRecord: {
      create: vi.fn(async ({ data }: { data: object }) => ({ ...data, status: 'queued' })),
      findFirst: vi.fn().mockResolvedValue({ ...run, status: 'running' }),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ ...run, status: 'succeeded' }),
    },
  };
  const db = {
    agentRunRecord: {
      findMany: vi.fn().mockResolvedValue([run]),
      findFirst: vi.fn().mockResolvedValue({ ...run, status: 'running' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    workspaceRecord: {
      findUnique: vi.fn().mockResolvedValue({ monthlyBudgetMicros: 500 }),
      update: vi.fn().mockResolvedValue({}),
    },
    costRateRecord: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(async ({ create }: { create: object }) => create),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  return { db, tx, store: new PrismaRunStore(db as unknown as PrismaClient) };
}

describe('PrismaRunStore', () => {
  it('reads runs scoped by workspace, issue and status', async () => {
    const { db, store } = prismaRunDb();
    expect(store.managesIssueStatus).toBe(true);
    expect(await store.incomplete()).toEqual([run]);
    expect(db.agentRunRecord.findMany).toHaveBeenLastCalledWith({
      where: { status: { in: ['queued', 'running'] } },
    });
    await store.list('ws');
    expect(db.agentRunRecord.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws' },
      orderBy: { createdAt: 'desc' },
    });
    await store.list('ws', 'issue-1');
    expect(db.agentRunRecord.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws', issueId: 'issue-1' },
      orderBy: { createdAt: 'desc' },
    });
    await store.assignedTo('ws', 'user-a');
    expect(db.agentRunRecord.findMany).toHaveBeenLastCalledWith({
      where: { workspaceId: 'ws', assigneeUserId: 'user-a' },
      orderBy: { createdAt: 'desc' },
    });
    expect(await store.get('ws', 'run-1')).toMatchObject({ id: 'run-1' });
    expect(db.agentRunRecord.findFirst).toHaveBeenCalledWith({
      where: { id: 'run-1', workspaceId: 'ws' },
    });
  });

  it('claims an issue only when it has no active run', async () => {
    const { tx, store } = prismaRunDb();
    const claimed = await store.claim(claimInput);
    expect(claimed).toMatchObject({ issueId: 'issue-1', status: 'queued' });
    const id = (claimed as { id: string }).id;
    expect(tx.issueRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'issue-1', workspaceId: 'ws', activeRunId: null },
      data: { activeRunId: id, status: 'in_progress' },
    });
    tx.issueRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.claim(claimInput)).toBeNull();
    expect(tx.agentRunRecord.create).toHaveBeenCalledTimes(1);
  });

  it('starts only queued runs', async () => {
    const { db, store } = prismaRunDb();
    expect(await store.start('ws', 'run-1')).toMatchObject({ id: 'run-1' });
    expect(db.agentRunRecord.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'run-1', workspaceId: 'ws', status: 'queued' },
      data: { status: 'running' },
    });
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.start('ws', 'run-1')).toBeNull();
  });

  it('finishes active runs and maps the final status onto the issue', async () => {
    const { tx, store } = prismaRunDb();
    for (const [status, issueStatus] of [
      ['succeeded', 'in_review'],
      ['failed', 'blocked'],
      ['cancelled', 'todo'],
    ] as const) {
      expect(await store.finish('ws', 'run-1', status, { output: 'x' })).toMatchObject({
        status: 'succeeded',
      });
      expect(tx.issueRecord.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'issue-1', workspaceId: 'ws', activeRunId: 'run-1' },
        data: { activeRunId: null, status: issueStatus },
      });
    }
    expect(tx.agentRunRecord.update.mock.calls[0]![0]).toMatchObject({
      where: { id: 'run-1' },
      data: { output: 'x', status: 'succeeded' },
    });
    tx.agentRunRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.finish('ws', 'missing', 'failed', {})).toBeNull();
    tx.agentRunRecord.findFirst.mockResolvedValueOnce({ ...run, status: 'succeeded' });
    expect(await store.finish('ws', 'run-1', 'failed', {})).toBeNull();
    expect(tx.agentRunRecord.update).toHaveBeenCalledTimes(3);
  });

  it('manages budgets and cost rates', async () => {
    const { db, store } = prismaRunDb();
    expect(await store.getBudget('ws')).toBe(500);
    db.workspaceRecord.findUnique.mockResolvedValueOnce(null);
    expect(await store.getBudget('ws')).toBe(0);
    await store.setBudget('ws', 900);
    expect(db.workspaceRecord.update).toHaveBeenCalledWith({
      where: { id: 'ws' },
      data: { monthlyBudgetMicros: 900 },
    });
    expect(await store.rates('ws')).toEqual([]);
    const rate = {
      workspaceId: 'ws',
      provider: 'openai',
      model: 'm',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    };
    expect(await store.setRate(rate)).toEqual(rate);
    expect(db.costRateRecord.upsert).toHaveBeenCalledWith({
      where: { workspaceId_provider_model: { workspaceId: 'ws', provider: 'openai', model: 'm' } },
      create: rate,
      update: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    });
    expect(await store.removeRate('ws', 'openai', 'm')).toBe(true);
    db.costRateRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.removeRate('ws', 'openai', 'm')).toBe(false);
  });
});

describe('InMemoryRunStore', () => {
  it('keeps the assignee of the issue at the start of each run', async () => {
    const store = new InMemoryRunStore();
    const unassigned = (await store.claim(claimInput))!;
    expect(unassigned.assigneeUserId).toBeNull();
    await store.finish('ws', unassigned.id, 'succeeded', {});
    const mine = (await store.claim({ ...claimInput, assigneeUserId: 'user-a' }))!;
    await store.finish('ws', mine.id, 'succeeded', {});
    await store.claim({ ...claimInput, issueId: 'issue-2', assigneeUserId: 'user-b' });
    await store.claim({ ...claimInput, workspaceId: 'other', assigneeUserId: 'user-a' });
    expect((await store.assignedTo('ws', 'user-a')).map((run) => run.id)).toEqual([mine.id]);
  });

  it('ignores runs from other workspaces and finished runs', async () => {
    const store = new InMemoryRunStore();
    const claimed = (await store.claim(claimInput))!;
    expect(await store.get('other', claimed.id)).toBeNull();
    expect(await store.start('other', claimed.id)).toBeNull();
    expect(await store.finish('other', claimed.id, 'failed', {})).toBeNull();
    await store.finish('ws', claimed.id, 'cancelled', {});
    expect(await store.start('ws', claimed.id)).toBeNull();
    expect(await store.finish('ws', claimed.id, 'failed', {})).toBeNull();
    expect(await store.incomplete()).toEqual([]);
    const rate = {
      workspaceId: 'ws',
      provider: 'p',
      model: 'm',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    };
    await store.setRate(rate);
    await store.setRate({ ...rate, workspaceId: 'other' });
    expect(await store.rates('ws')).toEqual([rate]);
    expect(await store.removeRate('ws', 'p', 'm')).toBe(true);
    expect(await store.removeRate('ws', 'p', 'm')).toBe(false);
  });
});

function prismaIssueDb() {
  const issue = { id: 'issue-1', workspaceId: 'ws', title: 'T' };
  const tx = {
    issueCounterRecord: { upsert: vi.fn().mockResolvedValue({ nextNumber: 4 }) },
    issueRecord: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'new', ...data })),
      update: vi.fn().mockResolvedValue({}),
    },
    issueCommentRecord: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: 'c1', ...data })),
    },
  };
  const db = {
    issueRecord: {
      findMany: vi.fn().mockResolvedValue([issue]),
      findFirst: vi.fn().mockResolvedValue(issue),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    issueCommentRecord: { findMany: vi.fn().mockResolvedValue([]) },
    issueInboxRecord: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(async ({ create }: { create: object }) => create),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  return { db, tx, issue, store: new PrismaIssueStore(db as unknown as PrismaClient) };
}

describe('PrismaIssueStore', () => {
  it('lists and reads issues within a workspace', async () => {
    const { db, store, issue } = prismaIssueDb();
    expect(await store.list('ws')).toEqual([issue]);
    expect(db.issueRecord.findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      orderBy: { updatedAt: 'desc' },
    });
    expect(await store.get('ws', 'issue-1')).toEqual(issue);
    expect(db.issueRecord.findFirst).toHaveBeenCalledWith({
      where: { id: 'issue-1', workspaceId: 'ws' },
    });
  });

  it('numbers new issues from the workspace counter and applies defaults', async () => {
    const { tx, store } = prismaIssueDb();
    const created = await store.create('ws', 'user-1', { title: 'New' });
    expect(created).toMatchObject({
      workspaceId: 'ws',
      number: 3,
      title: 'New',
      description: '',
      status: 'todo',
      priority: 'medium',
      createdBy: 'user-1',
    });
    expect(tx.issueCounterRecord.upsert).toHaveBeenCalledWith({
      where: { workspaceId: 'ws' },
      create: { workspaceId: 'ws', nextNumber: 2 },
      update: { nextNumber: { increment: 1 } },
    });
    expect(
      await store.create('ws', 'user-1', {
        title: 'Full',
        description: 'D',
        status: 'backlog',
        priority: 'high',
        assigneeAgentId: 'a',
        assigneeUserId: 'u',
        pbiItemId: 'p',
      }),
    ).toMatchObject({
      description: 'D',
      status: 'backlog',
      priority: 'high',
      assigneeAgentId: 'a',
      assigneeUserId: 'u',
      pbiItemId: 'p',
    });
  });

  it('updates and removes only matching issues', async () => {
    const { db, store, issue } = prismaIssueDb();
    expect(await store.update('ws', 'issue-1', { title: 'X' })).toEqual(issue);
    expect(db.issueRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'issue-1', workspaceId: 'ws' },
      data: { title: 'X' },
    });
    db.issueRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.update('ws', 'missing', { title: 'X' })).toBeNull();
    expect(await store.remove('ws', 'issue-1')).toBe(true);
    db.issueRecord.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.remove('ws', 'missing')).toBe(false);
  });

  it('stores comments, touches the issue and tracks inbox state', async () => {
    const { db, tx, store } = prismaIssueDb();
    expect(await store.comments('issue-1')).toEqual([]);
    expect(db.issueCommentRecord.findMany).toHaveBeenCalledWith({
      where: { issueId: 'issue-1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(await store.addComment('issue-1', 'user-1', 'Hello')).toEqual({
      id: 'c1',
      issueId: 'issue-1',
      authorId: 'user-1',
      body: 'Hello',
    });
    expect(tx.issueRecord.update.mock.calls[0]![0]).toMatchObject({ where: { id: 'issue-1' } });
    await store.inboxStates('ws', 'user-1');
    expect(db.issueInboxRecord.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', issue: { workspaceId: 'ws' } },
    });
    const changes = { readAt: new Date(), archivedAt: null };
    expect(await store.setInboxState('issue-1', 'user-1', changes)).toEqual({
      issueId: 'issue-1',
      userId: 'user-1',
      ...changes,
    });
    expect(db.issueInboxRecord.upsert).toHaveBeenCalledWith({
      where: { issueId_userId: { issueId: 'issue-1', userId: 'user-1' } },
      create: { issueId: 'issue-1', userId: 'user-1', ...changes },
      update: changes,
    });
  });
});

describe('InMemoryIssueStore', () => {
  it('handles missing issues, comments on unknown issues and removal of inbox state', async () => {
    const store = new InMemoryIssueStore();
    expect(await store.update('ws', 'missing', { title: 'X' })).toBeNull();
    expect(await store.remove('ws', 'missing')).toBe(false);
    const comment = await store.addComment('unknown', 'user', 'Orphan');
    expect(await store.comments('unknown')).toEqual([comment]);
    const issue = await store.create('ws', 'user', { title: 'A' });
    await store.setInboxState(issue.id, 'user', { readAt: new Date(), archivedAt: null });
    await store.setInboxState('other-issue', 'user', { readAt: null, archivedAt: null });
    expect(await store.inboxStates('ws', 'user')).toHaveLength(1);
    expect(await store.remove('ws', issue.id)).toBe(true);
    expect(await store.inboxStates('ws', 'user')).toEqual([]);
    expect(await store.get('ws', issue.id)).toBeNull();
  });
});

describe('PrismaAuditPersistence actor enrichment', () => {
  it('fills actor names from user records and filters by entity id', async () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const findMany = vi.fn().mockResolvedValue([
      { id: 'e1', actorId: 'u1', actorName: null, actorEmail: null, occurredAt },
      { id: 'e2', actorId: 'gone', actorName: 'Old', actorEmail: 'old@x', occurredAt },
      { id: 'e3', actorId: null, actorName: null, actorEmail: null, occurredAt },
    ]);
    const users = vi.fn().mockResolvedValue([{ id: 'u1', name: 'Ana', email: 'ana@x' }]);
    const persistence = new PrismaAuditPersistence({
      auditEventRecord: { findMany, count: vi.fn().mockResolvedValue(3) },
      userRecord: { findMany: users },
      $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaClient);
    const result = await persistence.list({
      workspaceId: 'ws',
      entityType: 'issue',
      entityId: 'issue-1',
      offset: 0,
      limit: 10,
    });
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { workspaceId: 'ws', entityType: 'issue', entityId: { in: ['issue-1'] } },
    });
    expect(users).toHaveBeenCalledWith({
      where: { id: { in: ['u1', 'gone'] } },
      select: { id: true, name: true, email: true },
    });
    expect(result.items).toMatchObject([
      { id: 'e1', actorName: 'Ana', actorEmail: 'ana@x', occurredAt: occurredAt.toISOString() },
      { id: 'e2', actorName: 'Old', actorEmail: 'old@x' },
      { id: 'e3', actorName: null },
    ]);
    expect(result.total).toBe(3);
  });
});

describe('auditedIssueStore', () => {
  it('skips audit entries for updates of missing issues', async () => {
    const append = vi.fn();
    const persistence = { run: append } as unknown as AuditPersistence;
    const store = auditedIssueStore(new InMemoryIssueStore(), new EntityAuditLog(persistence));
    expect(await store.update('ws', 'missing', { title: 'X' })).toBeNull();
    expect(append).not.toHaveBeenCalled();
  });
});
