import { describe, expect, it, vi } from 'vitest';
import {
  AzureTestManagementProvider,
  actionPathOf,
  parseAzureSteps,
} from '../src/modules/test-management/adapters/azure-test-management.js';
import type {
  CaseRunResult,
  ExternalTestCase,
  StepRunResult,
  TestEvidence,
  TestRunReport,
} from '../src/modules/test-management/domain/test-run.js';

interface Call {
  readonly method: string;
  readonly url: URL;
  /** Path after `/_apis/`. */
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

const BASE = 'https://dev.azure.com/contoso/My%20Project';

function json(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status: 200, headers });
}

/** Routes Azure calls to `handler`; unknown routes answer 404. */
function fakeAzure(handler: (call: Call) => unknown = () => undefined) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      path: url.pathname.split('/_apis/')[1] ?? '',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: init?.headers as Record<string, string>,
    };
    calls.push(call);
    const out = handler(call);
    if (out === undefined) return new Response('not found', { status: 404 });
    return out instanceof Response ? out : json(out);
  });
  return { fetcher, calls };
}

function provider(fetcher: typeof fetch, token = 'my-pat') {
  return new AzureTestManagementProvider({
    organizationUrl: 'https://dev.azure.com/contoso//',
    project: 'My Project',
    token,
    fetcher,
    retryDelayMs: 0,
  });
}

function evidence(fileName: string, description?: string): TestEvidence {
  return {
    fileName,
    contentType: 'image/png',
    content: new Uint8Array([1, 2, 3]),
    ...(description ? { description } : {}),
  };
}

function step(stepId: string, overrides: Partial<StepRunResult> = {}): StepRunResult {
  return {
    position: 1,
    stepId,
    action: `Action ${stepId}`,
    expectedResult: '',
    outcome: 'passed',
    actualResult: null,
    durationMs: 10,
    evidence: [],
    ...overrides,
  };
}

function result(
  caseId: string,
  testCase: Partial<ExternalTestCase> = {},
  overrides: Partial<CaseRunResult> = {},
): CaseRunResult {
  return {
    testCase: { provider: 'azure_devops', caseId, title: caseId, steps: [], ...testCase },
    outcome: 'passed',
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    finishedAt: new Date('2026-01-01T10:01:00.000Z'),
    durationMs: 60_000,
    errorMessage: null,
    comment: null,
    steps: [],
    attachments: [],
    ...overrides,
  };
}

function report(results: CaseRunResult[], overrides: Partial<TestRunReport> = {}): TestRunReport {
  return {
    name: 'Nightly',
    startedAt: new Date('2026-01-01T10:00:00.000Z'),
    finishedAt: new Date('2026-01-01T10:05:00.000Z'),
    environment: 'https://app.example.com - chromium',
    target: {},
    results,
    ...overrides,
  };
}

const STEPS_XML = `<steps id="0" last="9">
  <step id="2" type="ActionStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Open &amp;amp; login&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true">&lt;P&gt;Home&lt;BR/&gt;shown&lt;/P&gt;</parameterizedString><description/></step>
  <compref id="3" ref="55"/>
  <compref id="4" ref="56"><step id="5" type="ActionStep"><parameterizedString>Shared</parameterizedString><parameterizedString/></step></compref>
  <step id="6" type="ValidateStep"><parameterizedString isformatted="true">Only action</parameterizedString><parameterizedString isformatted="true"/></step>
  <step type="ActionStep"><parameterizedString>No id</parameterizedString><parameterizedString/></step>
  <step id="7" type="ActionStep"><parameterizedString/><parameterizedString/></step>
  <step id="8" type="ActionStep"><description/></step>
  <step id="9" type="ActionStep"><parameterizedString/><parameterizedString>Expected only</parameterizedString></step>
</steps>`;

