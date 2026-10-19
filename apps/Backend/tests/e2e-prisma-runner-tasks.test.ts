import { describe, expect, it, vi } from 'vitest';
import { PrismaE2eRunnerTaskStore } from '../src/modules/e2e/adapters/prisma-runner-task-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const created = new Date('2026-10-13T10:00:00Z');
const modelRow = {
  id: 'task-1',
  workspaceId: 'ws',
  creationId: 'c1',
  testId: 't1',
  userId: 'u1',
  kind: 'run',
  payload: 'encrypted',
  status: 'queued',
  runnerId: null,
  runnerLabel: null,
  result: null,
  error: null,
  heartbeatAt: null,
  createdAt: created,
};
const rawRow = {
  id: 'task-1',
  workspace_id: 'ws',
  creation_id: 'c1',
  test_id: null,
  user_id: 'u1',
  kind: 'explore',
  payload: 'encrypted',
  status: 'running',
  runner_id: 'runner-1',
  runner_label: 'QA (win32)',
  result: null,
  error: null,
  heartbeat_at: created,
  created_at: created,
};

function fakeDb() {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([rawRow]),
    e2eRunnerTaskRecord: {
      create: vi.fn().mockResolvedValue(modelRow),
      findUnique: vi.fn().mockResolvedValue(modelRow),
      findFirst: vi.fn().mockResolvedValue({ status: 'running' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    e2eLocalRunnerRecord: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'runner-1', name: 'QA', platform: 'win32', version: '0.2.0', lastSeenAt: created },
        ]),
    },
  };
  return { db, store: new PrismaE2eRunnerTaskStore(db as unknown as PrismaClient) };
}

const sql = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

describe('PrismaE2eRunnerTaskStore', () => {
  it('creates, reads and claims the user tasks with SKIP LOCKED', async () => {
    const { db, store } = fakeDb();
    const input = {
      workspaceId: 'ws',
      creationId: 'c1',
      testId: 't1',
      userId: 'u1',
      kind: 'run' as const,
      payload: 'encrypted',
    };
    expect(await store.create(input)).toMatchObject({ id: 'task-1', status: 'queued' });
    expect(db.e2eRunnerTaskRecord.create).toHaveBeenCalledWith({ data: input });
    expect(await store.get('task-1')).toMatchObject({ kind: 'run', testId: 't1' });
    db.e2eRunnerTaskRecord.findUnique.mockResolvedValueOnce(null);
    expect(await store.get('missing')).toBeNull();

    const scope = { workspaceId: 'ws', userId: 'u1', createdAfter: created };
    expect(
      await store.claim({ ...scope, creationId: 'c1' }, { id: 'runner-1', label: 'QA' }),
    ).toEqual({
      id: 'task-1',
      workspaceId: 'ws',
      creationId: 'c1',
      testId: null,
      userId: 'u1',
      kind: 'explore',
      payload: 'encrypted',
      status: 'running',
      runnerId: 'runner-1',
      runnerLabel: 'QA (win32)',
      result: null,
      error: null,
      heartbeatAt: created,
      createdAt: created,
    });
    const claim = db.$queryRaw.mock.calls[0]!;
    expect(sql(claim)).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain('c1');
    db.$queryRaw.mockResolvedValueOnce([]);
    expect(await store.claim(scope, { id: 'runner-1', label: 'QA' })).toBeNull();
    expect(db.$queryRaw.mock.calls[1]).toContain(null);
  });

  it('renews, completes and removes tasks of the claiming runner only', async () => {
    const { db, store } = fakeDb();
    expect(await store.heartbeat('task-1', 'runner-1')).toBe('running');
    expect(db.e2eRunnerTaskRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'task-1', runnerId: 'runner-1', status: 'running' },
      data: { heartbeatAt: expect.any(Date) },
    });
    db.e2eRunnerTaskRecord.findFirst.mockResolvedValueOnce(null);
    expect(await store.heartbeat('task-1', 'other')).toBeNull();

    const outcome = { status: 'succeeded' as const, result: '{}', error: null };
    expect(await store.complete('task-1', 'runner-1', outcome)).toBe(true);
    expect(db.e2eRunnerTaskRecord.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'task-1', runnerId: 'runner-1', status: 'running' },
      data: { ...outcome, payload: '' },
    });
    db.e2eRunnerTaskRecord.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await store.complete('task-1', 'late', outcome)).toBe(false);

    await store.remove('task-1');
    expect(db.e2eRunnerTaskRecord.deleteMany).toHaveBeenCalledWith({ where: { id: 'task-1' } });
  });

  it('records and lists the runners a user connected', async () => {
    const { db, store } = fakeDb();
    const runner = { id: 'runner-1', name: 'QA', platform: 'win32', version: '0.2.0' };
    await store.seen({ ...runner, workspaceId: 'ws', userId: 'u1' });
    expect(db.e2eLocalRunnerRecord.upsert).toHaveBeenCalledWith({
      where: { id_workspaceId: { id: 'runner-1', workspaceId: 'ws' } },
      create: { ...runner, workspaceId: 'ws', userId: 'u1' },
      update: {
        userId: 'u1',
        name: 'QA',
        platform: 'win32',
        version: '0.2.0',
        lastSeenAt: expect.any(Date),
      },
    });
    expect(await store.listRunners('ws', 'u1', created)).toEqual([
      { ...runner, lastSeenAt: created },
    ]);
    expect(db.e2eLocalRunnerRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws', userId: 'u1', lastSeenAt: { gte: created } },
      }),
    );
  });
});
