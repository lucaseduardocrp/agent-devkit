import { describe, expect, it, vi } from 'vitest';
import { XrayTestManagementProvider } from '../src/modules/test-management/adapters/xray-test-management.js';
import type {
  CaseRunResult,
  ExternalTestCase,
  StepRunResult,
  TestEvidence,
  TestRunReport,
} from '../src/modules/test-management/domain/test-run.js';

interface Body {
  readonly query?: string;
  readonly variables?: Record<string, unknown>;
  readonly info?: Record<string, unknown>;
  readonly tests?: Record<string, unknown>[];
  readonly client_id?: string;
}

interface Call {
  readonly url: string;
  readonly body: Body;
  readonly headers: Record<string, string>;
}

const MB = 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

/** Routes Xray calls to `handler`; authentication answers a token unless handled. */
function fakeXray(handler: (url: string, body: Body) => unknown = () => ({})) {
  const calls: Call[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    const out = handler(url, body);
    if (out === undefined && url.endsWith('/api/v2/authenticate')) return json('token-1');
    return out instanceof Response ? out : json(out);
  });
  const graphqlCalls = () => calls.filter((call) => call.url.endsWith('/api/v2/graphql'));
  const authCalls = () => calls.filter((call) => call.url.endsWith('/api/v2/authenticate'));
  return { fetcher, calls, graphqlCalls, authCalls };
}

function provider(
  fetcher: typeof fetch,
  options: Partial<ConstructorParameters<typeof XrayTestManagementProvider>[0]> = {},
) {
  return new XrayTestManagementProvider({
    clientId: 'client',
    clientSecret: 'super-secret',
    projectKey: 'QA',
    jiraBaseUrl: 'https://acme.atlassian.net/',
    fetcher,
    retryDelayMs: 0,
    ...options,
  });
}

function evidence(fileName: string, content: Uint8Array = new Uint8Array([1, 2, 3])): TestEvidence {
  return { fileName, contentType: 'image/png', content };
}

/** Large evidence without allocating it: only its size is read unless it is encoded. */
function sized(fileName: string, bytes: number): TestEvidence {
  return evidence(fileName, { byteLength: bytes, length: 0 } as unknown as Uint8Array);
}

