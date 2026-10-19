import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySavedTestPlanStore,
  type SavedTestPlan,
} from '../src/modules/testplans/application/saved-test-plans.js';
import { InMemoryTestSuiteStore } from '../src/modules/testplans/application/test-suites.js';
import {
  PublishTestSuite,
  type PublishableTestSuite,
  type PublishedTestSuite,
  type TestSuitePublisher,
} from '../src/modules/testplans/application/publish-test-suite.js';
import { AzureTestSuitePublisher } from '../src/modules/testplans/adapters/azure-test-suite-publisher.js';
import type { FieldMappingTemplate } from '../src/modules/field-mapping/field-mapping.js';
import type { TestPlan } from '../src/modules/testplans/domain/test-plan.js';

const now = new Date().toISOString();
const testCase: TestPlan = {
  title: 'Login',
  description: 'Session',
  steps: [{ action: 'Open login', expectedResult: 'Form shown' }],
};

const suite = (id: string, parentId?: string) => ({
  id,
  workspaceId: 'ws',
  name: `Suite ${id}`,
  createdAt: now,
  updatedAt: now,
  ...(parentId ? { parentId } : {}),
});

const savedPlan = (id: string, suiteId: string, plans: TestPlan[]): SavedTestPlan => ({
  id,
  workspaceId: 'ws',
  title: id,
  suiteId,
  plans,
  createdAt: now,
  updatedAt: now,
});

const published = (extra: Partial<PublishedTestSuite> = {}): PublishedTestSuite => ({
  provider: 'azure_devops',
  remotePlanId: '5',
  remoteSuiteId: '6',
  remoteUrl: 'https://example.com',
  suitesCount: 1,
  casesCount: 1,
  ...extra,
});

describe('PublishTestSuite remote links', () => {
  it('rejects a suite hierarchy with a cycle before publishing', async () => {
    const suites = new InMemoryTestSuiteStore();
    await suites.save(suite('a', 'b'));
    await suites.save(suite('b', 'a'));
    const plans = new InMemorySavedTestPlanStore();
    await plans.save(savedPlan('p', 'a', [testCase]));
    const publisher: TestSuitePublisher = { publish: vi.fn() };
    await expect(
      new PublishTestSuite(suites, plans).execute('ws', 'a', publisher),
    ).rejects.toMatchObject({ code: 'TEST_SUITE_CYCLE', statusCode: 409 });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('stores remote ids and locations on the published cases only', async () => {
    const suites = new InMemoryTestSuiteStore();
    await suites.save(suite('root'));
    const plans = new InMemorySavedTestPlanStore();
    const linked: TestPlan = {
      ...testCase,
      metadata: {
        caseId: 'case-1',
        remoteCaseIds: { jira: 'J-1' },
        remoteCaseLocations: { jira: { planId: '1', suiteId: '2' } },
      },
    };
    const withoutLocation: TestPlan = { ...testCase, metadata: { caseId: 'case-2' } };
    const untouched: TestPlan = { ...testCase, title: 'Without id' };
    await plans.save(savedPlan('changed', 'root', [linked, withoutLocation, untouched]));
    const unchanged = savedPlan('unchanged', 'root', [
      { ...testCase, metadata: { caseId: 'case-3' } },
    ]);
    await plans.save(unchanged);
    const save = vi.spyOn(plans, 'save');
    const result = published({
      caseLinks: { 'case-1': '101', 'case-2': '102' },
      caseLocations: { 'case-1': { planId: '5', suiteId: '6' } },
    });
    const publisher: TestSuitePublisher = { publish: vi.fn(async () => result) };

    await expect(
      new PublishTestSuite(suites, plans).execute('ws', 'root', publisher),
    ).resolves.toBe(result);

    expect(save).toHaveBeenCalledOnce();
    const stored = await plans.find('changed', 'ws');
    expect(stored?.updatedAt).not.toBe(now);
    expect(stored?.plans[0]?.metadata).toEqual({
      caseId: 'case-1',
      remoteCaseIds: { jira: 'J-1', azure_devops: '101' },
      remoteCaseLocations: {
        jira: { planId: '1', suiteId: '2' },
        azure_devops: { planId: '5', suiteId: '6' },
      },
    });
    expect(stored?.plans[1]?.metadata).toEqual({
      caseId: 'case-2',
      remoteCaseIds: { azure_devops: '102' },
    });
    expect(stored?.plans[2]).toBe(untouched);
    expect(await plans.find('unchanged', 'ws')).toBe(unchanged);
  });

  it('links cases when the provider returns no locations and ignores empty link maps', async () => {
    const suites = new InMemoryTestSuiteStore();
    await suites.save(suite('root'));
    const plans = new InMemorySavedTestPlanStore();
    await plans.save(savedPlan('p', 'root', [{ ...testCase, metadata: { caseId: 'case-1' } }]));
    const save = vi.spyOn(plans, 'save');
    const useCase = new PublishTestSuite(suites, plans);

    await useCase.execute('ws', 'root', { publish: async () => published({ caseLinks: {} }) });
    expect(save).not.toHaveBeenCalled();

    await useCase.execute('ws', 'root', {
      publish: async () => published({ caseLinks: { 'case-1': '77' } }),
    });
    expect((await plans.find('p', 'ws'))?.plans[0]?.metadata).toEqual({
      caseId: 'case-1',
      remoteCaseIds: { azure_devops: '77' },
    });
  });
});

type Route = (url: string, init?: RequestInit) => unknown;

/** Marks a route answer as the raw fetch response instead of a JSON body. */
class Raw {
  public constructor(public readonly response: Partial<Response>) {}
}
const raw = (response: Partial<Response>) => new Raw(response);

/** Builds a fetch fake that answers JSON per route, recording every call. */
function azure(route: Route, token = 'pat') {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const data = route(url, init);
    if (data instanceof Raw) return data.response as Response;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => data,
    } as Response;
  });
  return {
    calls,
    fetcher,
    publisher: new AzureTestSuitePublisher('https://dev.azure.com/org', 'QA', token, fetcher),
  };
}

