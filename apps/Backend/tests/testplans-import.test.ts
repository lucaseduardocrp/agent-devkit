import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/adapters/http/app.js';
import {
  IMPORT_SOURCE_TYPE,
  ImportTestCases,
  MAX_IMPORTED_SUITES,
} from '../src/modules/testplans/application/import-test-cases.js';
import {
  InMemorySavedTestPlanStore,
  createSavedTestPlan,
  keepCaseMetadata,
  listAllSavedTestPlans,
} from '../src/modules/testplans/application/saved-test-plans.js';
import { SavedTestCaseReader } from '../src/modules/testplans/application/saved-test-cases.js';
import {
  InMemoryTestSuiteStore,
  TestSuiteService,
} from '../src/modules/testplans/application/test-suites.js';
import type {
  TestManagementProvider,
  TestManagementResolver,
} from '../src/modules/test-management/application/test-management-provider.js';
import type {
  ExternalTestCase,
  RemoteContainer,
  TestManagementCapabilities,
} from '../src/modules/test-management/domain/test-run.js';

const WS = 'workspace-1';

const AZURE: TestManagementCapabilities = {
  planLabel: 'Test Plan',
  suiteLabel: 'Suite',
  suiteRequired: true,
  caseIdLabel: 'Test Case ID',
  stepEvidence: true,
};

const remoteCase = (caseId: string, suiteId: string, title = `Case ${caseId}`) =>
  ({
    provider: 'azure_devops',
    caseId,
    planId: '10',
    suiteId,
    title,
    description: '<p>Scenario</p>',
    steps: [
      { id: '2', action: 'Open', expectedResult: 'Opened' },
      { id: '3', action: 'Save', expectedResult: 'Saved' },
    ],
    customFields: { 'Custom.Risk': 'High', 'System.State': 'Design' },
    customFieldLabels: { 'Custom.Risk': 'Risk', 'System.State': 'State' },
    url: `https://dev.azure.com/acme/QA/_workitems/edit/${caseId}`,
  }) satisfies ExternalTestCase;

function fakeProvider(
  options: {
    capabilities?: TestManagementCapabilities;
    suites?: RemoteContainer[];
    cases?: Record<string, ExternalTestCase[]>;
  } = {},
) {
  const cases: Record<string, ExternalTestCase[]> = options.cases ?? {
    '1': [remoteCase('100', '1')],
    '2': [remoteCase('200', '2'), remoteCase('201', '2')],
    '3': [remoteCase('300', '3')],
    '4': [],
  };
  return {
    id: 'azure_devops' as const,
    name: 'Azure DevOps Test Plans',
    capabilities: options.capabilities ?? AZURE,
    listPlans: vi.fn().mockResolvedValue([{ id: '10', name: 'Sprint 10' }]),
    // Azure: the plan's root suite holds Login (with Errors below it) and an empty suite.
    listSuites: vi.fn().mockResolvedValue(
      options.suites ?? [
        { id: '1', name: 'Sprint 10' },
        { id: '2', name: 'Login', parentId: '1' },
        { id: '3', name: 'Errors', parentId: '2' },
        { id: '4', name: 'Empty', parentId: '1' },
      ],
    ),
    listCases: vi
      .fn()
      .mockImplementation(({ suiteId }: { suiteId?: string }) =>
        Promise.resolve(cases[suiteId ?? ''] ?? []),
      ),
    getCase: vi.fn(),
    publishRun: vi.fn(),
  } satisfies TestManagementProvider;
}

function setup(provider: TestManagementProvider | null = fakeProvider()) {
  const plans = new InMemorySavedTestPlanStore();
  const suites = new InMemoryTestSuiteStore();
  const resolver: TestManagementResolver = {
    listTestManagementProviders: vi.fn().mockResolvedValue([]),
    resolveTestManagementProvider: vi.fn().mockResolvedValue(provider),
  };
  return { plans, suites, importer: new ImportTestCases(plans, suites, resolver), provider };
}

async function tree(suites: InMemoryTestSuiteStore) {
  const all = await suites.list(WS);
  const path = (id: string | undefined): string => {
    const suite = all.find((item) => item.id === id);
    return suite ? [path(suite.parentId), suite.name].filter(Boolean).join(' / ') : '';
  };
  return Object.fromEntries(all.map((suite) => [suite.id, path(suite.id)]));
}

