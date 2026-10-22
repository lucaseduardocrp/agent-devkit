import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorMiddleware } from '../src/adapters/http/app.js';
import {
  createCompatibilityRouter,
  type RequestContextResolver,
} from '../src/adapters/http/compatibility-routes.js';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
  type SavedTestPlanStore,
} from '../src/modules/testplans/application/saved-test-plans.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
  type TestSuiteStore,
} from '../src/modules/testplans/application/test-suites.js';
import {
  InMemoryFieldMappingStore,
  type FieldMappingStore,
} from '../src/modules/field-mapping/field-mapping.js';
import type { DynamicProviderFactory } from '../src/modules/integrations/application/dynamic-provider-factory.js';
import type { TestManagementResolver } from '../src/modules/test-management/application/test-management-provider.js';
import { parseAndNormalizeTestPlans } from '../src/modules/testplans/domain/test-plan.js';
import { serializeTestPlanCsv } from '../src/modules/testplans/adapters/csv-test-plan-exporters.js';
import type { TestPlan } from '../src/modules/testplans/domain/test-plan.js';

const owner: RequestContextResolver = () => ({ requestId: 'r', ownerId: 'ws' });
const anonymous: RequestContextResolver = () => ({ requestId: 'r' });

interface Setup {
  context?: RequestContextResolver;
  plans?: SavedTestPlanStore;
  suites?: TestSuiteStore;
  // Stubs only implement the provider methods each scenario exercises.
  factory?: { [K in keyof DynamicProviderFactory]?: (...args: never[]) => unknown };
  mappings?: FieldMappingStore;
  testManagement?: TestManagementResolver;
}

function build(setup: Setup = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    createCompatibilityRouter(
      undefined,
      undefined,
      setup.context ?? owner,
      setup.plans ?? new InMemorySavedTestPlanStore(),
      setup.suites ?? new InMemoryTestSuiteStore(),
      setup.factory as unknown as DynamicProviderFactory | undefined,
      setup.mappings ?? new InMemoryFieldMappingStore(),
      setup.testManagement,
    ),
  );
  app.use(errorMiddleware);
  return app;
}

const testCase = (title: string, metadata?: Record<string, unknown>): TestPlan => ({
  title,
  description: 'Scenario',
  steps: [{ action: 'Open', expectedResult: 'Opened' }],
  ...(metadata ? { metadata } : {}),
});

const caseFields = [
  { id: 'Custom.Area', name: 'Area', type: 'text' as const },
  { id: 'Custom.Priority', name: 'Priority', type: 'number' as const },
];