function step(position: number, overrides: Partial<StepRunResult> = {}): StepRunResult {
  return {
    position,
    stepId: `s${position}`,
    action: `Action ${position}`,
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
  overrides: Partial<CaseRunResult> = {},
  testCase: Partial<ExternalTestCase> = {},
): CaseRunResult {
  return {
    testCase: { provider: 'xray', caseId, title: caseId, steps: [], ...testCase },
    outcome: 'passed',
    startedAt: new Date('2026-01-01T10:00:00.123Z'),
    finishedAt: new Date('2026-01-01T10:01:00.000Z'),
    durationMs: 60_000,
    errorMessage: null,
    comment: null,
    steps: [],
    attachments: [],
    ...overrides,
  };
}

function report(results: CaseRunResult[], target: TestRunReport['target'] = {}): TestRunReport {
  return {
    name: 'Nightly',
    startedAt: new Date('2026-01-01T10:00:00Z'),
    finishedAt: new Date('2026-01-01T10:05:00Z'),
    environment: 'https://app.example.com - chromium',
    target,
    results,
  };
}

const remoteSteps = [
  { id: 'r1', action: 'Open', expectedResult: '' },
  { id: 'r2', action: 'Login', expectedResult: '' },
  { id: 'r3', action: 'Logout', expectedResult: '' },
];

describe('XrayTestManagementProvider', () => {
  it('describes the platform and validates the project key', async () => {
    const { fetcher } = fakeXray();
    const xray = provider(fetcher, { projectKey: ' qa ' });
    expect(xray).toMatchObject({
      id: 'xray',
      name: 'Xray Cloud',
      capabilities: {
        planLabel: 'Test Plan',
        suiteLabel: null,
        suiteRequired: false,
        caseIdLabel: 'Test key',
        stepEvidence: true,
      },
    });
    await expect(xray.listSuites()).resolves.toEqual([]);
    expect(() => provider(fetcher, { projectKey: "QA' OR 1=1" })).toThrow(
      expect.objectContaining({ code: 'TEST_MANAGEMENT_INVALID_ID', statusCode: 400 }),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('lists Test Plans across pages, authenticating once with the default region', async () => {
    const pages: unknown[] = [
      {
        data: {
          getTestPlans: {
            total: 4,
            results: [
              { issueId: '1', jira: { key: 'QA-1', summary: ' Login ' } },
              null,
              { issueId: '2', jira: { key: 'bad' } },
            ],
          },
        },
      },
      { data: { getTestPlans: { total: 4, results: [{ issueId: '9', jira: { key: 'QA-9' } }] } } },
      { data: { getTestPlans: { results: [{ jira: { key: 'QA-3', summary: 'No total' } }] } } },
      { data: { getTestPlans: { total: 5, results: null } } },
      { data: {} },
    ];
    const { fetcher, calls, graphqlCalls, authCalls } = fakeXray((url) =>
      url.endsWith('/graphql') ? pages.shift() : undefined,
    );
    const xray = provider(fetcher, { baseUrl: undefined });
    await expect(xray.listPlans()).resolves.toEqual([
      { id: 'QA-1', name: 'QA-1 - Login' },
      { id: 'QA-9', name: 'QA-9' },
    ]);
    await expect(xray.listPlans()).resolves.toEqual([{ id: 'QA-3', name: 'QA-3 - No total' }]);
    await expect(xray.listPlans()).resolves.toEqual([]);
    await expect(xray.listPlans()).resolves.toEqual([]);
    expect(authCalls()).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://xray.cloud.getxray.app/api/v2/authenticate',
      body: { client_id: 'client', client_secret: 'super-secret' },
    });
    const [first, second] = graphqlCalls();
    expect(first?.headers.authorization).toBe('Bearer token-1');
    expect(first?.body.variables).toEqual({ jql: "project = 'QA'", start: 0, limit: 100 });
    expect(second?.body.variables).toMatchObject({ start: 3 });
    expect(first?.body.query).toContain('getTestPlans');
  });

  it('stops paginating after the page cap', async () => {
    const { fetcher, graphqlCalls } = fakeXray((url) =>
      url.endsWith('/graphql')
        ? { data: { getTestPlans: { total: 1_000_000, results: [{ jira: { key: 'QA-1' } }] } } }
        : undefined,
    );
    await expect(provider(fetcher).listPlans()).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      statusCode: 502,
      details: [{ provider: 'xray', stage: 'plans' }],
    });
    expect(graphqlCalls()).toHaveLength(100);
  });

  it('reports GraphQL errors without echoing the server message', async () => {
    const answers: unknown[] = [
      { errors: [{ message: 'jql leaked QA secret' }] },
      { data: null, errors: [] },
      {},
    ];
    const { fetcher } = fakeXray((url) => (url.endsWith('/graphql') ? answers.shift() : undefined));
    const xray = provider(fetcher);
    const rejected = await xray.listPlans().catch((error: unknown) => error);
    expect(rejected).toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      statusCode: 502,
      message: 'Xray rejected the query (plans).',
      details: [{ provider: 'xray', stage: 'plans' }],
    });
    expect(JSON.stringify(rejected)).not.toContain('leaked');
    await expect(xray.listPlans()).rejects.toThrow('Xray returned no data (plans).');
    await expect(xray.listPlans()).rejects.toThrow('Xray returned no data (plans).');
  });

  it('retries authentication after a failure and never exposes the secret', async () => {
    const tokens: unknown[] = [json({ error: 'bad' }, 401), { token: 'x' }, '  ', 'token-2'];
    const { fetcher, authCalls, graphqlCalls } = fakeXray((url) =>
      url.endsWith('/authenticate') ? tokens.shift() : { data: { getTestPlans: { results: [] } } },
    );
    const xray = provider(fetcher);
    const first = await xray.listPlans().catch((error: unknown) => error);
    expect(first).toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      statusCode: 400,
      details: [{ provider: 'Xray', stage: 'authenticate', status: 401 }],
    });
    expect(JSON.stringify(first)).not.toContain('super-secret');
    await expect(xray.listPlans()).rejects.toThrow('Xray did not return an access token.');
    await expect(xray.listPlans()).rejects.toMatchObject({
      details: [{ provider: 'xray', stage: 'authenticate' }],
    });
    await Promise.all([xray.listPlans(), xray.listPlans()]);
    expect(authCalls()).toHaveLength(4);
    expect(graphqlCalls().map((call) => call.headers.authorization)).toEqual([
      'Bearer token-2',
      'Bearer token-2',
    ]);
  });

  it('lists the tests of a Test Plan with their steps, keeping every position', async () => {
    const pages: unknown[] = [
      {
        data: {
          getTestPlans: {
            results: [
              {
                issueId: '70',
                tests: {
                  total: 3,
                  results: [
                    {
                      issueId: '1',
                      jira: { key: 'QA-1', summary: 'Login' },
                      steps: [
                        { id: 's1', action: 'Open', data: 'user@example.com', result: 'Form' },
                        null,
                        { action: null, data: '', result: null },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
      {
        data: {
          getTestPlans: {
            results: [
              {
                tests: {
                  total: 3,
                  results: [
                    {
                      jira: {
                        key: 'QA-2',
                        description: 'Checks the cart',
                        priority: { name: 'High' },
                        labels: ['smoke', 'cart'],
                        status: { name: 'Ready' },
                        components: [],
                        assignee: null,
                      },
                      testType: { name: 'Manual' },
                    },
                    { jira: null },
                  ],
                },
              },
            ],
          },
        },
      },
      { data: { getTestPlans: { results: [{ tests: null }] } } },
    ];
    const { fetcher, graphqlCalls } = fakeXray((url) =>
      url.endsWith('/graphql') ? pages.shift() : undefined,
    );
    const xray = provider(fetcher, { baseUrl: 'https://eu.xray.cloud.getxray.app/' });
    await expect(xray.listCases({ planId: ' qa-7 ' })).resolves.toEqual([
      {
        provider: 'xray',
        caseId: 'QA-1',
        planId: 'QA-7',
        title: 'Login',
        steps: [
          { id: 's1', action: 'Open\nuser@example.com', expectedResult: 'Form' },
          { id: '2', action: '', expectedResult: '' },
          { id: '3', action: '', expectedResult: '' },
        ],
        url: 'https://acme.atlassian.net/browse/QA-1',
      },
      {
        provider: 'xray',
        caseId: 'QA-2',
        planId: 'QA-7',
        title: 'QA-2',
        description: 'Checks the cart',
        steps: [],
        customFields: {
          testType: 'Manual',
          priority: 'High',
          status: 'Ready',
          labels: 'smoke, cart',
        },
        customFieldLabels: {
          testType: 'Test Type',
          priority: 'Priority',
          status: 'Status',
          labels: 'Labels',
        },
        url: 'https://acme.atlassian.net/browse/QA-2',
      },
    ]);
    await expect(xray.listCases({ planId: 'QA-8' })).resolves.toEqual([]);
    const calls = graphqlCalls();
    expect(calls[0]?.url).toBe('https://eu.xray.cloud.getxray.app/api/v2/graphql');
    expect(calls[0]?.body.variables).toEqual({ jql: "key = 'QA-7'", start: 0, limit: 100 });
    expect(calls[1]?.body.variables).toMatchObject({ start: 1 });
    expect(calls[0]?.body.query).toContain('testType { name }');
    expect(calls[0]?.body.query).toContain('"priority"');
  });

  it('rejects invalid or unknown Test Plans', async () => {
    const { fetcher } = fakeXray((url) =>
      url.endsWith('/graphql') ? { data: { getTestPlans: { results: [] } } } : undefined,
    );
    const xray = provider(fetcher);
    await expect(xray.listCases({})).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
      details: [{ field: 'planId' }],
    });
    await expect(xray.listCases({ planId: "QA-1' OR key != 'X" })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(xray.listCases({ planId: 'QA-404' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_PLAN_NOT_FOUND',
      statusCode: 404,
      details: [{ provider: 'xray', planId: 'QA-404' }],
    });
  });

  it('gets a single test by key', async () => {
    const answers: unknown[] = [
      { data: { getTests: { results: [{ jira: { key: 'QA-5', summary: 'Checkout' } }] } } },
      { data: { getTests: { results: [{ jira: { key: 'QA-5' }, steps: [] }] } } },
      { data: { getTests: { results: [] } } },
      { data: { getTests: { results: [{ jira: { key: 'nope' } }] } } },
      { data: {} },
    ];
    const { fetcher, graphqlCalls } = fakeXray((url) =>
      url.endsWith('/graphql') ? answers.shift() : undefined,
    );
    await expect(provider(fetcher).getCase({ caseId: 'qa-5', planId: 'QA-7' })).resolves.toEqual({
      provider: 'xray',
      caseId: 'QA-5',
      planId: 'QA-7',
      title: 'Checkout',
      steps: [],
      url: 'https://acme.atlassian.net/browse/QA-5',
    });
    expect(graphqlCalls()[0]?.body.variables).toEqual({ jql: "key = 'QA-5'" });
    const bare = provider(fetcher, { jiraBaseUrl: undefined });
    await expect(bare.getCase({ caseId: 'QA-5' })).resolves.toEqual({
      provider: 'xray',
      caseId: 'QA-5',
      title: 'QA-5',
      steps: [],
    });
    for (let index = 0; index < 3; index++)
      await expect(bare.getCase({ caseId: 'QA-6' })).rejects.toMatchObject({
        code: 'TEST_MANAGEMENT_CASE_NOT_FOUND',
        statusCode: 404,
        details: [{ provider: 'xray', caseId: 'QA-6' }],
      });
    await expect(bare.getCase({ caseId: '42' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
      details: [{ field: 'caseId' }],
    });
  });

  it('publishes one Test Execution with ordered step results and evidence', async () => {
    const { fetcher, calls } = fakeXray((url) =>
      url.endsWith('/import/execution')
        ? { id: '100', key: 'QA-100', self: 'https://xray/100' }
        : undefined,
    );
    const shot = evidence('step-1.png', new Uint8Array([104, 105]));
    const video = { ...evidence('run.webm'), contentType: 'video/webm' };
    const published = await provider(fetcher).publishRun(
      report([
        result(
          'QA-1',
          {
            outcome: 'failed',
            errorMessage: 'boom',
            comment: 'note',
            attachments: [video],
            steps: [
              step(2, { outcome: 'failed' }),
              step(1, { actualResult: 'ok', evidence: [shot] }),
              step(4),
            ],
          },
          { planId: 'QA-7', steps: remoteSteps },
        ),
        result(
          'qa-2',
          {
            outcome: 'blocked',
            comment: '  ',
            steps: [step(1, { outcome: 'blocked', evidence: [evidence('moved.png')] })],
          },
          { planId: 'qa-7' },
        ),
        result('bad'),
        result('QA-1'),
        result('QA-3', { outcome: 'not_executed' }, { planId: 'QA-7' }),
      ]),
    );
    expect(published).toEqual({
      provider: 'xray',
      remoteRunId: 'QA-100',
      url: 'https://acme.atlassian.net/browse/QA-100',
      publishedCases: 3,
      warnings: [
        'Test case bad is not an Xray Test key; it was not published.',
        'Test QA-1 appears more than once; only its first result was published.',
        'Step 4 of QA-1 does not exist in Xray; it was not published.',
      ],
    });
    const body = calls.find((call) => call.url.endsWith('/import/execution'))?.body;
    expect(body?.info).toEqual({
      project: 'QA',
      summary: 'Nightly',
      description: 'https://app.example.com - chromium',
      startDate: '2026-01-01T10:00:00+00:00',
      finishDate: '2026-01-01T10:05:00+00:00',
      testPlanKey: 'QA-7',
    });
    expect(body?.tests).toEqual([
      {
        testKey: 'QA-1',
        start: '2026-01-01T10:00:00+00:00',
        finish: '2026-01-01T10:01:00+00:00',
        status: 'FAILED',
        comment: 'boom\n\nnote',
        evidence: [{ data: 'AQID', filename: 'run.webm', contentType: 'video/webm' }],
        steps: [
          {
            status: 'PASSED',
            actualResult: 'ok',
            evidence: [{ data: 'aGk=', filename: 'step-1.png', contentType: 'image/png' }],
          },
          { status: 'FAILED', evidence: [] },
          { status: 'TODO', evidence: [] },
        ],
      },
      {
        testKey: 'QA-2',
        start: '2026-01-01T10:00:00+00:00',
        finish: '2026-01-01T10:01:00+00:00',
        status: 'ABORTED',
        evidence: [{ data: 'AQID', filename: 'moved.png', contentType: 'image/png' }],
      },
      {
        testKey: 'QA-3',
        start: '2026-01-01T10:00:00+00:00',
        finish: '2026-01-01T10:01:00+00:00',
        status: 'TODO',
      },
    ]);
  });

  it('chooses the Test Plan of the execution', async () => {
    const { fetcher, calls } = fakeXray((url) =>
      url.endsWith('/import/execution') ? { key: 'QA-100' } : undefined,
    );
    const xray = provider(fetcher, { jiraBaseUrl: '  ' });
    const planOf = async (results: CaseRunResult[], target: TestRunReport['target'] = {}) => {
      const published = await xray.publishRun(report(results, target));
      expect(published.url).toBeNull();
      return calls.at(-1)?.body.info?.testPlanKey;
    };
    await expect(
      planOf([result('QA-1', {}, { planId: 'QA-7' })], { planId: 'qa-9' }),
    ).resolves.toBe('QA-9');
    await expect(
      planOf([result('QA-1', {}, { planId: 'QA-7' }), result('QA-2', {}, { planId: 'QA-8' })]),
    ).resolves.toBeUndefined();
    await expect(planOf([result('QA-1')])).resolves.toBeUndefined();
    await expect(planOf([result('QA-1', {}, { planId: 'plan' })])).resolves.toBeUndefined();
    await expect(
      xray.publishRun(report([result('QA-1')], { planId: 'plan' })),
    ).rejects.toMatchObject({ code: 'TEST_MANAGEMENT_INVALID_ID', details: [{ field: 'planId' }] });
  });

  it('refuses a run without valid Test keys and requires the execution key', async () => {
    const { fetcher } = fakeXray((url) =>
      url.endsWith('/import/execution') ? { id: '1' } : undefined,
    );
    const xray = provider(fetcher);
    await expect(xray.publishRun(report([result('42')]))).rejects.toMatchObject({
      code: 'TEST_RUN_NOTHING_TO_PUBLISH',
      statusCode: 400,
      details: [
        {
          provider: 'xray',
          warnings: ['Test case 42 is not an Xray Test key; it was not published.'],
        },
      ],
    });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(xray.publishRun(report([result('QA-1')]))).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      statusCode: 502,
      details: [{ provider: 'xray', stage: 'import-execution' }],
    });
  });

  it('keeps the import within the Xray size limits, dropping recordings first', async () => {
    const { fetcher, calls } = fakeXray((url) =>
      url.endsWith('/import/execution') ? { key: 'QA-100' } : undefined,
    );
    const shots = Array.from({ length: 8 }, (_, index) => sized(`shot-${index}.png`, 9 * MB));
    const published = await provider(fetcher).publishRun(
      report([
        result(
          'QA-1',
          {
            attachments: [sized('long.webm', 9 * MB), sized('short.webm', 8 * MB)],
            steps: [
              step(1, { evidence: [sized('huge.png', 11 * MB), evidence('tiny.png')] }),
              step(2, { evidence: shots }),
            ],
          },
          { steps: remoteSteps.slice(0, 2) },
        ),
      ]),
    );
    expect(published.warnings).toEqual([
      'huge.png of QA-1 is larger than 10 MB; it was not attached.',
      'long.webm of QA-1 was not attached to keep the Xray import within its size limit.',
      'short.webm of QA-1 was not attached to keep the Xray import within its size limit.',
      'shot-0.png of QA-1 was not attached to keep the Xray import within its size limit.',
    ]);
    const [test] = calls.at(-1)?.body.tests ?? [];
    expect(test).not.toHaveProperty('evidence');
    const steps = test?.steps as { evidence: { filename: string }[] }[];
    expect(steps[0]?.evidence.map((item) => item.filename)).toEqual(['tiny.png']);
    expect(steps[1]?.evidence).toHaveLength(7);
  });
});