describe('importing test cases from a test management platform', () => {
  it('mirrors a whole plan as local suites with one Test Plan per remote suite', async () => {
    const { importer, plans, suites } = setup();
    const result = await importer.import(WS, { provider: 'azure_devops', planId: '10' });

    expect(result).toMatchObject({ suitesCreated: 3, created: 4, updated: 0 });
    const paths = await tree(suites);
    // The remote root suite is the local root; suites without cases are not created.
    expect(Object.values(paths).sort()).toEqual([
      'Sprint 10',
      'Sprint 10 / Login',
      'Sprint 10 / Login / Errors',
    ]);
    expect(paths[result.rootSuiteId]).toBe('Sprint 10');
    expect(result.plans.map((plan) => [plan.title, paths[plan.suiteId!], plan.sourceId])).toEqual([
      ['Sprint 10', 'Sprint 10', 'azure_devops:10:1'],
      ['Login', 'Sprint 10 / Login', 'azure_devops:10:2'],
      ['Errors', 'Sprint 10 / Login / Errors', 'azure_devops:10:3'],
    ]);
    expect(result.plans.every((plan) => plan.sourceType === IMPORT_SOURCE_TYPE)).toBe(true);
    const [login] = result.plans[1]!.plans;
    expect(login).toMatchObject({
      title: 'Case 200',
      description: '<p>Scenario</p>',
      steps: [
        { order: 1, action: 'Open', expectedResult: 'Opened' },
        { order: 2, action: 'Save', expectedResult: 'Saved' },
      ],
      metadata: {
        caseId: expect.any(String),
        remoteCaseIds: { azure_devops: '200' },
        remoteCaseLocations: { azure_devops: { planId: '10', suiteId: '2' } },
        remoteUrls: { azure_devops: 'https://dev.azure.com/acme/QA/_workitems/edit/200' },
        remoteStepIds: { azure_devops: ['2', '3'] },
        customFields: { azure_devops: { 'Custom.Risk': 'High', 'System.State': 'Design' } },
        customFieldLabels: { azure_devops: { 'Custom.Risk': 'Risk', 'System.State': 'State' } },
        importedFrom: 'azure_devops',
      },
    });
    expect(await listAllSavedTestPlans(plans, WS)).toHaveLength(3);
  });

  it('refreshes earlier imports in place, keeping local ids, suites and placement', async () => {
    const provider = fakeProvider();
    const { importer, plans, suites } = setup(provider);
    const first = await importer.import(WS, { provider: 'azure_devops', planId: '10' });
    const login = first.plans[1]!;
    const moved = await new TestSuiteService(suites).create(WS, 'Moved');
    await plans.save({ ...login, suiteId: moved.id, title: 'Renamed' });

    provider.listCases.mockImplementation(({ suiteId }: { suiteId?: string }) =>
      Promise.resolve(
        suiteId === '2'
          ? [remoteCase('201', '2', 'Changed remotely'), remoteCase('202', '2')]
          : suiteId === '1'
            ? [remoteCase('100', '1')]
            : [],
      ),
    );
    const second = await importer.import(WS, { provider: 'azure_devops', planId: '10' });
    expect(second).toMatchObject({ suitesCreated: 0, created: 1, updated: 2 });
    const refreshed = (await plans.find(login.id, WS))!;
    // The local title and suite are the user's; the cases follow the platform.
    expect(refreshed).toMatchObject({ title: 'Renamed', suiteId: moved.id });
    expect(refreshed.plans.map((testCase) => testCase.title)).toEqual([
      'Changed remotely',
      'Case 202',
    ]);
    expect(refreshed.plans[0]!.metadata!['caseId']).toBe(login.plans[1]!.metadata!['caseId']);
    expect(await listAllSavedTestPlans(plans, WS)).toHaveLength(3);
  });

  it('imports chosen cases only, keeping the other cases of the Test Plan', async () => {
    const provider = fakeProvider();
    const { importer, plans } = setup(provider);
    const { plans: first } = await importer.import(WS, {
      provider: 'azure_devops',
      planId: '10',
      suiteId: '2',
    });
    // Cases added in ADK to the imported Test Plan stay where they are.
    await plans.save({
      ...first[0]!,
      plans: [
        ...first[0]!.plans,
        { title: 'Added locally', description: '', steps: [], metadata: { caseId: 'local' } },
        {
          title: 'Odd ids',
          description: '',
          steps: [],
          metadata: { caseId: 'odd', remoteCaseIds: 'x' },
        },
      ],
    });
    // A platform case may come without description or fields.
    const { description: _description, customFields: _fields, ...bare } = remoteCase('203', '2');
    provider.listCases.mockResolvedValue([
      remoteCase('201', '2', 'Only this one'),
      { ...bare, title: 'New one', customFieldLabels: undefined },
    ]);
    const result = await importer.import(WS, {
      provider: 'azure_devops',
      planId: '10',
      suiteId: '2',
      caseIds: ['201', '203'],
    });
    expect(result).toMatchObject({ created: 1, updated: 1 });
    expect(result.plans[0]!.plans.map((testCase) => testCase.title)).toEqual([
      'Case 200',
      'Only this one',
      'Added locally',
      'Odd ids',
      'New one',
    ]);
    expect(result.plans[0]!.plans.at(-1)).toMatchObject({
      description: '',
      metadata: { customFields: { azure_devops: {} }, customFieldLabels: { azure_devops: {} } },
    });
  });

  it('imports one suite with its children into a chosen local suite', async () => {
    const { importer, suites } = setup();
    const target = await new TestSuiteService(suites).create(WS, 'Regression');
    const result = await importer.import(WS, {
      provider: 'azure_devops',
      planId: '10',
      suiteId: '2',
      includeChildSuites: true,
      localSuiteId: target.id,
    });
    const paths = await tree(suites);
    expect(result.rootSuiteId).toBe(target.id);
    expect(result.plans.map((plan) => paths[plan.suiteId!])).toEqual([
      'Regression',
      'Regression / Errors',
    ]);
  });

  it('names the local root after a single imported suite', async () => {
    const { importer, suites } = setup();
    const result = await importer.import(WS, {
      provider: 'azure_devops',
      planId: '10',
      suiteId: '3',
    });
    expect((await tree(suites))[result.rootSuiteId]).toBe('Errors');
  });

  it('turns several top-level suites (TestRail) into children of the plan suite', async () => {
    const provider = fakeProvider({
      capabilities: { ...AZURE, planLabel: 'Project', suiteRequired: false },
      suites: [
        { id: '7', name: 'Smoke' },
        { id: '8', name: 'Regression' },
      ],
      cases: { '7': [remoteCase('C1', '7')], '8': [remoteCase('C2', '8')] },
    });
    provider.listPlans.mockResolvedValue([]);
    const { importer, suites } = setup(provider);
    const result = await importer.import(WS, { provider: 'azure_devops', planId: '10' });
    const paths = await tree(suites);
    expect(result.plans.map((plan) => paths[plan.suiteId!])).toEqual([
      'Project 10 / Smoke',
      'Project 10 / Regression',
    ]);
  });

  it('reads the plan itself on platforms without suites (Xray)', async () => {
    const provider = fakeProvider({
      capabilities: { ...AZURE, suiteLabel: null, suiteRequired: false },
      cases: { '': [remoteCase('QA-1', '')] },
    });
    const { importer, suites } = setup(provider);
    const result = await importer.import(WS, { provider: 'azure_devops', planId: '10' });
    expect(provider.listSuites).not.toHaveBeenCalled();
    expect(provider.listCases).toHaveBeenCalledWith({ planId: '10' });
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({ title: 'Sprint 10', sourceId: 'azure_devops:10:' });
    expect((await tree(suites))[result.plans[0]!.suiteId!]).toBe('Sprint 10');
  });

  it('reuses local suites that already have the remote names', async () => {
    const { importer, suites } = setup();
    const service = new TestSuiteService(suites);
    const root = await service.create(WS, 'Sprint 10');
    const result = await importer.import(WS, { provider: 'azure_devops', planId: '10' });
    expect(result.rootSuiteId).toBe(root.id);
    expect(result.suitesCreated).toBe(2);
  });

  it('rejects imports that cannot be done', async () => {
    await expect(
      setup(null).importer.import(WS, { provider: 'azure_devops', planId: '10' }),
    ).rejects.toMatchObject({ code: 'TEST_PROVIDER_NOT_CONFIGURED' });
    await expect(
      setup().importer.import(WS, {
        provider: 'azure_devops',
        planId: '10',
        localSuiteId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'TEST_SUITE_NOT_FOUND', statusCode: 404 });
    await expect(
      setup().importer.import(WS, { provider: 'azure_devops', planId: '10', caseIds: ['x'] }),
    ).rejects.toMatchObject({ code: 'TEST_CASES_NOT_FOUND', statusCode: 404 });
    const many = fakeProvider({
      suites: Array.from({ length: MAX_IMPORTED_SUITES + 1 }, (_, index) => ({
        id: String(index + 1),
        name: `S${index}`,
      })),
    });
    await expect(
      setup(many).importer.import(WS, { provider: 'azure_devops', planId: '10' }),
    ).rejects.toMatchObject({ code: 'TEST_IMPORT_TOO_LARGE' });
    const huge = fakeProvider({
      cases: {
        '1': Array.from({ length: 2_001 }, (_, index) => remoteCase(String(index), '1')),
      },
    });
    await expect(
      setup(huge).importer.import(WS, { provider: 'azure_devops', planId: '10' }),
    ).rejects.toMatchObject({ code: 'TEST_IMPORT_TOO_LARGE' });
  });
});

describe('saved test case metadata', () => {
  it('keeps the stored metadata of edited cases', () => {
    const previous = [
      {
        title: 'A',
        description: '',
        steps: [],
        metadata: { caseId: 'a', remoteCaseIds: { azure_devops: '1' } },
      },
      { title: 'Without id', description: '', steps: [] },
    ];
    expect(
      keepCaseMetadata(previous, [
        { title: 'A2', description: '', steps: [], metadata: { caseId: 'a', note: 1 } },
        { title: 'B', description: '', steps: [] },
      ]),
    ).toEqual([
      {
        title: 'A2',
        description: '',
        steps: [],
        metadata: { caseId: 'a', remoteCaseIds: { azure_devops: '1' }, note: 1 },
      },
      { title: 'B', description: '', steps: [] },
    ]);
  });

  it('keeps imported fields when the web app saves an edited Test Plan', async () => {
    const { plans, suites, importer } = setup();
    const resolver: TestManagementResolver = {
      listTestManagementProviders: vi.fn().mockResolvedValue([]),
      resolveTestManagementProvider: vi.fn().mockResolvedValue(fakeProvider()),
    };
    const app = createApp({
      requestContextResolver: async () => ({ requestId: 'r', ownerId: WS }),
      savedTestPlans: plans,
      testSuites: suites,
      testManagement: resolver,
    });
    const { plans: imported } = await importer.import(WS, {
      provider: 'azure_devops',
      planId: '10',
      suiteId: '3',
    });
    const plan = imported[0]!;
    const caseId = plan.plans[0]!.metadata!['caseId'];
    const saved = await request(app)
      .put(`/TestPlan/${plan.id}`)
      .send({
        plans: [{ title: 'Edited', description: 'x', steps: [], metadata: { caseId } }],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.plans[0]).toMatchObject({
      title: 'Edited',
      metadata: {
        caseId,
        remoteCaseIds: { azure_devops: '300' },
        customFields: expect.any(Object),
      },
    });
  });

  it('imports whole plans through the HTTP route', async () => {
    const { plans, suites } = setup();
    const app = createApp({
      requestContextResolver: async () => ({ requestId: 'r', ownerId: WS }),
      savedTestPlans: plans,
      testSuites: suites,
      testManagement: {
        listTestManagementProviders: vi.fn().mockResolvedValue([]),
        resolveTestManagementProvider: vi.fn().mockResolvedValue(fakeProvider()),
      },
    });
    const response = await request(app)
      .post('/TestPlan/import')
      .send({ providerId: 'azure_devops', planId: '10' });
    expect(response.status).toBe(201);
    expect(response.body.result).toMatchObject({ created: 4, suitesCreated: 3 });
    expect(response.body.savedPlan.id).toBe(response.body.result.plans[0].id);
    const invalid = await request(app)
      .post('/TestPlan/import')
      .send({ providerId: 'unknown', planId: '10' });
    expect(invalid.body.error?.code ?? invalid.body.code).toBe('TEST_PROVIDER_INVALID');
    const missingPlan = await request(app)
      .post('/TestPlan/import')
      .send({ providerId: 'azure_devops' });
    expect(missingPlan.status).toBe(400);
  });
});

describe('reading saved test cases', () => {
  async function savedFixture() {
    const plans = new InMemorySavedTestPlanStore();
    const suites = new InMemoryTestSuiteStore();
    const service = new TestSuiteService(suites);
    const root = await service.create(WS, 'Root');
    const child = await service.create(WS, 'Child', root.id);
    const other = await service.create(WS, 'Other');
    const step = { action: 'Open', expectedResult: 'Opened' };
    const imported = await plans.save(
      createSavedTestPlan(WS, { title: 'Imported', suiteId: child.id }, [
        {
          title: 'Remote',
          description: '',
          steps: [step],
          metadata: {
            caseId: 'c-remote',
            importedFrom: 'testrail',
            remoteCaseIds: { azure_devops: '9', testrail: '30' },
            remoteCaseLocations: { testrail: { planId: '1', suiteId: '' } },
          },
        },
        {
          title: 'Suite only',
          description: '',
          steps: [step],
          metadata: { caseId: 'c-suite', remoteCaseIds: 'not a map' },
        },
        {
          title: 'Located by suite',
          description: '',
          steps: [step],
          metadata: {
            caseId: 'c-located',
            remoteCaseIds: { xray: 'QA-1' },
            remoteCaseLocations: { xray: { suiteId: '5' } },
          },
        },
      ]),
    );
    const local = await plans.save(
      createSavedTestPlan(WS, { title: 'Local', suiteId: root.id }, [
        { title: 'One', description: 'd', steps: [step], metadata: { caseId: 'c-1' } },
        { title: 'Two', description: 'd', steps: [step], metadata: { caseId: 'c-2' } },
      ]),
    );
    await plans.save(
      createSavedTestPlan(WS, { title: 'Elsewhere', suiteId: other.id }, [
        { title: 'Out', description: '', steps: [step] },
      ]),
    );
    return { reader: new SavedTestCaseReader(plans, suites), root, imported, local };
  }

  it('reads a suite with its child suites, a Test Plan or chosen cases', async () => {
    const { reader, root, imported, local } = await savedFixture();
    const fromSuite = await reader.listSavedCases(WS, { suiteId: root.id });
    expect(fromSuite.map((item) => item.title).sort()).toEqual([
      'Located by suite',
      'One',
      'Remote',
      'Suite only',
      'Two',
    ]);
    expect(fromSuite.find((item) => item.title === 'Suite only')!.remote).toBeNull();
    expect(fromSuite.find((item) => item.title === 'Located by suite')!.remote).toEqual({
      provider: 'xray',
      caseId: 'QA-1',
      suiteId: '5',
    });
    expect(fromSuite.find((item) => item.title === 'Remote')).toMatchObject({
      planId: imported.id,
      remote: { provider: 'testrail', caseId: '30', planId: '1' },
    });
    expect(fromSuite.find((item) => item.title === 'One')!.remote).toBeNull();
    expect(
      (await reader.listSavedCases(WS, { planId: local.id, caseIds: ['c-2'] })).map(
        (item) => item.caseId,
      ),
    ).toEqual(['c-2']);
  });

  it('rejects unknown or missing selections', async () => {
    const { reader } = await savedFixture();
    await expect(reader.listSavedCases(WS, { planId: 'missing' })).rejects.toMatchObject({
      code: 'TEST_PLAN_NOT_FOUND',
    });
    await expect(reader.listSavedCases(WS, { suiteId: 'missing' })).rejects.toMatchObject({
      code: 'TEST_SUITE_NOT_FOUND',
    });
    await expect(reader.listSavedCases(WS, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});
