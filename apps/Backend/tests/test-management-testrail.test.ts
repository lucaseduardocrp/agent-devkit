import { describe, expect, it } from 'vitest';
import {
  TestRailTestManagementProvider,
  parseCaseId,
  testRailSteps,
} from '../src/modules/test-management/adapters/testrail-test-management.js';
import type {
  CaseRunResult,
  StepRunResult,
  TestEvidence,
  TestRunReport,
} from '../src/modules/test-management/domain/test-run.js';

const BASE = 'https://acme.testrail.io';
const API = `${BASE}/index.php?/api/v2/`;

interface Call {
  readonly path: string;
  readonly method: string;
  readonly authorization: string;
  readonly body: unknown;
}

type Route = (call: Call) => unknown;

/** Routes by the API path (what follows "api/v2/"); a Response is returned as is. */
function fakeTestRail(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(API)).toBe(true);
    const path = url.slice(API.length);
    const headers = init?.headers as Record<string, string>;
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body === undefined
          ? undefined
          : JSON.parse(String(init.body));
    const call = {
      path,
      method: init?.method ?? 'GET',
      authorization: headers.authorization!,
      body,
    };
    calls.push(call);
    const route = routes[path] ?? routes[path.split('&')[0]!.replace(/\/\d+$/, '')];
    if (!route) return new Response('{"error":"not found"}', { status: 404 });
    const result = route(call);
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  }) as typeof fetch;
  const provider = new TestRailTestManagementProvider({
    baseUrl: `${BASE}/`,
    username: 'qa@acme.io',
    apiKey: 'secret-key',
    fetcher,
    retryDelayMs: 0,
  });
  return { provider, calls };
}

const png = (name: string): TestEvidence => ({
  fileName: name,
  contentType: 'image/png',
  content: new Uint8Array([1, 2, 3]),
});

function step(position: number, overrides: Partial<StepRunResult> = {}): StepRunResult {
  return {
    position,
    stepId: String(position),
    action: `Action ${position}`,
    expectedResult: `Expected ${position}`,
    outcome: 'passed',
    actualResult: null,
    durationMs: 100,
    evidence: [],
    ...overrides,
  };
}

function result(
  caseId: string,
  location: { planId?: string; suiteId?: string },
  overrides: Partial<CaseRunResult> = {},
): CaseRunResult {
  return {
    testCase: { provider: 'testrail', caseId, ...location, title: `Case ${caseId}`, steps: [] },
    outcome: 'passed',
    startedAt: new Date('2026-01-01T10:00:00Z'),
    finishedAt: new Date('2026-01-01T10:01:32Z'),
    durationMs: 92_000,
    errorMessage: null,
    comment: null,
    steps: [],
    attachments: [],
    ...overrides,
  };
}

function report(results: readonly CaseRunResult[]): TestRunReport {
  return {
    name: 'Nightly',
    startedAt: new Date('2026-01-01T10:00:00Z'),
    finishedAt: new Date('2026-01-01T10:05:00Z'),
    environment: 'https://app.acme.io - chromium',
    target: {},
    results,
  };
}

