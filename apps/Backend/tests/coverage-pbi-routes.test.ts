import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createPbiRouter } from '../src/adapters/http/pbi-routes.js';
import type { RequestContextResolver } from '../src/adapters/http/compatibility-routes.js';
import type { PbiService } from '../src/modules/pbi/pbi-service.js';
import type { PbiItem } from '../src/modules/pbi/pbi-store.js';
import type { IssueStore } from '../src/modules/issues/issue-store.js';
import type { RunService } from '../src/modules/issues/run-service.js';
import type { WorkspaceService } from '../src/modules/workspaces/application/workspace-service.js';
import { ApplicationError } from '../src/shared/errors.js';
import type { RequestContext } from '../src/shared/context.js';

const ROOT_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';

function item(overrides: Partial<PbiItem> = {}): PbiItem {
  return {
    id: ROOT_ID,
    workspaceId: 'ws',
    parentId: null,
    kind: 'pbi',
    title: 'Root',
    description: '',
    status: 'backlog',
    position: 0,
    sourceData: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    links: [],
    ...overrides,
  };
}

const boom = () => Promise.reject(new ApplicationError('BOOM', 'Service failed.', 409));

function fakeService(overrides: Partial<Record<keyof PbiService, unknown>> = {}) {
  return {
    list: vi.fn(() => Promise.resolve([item()])),
    search: vi.fn(() =>
      Promise.resolve({
        items: [
          item({
            sourceData: { iterationPath: 'Sprint 1' },
            links: [
              {
                id: 'l1',
                providerId: 'azure_devops',
                externalId: '42',
                externalUrl: 'https://example.test/42',
                boardId: 'b',
                syncedAt: new Date(0),
              },
            ],
          }),
          item({ id: 'other' }),
        ],
        total: 2,
        page: 1,
        pageSize: 25,
      }),
    ),
    availableProviders: vi.fn(() => Promise.resolve([{ providerId: 'trello', settings: {} }])),
    currentIteration: vi.fn(() => Promise.resolve('Sprint 1')),
    pull: vi.fn((_ws: string, includeItems?: boolean) =>
      Promise.resolve(includeItems === false ? { results: [] } : { results: [], items: [item()] }),
    ),
    create: vi.fn(() => Promise.resolve(item())),
    get: vi.fn(() => Promise.resolve(item())),
    comments: vi.fn(() => Promise.resolve([])),
    syncChildren: vi.fn(() => Promise.resolve([])),
    update: vi.fn(() => Promise.resolve(item())),
    remove: vi.fn(() => Promise.resolve()),
    pushContract: vi.fn(() => Promise.resolve({ providerId: 'jira', update: false, fields: [] })),
    push: vi.fn(() => Promise.resolve({ item: item(), warnings: [] })),
    relations: vi.fn(() => Promise.resolve([])),
    addRelations: vi.fn(() => Promise.resolve([])),
    removeRelation: vi.fn(() => Promise.resolve([])),
    ...overrides,
  } as unknown as PbiService & Record<string, ReturnType<typeof vi.fn>>;
}

function build(options: {
  service?: PbiService;
  context?: Partial<RequestContext>;
  resolver?: RequestContextResolver | null;
  issues?: object;
  runs?: object;
  workspaces?: WorkspaceService;
}) {
  const app = express();
  app.use(express.json());
  const context: RequestContext = {
    requestId: 'r',
    ownerId: 'ws',
    workspaceId: 'ws',
    actorId: 'user-a',
    memberRole: 'ADMIN',
    ...options.context,
  };
  const resolver = options.resolver === null ? undefined : (options.resolver ?? (() => context));
  if (!resolver) app.use((req, _res, next) => ((req.context = context), next()));
  app.use(
    createPbiRouter(
      options.service ?? fakeService(),
      (options.issues ?? {}) as IssueStore,
      (options.runs ?? {}) as RunService,
      resolver,
      options.workspaces,
    ),
  );
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApplicationError)
      res.status(error.statusCode).json({ code: error.code, message: error.message });
    else res.status(500).json({ code: 'INTERNAL', message: String(error) });
  });
  return app;
}

