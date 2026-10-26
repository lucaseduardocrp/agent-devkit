import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import { createIssuesRouter } from '../src/adapters/http/issues-routes.js';
import { createPbiRouter } from '../src/adapters/http/pbi-routes.js';
import { InMemoryIssueStore } from '../src/modules/issues/issue-store.js';
import { InMemoryE2eArtifactStore } from '../src/modules/e2e/application/artifact-store.js';
import type { AgentService } from '../src/modules/agents/application/agent-service.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import type { PbiService } from '../src/modules/pbi/pbi-service.js';
import type { IssueStore } from '../src/modules/issues/issue-store.js';
import type { RequestContext } from '../src/shared/context.js';
import { ApplicationError } from '../src/shared/errors.js';

const context: RequestContext = {
  requestId: 'r',
  ownerId: 'ws',
  workspaceId: 'ws',
  actorId: 'user-a',
  memberRole: 'ADMIN',
};
const link = (scope: 'issue' | 'pbi') => ({
  id: `inline:https://cdn.example/${scope}.png`,
  name: `${scope}.png`,
  scope,
  source: 'url',
  url: `https://cdn.example/${scope}.png`,
});

function issuesApp(runs: Partial<Record<keyof RunService, unknown>> = {}) {
  const store = new InMemoryIssueStore();
  const app = express();
  app.use(express.json());
  app.use(
    createIssuesRouter(
      store,
      {} as AgentService,
      {} as WorkspaceService,
      runs as unknown as RunService,
      () => context,
      new InMemoryE2eArtifactStore(),
    ),
  );
  app.use(errorMiddleware);
  return { app, store };
}

describe('issue routes with attachments', () => {
  it('stores validated attachments on create and update', async () => {
    const { app, store } = issuesApp();
    const created = await request(app)
      .post('/issues')
      .send({ title: 'With image', attachments: [link('issue')] })
      .expect(201);
    expect(created.body.issue.attachments).toEqual([link('issue')]);
    const id = created.body.issue.id as string;
    await request(app)
      .patch(`/issues/${id}`)
      .send({ attachments: [link('pbi')] })
      .expect(200);
    expect((await store.get('ws', id))!.attachments).toEqual([link('pbi')]);
    await request(app)
      .post('/issues')
      .send({ title: 'Bad', attachments: [{ ...link('issue'), url: 'http://cdn.example/x.png' }] })
      .expect(400);
  });
});

describe('inbox states', () => {
  it('returns read and archived times newer than the latest activity', async () => {
    const assignedTo = vi.fn();
    const { app, store } = issuesApp({ assignedTo });
    const issue = await store.create('ws', 'user-a', { title: 'Inbox' });
    assignedTo.mockResolvedValue([
      { id: 'run', issueId: issue.id, createdAt: new Date(0), finishedAt: null },
    ]);
    const later = new Date(issue.updatedAt.getTime() + 1000);
    await store.setInboxState(issue.id, 'user-a', { readAt: later, archivedAt: later });
    const response = await request(app).get('/inbox').expect(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({
        readAt: later.toISOString(),
        archivedAt: later.toISOString(),
        runs: [expect.objectContaining({ id: 'run' })],
      }),
    ]);
  });
});

describe('workflow continuation route', () => {
  it('continues a run with the validated action', async () => {
    const continueWorkflow = vi.fn(async (_ws: string, id: string, fields: object) => ({
      id,
      ...fields,
    }));
    const { app } = issuesApp({ continueWorkflow });
    const response = await request(app)
      .post('/runs/run-1/continue')
      .send({ action: 'answer', answer: ' staging ' })
      .expect(200);
    expect(response.body.run).toEqual({ id: 'run-1', action: 'answer', answer: 'staging' });
    expect(continueWorkflow).toHaveBeenCalledWith('ws', 'run-1', {
      action: 'answer',
      answer: 'staging',
    });
  });

  it('requires an answer for revisions and forwards service errors', async () => {
    const continueWorkflow = vi.fn(() =>
      Promise.reject(new ApplicationError('INVALID_RUN_STATE', 'Not waiting.', 409)),
    );
    const { app } = issuesApp({ continueWorkflow });
    await request(app).post('/runs/run-1/continue').send({ action: 'revise' }).expect(400);
    expect(continueWorkflow).not.toHaveBeenCalled();
    const response = await request(app)
      .post('/runs/run-1/continue')
      .send({ action: 'approve' })
      .expect(409);
    expect(response.body.code).toBe('INVALID_RUN_STATE');
  });
});

describe('PBI routes with attachments', () => {
  it('validates attachments on create and update', async () => {
    const item = { id: 'item-1', workspaceId: 'ws', title: 'Root', sourceData: {}, links: [] };
    const service = {
      create: vi.fn(async (_ws: string, fields: object) => ({ ...item, ...fields })),
      get: vi.fn(async () => item),
      update: vi.fn(async (_ws: string, _id: string, fields: object) => ({ ...item, ...fields })),
    };
    const app = express();
    app.use(express.json());
    app.use(
      createPbiRouter(
        service as unknown as PbiService,
        {} as IssueStore,
        {} as RunService,
        () => context,
        undefined,
        new InMemoryE2eArtifactStore(),
      ),
    );
    app.use(errorMiddleware);
    const created = await request(app)
      .post('/pbi/items')
      .send({ kind: 'pbi', title: 'Root', attachments: [link('pbi')] })
      .expect(201);
    expect(created.body.item.attachments).toEqual([link('pbi')]);
    await request(app)
      .patch('/pbi/items/item-1')
      .send({ attachments: [link('pbi')] })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(
      'ws',
      'item-1',
      expect.objectContaining({ attachments: [link('pbi')] }),
    );
    await request(app)
      .patch('/pbi/items/item-1')
      .send({ attachments: [link('issue')] })
      .expect(400);
  });
});
