import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaAuditPersistence } from '../src/modules/audit/prisma-audit.js';
import type { AuditEvent } from '../src/modules/audit/audit.js';

const event: AuditEvent = {
  id: 'event',
  workspaceId: 'w',
  entityType: 'document',
  entityId: 'doc',
  action: 'create',
  actorId: 'user',
  requestId: 'req',
  operation: 'POST /knowledge/documents',
  occurredAt: '2026-09-16T12:00:00.000Z',
  before: null,
  after: { content: 'Text' },
};
describe('Prisma audit unit of work', () => {
  it('queries the complete individual document lineage with a workspace-scoped filter', async () => {
    const before = { source: 'app://local?title=Old', pageId: 'doc' };
    const after = { source: 'https://wiki.test/page', pageId: 'remote' };
    const current = JSON.stringify([after.source, after.pageId]);
    const original = JSON.stringify([before.source, before.pageId]);
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([{ entityId: current, action: 'update', before, after }])
      .mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(2);
    const persistence = new PrismaAuditPersistence({
      auditEventRecord: { findMany, count },
      $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaClient);
    expect(
      (
        await persistence.list({
          workspaceId: 'ws',
          entityType: 'document',
          entityId: current,
          offset: 0,
          limit: 20,
        })
      ).total,
    ).toBe(2);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { workspaceId: 'ws', entityType: 'document', action: 'update' },
    });
    expect(count).toHaveBeenCalledWith({
      where: { workspaceId: 'ws', entityType: 'document', entityId: { in: [current, original] } },
    });
  });
  it('writes content and audit on the same transaction client, normalizes JSON nulls and propagates failures', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      auditEventRecord: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      knowledgeChunkRecord: { deleteMany: vi.fn(), createMany: vi.fn() },
      knowledgeRelationRecord: { deleteMany: vi.fn() },
      integrationRecord: { deleteMany: vi.fn() },
      workspaceRecord: { delete: vi.fn() },
    };
    const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    const persistence = new PrismaAuditPersistence({
      $transaction: transaction,
    } as unknown as PrismaClient);
    await persistence.run('w', async (unit) => {
      await unit.knowledge.replacePage(
        { id: 'doc', source: 'app' },
        [
          {
            pageId: 'doc',
            source: 'app',
            chunkIndex: 0,
            content: 'Text',
            createdAt: event.occurredAt,
          },
        ],
        { ownerId: 'w', requestId: 'req' },
      );
      await unit.append([
        event,
        { ...event, id: 'deleted', action: 'delete', before: { content: 'Text' }, after: null },
      ]);
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.knowledgeChunkRecord.createMany).toHaveBeenCalledOnce();
    expect(tx.auditEventRecord.createMany.mock.calls[0]![0]).toMatchObject({
      data: [
        { before: Prisma.JsonNull, after: { content: 'Text' } },
        { before: { content: 'Text' }, after: Prisma.JsonNull },
      ],
    });
    await persistence.run('w', (unit) => unit.append([]));
    expect(tx.auditEventRecord.createMany).toHaveBeenCalledTimes(1);
    tx.auditEventRecord.createMany.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(persistence.run('w', (unit) => unit.append([event]))).rejects.toThrow(
      'audit unavailable',
    );
    await persistence.run('w', async (unit) => unit.deleteWorkspace!('w'));
    expect(tx.workspaceRecord.delete).toHaveBeenCalledWith({ where: { id: 'w' } });
    expect(tx.knowledgeRelationRecord.deleteMany).toHaveBeenCalledWith({ where: { ownerId: 'w' } });
    expect(tx.auditEventRecord.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: 'w' } });
  });
  it('scopes and paginates durable history with stable ordering', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([{ ...event, occurredAt: new Date(event.occurredAt) }]);
    const count = vi.fn().mockResolvedValue(1);
    const persistence = new PrismaAuditPersistence({
      auditEventRecord: { findMany, count },
      $transaction: async (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaClient);
    expect(
      await persistence.list({
        workspaceId: 'w',
        entityType: 'document',
        entityId: 'doc',
        offset: 20,
        limit: 20,
      }),
    ).toEqual({ items: [event], total: 1 });
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: 'w', entityType: 'document', entityId: { in: ['doc'] } },
      orderBy: [{ sequence: 'desc' }],
      skip: 20,
      take: 20,
    });
    await persistence.list({ workspaceId: 'other', entityType: 'testplan', offset: 0, limit: 10 });
    expect(count).toHaveBeenLastCalledWith({
      where: { workspaceId: 'other', entityType: 'testplan' },
    });
  });
});