describe('test suite publish provider routes', () => {
  it('lists no providers without a provider factory and requires an owner', async () => {
    expect((await request(build()).get('/TestPlan/publish/providers')).body).toEqual({
      providers: [],
    });
    const denied = await request(build({ context: anonymous })).get('/TestPlan/publish/providers');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('OWNER_CONTEXT_REQUIRED');
  });

  it('lists destination Test Case fields only for providers exposing them', async () => {
    const listCaseFields = vi.fn(async () => caseFields);
    const resolveTestSuitePublisher = vi
      .fn()
      .mockResolvedValueOnce({ listCaseFields })
      .mockResolvedValueOnce({});
    const app = build({ factory: { resolveTestSuitePublisher } });

    const fields = await request(app).get('/TestPlan/publish/fields?providerId=azure_devops');
    expect(fields.body).toEqual({ fields: caseFields });
    expect(resolveTestSuitePublisher).toHaveBeenCalledWith('ws', 'azure_devops');

    const unsupported = await request(app).get('/TestPlan/publish/fields?providerId=jira');
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('FIELD_MAPPING_UNSUPPORTED');

    const noFactory = await request(build()).get('/TestPlan/publish/fields?providerId=x');
    expect(noFactory.body.code).toBe('FIELD_MAPPING_UNSUPPORTED');
  });

  it('rejects remote plan and suite listings without a configured provider', async () => {
    const resolveTestSuitePublisher = vi.fn().mockResolvedValue(undefined);
    const app = build({ factory: { resolveTestSuitePublisher } });

    const plans = await request(app).get('/TestPlan/publish/plans?providerId=azure_devops');
    expect(plans.status).toBe(400);
    expect(plans.body.code).toBe('TEST_SUITE_PROVIDER_NOT_CONFIGURED');
    const suites = await request(app).get(
      '/TestPlan/publish/plans/12/suites?providerId=azure_devops',
    );
    expect(suites.status).toBe(400);
    expect(suites.body.code).toBe('TEST_SUITE_PROVIDER_NOT_CONFIGURED');

    const invalidPlan = await request(app).get(
      '/TestPlan/publish/plans/abc/suites?providerId=azure_devops',
    );
    expect(invalidPlan.status).toBe(400);
    expect(invalidPlan.body.code).toBe('INVALID_REMOTE_PLAN_ID');
    expect(resolveTestSuitePublisher).toHaveBeenCalledTimes(2);

    const anonymousApp = build({ context: anonymous, factory: { resolveTestSuitePublisher } });
    expect((await request(anonymousApp).get('/TestPlan/publish/plans?providerId=x')).status).toBe(
      403,
    );
    expect(
      (await request(anonymousApp).get('/TestPlan/publish/plans/1/suites?providerId=x')).status,
    ).toBe(403);
  });

  it('rejects imports when no test management resolver is configured', async () => {
    const response = await request(build())
      .post('/TestPlan/import')
      .send({ providerId: 'azure_devops', planId: '10' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TEST_PROVIDER_NOT_CONFIGURED');
  });
});

async function seedSuiteTree() {
  const suites = new InMemoryTestSuiteStore();
  const plans = new InMemorySavedTestPlanStore();
  const service = new TestSuiteService(suites);
  const root = await service.create('ws', 'Root');
  const other = await service.create('ws', 'Other');
  const now = new Date().toISOString();
  // Saved before its parent so the descendant walk needs a second pass.
  await suites.save({
    id: 'grandchild',
    workspaceId: 'ws',
    parentId: 'child',
    name: 'Grandchild',
    createdAt: now,
    updatedAt: now,
  });
  await suites.save({
    id: 'child',
    workspaceId: 'ws',
    parentId: root.id,
    name: 'Child',
    createdAt: now,
    updatedAt: now,
  });
  return { suites, plans, root, other };
}

describe('suite field sources and previews', () => {
  it('collects custom field keys from the suite and every descendant suite', async () => {
    const { suites, plans, root, other } = await seedSuiteTree();
    await plans.save(
      createSavedTestPlan('ws', { suiteId: root.id }, [
        testCase('Root case', { customFields: { azure_devops: { 'Custom.Area': 'Web' } } }),
        testCase('Array custom fields', { customFields: ['ignored'] }),
        testCase('Text custom fields', { customFields: 'ignored' }),
        testCase('Mixed providers', {
          customFields: { jira: ['bad'], trello: 'bad', xray: null, testrail: { Priority: 1 } },
        }),
      ]),
    );
    await plans.save(
      createSavedTestPlan('ws', { suiteId: 'grandchild' }, [
        testCase('Deep case', { customFields: { azure_devops: { 'Custom.Priority': 2 } } }),
      ]),
    );
    await plans.save(
      createSavedTestPlan('ws', { suiteId: other.id }, [
        testCase('Other', { customFields: { jira: { Hidden: 'x' } } }),
      ]),
    );
    await plans.save(createSavedTestPlan('ws', {}, [testCase('Loose')]));

    const response = await request(build({ suites, plans })).get(
      `/TestPlan/suites/${root.id}/field-sources`,
    );
    expect(response.status).toBe(200);
    expect(response.body.sources).toHaveLength(3);
    expect(response.body.sources).toEqual(
      expect.arrayContaining([
        { providerId: 'azure_devops', key: 'Custom.Area' },
        { providerId: 'testrail', key: 'Priority' },
        { providerId: 'azure_devops', key: 'Custom.Priority' },
      ]),
    );

    const missing = await request(build({ suites, plans })).get(
      '/TestPlan/suites/missing/field-sources',
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TEST_SUITE_NOT_FOUND');
  });

  it('previews mapped values for at most twenty suite cases', async () => {
    const { suites, plans, root } = await seedSuiteTree();
    await plans.save(
      createSavedTestPlan(
        'ws',
        { suiteId: 'child' },
        Array.from({ length: 21 }, (_, index) =>
          testCase(`Case ${index}`, {
            customFields: { azure_devops: { Priority: String(index) } },
          }),
        ),
      ),
    );
    const mappings = new InMemoryFieldMappingStore();
    const template = await mappings.save('ws', null, {
      name: 'Azure',
      entityType: 'test_case',
      providerId: 'azure_devops',
      scope: '',
      itemType: '',
      rules: [
        { targetFieldId: 'Custom.Area', source: { kind: 'core', key: 'title' } },
        {
          targetFieldId: 'Custom.Priority',
          source: { kind: 'custom', providerId: 'azure_devops', key: 'Priority' },
        },
      ],
    });
    const listCaseFields = vi.fn(async () => caseFields);
    const app = build({
      suites,
      plans,
      mappings,
      factory: { resolveTestSuitePublisher: vi.fn(async () => ({ listCaseFields })) },
    });

    const response = await request(app)
      .post(`/TestPlan/suites/${root.id}/field-preview`)
      .send({ providerId: 'azure_devops', templateId: template.id });
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(21);
    expect(response.body.previews).toHaveLength(20);
    expect(response.body.previews[3]).toEqual({
      title: 'Case 3',
      values: { 'Custom.Area': 'Case 3', 'Custom.Priority': 3 },
    });

    // Values filled in when publishing replace the template source of that field.
    const filled = await request(app)
      .post(`/TestPlan/suites/${root.id}/field-preview`)
      .send({
        providerId: 'azure_devops',
        templateId: template.id,
        fieldValues: { 'Custom.Area': 'Fixed area' },
      });
    expect(filled.body.previews[3]).toEqual({
      title: 'Case 3',
      values: { 'Custom.Area': 'Fixed area', 'Custom.Priority': 3 },
    });
    const outside = await request(app)
      .post(`/TestPlan/suites/${root.id}/field-preview`)
      .send({ providerId: 'azure_devops', templateId: template.id, fieldValues: { Other: 'x' } });
    expect(outside.status).toBe(400);
    expect(outside.body.code).toBe('FIELD_MAPPING_INVALID');

    const missingSuite = await request(app)
      .post('/TestPlan/suites/missing/field-preview')
      .send({ providerId: 'azure_devops', templateId: template.id });
    expect(missingSuite.status).toBe(404);
  });

  it('rejects previews for mismatched templates or providers without fields', async () => {
    const { suites, root } = await seedSuiteTree();
    const mappings = new InMemoryFieldMappingStore();
    const base = { name: 'T', scope: '', itemType: '', rules: [] };
    const caseTemplate = await mappings.save('ws', null, {
      ...base,
      entityType: 'test_case',
      providerId: 'azure_devops',
    });
    const pbiTemplate = await mappings.save('ws', null, {
      ...base,
      entityType: 'pbi',
      providerId: 'azure_devops',
    });
    const resolveTestSuitePublisher = vi.fn(async () => ({}));
    const app = build({ suites, mappings, factory: { resolveTestSuitePublisher } });
    const preview = (body: object) =>
      request(app).post(`/TestPlan/suites/${root.id}/field-preview`).send(body);

    for (const body of [
      { providerId: 'azure_devops', templateId: crypto.randomUUID() },
      { providerId: 'azure_devops', templateId: pbiTemplate.id },
      { providerId: 'jira', templateId: caseTemplate.id },
    ]) {
      const response = await preview(body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('FIELD_MAPPING_INVALID');
    }
    expect(resolveTestSuitePublisher).not.toHaveBeenCalled();

    const unsupported = await preview({ providerId: 'azure_devops', templateId: caseTemplate.id });
    expect(unsupported.body.code).toBe('FIELD_MAPPING_UNSUPPORTED');
    const noFactory = await request(build({ suites, mappings }))
      .post(`/TestPlan/suites/${root.id}/field-preview`)
      .send({ providerId: 'azure_devops', templateId: caseTemplate.id });
    expect(noFactory.body.code).toBe('FIELD_MAPPING_UNSUPPORTED');
  });
});

describe('POST /TestPlan/suites/:id/push suite kind', () => {
  it('passes the suite kind and work item, and requires a work item for requirement suites', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const root = await new TestSuiteService(suites).create('ws', 'Root');
    await plans.save(createSavedTestPlan('ws', { suiteId: root.id }, [testCase('Case')]));
    const publish = vi.fn(async () => ({
      provider: 'azure_devops',
      remotePlanId: '1',
      remoteSuiteId: '2',
      remoteUrl: 'https://example.com',
      suitesCount: 1,
      casesCount: 1,
      suiteKind: 'requirement' as const,
      workItems: [{ id: '50', type: 'Product Backlog Item', title: 'Cores' }],
    }));
    const app = build({
      suites,
      plans,
      factory: { resolveTestSuitePublisher: vi.fn(async () => ({ publish })) },
    });
    const push = (body: object) =>
      request(app)
        .post(`/TestPlan/suites/${root.id}/push`)
        .send({ providerId: 'azure_devops', ...body });

    const ok = await push({ suiteKind: 'requirement', workItemId: '50' });
    expect(ok.status).toBe(200);
    expect(ok.body.workItems).toEqual([{ id: '50', type: 'Product Backlog Item', title: 'Cores' }]);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ suiteKind: 'requirement', workItemIds: ['50'] }),
    );
    // The single-item form and the list are merged without repeats.
    await push({ workItemId: '50', workItemIds: ['50', '51'] });
    expect(publish).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ workItemIds: ['50', '51'] }),
    );
    for (const body of [
      { suiteKind: 'requirement' },
      { suiteKind: 'requirement', workItemId: '50', remotePlanId: '1', remoteSuiteId: '2' },
      { suiteKind: 'dynamic', workItemId: '50' },
      { workItemId: 'abc' },
      { workItemIds: ['abc'] },
      { suiteKind: 'requirement', workItemIds: [] },
    ]) {
      const rejected = await push(body);
      expect(rejected.status).toBe(400);
      expect(rejected.body.code).toBe('VALIDATION_ERROR');
    }
    expect(publish).toHaveBeenCalledTimes(2);
  });
});

