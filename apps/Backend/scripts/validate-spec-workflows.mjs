import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/src/generated/prisma/client.js';
import { PrismaSpecRepository } from '../dist/src/modules/spec/adapters/prisma-spec-repository.js';
import { createPrismaKnowledgeAdapters } from '../dist/src/modules/knowledge/adapters/prisma-knowledge.js';
import { SpecWorkflows } from '../dist/src/modules/spec/application/spec-workflows.js';

const schema = `spec_validation_${randomUUID().replaceAll('-', '')}`;
const connectionString = process.env.DATABASE_URL;
assert.ok(connectionString);
const admin = new pg.Client({ connectionString });
await admin.connect();
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) });
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const table of [
    'specifications',
    'spec_templates',
    'knowledge_chunks',
    'knowledge_relations',
  ]) {
    await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  const specs = new PrismaSpecRepository(client);
  const knowledge = createPrismaKnowledgeAdapters(client).repository;
  const context = { ownerId: 'validation', workspaceId: 'validation', requestId: 'validation' };
  const now = new Date().toISOString();
  const spec = await specs.saveSpecification({
    id: randomUUID(),
    workspaceId: context.workspaceId,
    title: 'Validation Spec',
    sections: [
      { templateSectionId: 'requirements', title: 'Requirements', content: 'Persist content' },
    ],
    messages: [{ id: 'old', role: 'user', content: 'Old context '.repeat(1000), createdAt: now }],
    createdAt: now,
    updatedAt: now,
  });
  const workflows = new SpecWorkflows(specs, knowledge, {
    reply: async (input) => {
      assert.equal(input.agentId, 'selected-agent');
      assert.match(input.conversation[0].content, /Persist content/);
      return {
        content: 'Generated',
        sections: [{ templateSectionId: 'requirements', content: 'Generated requirement' }],
      };
    },
  });
  const size = async () =>
    (
      await admin.query(
        `SELECT octet_length(messages::text) AS bytes FROM "${schema}".specifications WHERE id=$1`,
        [spec.id],
      )
    ).rows[0].bytes;
  const before = await size();
  await workflows.clearMessages(context.workspaceId, spec.id);
  assert.equal(await size(), 2);
  assert.ok(before > 10000);
  assert.deepEqual(
    (await specs.findSpecification(spec.id, context.workspaceId)).sections,
    spec.sections,
  );
  const published = await workflows.publish(context.workspaceId, spec.id, context);
  await workflows.publish(context.workspaceId, spec.id, context);
  assert.equal((await knowledge.all(context)).length, 1);
  const generated = await workflows.generate(
    context.workspaceId,
    { ...published, agentId: 'selected-agent' },
    context,
  );
  assert.equal(
    generated.sections.find((section) => section.templateSectionId === 'requirements').content,
    'Generated requirement',
  );
  assert.deepEqual((await specs.findSpecification(generated.id, context.workspaceId)).messages, []);
  assert.equal(await specs.findSpecification(generated.id, 'other'), null);
  console.log(
    `PASS: persisted chat reduced from ${before} to 2 JSON bytes; fields preserved; repeatable Brain publication and selected-agent generation persisted. Agent simulated.`,
  );
} finally {
  await client.$disconnect();
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}