const tree = (children: PublishableTestSuite[] = []): PublishableTestSuite => ({
  id: 'local',
  name: 'Regression',
  cases: [testCase],
  children,
});

const mapping = (extra: Partial<FieldMappingTemplate> = {}): FieldMappingTemplate => ({
  id: 'mapping',
  workspaceId: 'ws',
  name: 'Azure',
  entityType: 'test_case',
  providerId: 'azure_devops',
  scope: 'QA',
  itemType: '',
  createdAt: new Date(),
  updatedAt: new Date(),
  rules: [{ targetFieldId: 'Custom.Area', source: { kind: 'core', key: 'title' } }],
  ...extra,
});

describe('AzureTestSuitePublisher requests', () => {
  it('sends Basic and Bearer tokens unchanged', async () => {
    for (const token of ['Basic abc', 'Bearer xyz']) {
      const { calls, publisher } = azure(() => ({ value: [] }), token);
      await publisher.listPlans();
      expect(calls[0]?.init?.headers).toMatchObject({ authorization: token });
    }
  });

  it('reports network failures, invalid JSON and 203 answers as publish failures', async () => {
    const offline = new AzureTestSuitePublisher('https://dev.azure.com/org', 'QA', 'pat', () =>
      Promise.reject(new Error('offline')),
    );
    await expect(offline.listPlans()).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
      statusCode: 502,
      details: [{ stage: 'testplan/plans' }],
    });

    const invalidJson = azure(() =>
      raw({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('bad json');
        },
      }),
    );
    await expect(invalidJson.publisher.listPlans()).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
      details: [{ stage: 'testplan/plans' }],
    });

    const redirectedToLogin = azure(() => raw({ ok: true, status: 203 }));
    await expect(redirectedToLogin.publisher.listPlans()).rejects.toMatchObject({
      details: [{ stage: 'testplan/plans', status: 203 }],
    });
  });

  it('rejects malformed lists and pagination that does not advance', async () => {
    const malformed = azure(() => ({ value: 'nope' }));
    await expect(malformed.publisher.listPlans()).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
    });

    const stuck = azure(() =>
      raw({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-ms-continuationtoken': 'same' }),
        json: async () => ({ value: [{ id: 1, name: 'Plan' }] }),
      }),
    );
    await expect(stuck.publisher.listPlans()).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
    });
    expect(stuck.calls).toHaveLength(2);
  });

  it('drops incomplete remote entries and defaults unknown suite types', async () => {
    const { publisher } = azure((url) =>
      url.includes('/suites?')
        ? { value: [{ id: 3, name: 'Root' }, { name: 'No id' }, { id: 4 }] }
        : {
            value: [
              { id: 'x', name: 'Bad' },
              { id: 2, name: 'Good' },
            ],
          },
    );
    expect(await publisher.listPlans()).toEqual([{ id: '2', name: 'Good' }]);
    expect(await publisher.listSuites('9')).toEqual([
      { id: '3', name: 'Root', suiteType: 'unknown' },
    ]);
    await expect(publisher.listSuites('0')).rejects.toMatchObject({
      code: 'INVALID_REMOTE_PLAN_ID',
      statusCode: 400,
    });
    await expect(publisher.listSuites('99999999999999999999')).rejects.toMatchObject({
      code: 'INVALID_REMOTE_PLAN_ID',
    });
  });
});

