import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import { PrismaE2eJobQueue } from '../../src/modules/e2e/adapters/prisma-e2e-queue.js';
import { PrismaE2eArtifactStore } from '../../src/modules/e2e/adapters/prisma-e2e-artifact-store.js';
import { PrismaE2eStore } from '../../src/modules/e2e/adapters/prisma-e2e-store.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required by the integration test configuration.');

const database = new PostgresDatabase(url);
const db = database.client;
const queue = new PrismaE2eJobQueue(db);
const store = new PrismaE2eStore(db);
const artifacts = new PrismaE2eArtifactStore(db);
const workspaceId = randomUUID();

async function newCreation() {
  return store.createCreation({
    workspaceId,
    ownerId: workspaceId,
    actorId: 'u',
    agentId: 'a',
    name: 'run',
    mode: 'frontend',
    scope: 'codebase',
    baseUrl: 'http://localhost',
    path: '/',
    username: null,
    passwordSecret: null,
    prd: 'p',
    prdFileNames: [],
    diff: null,
    instructions: null,
    locale: 'en-US',
    repository: { provider: 'github', id: '1', name: 'o/r', branch: 'main', path: 'tests/e2e' },
  });
}

beforeAll(async () => {
  const user = await db.userRecord.create({
    data: { email: `${workspaceId}@test.local`, name: 'Queue test' },
  });
  await db.workspaceRecord.create({
    data: { id: workspaceId, name: 'Queue test', slug: workspaceId, ownerId: user.id },
  });
});

afterAll(async () => {
  await db.workspaceRecord.deleteMany({ where: { id: workspaceId } });
  await database.close();
});

describe('Postgres E2E queue', () => {
  it('allows one active job per creation, even under concurrent enqueues', async () => {
    const creation = await newCreation();
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        queue.enqueue({ workspaceId, creationId: creation.id, kind: 'generate', testIds: [] }),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await queue.hasActive(workspaceId, creation.id)).toBe(true);
  });

  it('hands each job to exactly one of many competing workers', async () => {
    const creations = await Promise.all(Array.from({ length: 6 }, () => newCreation()));
    for (const creation of creations)
      await queue.enqueue({
        workspaceId,
        creationId: creation.id,
        kind: 'execute',
        testIds: ['t1', 't2'],
      });
    // 12 claims race for the jobs: SKIP LOCKED must never hand one out twice.
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) => queue.claim(`worker-${index % 3}`)),
    );
    const claimed = claims.filter((job) => job !== null);
    const ids = claimed.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ours = claimed.filter((job) => creations.some((c) => c.id === job.creationId));
    expect(ours).toHaveLength(6);
    expect(ours[0]).toMatchObject({ status: 'running', attempts: 1, testIds: ['t1', 't2'] });
    for (const job of claimed) await queue.finish(job.id, job.workerId!, 'succeeded');
  });

  it('keeps heartbeats, cancels and recovers abandoned jobs', async () => {
    const creation = await newCreation();
    await queue.enqueue({ workspaceId, creationId: creation.id, kind: 'generate', testIds: [] });
    const job = (await queue.claim('w1'))!;
    expect(job.creationId).toBe(creation.id);
    expect(await queue.heartbeat(job.id, 'w1')).toBe(true);
    expect(await queue.heartbeat(job.id, 'other')).toBe(false);

    // The worker dies: the sweep puts the job back, then fails it after the last attempt.
    const later = new Date(Date.now() + 60_000);
    const first = await queue.sweep(later, 2);
    expect(first.requeued.map((item) => item.id)).toContain(job.id);
    const retried = (await queue.claim('w2'))!;
    expect(retried).toMatchObject({ id: job.id, attempts: 2, workerId: 'w2' });
    const second = await queue.sweep(later, 2);
    expect(second.failed.map((item) => item.id)).toContain(job.id);
    expect(await queue.hasActive(workspaceId, creation.id)).toBe(false);

    await queue.enqueue({ workspaceId, creationId: creation.id, kind: 'execute', testIds: [] });
    expect(await queue.cancel(workspaceId, creation.id)).toBe(true);
    expect(await queue.cancel(workspaceId, creation.id)).toBe(false);
  });

  it('stores videos and removes jobs and videos with their run', async () => {
    const creation = await newCreation();
    await queue.enqueue({ workspaceId, creationId: creation.id, kind: 'generate', testIds: [] });
    const key = `${workspaceId}/${creation.id}/t1.mp4`;
    await artifacts.put(key, Buffer.from('first'));
    await artifacts.put(key, Buffer.from('second'));
    expect((await artifacts.get(key))?.toString()).toBe('second');
    await artifacts.removePrefix(`${workspaceId}/${creation.id}`);
    expect(await artifacts.get(key)).toBeNull();

    await store.deleteCreation(workspaceId, creation.id);
    expect(await queue.hasActive(workspaceId, creation.id)).toBe(false);
    expect(await db.e2eJobRecord.count({ where: { creationId: creation.id } })).toBe(0);
  });
});
