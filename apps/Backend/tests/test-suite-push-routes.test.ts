import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
} from '../src/modules/testplans/application/saved-test-plans.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
} from '../src/modules/testplans/application/test-suites.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';

describe('POST /TestPlan/suites/:id/push', () => {
  it('publishes the workspace suite through the provider port', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const suite = await new TestSuiteService(suites).create('ws-1', 'Regression');
    await plans.save(
      createSavedTestPlan('ws-1', { suiteId: suite.id }, [
        { title: 'Login', description: '', steps: [{ action: 'Open', expectedResult: 'Opened' }] },
      ]),
    );
    const publish = vi.fn(async () => ({
      provider: 'fake',
      remotePlanId: '8',
      remoteSuiteId: '9',
      remoteUrl: 'https://example.com',
      suitesCount: 1,
      casesCount: 1,
    }));
    const listPlans = vi.fn(async () => [{ id: '8', name: 'Regression' }]);
    const listSuites = vi.fn(async () => [{ id: '9', name: 'Root', suiteType: 'staticTestSuite' }]);
    const resolveTestSuitePublisher = vi.fn(async () => ({ publish, listPlans, listSuites }));
    const listTestSuiteProviders = vi.fn(async () => [
      { id: 'azure_devops', name: 'Azure DevOps', configured: true },
    ]);
    const app = createApp({
      savedTestPlans: plans,
      testSuites: suites,
      dynamicProviderFactory: {
        resolveTestSuitePublisher,
        listTestSuiteProviders,
      } as unknown as DynamicProviderFactory,
      requestContextResolver: async () => ({ requestId: 'test', ownerId: 'ws-1' }),
    });
    const response = await request(app)
      .post(`/TestPlan/suites/${suite.id}/push`)
      .send({ providerId: 'azure_devops', remotePlanId: '8', remoteParentSuiteId: '9' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ remotePlanId: '8', casesCount: 1 });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'Regression' }), {
      remotePlanId: '8',
      remoteParentSuiteId: '9',
      remoteSuiteId: undefined,
      remoteSuiteName: undefined,
    });
    const directResponse = await request(app)
      .post(`/TestPlan/suites/${suite.id}/push`)
      .send({ providerId: 'azure_devops', remotePlanId: '8', remoteSuiteId: '9' });
    expect(directResponse.status).toBe(200);
    expect(publish).toHaveBeenLastCalledWith(expect.anything(), {
      remotePlanId: '8',
      remoteParentSuiteId: undefined,
      remoteSuiteId: '9',
      remoteSuiteName: undefined,
    });
    const namedResponse = await request(app).post(`/TestPlan/suites/${suite.id}/push`).send({
      providerId: 'azure_devops',
      remotePlanId: '8',
      remoteParentSuiteId: '9',
      remoteSuiteName: '  Sprint 181  ',
    });
    expect(namedResponse.status).toBe(200);
    expect(publish).toHaveBeenLastCalledWith(expect.anything(), {
      remotePlanId: '8',
      remoteParentSuiteId: '9',
      remoteSuiteId: undefined,
      remoteSuiteName: 'Sprint 181',
    });
    expect((await request(app).get('/TestPlan/publish/providers')).body.providers).toHaveLength(1);
    expect(
      (await request(app).get('/TestPlan/publish/plans?providerId=azure_devops')).body.plans,
    ).toEqual([{ id: '8', name: 'Regression' }]);
    expect(
      (await request(app).get('/TestPlan/publish/plans/8/suites?providerId=azure_devops')).body
        .suites,
    ).toEqual([{ id: '9', name: 'Root', suiteType: 'staticTestSuite' }]);
    expect(listSuites).toHaveBeenCalledWith('8');
    expect(
      (
        await request(app)
          .post(`/TestPlan/suites/${suite.id}/push`)
          .send({ providerId: 'azure_devops', remotePlanId: 'oops' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/TestPlan/suites/missing/push')
          .send({ providerId: 'azure_devops' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/TestPlan/suites/${suite.id}/push`)
          .send({ providerId: 'azure_devops', remoteParentSuiteId: '9' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/TestPlan/suites/${suite.id}/push`)
          .send({ providerId: 'azure_devops', remoteSuiteName: 'Orphan' })
      ).status,
    ).toBe(400);
  });

  it('rejects viewers and unconfigured providers', async () => {
    const suites = new InMemoryTestSuiteStore();
    const suite = await new TestSuiteService(suites).create('ws-1', 'Regression');
    const viewer = createApp({
      testSuites: suites,
      requestContextResolver: async () => ({
        requestId: 'test',
        ownerId: 'ws-1',
        memberRole: 'VIEWER',
      }),
    });
    expect(
      (
        await request(viewer)
          .post(`/TestPlan/suites/${suite.id}/push`)
          .send({ providerId: 'azure_devops' })
      ).status,
    ).toBe(403);
    const unconfigured = createApp({
      testSuites: suites,
      requestContextResolver: async () => ({ requestId: 'test', ownerId: 'ws-1' }),
    });
    expect(
      (
        await request(unconfigured)
          .post(`/TestPlan/suites/${suite.id}/push`)
          .send({ providerId: 'azure_devops' })
      ).body.code,
    ).toBe('TEST_SUITE_PROVIDER_NOT_CONFIGURED');
  });
});