describe('AzureTestSuitePublisher case fields', () => {
  it('maps Azure field types and hides core Test Case fields', async () => {
    const { calls, publisher } = azure((url) =>
      url.includes('workitemtypes')
        ? {
            value: [
              { name: 'Title', referenceName: 'System.Title', alwaysRequired: true },
              { name: 'Priority', referenceName: 'P', allowedValues: ['1', '2'] },
              { name: 'Effort', referenceName: 'E' },
              { name: 'Cost', referenceName: 'C' },
              { name: 'Count', referenceName: 'N' },
              { name: 'Automated', referenceName: 'B' },
              { name: 'Due', referenceName: 'D' },
              { name: 'Notes', referenceName: 'T', alwaysRequired: true },
              { name: 'Unknown', referenceName: 'U' },
            ],
          }
        : {
            value: [
              { referenceName: 'E', type: 'Integer' },
              { referenceName: 'C', type: 'double' },
              { referenceName: 'N', type: 'number' },
              { referenceName: 'B', type: 'Boolean' },
              { referenceName: 'D', type: 'DateTime', readOnly: true },
              { referenceName: 'T', type: 'string' },
              { referenceName: 'U' },
            ],
          },
    );
    expect(await publisher.listCaseFields()).toEqual([
      {
        id: 'P',
        name: 'Priority',
        type: 'single_select',
        required: false,
        readOnly: false,
        options: [
          { id: '1', name: '1' },
          { id: '2', name: '2' },
        ],
      },
      { id: 'E', name: 'Effort', type: 'number', required: false, readOnly: false },
      { id: 'C', name: 'Cost', type: 'number', required: false, readOnly: false },
      { id: 'N', name: 'Count', type: 'number', required: false, readOnly: false },
      { id: 'B', name: 'Automated', type: 'boolean', required: false, readOnly: false },
      { id: 'D', name: 'Due', type: 'date', required: false, readOnly: true },
      { id: 'T', name: 'Notes', type: 'text', required: true, readOnly: false },
      { id: 'U', name: 'Unknown', type: 'text', required: false, readOnly: false },
    ]);
    expect(calls[0]!.url).toContain(
      '/wit/workitemtypes/Test%20Case/fields?api-version=7.1&%24expand=allowedValues',
    );
  });

  it('treats empty field catalogs as having no fields', async () => {
    const { publisher } = azure(() => raw({ ok: true, status: 204 }));
    expect(await publisher.listCaseFields()).toEqual([]);
    const missingCatalog = azure((url) =>
      url.includes('workitemtypes') ? { value: [{ name: 'Area', referenceName: 'A' }] } : {},
    );
    expect(await missingCatalog.publisher.listCaseFields()).toEqual([
      { id: 'A', name: 'Area', type: 'text', required: false, readOnly: false },
    ]);
  });
});