describe('POST /TestPlan/suites/:id/push field templates', () => {
  it('passes a matching template to the publisher and rejects mismatched ones', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const root = await new TestSuiteService(suites).create('ws', 'Root');
    await plans.save(createSavedTestPlan('ws', { suiteId: root.id }, [testCase('Case')]));
    const mappings = new InMemoryFieldMappingStore();
    const base = { name: 'T', scope: '', itemType: '', rules: [] };
    const azure = await mappings.save('ws', null, {
      ...base,
      entityType: 'test_case',
      providerId: 'azure_devops',
    });
    const jira = await mappings.save('ws', null, {
      ...base,
      entityType: 'test_case',
      providerId: 'jira',
    });
    const pbi = await mappings.save('ws', null, {
      ...base,
      entityType: 'pbi',
      providerId: 'azure_devops',
    });
    const publish = vi.fn(async () => ({
      provider: 'azure_devops',
      remotePlanId: '1',
      remoteSuiteId: '2',
      remoteUrl: 'https://example.com',
      suitesCount: 1,
      casesCount: 1,
    }));
    const app = build({
      suites,
      plans,
      mappings,
      factory: { resolveTestSuitePublisher: vi.fn(async () => ({ publish })) },
    });
    const push = (templateId: string) =>
      request(app)
        .post(`/TestPlan/suites/${root.id}/push`)
        .send({ providerId: 'azure_devops', templateId });

    const ok = await push(azure.id);
    expect(ok.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'Root' }), {
      remotePlanId: undefined,
      remoteParentSuiteId: undefined,
      remoteSuiteId: undefined,
      remoteSuiteName: undefined,
      fieldTemplate: azure,
    });
    for (const id of [jira.id, pbi.id, crypto.randomUUID()]) {
      const rejected = await push(id);
      expect(rejected.status).toBe(400);
      expect(rejected.body.code).toBe('FIELD_MAPPING_INVALID');
    }
    expect(publish).toHaveBeenCalledOnce();
  });

  it('applies the values filled in for template fields', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const root = await new TestSuiteService(suites).create('ws', 'Root');
    await plans.save(createSavedTestPlan('ws', { suiteId: root.id }, [testCase('Case')]));
    const mappings = new InMemoryFieldMappingStore();
    const template = await mappings.save('ws', null, {
      name: 'T',
      scope: '',
      itemType: '',
      entityType: 'test_case',
      providerId: 'azure_devops',
      rules: [
        {
          targetFieldId: 'Custom.Flow',
          source: { kind: 'core', key: 'title' },
          choices: { Case: 'Principal' },
          required: true,
        },
        { targetFieldId: 'Custom.Menu', source: { kind: 'constant', value: 'Recursos' } },
      ],
    });
    const publish = vi.fn(async () => ({
      provider: 'azure_devops',
      remotePlanId: '1',
      remoteSuiteId: '2',
      remoteUrl: 'https://example.com',
      suitesCount: 1,
      casesCount: 1,
    }));
    const app = build({
      suites,
      plans,
      mappings,
      factory: { resolveTestSuitePublisher: vi.fn(async () => ({ publish })) },
    });
    const push = (body: object) =>
      request(app)
        .post(`/TestPlan/suites/${root.id}/push`)
        .send({ providerId: 'azure_devops', ...body });

    const ok = await push({ templateId: template.id, fieldValues: { 'Custom.Flow': 'Exceção' } });
    expect(ok.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        fieldTemplate: {
          ...template,
          rules: [
            {
              targetFieldId: 'Custom.Flow',
              source: { kind: 'constant', value: 'Exceção' },
              required: true,
            },
            template.rules[1],
          ],
        },
      }),
    );

    const withoutTemplate = await push({ fieldValues: { 'Custom.Flow': 'Exceção' } });
    expect(withoutTemplate.status).toBe(400);
    const outside = await push({ templateId: template.id, fieldValues: { Other: 'x' } });
    expect(outside.body.code).toBe('FIELD_MAPPING_INVALID');
    expect(publish).toHaveBeenCalledOnce();
  });
});

