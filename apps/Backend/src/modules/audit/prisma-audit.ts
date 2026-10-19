import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import {
  PrismaKnowledgeRepository,
  type PrismaKnowledgeClient,
} from '../knowledge/adapters/prisma-knowledge.js';
import { PrismaSpecRepository } from '../spec/adapters/prisma-spec-repository.js';
import { PrismaSavedTestPlanStore } from '../testplans/adapters/prisma-saved-test-plans.js';
import type { AuditEvent, AuditPersistence, AuditQuery, AuditUnit } from './audit.js';
import { documentHistoryIds } from './audit.js';

export class PrismaAuditPersistence implements AuditPersistence {
  public constructor(private readonly client: PrismaClient) {}
  public async run<T>(workspaceId: string, work: (unit: AuditUnit) => Promise<T>): Promise<T> {
    return this.client.$transaction(
      async (tx) => {
        // Serialize audited mutations before reading the previous version.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 0))`;
        const knowledgeClient = {
          knowledgeChunkRecord: tx.knowledgeChunkRecord,
          knowledgeRelationRecord: tx.knowledgeRelationRecord,
          $transaction: async <R>(operation: (client: unknown) => Promise<R>) => operation(tx),
        } as unknown as PrismaKnowledgeClient;
        return work({
          knowledge: new PrismaKnowledgeRepository(knowledgeClient, { maxTransactionAttempts: 1 }),
          specs: new PrismaSpecRepository(tx),
          tests: new PrismaSavedTestPlanStore(tx),
          deleteWorkspace: async (id) => {
            await tx.knowledgeChunkRecord.deleteMany({ where: { ownerId: id } });
            await tx.knowledgeRelationRecord.deleteMany({ where: { ownerId: id } });
            await tx.integrationRecord.deleteMany({ where: { ownerId: id } });
            await tx.workspaceRecord.delete({ where: { id } });
            await tx.auditEventRecord.deleteMany({ where: { workspaceId: id } });
          },
          append: async (events) => {
            if (events.length)
              await tx.auditEventRecord.createMany({
                data: events.map((event) => ({
                  ...event,
                  occurredAt: new Date(event.occurredAt),
                  before:
                    event.before === null
                      ? Prisma.JsonNull
                      : (event.before as Prisma.InputJsonValue),
                  after:
                    event.after === null ? Prisma.JsonNull : (event.after as Prisma.InputJsonValue),
                })),
              });
          },
        });
      },
      { timeout: 30000 },
    );
  }
  public async list(query: AuditQuery) {
    let entityIds = query.entityId ? [query.entityId] : undefined;
    if (query.entityId && query.entityType === 'document') {
      const moves = await this.client.auditEventRecord.findMany({
        where: { workspaceId: query.workspaceId, entityType: 'document', action: 'update' },
        select: { entityId: true, action: true, before: true, after: true },
      });
      entityIds = documentHistoryIds(
        moves as Pick<AuditEvent, 'entityId' | 'action' | 'before' | 'after'>[],
        query.entityId,
      );
    }
    const where = {
      workspaceId: query.workspaceId,
      entityType: query.entityType,
      ...(entityIds ? { entityId: { in: entityIds } } : {}),
    };
    const [records, total] = await this.client.$transaction(
      [
        this.client.auditEventRecord.findMany({
          where,
          orderBy: [{ sequence: 'desc' }],
          skip: query.offset,
          take: query.limit,
        }),
        this.client.auditEventRecord.count({ where }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    const userRecord = (
      this.client as PrismaClient & {
        userRecord?: {
          findMany: (args: unknown) => Promise<Array<{ id: string; name: string; email: string }>>;
        };
      }
    ).userRecord;
    const actors = new Map<string, { name: string; email: string }>();
    if (userRecord) {
      const actorIds = records
        .map((record) => record.actorId)
        .filter((id): id is string => Boolean(id));
      const users = await userRecord.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      });
      for (const user of users) actors.set(user.id, { name: user.name, email: user.email });
    }
    return {
      items: records.map((record) => ({
        ...record,
        occurredAt: record.occurredAt.toISOString(),
        ...(record.actorId && actors.has(record.actorId)
          ? {
              actorName: actors.get(record.actorId)!.name,
              actorEmail: actors.get(record.actorId)!.email,
            }
          : {}),
      })) as AuditEvent[],
      total,
    };
  }
}
