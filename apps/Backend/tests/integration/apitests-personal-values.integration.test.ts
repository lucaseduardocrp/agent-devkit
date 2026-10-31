import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import { PrismaApiTestStore } from '../../src/modules/apitests/adapters/prisma-api-test-store.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required by the integration test configuration.');

const database = new PostgresDatabase(url);
const db = database.client;
const store = new PrismaApiTestStore(db);
const workspaceId = randomUUID();
let alice = '';
let bob = '';

beforeAll(async () => {
  alice = (
    await db.userRecord.create({ data: { email: `${workspaceId}-a@test.local`, name: 'A' } })
  ).id;
  bob = (await db.userRecord.create({ data: { email: `${workspaceId}-b@test.local`, name: 'B' } }))
    .id;
  await db.workspaceRecord.create({
    data: { id: workspaceId, name: 'Vault test', slug: workspaceId, ownerId: alice },
  });
});

afterAll(async () => {
  await db.workspaceRecord.deleteMany({ where: { id: workspaceId } });
  await db.userRecord.deleteMany({ where: { id: { in: [alice, bob] } } });
  await database.close();
});

describe('Postgres API test store: personal values', () => {
  it('keeps each user’s values apart and deletes them by scope', async () => {
    const key = (userId: string) => ({
      workspaceId,
      userId,
      scope: 'collection' as const,
      scopeId: 'c1',
    });
    await store.upsertPersonalValues(key(alice), new Map([['var:token', 'enc-a']]));
    await store.upsertPersonalValues(key(alice), new Map([['var:token', 'enc-a2']]));
    await store.upsertPersonalValues(key(bob), new Map([['var:token', 'enc-b']]));
    await store.upsertPersonalValues(key(bob), new Map());
    expect(await store.listPersonalValues(key(alice))).toEqual(new Map([['var:token', 'enc-a2']]));
    expect(await store.deletePersonalValue(key(alice), 'var:token')).toBe(true);
    expect(await store.deletePersonalValue(key(alice), 'var:token')).toBe(false);
    await store.deleteUserPersonalScope(key(bob));
    expect((await store.listPersonalValues(key(bob))).size).toBe(0);
    await store.upsertPersonalValues(key(bob), new Map([['auth:collection:token', 'x']]));
    await store.deletePersonalScope(workspaceId, 'collection', 'c1');
    expect((await store.listPersonalValues(key(bob))).size).toBe(0);
  });

  it('stores the whole collection definition and the environment owner', async () => {
    const now = new Date();
    const saved = await store.saveCollection({
      id: randomUUID(),
      workspaceId,
      name: 'Orders',
      variables: [],
      auth: { type: 'none' },
      items: [],
      headers: [{ key: 'Accept', value: 'application/json' }],
      settings: { timeoutMs: 1_000 },
      source: { kind: 'manual' },
      createdBy: alice,
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.getCollection(workspaceId, saved.id)).toMatchObject({
      headers: [{ key: 'Accept', value: 'application/json' }],
      settings: { timeoutMs: 1_000 },
    });
    const environment = await store.saveEnvironment({
      id: randomUUID(),
      workspaceId,
      name: 'Staging',
      variables: [],
      createdBy: bob,
      createdAt: now,
      updatedAt: now,
    });
    expect((await store.getEnvironment(workspaceId, environment.id))?.createdBy).toBe(bob);
  });
});
