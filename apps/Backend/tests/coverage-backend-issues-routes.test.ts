import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const admin: RequestContext = {
  requestId: 'r',
  ownerId: 'ws',
  workspaceId: 'ws',
  actorId: 'user-a',
  memberRole: 'ADMIN',
};

const link = {
  id: 'https://files.example.test/a.pdf',
  name: 'a.pdf',
  scope: 'issue',
  source: 'url',
  url: 'https://files.example.test/a.pdf',
};

let store: InMemoryIssueStore;
let runs: Record<string, ReturnType<typeof vi.fn>>;

function build() {
  const app = express();
  app.use(express.json());
  app.use(
    createIssuesRouter(
      store,
      { getAgent: vi.fn(), listAgents: vi.fn() } as unknown as AgentService,
      { listMembers: vi.fn().mockResolvedValue([]) } as unknown as WorkspaceService,
      runs as unknown as RunService,
      () => admin,
      new InMemoryE2eArtifactStore(),
    ),
  );
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => {
  store = new InMemoryIssueStore();
  runs = {
    assignedTo: vi.fn().mockResolvedValue([]),
    continueWorkflow: vi.fn(async (_ws: string, id: string) => ({ id, status: 'running' })),
  };
});
afterEach(() => vi.restoreAllMocks());

describe('issue routes: attachments', () => {
  it('stores validated attachments when creating an issue, or none', async () => {
    const app = build();
    const plain = await request(app).post('/issues').send({ title: 'Plain' }).expect(201);
    expect(plain.body.issue.attachments).toEqual([]);
    const withFile = await request(app)
      .post('/issues')
      .send({ title: 'With file', attachments: [link] })
      .expect(201);
    expect(withFile.body.issue.attachments).toEqual([link]);
    await request(app)
      .post('/issues')
      .send({ title: 'Bad scope', attachments: [{ ...link, scope: 'spec' }] })
      .expect(400);
  });

  it('changes the attachments of an issue only when they are sent', async () => {
    const app = build();
    const created = await request(app).post('/issues').send({ title: 'Edit me' }).expect(201);
    const id = created.body.issue.id as string;
    const renamed = await request(app)
      .patch(`/issues/${id}`)
      .send({ title: 'Renamed' })
      .expect(200);
    expect(renamed.body.issue.attachments).toEqual([]);
    const changed = await request(app)
      .patch(`/issues/${id}`)
      .send({ attachments: [link] })
      .expect(200);
    expect(changed.body.issue.attachments).toEqual([link]);
  });
});

describe('issue routes: continuing a workflow', () => {
  it('needs an answer unless the reviewer approves', async () => {
    const app = build();
    await request(app).post('/runs/run-1/continue').send({ action: 'approve' }).expect(200);
    expect(runs.continueWorkflow).toHaveBeenLastCalledWith('ws', 'run-1', { action: 'approve' });
    await request(app)
      .post('/runs/run-1/continue')
      .send({ action: 'answer', answer: 'Use the staging data.' })
      .expect(200);
    const missing = await request(app)
      .post('/runs/run-1/continue')
      .send({ action: 'revise' })
      .expect(400);
    expect(missing.body.error?.code ?? missing.body.code).toBe('VALIDATION_ERROR');
  });

  it('forwards failures of the workflow to the error handler', async () => {
    runs.continueWorkflow!.mockRejectedValueOnce(
      new ApplicationError('INVALID_RUN_STATE', 'Not waiting.', 409),
    );
    await request(build()).post('/runs/run-1/continue').send({ action: 'approve' }).expect(409);
  });
});

describe('issue routes: inbox', () => {
  it('sorts issues without runs by their last update and keeps fresh read states', async () => {
    const reviewed = await store.create('ws', 'user-b', { title: 'Reviewed' });
    await store.update('ws', reviewed.id, { proofreaderUserId: 'user-a' });
    const ran = await store.create('ws', 'user-b', { title: 'Ran' });
    runs.assignedTo!.mockResolvedValue([
      {
        id: 'run-1',
        issueId: ran.id,
        agentId: 'agent',
        status: 'succeeded',
        attempt: 1,
        createdAt: new Date('2030-01-01T00:00:00Z'),
        finishedAt: null,
      },
    ]);
    const app = build();
    await request(app)
      .patch(`/inbox/${reviewed.id}`)
      .send({ read: true, archived: true })
      .expect(200);
    const inbox = (await request(app).get('/inbox').expect(200)).body.items;
    expect(inbox.map((item: { issue: { title: string } }) => item.issue.title)).toEqual([
      'Ran',
      'Reviewed',
    ]);
    const item = inbox.find((entry: { issue: { id: string } }) => entry.issue.id === reviewed.id);
    expect(item.readAt).toBeTruthy();
    expect(item.archivedAt).toBeTruthy();
  });
});
