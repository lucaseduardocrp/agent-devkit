import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import { PrismaAuditPersistence } from '../../src/modules/audit/prisma-audit.js';
import { auditedRepositories, type AuditEvent } from '../../src/modules/audit/audit.js';
import { createPrismaKnowledgeAdapters } from '../../src/modules/knowledge/adapters/prisma-knowledge.js';
import { PrismaSpecRepository } from '../../src/modules/spec/adapters/prisma-spec-repository.js';
import { PrismaSavedTestPlanStore } from '../../src/modules/testplans/adapters/prisma-saved-test-plans.js';
import { chunkPage } from '../../src/modules/knowledge/application/knowledge-provider.js';

const url = process.env.TEST_DATABASE_URL!;
const db = new PostgresDatabase(url);
const ownerId = 'audit-test-' + randomUUID();
const context = { ownerId, actorId: 'author', requestId: 'audit-request' };
const persistence = new PrismaAuditPersistence(db.client);
const raw = {
  knowledge: createPrismaKnowledgeAdapters(db.client).repository,
  specs: new PrismaSpecRepository(db.client),
  tests: new PrismaSavedTestPlanStore(db.client),
};
const repo = auditedRepositories(raw, persistence);
afterAll(async () => {
  await db.client.knowledgeChunkRecord.deleteMany({ where: { ownerId } });
  await db.client.auditEventRecord.deleteMany({ where: { workspaceId: ownerId } });
  await db.close();
});
describe('durable content audit transactions', () => {
  it('rolls back content when audit insertion fails and retains history across deletion and restart', async () => {
    const page = {
      id: 'doc',
      source: 'app://local?title=Original',
      content: 'Original',
      updatedAt: new Date().toISOString(),
    };
    await repo.knowledge.replacePage(page, chunkPage(page), context);
    const saved = (
      await persistence.list({ workspaceId: ownerId, entityType: 'document', offset: 0, limit: 20 })
    ).items[0]!;
    await expect(
      persistence.run(ownerId, async (unit) => {
        await unit.knowledge.deletePage(page, context);
        // Force a unique-key error after content mutation, in the audit write itself.
        await unit.append([saved as AuditEvent]);
      }),
    ).rejects.toBeDefined();
    expect((await raw.knowledge.all(context))[0]?.content).toBe('Original');
    await repo.knowledge.deletePage(page, context);
    const independent = new PostgresDatabase(url);
    try {
      const history = await new PrismaAuditPersistence(independent.client).list({
        workspaceId: ownerId,
        entityType: 'document',
        offset: 0,
        limit: 20,
      });
      expect(history.total).toBe(2);
      expect(history.items[0]).toMatchObject({
        action: 'delete',
        actorId: 'author',
        before: { content: 'Original' },
        after: null,
      });
    } finally {
      await independent.close();
    }
  });
});
