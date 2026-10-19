import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
} from '../src/modules/testplans/application/saved-test-plans.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
} from '../src/modules/testplans/application/test-suites.js';
import {
  PublishTestSuite,
  type TestSuitePublisher,
} from '../src/modules/testplans/application/publish-test-suite.js';
import {
  AzureTestSuitePublisher,
  azureTestSteps,
} from '../src/modules/testplans/adapters/azure-test-suite-publisher.js';
import type { FieldMappingTemplate } from '../src/modules/field-mapping/field-mapping.js';

const testCase = {
  title: 'Login & logout',
  description: '<p>Session</p>',
  steps: [{ action: 'Open <login>', expectedResult: 'Page & form', data: 'user@example.com' }],
};

describe('PublishTestSuite', () => {
  it('publishes all descendant suites and cases, including plans beyond the first page', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const service = new TestSuiteService(suites);
    const root = await service.create('ws-1', 'Regression');
    const child = await service.create('ws-1', 'Checkout', root.id);
    for (let index = 0; index < 101; index++) {
      await plans.save(
        createSavedTestPlan('ws-1', { suiteId: child.id, title: `Batch ${index}` }, [testCase]),
      );
    }
    await plans.save(createSavedTestPlan('ws-2', { suiteId: child.id }, [testCase]));
    const publisher: TestSuitePublisher = {
      publish: vi.fn(async (tree, options) => {
        expect(tree.name).toBe('Regression');
        expect(tree.children[0]?.name).toBe('Checkout');
        expect(tree.children[0]?.cases).toHaveLength(101);
        expect(options.remotePlanId).toBe('51');
        return {
          provider: 'fake',
          remotePlanId: '51',
          remoteSuiteId: '7',
          remoteUrl: 'https://example.com',
          suitesCount: 2,
          casesCount: 101,
        };
      }),
    };
    await expect(
      new PublishTestSuite(suites, plans).execute('ws-1', root.id, publisher, {
        remotePlanId: '51',
      }),
    ).resolves.toMatchObject({ casesCount: 101 });
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it('rejects foreign and empty suites before calling the provider', async () => {
    const suites = new InMemoryTestSuiteStore();
    const plans = new InMemorySavedTestPlanStore();
    const root = await new TestSuiteService(suites).create('ws-2', 'Empty');
    const publisher: TestSuitePublisher = { publish: vi.fn() };
    const useCase = new PublishTestSuite(suites, plans);
    await expect(useCase.execute('ws-1', root.id, publisher)).rejects.toMatchObject({
      code: 'TEST_SUITE_NOT_FOUND',
    });
    await expect(useCase.execute('ws-2', root.id, publisher)).rejects.toMatchObject({
      code: 'TEST_SUITE_EMPTY',
    });
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});

describe('AzureTestSuitePublisher', () => {
  it('updates an imported Test Case with mapped fields without duplicating its suite association', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const data = url.includes('/wit/workitemtypes/Test%20Case')
        ? {
            value: [
              {
                name: 'Classification',
                referenceName: 'Custom.Classification',
                allowedValues: ['Critical'],
              },
            ],
          }
        : url.includes('/wit/fields?')
          ? { value: [{ referenceName: 'Custom.Classification', type: 'string' }] }
          : url.includes('/testplan/plans/5?')
            ? { id: 5, rootSuite: { id: 6 } }
            : url.includes('/testplan/Plans/5/suites/7?')
              ? { id: 7, suiteType: 'staticTestSuite' }
              : { id: 42 };
      return { ok: true, status: 200, headers: new Headers(), json: async () => data } as Response;
    });
    const template: FieldMappingTemplate = {
      id: 'mapping',
      workspaceId: 'ws',
      name: 'Azure Case',
      entityType: 'test_case',
      providerId: 'azure_devops',
      scope: '',
      itemType: 'Test Case',
      createdAt: new Date(),
      updatedAt: new Date(),
      rules: [
        {
          targetFieldId: 'Custom.Classification',
          source: { kind: 'custom', providerId: 'azure_devops', key: 'Custom.Classification' },
        },
      ],
    };
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    const result = await publisher.publish(
      {
        id: 'local-suite',
        name: 'Cases',
        children: [],
        cases: [
          {
            ...testCase,
            metadata: {
              caseId: 'local-1',
              remoteCaseIds: { azure_devops: '42' },
              remoteCaseLocations: { azure_devops: { planId: '5', suiteId: '7' } },
              customFields: { azure_devops: { 'Custom.Classification': 'Critical' } },
            },
          },
        ],
      },
      { remotePlanId: '5', remoteSuiteId: '7', fieldTemplate: template },
    );
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(patch?.url).toContain('/wit/workitems/42?');
    expect(JSON.parse(String(patch?.init?.body))).toContainEqual({
      op: 'add',
      path: '/fields/Custom.Classification',
      value: 'Critical',
    });
    expect(calls.some((call) => call.url.includes('/testcases/42'))).toBe(false);
    expect(result.caseLocations?.['local-1']).toEqual({ planId: '5', suiteId: '7' });
  });

  it('creates a plan, nested suites and executable test cases, then links each case', async () => {
    let nextSuite = 20;
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      let data: unknown = {};
      if (url.endsWith('/testplan/plans?api-version=7.1')) data = { id: 10 };
      else if (url.includes('/testplan/plans/10?')) data = { id: 10, rootSuite: { id: 11 } };
      else if (url.includes('/testplan/Plans/10/suites?')) data = { id: nextSuite++ };
      else if (url.includes('/wit/workitems/')) data = { id: 42 };
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    const result = await publisher.publish(
      {
        id: 'local',
        name: 'Regression',
        cases: [testCase],
        children: [{ id: 'child', name: 'Checkout', cases: [], children: [] }],
      },
      {},
    );
    expect(result).toMatchObject({
      remotePlanId: '10',
      remoteSuiteId: '20',
      suitesCount: 2,
      casesCount: 1,
    });
    expect(calls).toHaveLength(6);
    expect(calls[2]?.init?.body).toContain('"id":11');
    expect(calls[3]?.init?.headers).toMatchObject({
      'content-type': 'application/json-patch+json',
    });
    expect(calls[3]?.init?.body).toContain('Microsoft.VSTS.TCM.Steps');
    expect(calls[4]?.url).toContain('/suites/20/testcases/42');
    expect(calls[5]?.init?.body).toContain('"id":20');
    expect(azureTestSteps(testCase)).toContain('Open &lt;login&gt;');
    expect(azureTestSteps(testCase)).toContain('Page &amp; form');
  });

  it('uses an existing plan and stops on an upstream failure', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => ({ ok: false, status: 403 }) as Response);
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    await expect(
      publisher.publish(
        { id: 'x', name: 'X', cases: [testCase], children: [] },
        { remotePlanId: '5' },
      ),
    ).rejects.toMatchObject({ code: 'TEST_SUITE_PUBLISH_FAILED', statusCode: 502 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/testplan/plans/5?');
  });

  it('lists all plans and suites across continuation pages', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      const isSecond = url.includes('continuationToken=next');
      const isSuites = url.includes('/suites?');
      return {
        ok: true,
        status: 200,
        headers: new Headers(isSecond ? {} : { 'x-ms-continuationtoken': 'next' }),
        json: async () =>
          isSuites
            ? {
                value: isSecond
                  ? [{ id: 9, name: 'Child', parentSuite: { id: 8 }, suiteType: 'staticTestSuite' }]
                  : [{ id: 8, name: 'Root', suiteType: 'staticTestSuite' }],
              }
            : { value: isSecond ? [{ id: 7, name: 'Zeta' }] : [{ id: 6, name: 'Alpha' }] },
      } as Response;
    });
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    expect(await publisher.listPlans()).toEqual([
      { id: '6', name: 'Alpha' },
      { id: '7', name: 'Zeta' },
    ]);
    expect(await publisher.listSuites('7')).toEqual([
      { id: '8', name: 'Root', suiteType: 'staticTestSuite' },
      { id: '9', name: 'Child', parentId: '8', suiteType: 'staticTestSuite' },
    ]);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toContain('continuationToken=next');
  });

  it('creates a local suite below the selected existing remote suite', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const data = url.includes('/plans/7?')
        ? { id: 7, rootSuite: { id: 8 } }
        : url.includes('/suites/9?')
          ? { id: 9, suiteType: 'staticTestSuite' }
          : url.includes('/suites?')
            ? { id: 10 }
            : url.includes('/wit/workitems/')
              ? { id: 42 }
              : {};
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    const result = await publisher.publish(
      { id: 'local', name: 'New child', cases: [testCase], children: [] },
      { remotePlanId: '7', remoteParentSuiteId: '9', remoteSuiteName: 'Sprint 181' },
    );
    expect(result).toMatchObject({ remotePlanId: '7', remoteSuiteId: '10', casesCount: 1 });
    expect(calls[0]?.url).toContain('/plans/7?');
    expect(calls[1]?.url).toContain('/suites/9?');
    expect(calls[2]?.init?.body).toContain('"id":9');
    expect(calls[2]?.init?.body).toContain('"name":"Sprint 181"');
    expect(calls.some((call) => call.url.endsWith('/testplan/plans?api-version=7.1'))).toBe(false);
  });

  it('adds cases from the local tree directly to a requirement suite', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    let nextCaseId = 42;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      const data = url.includes('/plans/7?')
        ? { id: 7, rootSuite: { id: 8 } }
        : url.includes('/suites/9?')
          ? { id: 9, suiteType: 'requirementTestSuite' }
          : url.includes('/wit/workitems/')
            ? { id: nextCaseId++ }
            : {};
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    const result = await publisher.publish(
      {
        id: 'local',
        name: 'Regression',
        cases: [testCase],
        children: [{ id: 'child', name: 'Child', cases: [testCase], children: [] }],
      },
      { remotePlanId: '7', remoteSuiteId: '9' },
    );
    expect(result).toMatchObject({ remoteSuiteId: '9', suitesCount: 0, casesCount: 2 });
    expect(calls.filter((call) => call.url.includes('/suites/9/testcases/'))).toHaveLength(2);
    expect(calls.some((call) => call.url.includes('/testplan/Plans/7/suites?'))).toBe(false);
  });

  it('rejects adding cases directly to a query suite', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const data = url.includes('/plans/7?')
        ? { id: 7, rootSuite: { id: 8 } }
        : { id: 9, suiteType: 'dynamicTestSuite' };
      return { ok: true, status: 200, json: async () => data } as Response;
    });
    const publisher = new AzureTestSuitePublisher(
      'https://dev.azure.com/org',
      'QA',
      'pat',
      fetcher,
    );
    await expect(
      publisher.publish(
        { id: 'local', name: 'Regression', cases: [testCase], children: [] },
        { remotePlanId: '7', remoteSuiteId: '9' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REMOTE_SUITE_ID' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