describe('parseAzureSteps', () => {
  it('reads escaped HTML steps, leaving out shared, unidentified and empty steps', () => {
    expect(parseAzureSteps(STEPS_XML)).toEqual([
      { id: '2', action: 'Open & login', expectedResult: 'Home\nshown' },
      { id: '6', action: 'Only action', expectedResult: '' },
      { id: '9', action: '', expectedResult: 'Expected only' },
    ]);
    expect(parseAzureSteps('')).toEqual([]);
  });

  it('encodes step ids as 8-digit hexadecimal action paths', () => {
    expect(actionPathOf('2')).toBe('00000002');
    expect(actionPathOf('10')).toBe('0000000a');
    expect(actionPathOf('255')).toBe('000000ff');
  });
});

describe('AzureTestManagementProvider', () => {
  it('describes the platform and authenticates with a PAT or a full header', async () => {
    const { fetcher, calls } = fakeAzure(() => ({ value: [] }));
    const azure = provider(fetcher);
    expect(azure).toMatchObject({
      id: 'azure_devops',
      name: 'Azure DevOps Test Plans',
      capabilities: {
        planLabel: 'Test Plan',
        suiteLabel: 'Suite',
        suiteRequired: true,
        caseIdLabel: 'Test Case ID',
        stepEvidence: true,
      },
    });
    await azure.listPlans();
    await provider(fetcher, 'Basic abc').listPlans();
    await provider(fetcher, 'Bearer xyz').listPlans();
    expect(calls.map((call) => call.headers.authorization)).toEqual([
      `Basic ${Buffer.from(':my-pat').toString('base64')}`,
      'Basic abc',
      'Bearer xyz',
    ]);
    expect(String(calls[0]!.url)).toBe(`${BASE}/_apis/testplan/plans?api-version=7.1`);
  });

  it('lists Test Plans across continuation pages, sorted by name', async () => {
    const pages = [
      json(
        { value: [{ id: 2, name: 'Beta' }, { id: 'x', name: 'Bad id' }, { id: 3 }] },
        { 'x-ms-continuationtoken': 'tok-1' },
      ),
      json({ value: [{ id: 1, name: 'Alpha' }] }, { 'x-ms-continuationtoken': '' }),
    ];
    const { fetcher, calls } = fakeAzure(() => pages.shift());
    await expect(provider(fetcher).listPlans()).resolves.toEqual([
      { id: '1', name: 'Alpha' },
      { id: '2', name: 'Beta' },
    ]);
    expect(calls[0]!.url.searchParams.has('continuationToken')).toBe(false);
    expect(calls[1]!.url.searchParams.get('continuationToken')).toBe('tok-1');
  });

  it('stops when pagination does not advance or exceeds the page cap', async () => {
    const repeating = fakeAzure(() => json({ value: [] }, { 'x-ms-continuationtoken': 'same' }));
    await expect(provider(repeating.fetcher).listPlans()).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      technicalMessage: 'Azure DevOps pagination did not advance.',
      statusCode: 502,
      details: [{ provider: 'azure_devops', stage: 'plans' }],
    });
    expect(repeating.calls).toHaveLength(2);

    let page = 0;
    const endless = fakeAzure(() =>
      json({ value: [] }, { 'x-ms-continuationtoken': `tok-${++page}` }),
    );
    await expect(provider(endless.fetcher).listPlans()).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      statusCode: 502,
    });
    expect(endless.calls).toHaveLength(1_001);
  });

  it('lists the suites of a plan', async () => {
    const answers: unknown[] = [
      {
        value: [
          { id: 7, name: 'Login' },
          { id: 8, name: 'Errors', parentSuite: { id: 7 } },
          { name: 'No id' },
        ],
      },
      {},
    ];
    const { fetcher, calls } = fakeAzure(() => answers.shift());
    const azure = provider(fetcher);
    await expect(azure.listSuites('12')).resolves.toEqual([
      { id: '7', name: 'Login' },
      { id: '8', name: 'Errors', parentId: '7' },
    ]);
    await expect(azure.listSuites('12')).resolves.toEqual([]);
    expect(calls[0]!.path).toBe('testplan/Plans/12/suites');
    await expect(azure.listSuites('abc')).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
      details: [{ field: 'planId' }],
    });
    expect(calls).toHaveLength(2);
  });

  it('lists suite cases reading work items in batches of 200', async () => {
    const entries = [
      ...Array.from({ length: 201 }, (_, index) => ({ workItem: { id: index + 1 } })),
      {},
      { workItem: { id: 'x' } },
    ];
    const batches: number[][] = [];
    const { fetcher, calls } = fakeAzure((call) => {
      if (call.path === 'testplan/Plans/3/Suites/4/TestCase') return { value: entries };
      if (call.path !== 'wit/workitemsbatch') return undefined;
      const { ids } = call.body as { ids: number[] };
      batches.push(ids);
      if (ids.length < 200) return {};
      return {
        value: [
          {
            id: 1,
            fields: {
              'System.Title': ' Login ',
              'Microsoft.VSTS.TCM.Steps': STEPS_XML,
              'Custom.Estimate': 3,
              'System.State': 'Design',
              'System.AssignedTo': { displayName: 'Ana Souza', uniqueName: 'ana@contoso.com' },
              'System.Rev': 4,
              'Microsoft.VSTS.TCM.Parameters': '<parameters />',
            },
          },
          { id: 2 },
          { id: 3, fields: { 'System.Title': 42, 'Microsoft.VSTS.TCM.Steps': 7 } },
          null,
          { fields: { 'System.Title': 'No id' } },
        ],
      };
    });
    const cases = await provider(fetcher).listCases({ planId: '3', suiteId: '4' });
    // Field labels are read once, beside the first batch; a failure leaves the keys as labels.
    expect(calls.filter((call) => call.path === 'wit/fields')).toHaveLength(1);
    expect(batches.map((ids) => ids.length)).toEqual([200, 1]);
    expect(batches[1]).toEqual([201]);
    expect(calls.find((call) => call.path === 'wit/workitemsbatch')!.body).toEqual({
      ids: batches[0],
      errorPolicy: 'omit',
    });
    expect(calls.find((call) => call.path === 'wit/workitemsbatch')!.method).toBe('POST');
    expect(cases).toHaveLength(3);
    expect(cases[0]).toEqual({
      provider: 'azure_devops',
      caseId: '1',
      planId: '3',
      suiteId: '4',
      title: 'Login',
      description: '',
      customFields: {
        'Custom.Estimate': 3,
        'System.State': 'Design',
        'System.AssignedTo': 'Ana Souza',
      },
      customFieldLabels: {},
      steps: parseAzureSteps(STEPS_XML),
      url: `${BASE}/_workitems/edit/1`,
    });
    expect(cases[1]).toMatchObject({ caseId: '2', title: 'Test Case 2', steps: [] });
    expect(cases[2]).toMatchObject({ caseId: '3', title: 'Test Case 3', steps: [] });
  });

  it('validates the plan and suite of a case listing', async () => {
    const { fetcher } = fakeAzure();
    const azure = provider(fetcher);
    await expect(azure.listCases({ suiteId: '4' })).rejects.toMatchObject({
      details: [{ field: 'planId' }],
    });
    await expect(azure.listCases({ planId: '3' })).rejects.toMatchObject({
      details: [{ field: 'suiteId' }],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads a case by id, keeping the given location', async () => {
    const answers: unknown[] = [
      {
        value: [
          {
            id: 9,
            fields: { 'System.Title': 'Checkout', 'Custom.Risk': 'High', 'Custom.Tags': [] },
          },
        ],
      },
      { value: [{ id: 9, fields: { 'System.Title': 'Checkout' } }] },
      { value: [] },
    ];
    const { fetcher, calls } = fakeAzure((call) =>
      call.path === 'wit/fields'
        ? { value: [{ referenceName: 'Custom.Risk', name: 'Risk' }, { name: 'No reference' }] }
        : answers.shift(),
    );
    const azure = provider(fetcher);
    await expect(azure.getCase({ caseId: '9', planId: '1', suiteId: '2' })).resolves.toEqual({
      provider: 'azure_devops',
      caseId: '9',
      description: '',
      customFields: { 'Custom.Risk': 'High' },
      customFieldLabels: { 'Custom.Risk': 'Risk' },
      planId: '1',
      suiteId: '2',
      title: 'Checkout',
      steps: [],
      url: `${BASE}/_workitems/edit/9`,
    });
    const bare = await azure.getCase({ caseId: '9' });
    expect(bare).not.toHaveProperty('planId');
    expect(bare).not.toHaveProperty('suiteId');
    expect(calls[0]!.body).toMatchObject({ ids: [9] });
    expect(calls.filter((call) => call.path === 'wit/fields')).toHaveLength(1);
    const unlabeled = fakeAzure((call) =>
      call.path === 'wit/fields'
        ? {}
        : {
            value: [
              {
                id: 9,
                fields: {
                  'System.Title': 'Checkout',
                  'System.Description': '<p>Pay</p>',
                  'Custom.Risk': 'High',
                },
              },
            ],
          },
    );
    await expect(provider(unlabeled.fetcher).getCase({ caseId: '9' })).resolves.toMatchObject({
      description: '<p>Pay</p>',
      customFields: { 'Custom.Risk': 'High' },
      customFieldLabels: {},
    });
    await expect(azure.getCase({ caseId: '10' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_CASE_NOT_FOUND',
      statusCode: 404,
      details: [{ provider: 'azure_devops', caseId: '10' }],
    });
    await expect(azure.getCase({ caseId: 'TC-1' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
    });
  });

  it('publishes one run per plan with step results and evidence', async () => {
    let runs = 500;
    const { fetcher, calls } = fakeAzure((call) => {
      const key = `${call.method} ${call.path}`;
      switch (key) {
        case 'GET testplan/Plans/1/Suites/10/TestPoint':
          return {
            value: [
              { id: 1000, testCaseReference: { id: 100 } },
              { id: 1001, testCaseReference: { id: 101 } },
              { id: 9999, testCaseReference: { id: 100 } },
              { testCaseReference: { id: 105 } },
              { id: 1003, testCaseReference: { id: 103 } },
            ],
          };
        case 'GET testplan/Plans/1/Suites/11/TestPoint':
          return { value: [{ id: 1100 }] };
        case 'GET testplan/Plans/2/Suites/20/TestPoint':
          return { value: [{ id: 2000, testCaseReference: { id: 200 } }] };
        case 'GET testplan/Plans/3/Suites/30/TestPoint':
          return { value: [] };
        case 'POST test/runs':
          return { id: ++runs };
        case 'GET test/runs/501/results':
          return {
            value: [
              { id: 1, testPoint: { id: '1000' } },
              { id: 2, testPoint: { id: 1001 } },
              { testPoint: { id: 1003 } },
              { id: 4 },
            ],
          };
        case 'GET test/runs/502/results':
          return {};
        case 'PATCH test/runs/501/results':
        case 'PATCH test/runs/502/results':
        case 'PATCH test/runs/501':
        case 'PATCH test/runs/502':
          return {};
        case 'POST testresults/runs/501/results/1/attachments':
        case 'POST test/runs/501/results/1/attachments':
        case 'POST test/runs/501/results/2/attachments':
          return call.body && (call.body as { fileName: string }).fileName === 'broken.png'
            ? new Response('rejected', { status: 400 })
            : { id: 1 };
        default:
          return undefined;
      }
    });
    const failed = result(
      '100',
      { planId: '1', suiteId: '10' },
      {
        outcome: 'failed',
        errorMessage: 'E'.repeat(5_000),
        comment: 'C'.repeat(1_200),
        steps: [
          step('2', { evidence: [evidence('step-2.png', 'Step 2 screenshot')] }),
          step('10', {
            outcome: 'failed',
            actualResult: 'A'.repeat(4_500),
            durationMs: 25,
            evidence: [evidence('step-10.png'), evidence('broken.png')],
          }),
        ],
        attachments: [evidence('video.webm', 'Recording')],
      },
    );
    const published = await provider(fetcher).publishRun(
      report(
        [
          failed,
          result('101', { planId: '1', suiteId: '10' }, { errorMessage: '' }),
          result('102', { planId: '1', suiteId: '11' }),
          result('103', { planId: '1', suiteId: '10' }),
          result('104'),
          result('105', { planId: '2' }),
          result('200', { planId: '2', suiteId: '20' }),
          result('300', { planId: '3', suiteId: '30' }),
        ],
        { name: 'N'.repeat(300), environment: 'E'.repeat(1_200) },
      ),
    );

    expect(published).toEqual({
      provider: 'azure_devops',
      remoteRunId: '501',
      url: `${BASE}/_testManagement/runs?_a=runCharts&runId=501`,
      publishedCases: 2,
      warnings: [
        'Test case 104 has no Test Plan and suite; it was not published.',
        'Test case 105 has no Test Plan and suite; it was not published.',
        'Test case 102 has no test point in suite 11; it was not published.',
        'Test case 103 has no result in run 501; it was not published.',
        'Could not attach broken.png to result 1.',
        'Test case 200 has no result in run 502; it was not published.',
        'Test case 300 has no test point in suite 30; it was not published.',
      ],
    });

    const created = calls.filter((call) => call.method === 'POST' && call.path === 'test/runs');
    expect(created.map((call) => call.body)).toEqual([
      {
        name: 'N'.repeat(256),
        plan: { id: '1' },
        pointIds: [1000, 1001, 1003],
        automated: false,
        state: 'InProgress',
        startDate: '2026-01-01T10:00:00.000Z',
        comment: 'E'.repeat(1_000),
      },
      expect.objectContaining({ plan: { id: '2' }, pointIds: [2000] }),
    ]);
    expect(created[0]!.url.searchParams.get('api-version')).toBe('7.1');

    const updates = calls.find(
      (call) => call.method === 'PATCH' && call.path === 'test/runs/501/results',
    );
    expect(updates?.body).toEqual([
      {
        id: 1,
        state: 'Completed',
        outcome: 'Failed',
        startedDate: '2026-01-01T10:00:00.000Z',
        completedDate: '2026-01-01T10:01:00.000Z',
        durationInMs: 60_000,
        errorMessage: 'E'.repeat(4_000),
        comment: 'C'.repeat(1_000),
        iterationDetails: [
          {
            id: 1,
            outcome: 'Failed',
            startedDate: '2026-01-01T10:00:00.000Z',
            completedDate: '2026-01-01T10:01:00.000Z',
            durationInMs: 60_000,
            errorMessage: 'E'.repeat(4_000),
            actionResults: [
              {
                actionPath: '00000002',
                iterationId: 1,
                stepIdentifier: '2',
                outcome: 'Passed',
                durationInMs: 10,
              },
              {
                actionPath: '0000000a',
                iterationId: 1,
                stepIdentifier: '10',
                outcome: 'Failed',
                durationInMs: 25,
                errorMessage: 'A'.repeat(4_000),
              },
            ],
          },
        ],
      },
      {
        id: 2,
        state: 'Completed',
        outcome: 'Passed',
        startedDate: '2026-01-01T10:00:00.000Z',
        completedDate: '2026-01-01T10:01:00.000Z',
        durationInMs: 60_000,
        iterationDetails: [
          {
            id: 1,
            outcome: 'Passed',
            startedDate: '2026-01-01T10:00:00.000Z',
            completedDate: '2026-01-01T10:01:00.000Z',
            durationInMs: 60_000,
            actionResults: [],
          },
        ],
      },
    ]);
    const emptyUpdates = calls.find(
      (call) => call.method === 'PATCH' && call.path === 'test/runs/502/results',
    );
    expect(emptyUpdates).toBeUndefined();

    const attachments = calls.filter((call) => call.path.endsWith('/attachments'));
    expect(
      attachments.map((call) => ({
        path: call.path,
        query: Object.fromEntries(call.url.searchParams),
        body: call.body,
      })),
    ).toEqual([
      {
        path: 'testresults/runs/501/results/1/attachments',
        query: { 'api-version': '7.1-preview.1', iterationId: '1', actionPath: '00000002' },
        body: {
          stream: Buffer.from([1, 2, 3]).toString('base64'),
          fileName: 'step-2.png',
          comment: 'Step 2 screenshot',
          attachmentType: 'GeneralAttachment',
        },
      },
      {
        path: 'testresults/runs/501/results/1/attachments',
        query: { 'api-version': '7.1-preview.1', iterationId: '1', actionPath: '0000000a' },
        body: expect.objectContaining({ fileName: 'step-10.png', comment: '' }),
      },
      {
        path: 'testresults/runs/501/results/1/attachments',
        query: { 'api-version': '7.1-preview.1', iterationId: '1', actionPath: '0000000a' },
        body: expect.objectContaining({ fileName: 'broken.png' }),
      },
      {
        path: 'test/runs/501/results/1/attachments',
        query: { 'api-version': '7.1' },
        body: expect.objectContaining({ fileName: 'video.webm', comment: 'Recording' }),
      },
    ]);
    expect(
      attachments.slice(0, 3).every((call) => call.url.hostname === 'vstmr.dev.azure.com'),
    ).toBe(true);

    const completions = calls.filter(
      (call) => call.method === 'PATCH' && /^test\/runs\/\d+$/.test(call.path),
    );
    expect(completions.map((call) => [call.path, call.body])).toEqual([
      ['test/runs/501', { state: 'Completed', completedDate: '2026-01-01T10:05:00.000Z' }],
      ['test/runs/502', { state: 'Completed', completedDate: '2026-01-01T10:05:00.000Z' }],
    ]);
  });

  it('fails when nothing can be matched to a test point', async () => {
    const { fetcher } = fakeAzure(() => ({ value: [] }));
    await expect(
      provider(fetcher).publishRun(report([result('1'), result('2', { planId: '1' })])),
    ).rejects.toMatchObject({
      code: 'TEST_RUN_NOTHING_TO_PUBLISH',
      statusCode: 400,
      details: [
        {
          provider: 'azure_devops',
          warnings: [
            'Test case 1 has no Test Plan and suite; it was not published.',
            'Test case 2 has no Test Plan and suite; it was not published.',
          ],
        },
      ],
    });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      provider(fetcher).publishRun(report([result('3', { planId: '1', suiteId: '2' })])),
    ).rejects.toMatchObject({
      code: 'TEST_RUN_NOTHING_TO_PUBLISH',
      details: [
        {
          warnings: ['Test case 3 has no test point in suite 2; it was not published.'],
        },
      ],
    });
  });

  it('rejects a run that Azure created without an id', async () => {
    const { fetcher, calls } = fakeAzure((call) =>
      call.path.endsWith('/TestPoint')
        ? { value: [{ id: 5, testCaseReference: { id: 3 } }] }
        : call.path === 'test/runs'
          ? {}
          : undefined,
    );
    await expect(
      provider(fetcher).publishRun(report([result('3', { planId: '1', suiteId: '2' })])),
    ).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      technicalMessage: 'Azure DevOps did not return the run id.',
      statusCode: 502,
      details: [{ provider: 'azure_devops', stage: 'create-run' }],
    });
    expect(calls).toHaveLength(2);
  });

  it('validates the plan and suite ids of the results', async () => {
    const { fetcher } = fakeAzure(() => ({ value: [] }));
    await expect(
      provider(fetcher).publishRun(report([result('1', { planId: 'x', suiteId: '2' })])),
    ).rejects.toMatchObject({ code: 'TEST_MANAGEMENT_INVALID_ID', details: [{ field: 'planId' }] });
    await expect(
      provider(fetcher).publishRun(report([result('1', { planId: '1', suiteId: 'y' })])),
    ).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
      details: [{ field: 'suiteId' }],
    });
  });
});