describe('saved test plan routes', () => {
  it('renders English CSV descriptions for English plans', async () => {
    const plans = [
      {
        title: 'Open the report screen',
        description: '',
        steps: [{ action: 'Open the user report screen', expectedResult: 'The report is shown' }],
      },
    ];
    const response = await request(build()).post('/TestPlan/csv').send({ plans });
    expect(response.status).toBe(200);
    const csv = (language: 'en-US' | 'pt-BR') =>
      serializeTestPlanCsv(parseAndNormalizeTestPlans(JSON.stringify(plans), { language }), {
        platform: undefined,
        areaPath: undefined,
        assignedTo: undefined,
      });
    expect(response.text).toBe(csv('en-US'));
    expect(response.text).not.toBe(csv('pt-BR'));
  });

  it('normalizes invalid and oversized pagination parameters', async () => {
    const store = new InMemorySavedTestPlanStore();
    const list = vi.spyOn(store, 'list');
    const app = build({ plans: store });
    const first = await request(app).get('/TestPlan?page=abc&pageSize=500');
    expect(first.body).toMatchObject({ page: 1, pageSize: 50, total: 0, totalPages: 0 });
    const second = await request(app).get('/TestPlan?page=-2&pageSize=0');
    expect(second.body).toMatchObject({ page: 1, pageSize: 10 });
    const third = await request(app).get('/TestPlan?page=3&pageSize=5');
    expect(third.body).toMatchObject({ page: 3, pageSize: 5 });
    expect(list).toHaveBeenLastCalledWith('ws', 10, 5);
  });

  it('moves a saved plan only to an existing suite of the workspace', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const service = new TestSuiteService(suites);
    const from = await service.create('ws', 'From');
    const to = await service.create('ws', 'To');
    const saved = await plans.save(
      createSavedTestPlan('ws', { suiteId: from.id }, [testCase('Case')]),
    );
    const app = build({ suites, plans });

    const missing = await request(app).put(`/TestPlan/${saved.id}`).send({ suiteId: 'nope' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TEST_SUITE_NOT_FOUND');
    expect((await plans.find(saved.id, 'ws'))?.suiteId).toBe(from.id);

    const moved = await request(app).put(`/TestPlan/${saved.id}`).send({ suiteId: to.id });
    expect(moved.status).toBe(200);
    expect(moved.body.suiteId).toBe(to.id);

    const renamed = await request(app).put(`/TestPlan/${saved.id}`).send({ title: 'Renamed' });
    expect(renamed.body).toMatchObject({ title: 'Renamed', suiteId: to.id });
  });

  it('reports a plan removed concurrently as not found', async () => {
    const plans = new InMemorySavedTestPlanStore();
    const saved = await plans.save(createSavedTestPlan('ws', {}, [testCase('Case')]));
    vi.spyOn(plans, 'delete').mockResolvedValue(false);
    const response = await request(build({ plans })).delete(`/TestPlan/${saved.id}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('TEST_PLAN_NOT_FOUND');
  });
});
