import { describe, expect, it, vi } from 'vitest';
import { PrismaE2eJobQueue } from '../src/modules/e2e/adapters/prisma-e2e-queue.js';
import { PrismaE2eArtifactStore } from '../src/modules/e2e/adapters/prisma-e2e-artifact-store.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

const rawRow = {
  id: 'j1',
  workspace_id: 'ws',
  creation_id: 'c1',
  kind: 'execute',
  test_ids: ['t1', 2],
  status: 'running',
  attempts: 1,
  worker_id: 'w',
  heartbeat_at: new Date(),
  created_at: new Date(),
};
const modelRow = {
  id: 'j2',
  workspaceId: 'ws',
  creationId: 'c2',
  kind: 'generate',
  testIds: null,
  status: 'running',
  attempts: 2,
  workerId: 'dead',
  heartbeatAt: new Date(0),
  createdAt: new Date(),
};

function fakeDb() {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([rawRow]),
    e2eJobRecord: {
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    e2eArtifactRecord: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ content: new Uint8Array([1, 2]) }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  return { db, client: db as unknown as PrismaClient };
}

const sql = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

describe('PrismaE2eJobQueue', () => {
  it('enqueues atomically and claims with SKIP LOCKED', async () => {
    const { db, client } = fakeDb();
    const queue = new PrismaE2eJobQueue(client);
    expect(
      await queue.enqueue({
        workspaceId: 'ws',
        creationId: 'c1',
        kind: 'execute',
        testIds: ['t1'],
      }),
    ).toMatchObject({ id: 'j1', creationId: 'c1', testIds: ['t1'], workerId: 'w' });
    const insert = db.$queryRaw.mock.calls[0]!;
    expect(sql(insert)).toContain(
      `ON CONFLICT ("creation_id") WHERE "status" IN ('queued', 'running')`,
    );
    expect(insert).toContain('["t1"]');

    expect(await queue.claim('w')).toMatchObject({ status: 'running' });
    expect(sql(db.$queryRaw.mock.calls[1]!)).toContain('FOR UPDATE SKIP LOCKED');

    db.$queryRaw.mockResolvedValue([]);
    expect(
      await queue.enqueue({ workspaceId: 'ws', creationId: 'c1', kind: 'generate', testIds: [] }),
    ).toBeNull();
    expect(await queue.claim('w')).toBeNull();
  });

  it('tracks heartbeats, finishing, cancellation and active jobs per creation', async () => {
    const { db, client } = fakeDb();
    const queue = new PrismaE2eJobQueue(client);
    expect(await queue.hasActive('ws', 'c1')).toBe(true);
    expect(db.e2eJobRecord.count).toHaveBeenCalledWith({
      where: { workspaceId: 'ws', creationId: 'c1', status: { in: ['queued', 'running'] } },
    });
    expect(await queue.heartbeat('j1', 'w')).toBe(true);
    await queue.finish('j1', 'w', 'succeeded');
    expect(db.e2eJobRecord.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'j1', workerId: 'w', status: 'running' },
      data: { status: 'succeeded' },
    });
    expect(await queue.cancel('ws', 'c1')).toBe(true);
    db.e2eJobRecord.count.mockResolvedValue(0);
    db.e2eJobRecord.updateMany.mockResolvedValue({ count: 0 });
    expect(await queue.hasActive('ws', 'c1')).toBe(false);
    expect(await queue.heartbeat('j1', 'w')).toBe(false);
    expect(await queue.cancel('ws', 'c1')).toBe(false);
  });

  it('requeues or fails abandoned jobs, skipping ones that came back to life', async () => {
    const { db, client } = fakeDb();
    db.e2eJobRecord.findMany.mockResolvedValue([
      modelRow,
      { ...modelRow, id: 'j3', attempts: 1, testIds: ['t9'] },
      { ...modelRow, id: 'j4', attempts: 1 },
    ]);
    db.e2eJobRecord.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const queue = new PrismaE2eJobQueue(client);
    const staleBefore = new Date();
    const result = await queue.sweep(staleBefore, 2);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: 'j2', status: 'failed', testIds: [] }),
    ]);
    expect(result.requeued).toEqual([
      expect.objectContaining({ id: 'j3', status: 'queued', workerId: null, testIds: ['t9'] }),
    ]);
    expect(db.e2eJobRecord.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'j2', status: 'running', heartbeatAt: { lt: staleBefore } },
      data: { status: 'failed' },
    });
  });
});

describe('PrismaE2eArtifactStore', () => {
  it('stores, reads and removes videos by key prefix', async () => {
    const { db, client } = fakeDb();
    const store = new PrismaE2eArtifactStore(client);
    await store.put('ws/c1/t1.mp4', Buffer.from('mp4'));
    expect(db.e2eArtifactRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'ws/c1/t1.mp4' } }),
    );
    expect(await store.get('ws/c1/t1.mp4')).toEqual(Buffer.from([1, 2]));
    db.e2eArtifactRecord.findUnique.mockResolvedValue(null);
    expect(await store.get('missing')).toBeNull();
    await store.removePrefix('ws/c1');
    expect(db.e2eArtifactRecord.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ key: 'ws/c1' }, { key: { startsWith: 'ws/c1/' } }] },
    });
  });
});