describe('TestRailTestManagementProvider', () => {
  it('describes TestRail levels and authenticates with Basic auth', async () => {
    const { provider, calls } = fakeTestRail({ get_suites: () => [] });
    expect(provider.id).toBe('testrail');
    expect(provider.name).toBe('TestRail');
    expect(provider.capabilities).toEqual({
      planLabel: 'Project',
      suiteLabel: 'Suite',
      suiteRequired: false,
      caseIdLabel: 'Case ID',
      stepEvidence: true,
    });
    await provider.listSuites('1');
    expect(calls[0]!.authorization).toBe(
      `Basic ${Buffer.from('qa@acme.io:secret-key').toString('base64')}`,
    );
  });

  it('lists active projects across pages, sorted by name', async () => {
    const { provider, calls } = fakeTestRail({
      'get_projects&is_completed=0': () => ({
        projects: [{ id: 2, name: 'Web' }, { id: 'x', name: 'Invalid' }, { name: 'No id' }],
        _links: { next: '/api/v2/get_projects&is_completed=0&limit=250&offset=250' },
      }),
      'get_projects&is_completed=0&limit=250&offset=250': () => ({
        projects: [{ id: 1, name: 'API' }, { id: 3 }],
        _links: { next: null },
      }),
    });
    await expect(provider.listPlans()).resolves.toEqual([
      { id: '1', name: 'API' },
      { id: '2', name: 'Web' },
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      'get_projects&is_completed=0',
      'get_projects&is_completed=0&limit=250&offset=250',
    ]);
  });

  it('accepts the legacy array answer for projects and suites', async () => {
    const { provider, calls } = fakeTestRail({
      'get_projects&is_completed=0': () => [{ id: 5, name: 'Legacy' }],
      'get_suites/5': () => [
        { id: 7, name: 'Smoke' },
        { id: 8, name: 'Regression' },
      ],
    });
    await expect(provider.listPlans()).resolves.toEqual([{ id: '5', name: 'Legacy' }]);
    await expect(provider.listSuites('5')).resolves.toEqual([
      { id: '7', name: 'Smoke' },
      { id: '8', name: 'Regression' },
    ]);
    expect(calls.map((call) => call.path)).toEqual(['get_projects&is_completed=0', 'get_suites/5']);
    await expect(provider.listSuites('abc')).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
    });
  });

  it('lists cases of a suite with separated steps and text steps', async () => {
    const { provider, calls } = fakeTestRail({
      'get_cases/1&suite_id=4': () => ({
        cases: [
          {
            id: 10,
            title: ' Login ',
            suite_id: 4,
            custom_steps_separated: [
              { content: 'Open <b>login</b>', expected: 'Form &amp; button' },
              { content: '', expected: '' },
              { expected: 'Only expected' },
            ],
          },
          { id: 11, custom_steps: 'Do it', custom_expected: null, custom_steps_separated: [] },
          { title: 'Without id' },
        ],
        _links: { next: '' },
      }),
    });
    const cases = await provider.listCases({ planId: '1', suiteId: '4' });
    expect(calls[0]!.path).toBe('get_cases/1&suite_id=4');
    expect(cases).toEqual([
      {
        provider: 'testrail',
        caseId: '10',
        planId: '1',
        suiteId: '4',
        title: 'Login',
        steps: [
          { id: '1', action: 'Open login', expectedResult: 'Form & button' },
          { id: '3', action: '', expectedResult: 'Only expected' },
        ],
        url: `${BASE}/index.php?/cases/view/10`,
      },
      {
        provider: 'testrail',
        caseId: '11',
        planId: '1',
        suiteId: '4',
        title: 'Case C11',
        steps: [{ id: '1', action: 'Do it', expectedResult: '' }],
        url: `${BASE}/index.php?/cases/view/11`,
      },
    ]);
  });

  it('reads standard and custom fields with their labels and option names', async () => {
    const { provider, calls } = fakeTestRail({
      'get_cases/1': () => ({
        cases: [
          {
            id: 30,
            title: 'Checkout',
            priority_id: 4,
            type_id: 9,
            refs: 'JIRA-1',
            custom_preconds: '<p>Logged in</p>',
            custom_browser: 2,
            custom_platforms: [1, 3, 7],
            custom_automated: true,
            custom_steps_separated: [{ content: 'Pay', expected: 'Paid' }],
            custom_attachment: { id: 1 },
          },
        ],
      }),
      get_case_fields: () => [
        { system_name: 'custom_preconds', label: 'Preconditions' },
        {
          system_name: 'custom_browser',
          label: 'Browser',
          configs: [{ options: { items: '1, Chrome\n2, Firefox' } }],
        },
        {
          system_name: 'custom_platforms',
          label: 'Platforms',
          configs: [{ options: { items: '1, Web' } }, { options: { items: '3, Android' } }],
        },
        { label: 'Without key' },
        { system_name: 'custom_notes', configs: [{ options: {} }, {}] },
      ],
      get_priorities: () => [{ id: 4, name: 'Critical' }, { name: 'No id' }, { id: 5 }],
      get_case_types: () => new Response('{"error":"forbidden"}', { status: 403 }),
    });
    const [item] = await provider.listCases({ planId: '1' });
    expect(item!.customFields).toEqual({
      priority_id: 'Critical',
      type_id: 9,
      refs: 'JIRA-1',
      custom_preconds: '<p>Logged in</p>',
      custom_browser: 'Firefox',
      custom_platforms: 'Web, Android, 7',
      custom_automated: true,
    });
    expect(item!.customFieldLabels).toEqual({
      priority_id: 'Priority',
      type_id: 'Type',
      refs: 'References',
      custom_preconds: 'Preconditions',
      custom_browser: 'Browser',
      custom_platforms: 'Platforms',
    });
    expect(item!.steps).toEqual([{ id: '1', action: 'Pay', expectedResult: 'Paid' }]);
    // The catalog is read once per adapter.
    await provider.listCases({ planId: '1' });
    expect(calls.filter((call) => call.path === 'get_case_fields')).toHaveLength(1);

    // An instance that answers the catalog with something else than a list.
    const odd = fakeTestRail({
      'get_case/31': () => ({ id: 31, title: 'Odd', priority_id: 2 }),
      get_case_fields: () => ({ error: 'unexpected' }),
      get_priorities: () => [],
      get_case_types: () => [],
    });
    await expect(odd.provider.getCase({ caseId: 'C31' })).resolves.toMatchObject({
      customFields: { priority_id: 2 },
      customFieldLabels: { priority_id: 'Priority' },
    });
  });

  it('lists cases of a single-suite project, taking the suite from each case', async () => {
    const { provider, calls } = fakeTestRail({
      'get_cases/1': () => ({
        cases: [
          { id: 20, title: 'With suite', suite_id: 9 },
          { id: 21, title: 'Without suite' },
        ],
      }),
      'get_cases/2': () => ({ _links: { next: '/api/v2/get_cases/2&offset=250' } }),
      'get_cases/2&offset=250': () => [],
    });
    const cases = await provider.listCases({ planId: '1' });
    expect(cases.map((item) => [item.caseId, item.suiteId, item.steps])).toEqual([
      ['20', '9', []],
      ['21', undefined, []],
    ]);
    expect(cases[1]).not.toHaveProperty('suiteId');
    await expect(provider.listCases({ planId: '2' })).resolves.toEqual([]);
    expect(calls.map((call) => call.path)).toEqual([
      'get_cases/1',
      'get_cases/2',
      'get_cases/2&offset=250',
    ]);
    await expect(provider.listCases({})).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
    });
    await expect(provider.listCases({ planId: '1', suiteId: 'x' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
    });
  });

  it('stops when pagination repeats a page or never ends', async () => {
    const repeating = fakeTestRail({
      'get_cases/1': () => ({ cases: [], _links: { next: '/api/v2/get_cases/1' } }),
    });
    await expect(repeating.provider.listCases({ planId: '1' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
      statusCode: 502,
    });
    let page = 0;
    const endless = fakeTestRail({
      get_cases: () => ({ cases: [], _links: { next: `/api/v2/get_cases/1&offset=${++page}` } }),
    });
    await expect(endless.provider.listCases({ planId: '1' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_REQUEST_FAILED',
    });
    expect(endless.calls).toHaveLength(1_000);
  });

  it('gets a case by "C" id or number, keeping the given location', async () => {
    const { provider, calls } = fakeTestRail({
      'get_case/12': () => ({ id: 12, title: 'Checkout', custom_steps: 'Pay' }),
      'get_case/13': () => ({ id: 13, title: 'Search', suite_id: 6 }),
      'get_case/14': () => ({}),
    });
    await expect(
      provider.getCase({ caseId: ' C12 ', planId: '1', suiteId: '4' }),
    ).resolves.toMatchObject({
      caseId: '12',
      planId: '1',
      suiteId: '4',
      steps: [{ id: '1', action: 'Pay', expectedResult: '' }],
    });
    const search = await provider.getCase({ caseId: '13' });
    expect(search).toMatchObject({ caseId: '13', suiteId: '6' });
    expect(search).not.toHaveProperty('planId');
    await expect(provider.getCase({ caseId: 'c14' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_CASE_NOT_FOUND',
      statusCode: 404,
    });
    await expect(provider.getCase({ caseId: 'C0' })).rejects.toMatchObject({
      code: 'TEST_MANAGEMENT_INVALID_ID',
    });
    expect(calls.map((call) => call.path)).toEqual(['get_case/12', 'get_case/13', 'get_case/14']);
  });

  it('reports TestRail errors without the URL or the key', async () => {
    const { provider } = fakeTestRail({
      'get_case/15': () => new Response('{"error":"Field :case_id is not valid"}', { status: 400 }),
    });
    const error = await provider.getCase({ caseId: '15' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'TEST_MANAGEMENT_REQUEST_FAILED' });
    expect(JSON.stringify(error)).not.toMatch(/secret-key|acme\.testrail/);
    expect(String((error as Error).message)).not.toMatch(/secret-key|acme\.testrail/);
  });

  it('publishes one open run per project and suite with step results and evidence', async () => {
    let attachment = 100;
    let nextRun = 50;
    const { provider, calls } = fakeTestRail({
      add_run: () => ({ id: nextRun++ }),
      add_attachment_to_run: (call) => {
        const file = (call.body as FormData).get('attachment') as File;
        if (file.name === 'broken.png') return new Response('{}', { status: 400 });
        if (file.name === 'empty.png') return {};
        if (file.name === 'fraction.png') return { attachment_id: 1.5 };
        if (file.name === 'blank.png') return { attachment_id: '' };
        if (file.name === 'uuid.png') return { attachment_id: 'a1b2-c3' };
        return { attachment_id: attachment++ };
      },
      'add_results_for_cases/50': (call) =>
        (call.body as { results: unknown[] }).results.map((_, index) =>
          index === 1 ? {} : { id: 900 + index },
        ),
      'add_results_for_cases/51': () => ({}),
      add_attachment_to_result: (call) =>
        call.path.endsWith('/900') ? { attachment_id: 7 } : new Response('', { status: 500 }),
    });
    const published = await provider.publishRun(
      report([
        result(
          'C10',
          { planId: '1', suiteId: '4' },
          {
            outcome: 'failed',
            errorMessage: 'Timeout',
            comment: 'Automated',
            steps: [
              step(1, { evidence: [png('one.png'), png('uuid.png')] }),
              step(2, {
                outcome: 'failed',
                actualResult: 'Button missing',
                evidence: [png('two.png'), png('broken.png')],
              }),
              step(3, { outcome: 'not_executed', evidence: [png('empty.png')] }),
              step(4, {
                outcome: 'blocked',
                evidence: [png('fraction.png'), png('blank.png')],
              }),
            ],
            attachments: [{ ...png('video.webm'), contentType: 'video/webm' }],
          },
        ),
        result('11', { planId: '1', suiteId: '4' }, { attachments: [png('lost.png')] }),
        result('10', { planId: '1', suiteId: '4' }, { outcome: 'not_executed', comment: 'Rerun' }),
        result('12', { planId: '2' }, { outcome: 'blocked', attachments: [png('orphan.png')] }),
        result('13', {}),
      ]),
    );

    expect(published).toEqual({
      provider: 'testrail',
      remoteRunId: '50,51',
      url: `${BASE}/index.php?/runs/view/50`,
      publishedCases: 4,
      warnings: [
        'Test case 13 has no TestRail project; it was not published.',
        'Could not attach broken.png to run 50.',
        'Could not attach empty.png to run 50.',
        'Could not attach fraction.png to run 50.',
        'Could not attach blank.png to run 50.',
        'Could not attach lost.png: TestRail returned no result id.',
        'Could not attach orphan.png: TestRail returned no result id.',
      ],
    });

    const runs = calls.filter((call) => call.path.startsWith('add_run/'));
    expect(runs.map((call) => [call.path, call.method, call.body])).toEqual([
      [
        'add_run/1',
        'POST',
        {
          suite_id: 4,
          name: 'Nightly',
          description: 'https://app.acme.io - chromium',
          include_all: false,
          case_ids: [10, 11],
        },
      ],
      [
        'add_run/2',
        'POST',
        {
          name: 'Nightly',
          description: 'https://app.acme.io - chromium',
          include_all: false,
          case_ids: [12],
        },
      ],
    ]);

    const uploads = calls.filter((call) => call.path.startsWith('add_attachment_to_run/'));
    expect(uploads.every((call) => call.path === 'add_attachment_to_run/50')).toBe(true);
    const first = (uploads[0]!.body as FormData).get('attachment') as File;
    expect(first.type).toBe('image/png');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const results = calls.find((call) => call.path === 'add_results_for_cases/50')!;
    expect(results.body).toEqual({
      results: [
        {
          case_id: 10,
          status_id: 5,
          comment: 'Automated\n\nTimeout',
          elapsed: '1m 32s',
          custom_step_results: [
            {
              content: 'Action 1',
              expected: 'Expected 1',
              actual:
                '![](index.php?/attachments/get/100)\n![](index.php?/attachments/get/a1b2-c3)',
              status_id: 1,
            },
            {
              content: 'Action 2',
              expected: 'Expected 2',
              actual: 'Button missing\n![](index.php?/attachments/get/101)',
              status_id: 5,
            },
            { content: 'Action 3', expected: 'Expected 3', actual: '', status_id: 3 },
            { content: 'Action 4', expected: 'Expected 4', actual: '', status_id: 2 },
          ],
        },
        { case_id: 11, status_id: 1, comment: '', elapsed: '1m 32s', custom_step_results: [] },
        { case_id: 10, status_id: 4, comment: 'Rerun', elapsed: '1m 32s', custom_step_results: [] },
      ],
    });
    expect(calls.find((call) => call.path === 'add_results_for_cases/51')!.body).toMatchObject({
      results: [{ case_id: 12, status_id: 2 }],
    });

    const video = calls.filter((call) => call.path.startsWith('add_attachment_to_result/'));
    expect(video.map((call) => call.path)).toEqual(['add_attachment_to_result/900']);
    expect(((video[0]!.body as FormData).get('attachment') as File).name).toBe('video.webm');
    expect(calls.some((call) => call.path.startsWith('close_run'))).toBe(false);
  });

  it('reports a failed case-level attachment and keeps publishing', async () => {
    const { provider } = fakeTestRail({
      add_run: () => ({ id: 60 }),
      add_results_for_cases: () => [{ id: 70 }],
      add_attachment_to_result: () => new Response('', { status: 413 }),
    });
    await expect(
      provider.publishRun(
        report([result('5', { planId: '1' }, { attachments: [png('video.webm')] })]),
      ),
    ).resolves.toMatchObject({
      remoteRunId: '60',
      publishedCases: 1,
      warnings: ['Could not attach video.webm to result 70.'],
    });
  });

  it('fails when nothing can be published or the run has no id', async () => {
    const { provider, calls } = fakeTestRail({ add_run: () => ({}) });
    await expect(provider.publishRun(report([result('1', {})]))).rejects.toMatchObject({
      code: 'TEST_RUN_NOTHING_TO_PUBLISH',
      statusCode: 400,
      details: [
        {
          provider: 'testrail',
          warnings: ['Test case 1 has no TestRail project; it was not published.'],
        },
      ],
    });
    expect(calls).toHaveLength(0);
    await expect(provider.publishRun(report([result('1', { planId: '1' })]))).rejects.toMatchObject(
      { code: 'TEST_MANAGEMENT_REQUEST_FAILED', statusCode: 502 },
    );
    await expect(
      provider.publishRun(report([result('C1', { planId: '1', suiteId: '0' })])),
    ).rejects.toMatchObject({ code: 'TEST_MANAGEMENT_INVALID_ID' });
    await expect(
      provider.publishRun(report([result('X1', { planId: '1' })])),
    ).rejects.toMatchObject({ code: 'TEST_MANAGEMENT_INVALID_ID' });
  });
});

describe('TestRail helpers', () => {
  it('parses case ids with or without the "C" prefix', () => {
    expect(parseCaseId('C123')).toBe(123);
    expect(parseCaseId('c7')).toBe(7);
    expect(parseCaseId('42')).toBe(42);
    expect(() => parseCaseId(undefined)).toThrow('Invalid caseId.');
    expect(() => parseCaseId('C')).toThrow('Invalid caseId.');
  });

  it('reads separated steps, text steps or nothing', () => {
    expect(testRailSteps({ custom_steps_separated: null, custom_expected: 'Shown' })).toEqual([
      { id: '1', action: '', expectedResult: 'Shown' },
    ]);
    expect(testRailSteps({ custom_steps_separated: [{ content: 'Only action' }] })).toEqual([
      { id: '1', action: 'Only action', expectedResult: '' },
    ]);
    expect(testRailSteps({ custom_steps: '  ', custom_expected: null })).toEqual([]);
    expect(testRailSteps({})).toEqual([]);
  });
});