describe('AzureTestSuitePublisher publish validation', () => {
  it('rejects field templates for another provider, entity, project or item type', async () => {
    const { fetcher, publisher } = azure(() => ({}));
    for (const extra of [
      { providerId: 'jira' },
      { entityType: 'pbi' as const },
      { scope: 'Other' },
      { itemType: 'Bug' },
    ])
      await expect(
        publisher.publish(tree(), { fieldTemplate: mapping(extra) }),
      ).rejects.toMatchObject({ code: 'FIELD_MAPPING_INVALID', statusCode: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires a plan for a destination suite and a single destination', async () => {
    const { fetcher, publisher } = azure(() => ({}));
    await expect(publisher.publish(tree(), { remoteParentSuiteId: '3' })).rejects.toMatchObject({
      code: 'INVALID_REMOTE_SUITE_ID',
    });
    await expect(publisher.publish(tree(), { remoteSuiteId: '3' })).rejects.toMatchObject({
      code: 'INVALID_REMOTE_SUITE_ID',
    });
    await expect(
      publisher.publish(tree(), {
        remotePlanId: '1',
        remoteParentSuiteId: '3',
        remoteSuiteId: '4',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REMOTE_SUITE_ID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails when Azure does not return a plan id or a root suite', async () => {
    const noPlanId = azure(() => ({}));
    await expect(noPlanId.publisher.publish(tree(), {})).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
      details: [{ stage: 'create-plan' }],
    });
    const noRoot = azure(() => ({ id: 5 }));
    await expect(noRoot.publisher.publish(tree(), { remotePlanId: '5' })).rejects.toMatchObject({
      code: 'TEST_SUITE_PUBLISH_FAILED',
      statusCode: 502,
    });
  });

  it('rejects destination suites from another plan or of a non-static type', async () => {
    const otherPlan = azure((url) =>
      url.includes('/plans/5?') ? { id: 5, rootSuite: { id: 6 } } : { id: 99 },
    );
    await expect(
      otherPlan.publisher.publish(tree(), { remotePlanId: '5', remoteParentSuiteId: '7' }),
    ).rejects.toMatchObject({ code: 'INVALID_REMOTE_SUITE_ID', statusCode: 400 });

    const requirementSuite = azure((url) =>
      url.includes('/plans/5?')
        ? { id: 5, rootSuite: { id: 6 } }
        : { id: 7, suiteType: 'requirementTestSuite' },
    );
    await expect(
      requirementSuite.publisher.publish(tree(), { remotePlanId: '5', remoteParentSuiteId: '7' }),
    ).rejects.toMatchObject({
      code: 'INVALID_REMOTE_SUITE_ID',
      message: 'Escolha uma suite estática como destino.',
    });
  });
});

describe('AzureTestSuitePublisher publish', () => {
  it('applies mapped fields to every case in nested suites under a typed suite', async () => {
    let nextSuite = 20;
    let nextCase = 40;
    const { calls, publisher } = azure((url, init) => {
      if (url.includes('workitemtypes'))
        return { value: [{ name: 'Area', referenceName: 'Custom.Area' }] };
      if (url.includes('/wit/fields?')) return { value: [] };
      if (url.includes('/plans/5?')) return { id: 5, rootSuite: { id: 6 } };
      if (url.includes('/suites/7?')) return { id: 7 };
      if (url.includes('/testcases/'))
        return raw({ ok: true, status: 204, headers: new Headers() });
      if (url.includes('/suites?') && init?.method === 'POST') return { id: nextSuite++ };
      return { id: nextCase++ };
    });
    const child: PublishableTestSuite = {
      id: 'child',
      name: 'Child',
      cases: [{ ...testCase, title: 'Child case', metadata: { caseId: 'c-2' } }],
      children: [],
    };
    const result = await publisher.publish(
      { ...tree([child]), cases: [{ ...testCase, metadata: { caseId: 'c-1' } }] },
      {
        remotePlanId: '5',
        remoteParentSuiteId: '7',
        fieldTemplate: mapping({ itemType: 'Test Case' }),
      },
    );
    expect(result).toMatchObject({
      remotePlanId: '5',
      remoteSuiteId: '20',
      suitesCount: 2,
      casesCount: 2,
      caseLinks: { 'c-1': '40', 'c-2': '41' },
      caseLocations: {
        'c-1': { planId: '5', suiteId: '20' },
        'c-2': { planId: '5', suiteId: '21' },
      },
    });
    const created = calls.filter((call) => call.url.includes('/wit/workitems/$Test%20Case'));
    expect(JSON.parse(String(created[1]?.init?.body))).toContainEqual({
      op: 'add',
      path: '/fields/Custom.Area',
      value: 'Child case',
    });
    expect(calls.some((call) => call.url.includes('/suites/21/testcases/41'))).toBe(true);
  });

  it('moves an existing case to the new suite when its stored location differs', async () => {
    const { calls, publisher } = azure((url) => {
      if (url.includes('/plans/5?')) return { id: 5, rootSuite: { id: 6 } };
      if (url.includes('/suites/7?')) return { id: 7, suiteType: 'staticTestSuite' };
      return { id: 42 };
    });
    const result = await publisher.publish(
      {
        ...tree(),
        cases: [
          {
            ...testCase,
            metadata: {
              remoteCaseIds: { azure_devops: '42' },
              remoteCaseLocations: { azure_devops: { planId: '5', suiteId: '1' } },
            },
          },
          { ...testCase, metadata: { remoteCaseIds: { azure_devops: 'not-a-number' } } },
        ],
      },
      { remotePlanId: '5', remoteSuiteId: '7' },
    );
    expect(result).toMatchObject({ remoteSuiteId: '7', casesCount: 2, caseLinks: {} });
    expect(calls.filter((call) => call.init?.method === 'PATCH')).toHaveLength(1);
    expect(calls.filter((call) => call.url.includes('/suites/7/testcases/42'))).toHaveLength(2);
  });
});
