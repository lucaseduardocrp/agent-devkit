import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCompatibilityRouter } from '../src/adapters/http/compatibility-routes.js';
import { createApp } from '../src/adapters/http/app.js';
import { InMemoryKnowledgeSearch } from '../src/modules/knowledge/application/knowledge-search.js';
import { InMemorySavedTestPlanStore } from '../src/modules/testplans/application/saved-test-plans.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
} from '../src/modules/testplans/application/test-suites.js';
import type { TestManagementResolver } from '../src/modules/test-management/application/test-management-provider.js';

describe('compatibility routes', () => {
  it('imports Azure Test Cases with custom fields and the remote case location', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const suite = await new TestSuiteService(suites).create('workspace-1', 'Imported');
    const provider = {
      id: 'azure_devops' as const,
      name: 'Azure DevOps',
      capabilities: {
        planLabel: 'Plan',
        suiteLabel: 'Suite',
        suiteRequired: true,
        caseIdLabel: 'ID',
        stepEvidence: true,
      },
      listPlans: async () => [],
      listSuites: async () => [],
      getCase: async () => {
        throw new Error('unused');
      },
      publishRun: async () => {
        throw new Error('unused');
      },
      listCases: async () => [
        {
          provider: 'azure_devops' as const,
          caseId: '50735',
          title: 'Classification',
          description: 'Scenario',
          steps: [],
          customFields: { 'Custom.Classification': 'Workflow', 'Custom.Estimate': 4 },
        },
      ],
    };
    const resolver: TestManagementResolver = {
      listTestManagementProviders: async () => [],
      resolveTestManagementProvider: async () => provider,
    };
    const app = createApp({
      requestContextResolver: async () => ({ requestId: 'import', ownerId: 'workspace-1' }),
      savedTestPlans: plans,
      testSuites: suites,
      testManagement: resolver,
    });
    const imported = await request(app).post('/TestPlan/import').send({
      providerId: 'azure_devops',
      planId: '10',
      suiteId: '20',
      localSuiteId: suite.id,
    });
    expect(imported.status).toBe(201);
    expect(imported.body.savedPlan.plans[0]).toMatchObject({
      title: 'Classification',
      description: 'Scenario',
      metadata: {
        remoteCaseIds: { azure_devops: '50735' },
        remoteCaseLocations: { azure_devops: { planId: '10', suiteId: '20' } },
        customFields: {
          azure_devops: { 'Custom.Classification': 'Workflow', 'Custom.Estimate': 4 },
        },
      },
    });
    const sources = await request(app).get(`/TestPlan/suites/${suite.id}/field-sources`);
    expect(sources.body.sources).toEqual(
      expect.arrayContaining([
        { providerId: 'azure_devops', key: 'Custom.Classification' },
        { providerId: 'azure_devops', key: 'Custom.Estimate' },
      ]),
    );
  });
  it('persists, lists, and updates generated Test Plans by workspace', async () => {
    const app = createApp({
      requestContextResolver: async () => ({ requestId: 'saved', ownerId: 'workspace-1' }),
    });
    const generated = await request(app)
      .post('/TestPlan/generate')
      .send({ prompt: 'Checkout', title: 'Checkout plan', criteria: 'Must pay' });
    expect(generated.status).toBe(200);
    expect(generated.body.savedPlan).toMatchObject({
      workspaceId: 'workspace-1',
      title: 'Checkout plan',
    });
    expect(generated.body.savedPlan.suiteId).toEqual(expect.any(String));
    const defaultSuites = await request(app).get('/TestPlan/suites');
    expect(defaultSuites.body).toEqual([
      expect.objectContaining({ id: generated.body.savedPlan.suiteId, name: 'Test' }),
    ]);

    const listed = await request(app).get('/TestPlan');
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body).toMatchObject({ page: 1, pageSize: 10, total: 1, totalPages: 1 });
    const updated = await request(app).put(`/TestPlan/${generated.body.savedPlan.id}`).send({
      title: 'Revised plan',
      plans: generated.body.plans,
    });
    expect(updated.body).toMatchObject({ title: 'Revised plan' });
    expect(updated.body).not.toHaveProperty('prompt');
    expect(updated.body).not.toHaveProperty('criteria');
    const unchanged = await request(app)
      .put(`/TestPlan/${generated.body.savedPlan.id}`)
      .send({ title: '   ' });
    expect(unchanged.body.title).toBe('Revised plan');
    expect(
      (await request(app).put(`/TestPlan/${generated.body.savedPlan.id}`).send({ suiteId: null }))
        .status,
    ).toBe(400);
    expect((await request(app).put('/TestPlan/missing').send({ title: 'Nope' })).status).toBe(404);

    expect((await request(app).delete('/TestPlan/missing')).status).toBe(404);
    const deleted = await request(app).delete(`/TestPlan/${generated.body.savedPlan.id}`);
    expect(deleted.status).toBe(204);
    const listedAfterDelete = await request(app).get('/TestPlan');
    expect(listedAfterDelete.body.items).toHaveLength(0);

    const noOwner = createApp({ requestContextResolver: async () => ({ requestId: 'none' }) });
    expect((await request(noOwner).get('/TestPlan')).status).toBe(403);
    expect((await request(noOwner).delete('/TestPlan/p1')).status).toBe(403);
  });
  it('generates a CSV Test Plan', async () => {
    const response = await request(createApp())
      .post('/TestPlan/generate/csv')
      .send({ prompt: 'Create a user' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.text).toContain('Generated Test Plan');
  });

  it('generates a structured JSON Test Plan via POST /TestPlan/generate', async () => {
    const response = await request(createApp())
      .post('/TestPlan/generate')
      .send({ prompt: 'Create an invoice', assignedTo: 'User1', areaPath: 'Finances' });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.plans)).toBe(true);
    expect(response.body.plans[0].title).toBe('Generated Test Plan');
    expect(response.body.csv).toContain('Work Item Type');
    expect(response.body.csv).toContain('User1');
  });

  it('rejects invalid Test Plan input', async () => {
    const response = await request(createApp()).post('/TestPlan/generate/csv').send({ prompt: '' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');

    const jsonResponse = await request(createApp()).post('/TestPlan/generate').send({ prompt: '' });
    expect(jsonResponse.status).toBe(400);
    expect(jsonResponse.body.code).toBe('VALIDATION_ERROR');
  });

  it('forwards generator errors to next error middleware', async () => {
    const failingGenerator = {
      generate: () => Promise.reject(new Error('Generator internal failure')),
    };

    const app = express();
    app.use(express.json());
    app.use(createCompatibilityRouter(undefined, failingGenerator));
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      },
    );

    const resCsv = await request(app).post('/TestPlan/generate/csv').send({ prompt: 'test' });
    expect(resCsv.status).toBe(500);
    expect(resCsv.body.error).toBe('Generator internal failure');

    const resJson = await request(app).post('/TestPlan/generate').send({ prompt: 'test' });
    expect(resJson.status).toBe(500);
    expect(resJson.body.error).toBe('Generator internal failure');
  });

  it('handles generators returning a single plan without .plans property', async () => {
    const singlePlanGenerator = {
      generate: () =>
        Promise.resolve({
          title: 'Single Plan',
          description: 'Single Desc',
          steps: [{ order: 1, action: 'Step 1', expectedResult: 'Done' }],
        } as unknown as import('../src/modules/testplans/application/generate-test-plan.js').GeneratedTestPlanResult),
    };

    const app = express();
    app.use(express.json());
    app.use(createCompatibilityRouter(undefined, singlePlanGenerator));

    const resCsv = await request(app).post('/TestPlan/generate/csv').send({ prompt: 'test' });
    expect(resCsv.status).toBe(200);

    const resJson = await request(app).post('/TestPlan/generate').send({ prompt: 'test' });
    expect(resJson.status).toBe(200);
    expect(resJson.body.plans[0].title).toBe('Single Plan');
  });

  it('fails closed when no trusted owner context resolver is configured', async () => {
    const response = await request(createApp())
      .get('/TestPlan/search')
      .query({ prompt: 'missing' });

    expect(response.status).toBe(403);
  });

  it('returns matching search chunks', async () => {
    const search = new InMemoryKnowledgeSearch([
      {
        ownerId: 'owner-1',
        chunk: {
          source: 'knowledge',
          pageId: 'page-1',
          chunkIndex: 0,
          content: 'Searchable knowledge',
          createdAt: '2026-09-10T00:00:00Z',
        },
      },
    ]);
    const app = express();
    app.use(express.json());
    app.use(
      createCompatibilityRouter(search, undefined, () => ({
        requestId: 'request-1',
        ownerId: 'owner-1',
      })),
    );
    const response = await request(app).get('/TestPlan/search').query({ prompt: 'knowledge' });

    expect(response.status).toBe(200);
    expect(response.body[0].pageId).toBe('page-1');
  });

  it('returns no content for an owned search without matches', async () => {
    const response = await request(
      createApp({
        requestContextResolver: () => ({ requestId: 'request-1', ownerId: 'owner-1' }),
      }),
    )
      .get('/TestPlan/search')
      .query({ prompt: 'missing' });

    expect(response.status).toBe(204);
  });

  it('rejects an empty search prompt', async () => {
    const response = await request(createApp()).get('/TestPlan/search').query({ prompt: '' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects search without an explicit owner context', async () => {
    const response = await request(createApp())
      .get('/TestPlan/search')
      .query({ prompt: 'knowledge' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('OWNER_CONTEXT_REQUIRED');
  });

  it('accepts a valid webhook payload', async () => {
    const response = await request(createApp())
      .post('/WikiWebhook/azure-devops')
      .send({ eventType: 'git.push' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true });
  });

  it('rejects an invalid webhook payload', async () => {
    const response = await request(createApp()).post('/WikiWebhook/azure-devops').send({});

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('can run the compatibility router without the request middleware', async () => {
    const app = express();
    app.use(express.json());
    app.use(createCompatibilityRouter());
    const response = await request(app).get('/TestPlan/search').query({ prompt: 'missing' });

    expect(response.status).toBe(403);
  });

  it('uses x-request-id from response headers when present in default context resolver', async () => {
    const app = express();
    app.use((_req, res, next) => {
      res.setHeader('x-request-id', 'header-req-id');
      next();
    });
    app.use(createCompatibilityRouter());
    const response = await request(app).get('/TestPlan/search').query({ prompt: 'missing' });

    expect(response.status).toBe(403);
  });
});
