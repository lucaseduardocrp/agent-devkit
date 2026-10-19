import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { PrismaClient } from '../dist/src/generated/prisma/client.js';
import { createApp } from '../dist/src/adapters/http/app.js';
import { createPrismaKnowledgeAdapters } from '../dist/src/modules/knowledge/adapters/prisma-knowledge.js';

// All writes are isolated in a fresh schema; application rows are never modified.
const schema = `brain_validation_${randomUUID().replaceAll('-', '')}`;
const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString, 'DATABASE_URL is required');
const admin = new pg.Client({ connectionString });
await admin.connect();
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of ['knowledge_chunks', 'knowledge_relations']) {
    await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  const { repository } = createPrismaKnowledgeAdapters(client);
  const context = { ownerId: 'validation-owner', requestId: 'brain-validation' };
  const remotePages = new Map();
  const provider = {
    name: 'validation-wiki',
    ownsSource: (source) => source.startsWith('https://validation.invalid/'),
    listPages: async () => [...remotePages.values()],
    pushPage: async ({ content, path }) => {
      const page = {
        id: '51',
        source: `https://validation.invalid/wiki?pagePath=${encodeURIComponent(path)}`,
        content,
        updatedAt: new Date().toISOString(),
      };
      remotePages.set(page.id, page);
      return page;
    },
  };
  const app = createApp({
    logger: { info() {}, error() {} },
    knowledgeRepository: repository,
    requestContextResolver: async () => context,
    dynamicProviderFactory: {
      resolveAzureDevOpsWikiProvider: async () => provider,
      resolveKnowledgeProvider: async () => provider,
    },
  });
  const create = async (title) => {
    const response = await request(app)
      .post('/knowledge/documents')
      .send({ title, content: 'Original body' });
    assert.equal(response.status, 201);
    return response.body.document;
  };
  const first = await create('Original');
  const related = await create('Related');
  await repository.addRelation(first.pageId, related.pageId, context);
  const relations = await repository.listRelations(context);
  const rename = await request(app)
    .put(`/knowledge/documents/${first.pageId}`)
    .send({ title: 'Renamed', content: 'New body' });
  assert.equal(rename.status, 200);
  assert.deepEqual(await repository.listRelations(context), relations);
  const beforeFailure = await repository.all(context);

  // Force a real SQL failure after chunk deletion; the transaction must roll back.
  await admin.query(`ALTER TABLE "${schema}".knowledge_relations RENAME TO unavailable_relations`);
  assert.equal((await request(app).delete(`/knowledge/documents/${first.pageId}`)).status, 500);
  assert.deepEqual(await repository.all(context), beforeFailure);
  await admin.query(`ALTER TABLE "${schema}".unavailable_relations RENAME TO knowledge_relations`);
  assert.deepEqual(await repository.listRelations(context), relations);

  // Force insertion failure after deleting the old source during rename and push.
  await admin.query(
    `ALTER TABLE "${schema}".knowledge_chunks ADD CONSTRAINT reject_changes CHECK (content NOT LIKE '%Reject%' AND source NOT LIKE 'https://validation.invalid/%') NOT VALID`,
  );
  assert.equal(
    (
      await request(app)
        .put(`/knowledge/documents/${first.pageId}`)
        .send({ title: 'Reject', content: 'Reject' })
    ).status,
    500,
  );
  assert.deepEqual(await repository.all(context), beforeFailure);
  assert.equal((await request(app).post(`/knowledge/documents/${first.pageId}/push`)).status, 500);
  assert.deepEqual(await repository.all(context), beforeFailure);
  assert.deepEqual(await repository.listRelations(context), relations);
  await admin.query(`ALTER TABLE "${schema}".knowledge_chunks DROP CONSTRAINT reject_changes`);
  assert.equal((await request(app).post(`/knowledge/documents/${first.pageId}/push`)).status, 200);
  assert.ok(
    (await repository.listRelations(context)).some((relation) =>
      [relation.sourcePageId, relation.targetPageId].includes('51'),
    ),
  );

  const remote = remotePages.get('51');
  remotePages.clear();
  remotePages.set('52', { ...remote, id: '52', content: '# Synced' });
  assert.equal((await request(app).post('/knowledge/sync')).status, 200);
  assert.ok(
    (await repository.all(context)).some(
      (chunk) => chunk.pageId === '52' && chunk.content === '# Synced',
    ),
  );
  assert.ok(
    (await repository.listRelations(context)).some((relation) =>
      [relation.sourcePageId, relation.targetPageId].includes('52'),
    ),
  );
  remotePages.clear();
  assert.equal((await request(app).post('/knowledge/sync')).status, 200);
  assert.ok(
    (await repository.all(context)).some(
      (chunk) => chunk.pageId === '52' && chunk.source.startsWith('app://local'),
    ),
  );
  assert.equal((await request(app).delete('/knowledge/documents/52')).status, 200);
  assert.deepEqual(await repository.listRelations(context), []);
  assert.equal((await repository.all(context)).length, 1);
  assert.deepEqual(await repository.all({ ...context, ownerId: 'other-owner' }), []);
  console.log(
    'PASS: PostgreSQL HTTP edit/delete/push/sync, relation preservation, rollback and owner isolation. Azure provider is simulated.',
  );
} finally {
  await client.$disconnect();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
