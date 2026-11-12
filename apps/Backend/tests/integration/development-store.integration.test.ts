import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresDatabase } from '../../src/adapters/persistence/postgres-database.js';
import { DevelopmentService } from '../../src/modules/development/development-service.js';
import { PrismaDevelopmentStore } from '../../src/modules/development/development-store.js';

const db = new PostgresDatabase(process.env.TEST_DATABASE_URL!);
const userId = `development-test-${randomUUID()}`;
const workspaceId = `development-test-${randomUUID()}`;
const service = new DevelopmentService(new PrismaDevelopmentStore(db.client));
const actor = { id: userId, name: 'Tester' };

afterAll(async () => {
  await db.client.userRecord.deleteMany({ where: { id: userId } });
  await db.close();
});

describe('development store on PostgreSQL', () => {
  it('keeps changes and sessions through their whole lifecycle', async () => {
    await db.client.userRecord.create({
      data: { id: userId, email: `${userId}@adk.test`, name: 'Tester' },
    });
    await db.client.workspaceRecord.create({
      data: { id: workspaceId, name: 'Development', slug: workspaceId, ownerId: userId },
    });

    const change = await service.createChange(workspaceId, { title: 'Add login' }, actor);
    expect(change.artifacts).toHaveLength(4);
    await expect(service.createChange(workspaceId, { title: 'Add login' }, actor)).rejects.toThrow(
      'already exists',
    );
    await service.transitionChange(workspaceId, change.id, 'propose', actor);
    const approved = await service.transitionChange(workspaceId, change.id, 'approve', actor);
    expect(approved).toMatchObject({ status: 'approved', decidedBy: userId });
    expect(approved.updatedAt.getTime()).toBeGreaterThanOrEqual(change.updatedAt.getTime());

    const session = await service.createSession(
      workspaceId,
      { title: 'Implement login', prompt: 'Follow the tasks', changeId: change.id },
      actor,
    );
    await service.claim(workspaceId, session.id, { runner: 'laptop', worktreePath: '/work/x' });
    const reported = await service.report(workspaceId, session.id, {
      usedTokens: 170_000,
      events: [{ kind: 'message', text: 'Reading' }],
      subagents: [
        { id: 'a', name: 'Tests', role: 'qa', status: 'running', summary: '', usedTokens: 10 },
      ],
    });
    expect(reported.directives).toEqual({ compact: true, cancel: false, spawnSubagents: true });
    await service.submitDiff(workspaceId, session.id, [
      { path: 'src/login.ts', status: 'added', additions: 1, deletions: 0, patch: '+a' },
    ]);
    await service.complete(workspaceId, session.id, { outcome: 'succeeded', summary: 'Done' });
    // An inline review comment: a chat message (no file) would send the session back to the queue.
    await service.addComment(
      workspaceId,
      session.id,
      { body: 'Looks good', path: 'src/login.ts', line: 1 },
      actor,
    );

    // Read back from the database: the JSON body and the filter columns agree.
    const stored = await service.getSession(workspaceId, session.id);
    expect(stored).toMatchObject({
      status: 'waiting_review',
      changeId: change.id,
      runner: 'laptop',
      worktree: { path: '/work/x' },
      context: { usedTokens: 170_000 },
      diff: [{ path: 'src/login.ts' }],
      comments: [{ body: 'Looks good', authorName: 'Tester' }],
    });
    expect(
      await service.listSessions(workspaceId, { status: 'waiting_review', createdBy: userId }),
    ).toHaveLength(1);
    expect(await service.listSessions(workspaceId, { createdBy: 'someone-else' })).toHaveLength(0);
    expect((await service.pipeline(workspaceId)).review).toEqual([
      expect.objectContaining({
        changeId: change.id,
        session: expect.objectContaining({ id: session.id }),
      }),
    ]);
    await expect(service.getSession('another-workspace', session.id)).rejects.toThrow('not found');

    await service.review(workspaceId, session.id, { verdict: 'approve' }, actor);
    await service.transitionChange(workspaceId, change.id, 'archive', actor);
    await service.removeSession(workspaceId, session.id);
    await service.removeChange(workspaceId, change.id);
    expect(await service.listChanges(workspaceId)).toEqual([]);
    expect(await service.listSessions(workspaceId)).toEqual([]);
  });

  it('removes the development data of a deleted workspace', async () => {
    await service.createChange(workspaceId, { title: 'Left behind' }, actor);
    await service.createSession(workspaceId, { title: 'Ad hoc', prompt: 'go' }, actor);
    await db.client.workspaceRecord.delete({ where: { id: workspaceId } });
    expect(await service.listChanges(workspaceId)).toEqual([]);
    expect(await service.listSessions(workspaceId)).toEqual([]);
  });
});
