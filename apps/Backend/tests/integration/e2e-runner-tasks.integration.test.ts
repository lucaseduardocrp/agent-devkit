import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import { PrismaE2eJobQueue } from '../../src/modules/e2e/adapters/prisma-e2e-queue.js';
import { PrismaE2eRunnerTaskStore } from '../../src/modules/e2e/adapters/prisma-runner-task-store.js';
import { PrismaE2eStore } from '../../src/modules/e2e/adapters/prisma-e2e-store.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required by the integration test configuration.');

const database = new PostgresDatabase(url);
const db = database.client;
const tasks = new PrismaE2eRunnerTaskStore(db);
const store = new PrismaE2eStore(db);
const queue = new PrismaE2eJobQueue(db);
const workspaceId = randomUUID();
const runner = { id: 'runner-integration', label: 'CI (linux)' };

async function newCreation() {
  return store.createCreation({
    workspaceId,
    ownerId: workspaceId,
    actorId: 'u',
    agentId: 'a',
    name: 'local run',
    mode: 'frontend',
    scope: 'codebase',
    baseUrl: 'http://localhost:8014',
    executionTarget: 'local',
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

afterAll(async () => {
  await db.e2eCreationRecord.deleteMany({ where: { workspaceId } });
  await db.e2eLocalRunnerRecord.deleteMany({ where: { workspaceId } });
  await database.close();
});

describe('Prisma E2E runner tasks', () => {
  it('stores the execution target, the requester and the executing computer', async () => {
    const creation = await newCreation();
    expect(creation.executionTarget).toBe('local');
    const job = await queue.enqueue({
      workspaceId,
      creationId: creation.id,
      kind: 'execute',
      testIds: [],
      requestedBy: 'qa-user',
    });
    expect(job?.requestedBy).toBe('qa-user');
    const [test] = await store.appendTests(creation, [
      { title: 'Open', description: 'd', steps: [], priority: 'high' },
    ]);
    const updated = await store.updateTest(workspaceId, test!.id, { executedOn: 'QA (win32)' });
    expect(updated?.executedOn).toBe('QA (win32)');
    await queue.cancel(workspaceId, creation.id);
  });

  it('claims only the user tasks once, renews them and keeps the outcome', async () => {
    const creation = await newCreation();
    const task = await tasks.create({
      workspaceId,
      creationId: creation.id,
      testId: null,
      userId: 'qa-user',
      kind: 'run',
      payload: 'encrypted',
    });
    const scope = { workspaceId, userId: 'qa-user', createdAfter: new Date(Date.now() - 60_000) };
    expect(await tasks.claim({ ...scope, userId: 'other' }, runner)).toBeNull();
    expect(
      await tasks.claim({ ...scope, createdAfter: new Date(Date.now() + 60_000) }, runner),
    ).toBeNull();
    const [first, second] = await Promise.all([
      tasks.claim({ ...scope, creationId: creation.id }, runner),
      tasks.claim(scope, runner),
    ]);
    expect([first?.id, second?.id].filter(Boolean)).toEqual([task.id]);
    expect(await tasks.heartbeat(task.id, 'another-runner')).toBeNull();
    expect(await tasks.heartbeat(task.id, runner.id)).toBe('running');
    expect(
      await tasks.complete(task.id, runner.id, {
        status: 'succeeded',
        result: '{"kind":"explore","snapshot":{}}',
        error: null,
      }),
    ).toBe(true);
    const done = await tasks.get(task.id);
    expect(done).toMatchObject({ status: 'succeeded', payload: '', runnerLabel: 'CI (linux)' });
    expect(await tasks.heartbeat(task.id, runner.id)).toBe('succeeded');
    await tasks.remove(task.id);
    expect(await tasks.get(task.id)).toBeNull();
  });

  it('lists the runners a user connected recently', async () => {
    const identity = { id: 'runner-a', name: 'QA', platform: 'linux', version: '0.2.0' };
    await tasks.seen({ ...identity, workspaceId, userId: 'qa-user' });
    await tasks.seen({ ...identity, version: '0.2.1', workspaceId, userId: 'qa-user' });
    const runners = await tasks.listRunners(workspaceId, 'qa-user', new Date(Date.now() - 60_000));
    expect(runners).toEqual([expect.objectContaining({ id: 'runner-a', version: '0.2.1' })]);
    expect(await tasks.listRunners(workspaceId, 'other', new Date(0))).toEqual([]);
  });
});
