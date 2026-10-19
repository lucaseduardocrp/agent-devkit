import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/adapters/http/app.js';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import {
  createPrismaKnowledgeAdapters,
  PrismaKnowledgeRepository,
  type PrismaKnowledgeClient,
} from '../../src/modules/knowledge/adapters/prisma-knowledge.js';
import type { KnowledgeChunkRepository } from '../../src/modules/knowledge/application/knowledge-provider.js';
import type { KnowledgeChunk } from '../../src/modules/knowledge/domain/knowledge-chunk.js';

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) {
    throw new Error('TEST_DATABASE_URL is required by the integration test configuration.');
  }
  return value;
}

const testDatabaseUrl = requireTestDatabaseUrl();
const runPrefix = `integration-test-${randomUUID()}`;
const page = { id: 'page-1', source: 'wiki' };

function context(label: string) {
  return { requestId: `request-${label}`, ownerId: `${runPrefix}-${label}` };
}

function chunk(index: number, content: string, createdAt = '2026-09-11T12:34:56.789Z') {
  return {
    source: page.source,
    pageId: page.id,
    chunkIndex: index,
    content,
    createdAt,
  } satisfies KnowledgeChunk;
}

async function withRepository<T>(
  operation: (repository: KnowledgeChunkRepository, database: PostgresDatabase) => Promise<T>,
): Promise<T> {
  const database = new PostgresDatabase(testDatabaseUrl);
  try {
    return await operation(createPrismaKnowledgeAdapters(database.client).repository, database);
  } finally {
    await database.close();
  }
}

afterAll(async () => {
  const database = new PostgresDatabase(testDatabaseUrl);
  try {
    await database.client.knowledgeChunkRecord.deleteMany({
      where: { ownerId: { startsWith: runPrefix } },
    });
  } finally {
    await database.close();
  }
});

describe('PostgreSQL Prisma knowledge persistence', () => {
  it('persists Unicode and source timestamps across independent clients', async () => {
    const ownerContext = context('restart');
    const expected = chunk(0, 'Conhecimento: ação, 東京 e 🚀', '2026-09-11T09:34:56.789-03:00');

    await withRepository((repository) => repository.replacePage(page, [expected], ownerContext));
    const stored = await withRepository((repository) => repository.all(ownerContext));

    expect(stored).toEqual([{ ...expected, createdAt: '2026-09-11T12:34:56.789Z' }]);
  });

  it('keeps replacement idempotent and removes obsolete chunks atomically', async () => {
    const ownerContext = context('replacement');
    const original = [chunk(0, 'old zero'), chunk(1, 'old one'), chunk(2, 'old two')];

    await withRepository(async (repository, database) => {
      await repository.replacePage(page, original, ownerContext);
      await repository.replacePage(page, original, ownerContext);
      expect(await repository.all(ownerContext)).toHaveLength(3);

      await expect(
        new PrismaKnowledgeRepository(database.client as unknown as PrismaKnowledgeClient, {
          maxTransactionAttempts: 1,
        }).replacePage(page, [chunk(0, 'duplicate'), chunk(0, 'duplicate')], ownerContext),
      ).rejects.toMatchObject({ code: 'KNOWLEDGE_WRITE_CONFLICT' });

      expect(await repository.all(ownerContext)).toEqual(original);
      await repository.replacePage(page, [chunk(0, 'new only')], ownerContext);
      expect(await repository.all(ownerContext)).toEqual([chunk(0, 'new only')]);
    });
  });

  it('resolves concurrent replacement without duplicate logical chunks', async () => {
    const ownerContext = context('concurrent');
    const database = new PostgresDatabase(testDatabaseUrl);
    try {
      const repository = createPrismaKnowledgeAdapters(database.client).repository;
      const first = [chunk(0, 'writer A zero'), chunk(1, 'writer A one')];
      const second = [chunk(0, 'writer B zero'), chunk(1, 'writer B one')];

      await Promise.all([
        repository.replacePage(page, first, ownerContext),
        repository.replacePage(page, second, ownerContext),
      ]);

      const stored = await repository.all(ownerContext);
      expect(stored).toHaveLength(2);
      expect(stored.map((value) => value.chunkIndex)).toEqual([0, 1]);
      expect([first, second]).toContainEqual(stored);
    } finally {
      await database.close();
    }
  });

  it('isolates list, search and replacement between owners', async () => {
    const firstOwner = context('owner-a');
    const secondOwner = context('owner-b');
    const database = new PostgresDatabase(testDatabaseUrl);
    try {
      const { repository, search } = createPrismaKnowledgeAdapters(database.client);
      await repository.replacePage(page, [chunk(0, 'alpha private')], firstOwner);
      await repository.replacePage(page, [chunk(0, 'beta private')], secondOwner);

      expect(await repository.all(firstOwner)).toEqual([chunk(0, 'alpha private')]);
      expect(await search.search('private', firstOwner)).toEqual([chunk(0, 'alpha private')]);

      await repository.replacePage(page, [chunk(0, 'alpha changed')], firstOwner);
      expect(await repository.all(secondOwner)).toEqual([chunk(0, 'beta private')]);
      expect(await search.search('alpha', secondOwner)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it('reports unavailable readiness and keeps connection details out of responses', async () => {
    const unavailableUrl = 'postgresql://test-user:secret@127.0.0.1:1/adk_test';
    const database = new PostgresDatabase(unavailableUrl);
    try {
      const response = await request(
        createApp({
          readinessProbes: [{ name: 'database:postgres', check: () => database.check() }],
        }),
      ).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: 'not-ready',
        checks: [{ name: 'database:postgres', status: 'not-ready' }],
      });
      expect(response.text).not.toContain('secret');
    } finally {
      await database.close();
    }
  });
});
