import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import {
  InMemoryRunStore,
  PrismaRunStore,
  type WorkflowRunState,
} from '../src/modules/issues/run-store.js';
import { PrismaIssueStore } from '../src/modules/issues/issue-store.js';

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

const state: WorkflowRunState = {
  enabled: true,
  autonomy: 'balanced',
  finalReview: true,
  uncertaintyBehavior: 'ask',
  issueCreationBehavior: 'ask',
  steps: [],
  currentStepIndex: 0,
  results: [],
  totalCostMicros: 0,
  allStepsPriced: true,
};

function prismaDb(status = 'running') {
  const db = {
    agentRunRecord: {
      findFirst: vi.fn().mockResolvedValue({ id: 'run-1', issueId: 'issue-1', status }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    issueRecord: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $transaction: vi.fn(async (work: (client: typeof db) => Promise<unknown>) => work(db)),
  };
  return { db, store: new PrismaRunStore(db as unknown as PrismaClient) };
}

describe('PrismaRunStore workflow state', () => {
  it('checkpoints a running run for review and marks the issue in review', async () => {
    const { db, store } = prismaDb();
    const checked = await store.checkpoint('ws', 'run-1', 'waiting_review', state, 'Output');
    expect(checked).toMatchObject({ id: 'run-1' });
    expect(db.agentRunRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', workspaceId: 'ws', status: 'running' },
      data: { status: 'waiting_review', workflowState: state, output: 'Output' },
    });
    expect(db.issueRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'issue-1', workspaceId: 'ws', activeRunId: 'run-1' },
      data: { status: 'in_review' },
    });
  });

  it('does not checkpoint runs that are missing, not running or finished concurrently', async () => {
    const { db, store } = prismaDb();
    db.agentRunRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.checkpoint('ws', 'run-1', 'waiting_input', state, '')).toBeNull();
    db.agentRunRecord.findFirst.mockResolvedValueOnce({ id: 'run-1', status: 'queued' });
    expect(await store.checkpoint('ws', 'run-1', 'waiting_input', state, '')).toBeNull();
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.checkpoint('ws', 'run-1', 'waiting_input', state, '')).toBeNull();
    expect(db.issueRecord.updateMany).not.toHaveBeenCalled();
  });

  it('stores progress only for running runs', async () => {
    const { db, store } = prismaDb();
    const metrics = { provider: 'OpenAI', costMicros: 5 };
    expect(await store.progress('ws', 'run-1', state, 'Out', metrics)).toMatchObject({
      id: 'run-1',
    });
    expect(db.agentRunRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', workspaceId: 'ws', status: 'running' },
      data: { provider: 'OpenAI', costMicros: 5, workflowState: state, output: 'Out' },
    });
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.progress('ws', 'run-1', state, 'Out', {})).toBeNull();
  });

  it('resumes a waiting run and puts the issue back in progress', async () => {
    const { db, store } = prismaDb('queued');
    expect(await store.resume('ws', 'run-1', state, 'Out')).toMatchObject({ id: 'run-1' });
    expect(db.agentRunRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
        workspaceId: 'ws',
        status: { in: ['waiting_review', 'waiting_input'] },
      },
      data: { status: 'queued', workflowState: state, output: 'Out' },
    });
    expect(db.issueRecord.updateMany).toHaveBeenCalledWith({
      where: { activeRunId: 'run-1', workspaceId: 'ws' },
      data: { status: 'in_progress' },
    });
    db.agentRunRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.resume('ws', 'run-1', state, 'Out')).toBeNull();
  });

  it('stores the workflow state of a claim, or a database null when there is none', async () => {
    const { db, store } = prismaDb();
    db.issueRecord.updateMany.mockResolvedValue({ count: 1 });
    await store.claim({ ...claimInput, workflowState: state });
    expect(db.agentRunRecord.create.mock.calls[0]?.[0].data.workflowState).toBe(state);
    await store.claim({ ...claimInput, workflowState: null });
    expect(db.agentRunRecord.create.mock.calls[1]?.[0].data.workflowState).toBe(Prisma.DbNull);
    await store.claim(claimInput);
    expect(db.agentRunRecord.create.mock.calls[2]?.[0].data.workflowState).toBeUndefined();
  });
});

describe('InMemoryRunStore workflow state', () => {
  it('only checkpoints running runs and only resumes waiting runs', async () => {
    const store = new InMemoryRunStore();
    expect(await store.checkpoint('ws', 'missing', 'waiting_review', state, '')).toBeNull();
    expect(await store.progress('ws', 'missing', state, '', {})).toBeNull();
    expect(await store.resume('ws', 'missing', state, '')).toBeNull();
    const claimed = (await store.claim(claimInput))!;
    expect(await store.checkpoint('ws', claimed.id, 'waiting_review', state, '')).toBeNull();
    expect(await store.progress('ws', claimed.id, state, '', {})).toBeNull();
    expect(await store.resume('ws', claimed.id, state, '')).toBeNull();
    await store.start('ws', claimed.id);
    expect(await store.progress('ws', claimed.id, state, 'Half', { provider: 'p' })).toMatchObject({
      output: 'Half',
      provider: 'p',
      status: 'running',
    });
    expect(
      await store.checkpoint('ws', claimed.id, 'waiting_input', state, 'Question'),
    ).toMatchObject({ status: 'waiting_input', output: 'Question' });
    expect(await store.resume('ws', claimed.id, state, 'Answer')).toMatchObject({
      status: 'queued',
      output: 'Answer',
    });
  });
});

describe('PrismaIssueStore lookups', () => {
  it('returns null for an issue that does not exist', async () => {
    const db = { issueRecord: { findFirst: vi.fn().mockResolvedValue(null) } };
    const store = new PrismaIssueStore(db as unknown as PrismaClient);
    expect(await store.get('ws', 'missing')).toBeNull();
    expect(db.issueRecord.findFirst).toHaveBeenCalledWith({
      where: { id: 'missing', workspaceId: 'ws', deletedAt: null },
    });
  });
});