describe('PBI routes (coverage)', () => {
  it('passes context resolver failures to the error handler', async () => {
    const app = build({
      resolver: () => {
        throw new ApplicationError('UNAUTHORIZED', 'No session.', 401);
      },
    });
    expect((await request(app).get('/pbi').expect(401)).body.code).toBe('UNAUTHORIZED');
  });

  it('works without a context resolver when the context is set upstream', async () => {
    const service = fakeService();
    const app = build({ service, resolver: null });
    expect((await request(app).get('/pbi').expect(200)).body.items).toHaveLength(1);
  });

  it('requires a workspace and rejects read-only tokens on writes', async () => {
    const noWorkspace = build({ context: { workspaceId: undefined } });
    expect((await request(noWorkspace).get('/pbi/providers').expect(400)).body.code).toBe(
      'WORKSPACE_REQUIRED',
    );
    const readOnly = build({ context: { tokenScope: 'read' } });
    expect((await request(readOnly).post('/pbi/pull').expect(403)).body.code).toBe('FORBIDDEN');
  });

  it('lists all items or searches with filters, optionally compacted', async () => {
    const service = fakeService();
    const app = build({ service });
    expect((await request(app).get('/pbi').expect(200)).body.items[0].id).toBe(ROOT_ID);

    const full = await request(app)
      .get('/pbi')
      .query({ externalId: '42', providerId: 'azure_devops', page: '1' })
      .expect(200);
    expect(full.body.total).toBe(2);
    expect(full.body.items[0].sourceData).toEqual({ iterationPath: 'Sprint 1' });
    expect(service.search).toHaveBeenCalledWith('ws', {
      externalId: '42',
      providerId: 'azure_devops',
      page: 1,
      pageSize: 25,
    });

    const compact = await request(app).get('/pbi').query({ compact: 'true' }).expect(200);
    expect(compact.body.items).toEqual([
      {
        id: ROOT_ID,
        parentId: null,
        kind: 'pbi',
        title: 'Root',
        status: 'backlog',
        iterationPath: 'Sprint 1',
        links: [
          { providerId: 'azure_devops', externalId: '42', externalUrl: 'https://example.test/42' },
        ],
      },
      expect.objectContaining({ id: 'other', iterationPath: null, links: [] }),
    ]);

    expect((await request(app).get('/pbi').query({ pageSize: '1000' }).expect(400)).body.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('returns providers and the current iteration', async () => {
    const app = build({});
    expect((await request(app).get('/pbi/providers').expect(200)).body.providers).toEqual([
      { providerId: 'trello', settings: {} },
    ]);
    expect((await request(app).get('/pbi/current-iteration').expect(200)).body).toEqual({
      currentIteration: 'Sprint 1',
    });
  });

  it('pulls with full items or only the summary', async () => {
    const service = fakeService();
    const app = build({ service });
    expect((await request(app).post('/pbi/pull').expect(200)).body.items).toHaveLength(1);
    expect(service.pull).toHaveBeenLastCalledWith('ws');
    const summary = await request(app).post('/pbi/pull?summaryOnly=true').expect(200);
    expect(summary.body).toEqual({ results: [] });
    expect(service.pull).toHaveBeenLastCalledWith('ws', false);
  });

  it('forwards service failures of every route to the error handler', async () => {
    const service = fakeService({
      search: boom,
      list: boom,
      availableProviders: boom,
      currentIteration: boom,
      pull: boom,
      create: boom,
      get: boom,
      comments: boom,
      syncChildren: boom,
      remove: boom,
      relations: boom,
      addRelations: boom,
      removeRelation: boom,
      update: boom,
    });
    const app = build({ service });
    const calls = [
      request(app).get('/pbi'),
      request(app).get('/pbi?page=2'),
      request(app).get('/pbi/providers'),
      request(app).get('/pbi/current-iteration'),
      request(app).post('/pbi/pull'),
      request(app).post('/pbi/items').send({ kind: 'pbi', title: 'New' }),
      request(app).get(`/pbi/items/${ROOT_ID}`),
      request(app).get(`/pbi/items/${ROOT_ID}/comments`),
      request(app).post(`/pbi/items/${ROOT_ID}/sync-children`),
      request(app).patch(`/pbi/items/${ROOT_ID}`).send({ title: 'Edited' }),
      request(app).delete(`/pbi/items/${ROOT_ID}`),
      request(app).post(`/pbi/items/${ROOT_ID}/push-contract`).send({ providerId: 'jira' }),
      request(app).post(`/pbi/items/${ROOT_ID}/push`).send({ providerId: 'jira' }),
      request(app).get(`/pbi/items/${ROOT_ID}/relations`),
      request(app)
        .post(`/pbi/items/${ROOT_ID}/relations`)
        .send({ type: 'related', targetIds: ['x'] }),
      request(app).delete(`/pbi/items/${ROOT_ID}/relations/related/x`),
      request(app).get(`/pbi/items/${ROOT_ID}/context`),
      request(app).post(`/pbi/items/${ROOT_ID}/issues`).send({}),
    ];
    for (const call of calls) expect((await call.expect(409)).body.code).toBe('BOOM');
  });

  it('records the actor of new relations, or null without one', async () => {
    const service = fakeService();
    await request(build({ service }))
      .post(`/pbi/items/${ROOT_ID}/relations`)
      .send({ type: 'related', targetIds: ['b'] })
      .expect(201);
    expect(service.addRelations).toHaveBeenLastCalledWith(
      'ws',
      ROOT_ID,
      'related',
      ['b'],
      'user-a',
    );
    await request(build({ service, context: { actorId: undefined } }))
      .post(`/pbi/items/${ROOT_ID}/relations`)
      .send({ type: 'related', targetIds: ['b'] })
      .expect(201);
    expect(service.addRelations).toHaveBeenLastCalledWith('ws', ROOT_ID, 'related', ['b'], null);
  });

  it('requires an authenticated actor to assign a member', async () => {
    const workspaces = { listMembers: vi.fn() } as unknown as WorkspaceService;
    const app = build({ workspaces, context: { actorId: undefined } });
    const response = await request(app)
      .post('/pbi/items')
      .send({ kind: 'pbi', title: 'New', sourceData: { adkAssigneeUserId: 'user-b' } })
      .expect(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
    expect(workspaces.listMembers).not.toHaveBeenCalled();
  });

  it('maps the item assignee to the push contract, falling back to the user id', async () => {
    const service = fakeService({
      get: vi.fn(() => Promise.resolve(item({ sourceData: { adkAssigneeUserId: 'gone' } }))),
    });
    const workspaces = {
      listMembers: vi.fn(() =>
        Promise.resolve([{ userId: 'user-a', user: { name: 'Alice', email: 'a@x.test' } }]),
      ),
    } as unknown as WorkspaceService;
    await request(build({ service, workspaces }))
      .post(`/pbi/items/${ROOT_ID}/push-contract`)
      .send({ providerId: 'jira' })
      .expect(200);
    expect(service.pushContract).toHaveBeenCalledWith('ws', ROOT_ID, 'jira', undefined, {
      name: 'gone',
      email: '',
    });
  });

  describe('creating issues from a PBI', () => {
    const issue = { id: 'issue-1', assigneeAgentId: AGENT_ID };

    it('starts an agent run for an assigned issue and returns the stored issue', async () => {
      const issues = {
        create: vi.fn(() => Promise.resolve(issue)),
        get: vi.fn(() => Promise.resolve({ ...issue, status: 'in_progress' })),
      };
      const runs = { create: vi.fn(() => Promise.resolve({ id: 'run-1' })) };
      const response = await request(build({ issues, runs }))
        .post(`/pbi/items/${ROOT_ID}/issues`)
        .send({ title: 'Custom', assigneeAgentId: AGENT_ID, runMode: 'host' })
        .expect(201);
      expect(response.body).toEqual({
        issue: { ...issue, status: 'in_progress' },
        run: { id: 'run-1' },
      });
      expect(runs.create).toHaveBeenCalledWith('issue-1', expect.anything(), 'host');
      expect(issues.create).toHaveBeenCalledWith('ws', 'user-a', {
        title: 'Custom',
        description: '',
        pbiItemId: ROOT_ID,
        assigneeAgentId: AGENT_ID,
      });
    });

    it('reports why the run could not start and falls back to the created issue', async () => {
      const issues = {
        create: vi.fn(() => Promise.resolve(issue)),
        get: vi.fn(() => Promise.resolve(null)),
      };
      const failing = { create: vi.fn(() => Promise.reject(new Error('Agent offline'))) };
      const first = await request(build({ issues, runs: failing }))
        .post(`/pbi/items/${ROOT_ID}/issues`)
        .send({ assigneeAgentId: AGENT_ID })
        .expect(201);
      expect(first.body).toEqual({ issue, automationError: 'Agent offline' });

      const odd = { create: vi.fn(() => Promise.reject('nope')) };
      const second = await request(build({ issues, runs: odd }))
        .post(`/pbi/items/${ROOT_ID}/issues`)
        .send({ assigneeAgentId: AGENT_ID })
        .expect(201);
      expect(second.body.automationError).toBe('Agent execution could not start.');
    });
  });
});
