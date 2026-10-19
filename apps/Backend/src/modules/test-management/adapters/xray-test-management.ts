import { ApplicationError } from '../../../shared/errors.js';
import type { TestManagementProvider } from '../application/test-management-provider.js';
import {
  customFieldValue,
  type CaseRunResult,
  type CustomFieldValue,
  type ExternalCaseLocation,
  type ExternalTestCase,
  type ExternalTestStep,
  type PublishedTestRun,
  type RemoteContainer,
  type TestEvidence,
  type TestOutcome,
  type TestRunReport,
} from '../domain/test-run.js';
import { ProviderHttp } from './provider-http.js';

export interface XrayTestManagementOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Jira project key where Test Executions are created, e.g. "QA". */
  readonly projectKey: string;
  /** Xray Cloud region URL; defaults to https://xray.cloud.getxray.app */
  readonly baseUrl?: string;
  /** Jira site, e.g. https://acme.atlassian.net — used only to build browse links. */
  readonly jiraBaseUrl?: string;
  readonly fetcher?: typeof fetch;
  readonly retryDelayMs?: number;
}

interface JiraFields {
  readonly key?: unknown;
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly [field: string]: unknown;
}

interface XrayStep {
  readonly id?: string | null;
  readonly action?: string | null;
  readonly data?: string | null;
  readonly result?: string | null;
}

interface XrayTest {
  readonly jira?: JiraFields | null;
  readonly testType?: { readonly name?: unknown } | null;
  readonly steps?: readonly (XrayStep | null)[] | null;
}

/** Jira fields read with each test and shown as its fields, with their display names. */
const JIRA_CASE_FIELDS: Readonly<Record<string, string>> = {
  priority: 'Priority',
  status: 'Status',
  labels: 'Labels',
  components: 'Components',
  assignee: 'Assignee',
};

interface XrayPage<T> {
  readonly total?: number | null;
  readonly results?: readonly (T | null)[] | null;
}

interface XrayEvidence {
  readonly data: string;
  readonly filename: string;
  readonly contentType: string;
}

interface XrayStepResult {
  status: string;
  actualResult?: string;
  readonly evidence: XrayEvidence[];
}

const DEFAULT_BASE_URL = 'https://xray.cloud.getxray.app';
/** Largest page the Xray GraphQL API accepts. */
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_TEXT = 32_000;
const MAX_SUMMARY = 255;
/** Xray rejects large imports: single files above this size are left out. */
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
/** Budget for the base64 evidence of one import; recordings are dropped first. */
const MAX_PAYLOAD_BASE64 = 90 * 1024 * 1024;
/** Jira issue key; the strict format also keeps keys from changing the JQL. */
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** Xray Cloud built-in statuses; "blocked" has no counterpart, ABORTED is the closest. */
const STATUSES: Record<TestOutcome, string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  blocked: 'ABORTED',
  not_executed: 'TODO',
};

const TEST_FIELDS = `issueId testType { name } jira(fields: ${JSON.stringify([
  'key',
  'summary',
  'description',
  ...Object.keys(JIRA_CASE_FIELDS),
])}) steps { id action data result }`;

const PLANS_QUERY = `query ($jql: String, $start: Int, $limit: Int!) {
  getTestPlans(jql: $jql, start: $start, limit: $limit) {
    total
    results { issueId jira(fields: ["key", "summary"]) }
  }
}`;

const PLAN_TESTS_QUERY = `query ($jql: String, $start: Int, $limit: Int!) {
  getTestPlans(jql: $jql, limit: 1) {
    results {
      issueId
      tests(start: $start, limit: $limit) { total results { ${TEST_FIELDS} } }
    }
  }
}`;

const TEST_QUERY = `query ($jql: String) {
  getTests(jql: $jql, limit: 1) { results { ${TEST_FIELDS} } }
}`;

/**
 * Xray Cloud (Jira). Plans are "Test Plan" issues and cases are "Test" issues read through
 * the GraphQL API; a run becomes one Test Execution created by the JSON results import, with
 * step results sent in the order of the test's steps and the screenshots embedded as base64.
 */
export class XrayTestManagementProvider implements TestManagementProvider {
  readonly id = 'xray' as const;
  readonly name = 'Xray Cloud';
  readonly capabilities = {
    planLabel: 'Test Plan',
    suiteLabel: null,
    suiteRequired: false,
    caseIdLabel: 'Test key',
    stepEvidence: true,
  };
  private readonly http: ProviderHttp;
  private readonly baseUrl: string;
  private readonly jiraBaseUrl: string | null;
  private readonly projectKey: string;
  /** Lazily obtained and shared by the calls of this instance. */
  private token: Promise<string> | undefined;

  constructor(private readonly options: XrayTestManagementOptions) {
    this.http = new ProviderHttp('Xray', options.fetcher, { retryDelayMs: options.retryDelayMs });
    this.baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.jiraBaseUrl = options.jiraBaseUrl?.trim().replace(/\/+$/, '') || null;
    this.projectKey = options.projectKey.trim().toUpperCase();
    if (!PROJECT_KEY.test(this.projectKey))
      throw new ApplicationError('TEST_MANAGEMENT_INVALID_ID', 'Invalid projectKey.', 400, [
        { field: 'projectKey' },
      ]);
  }

  async listPlans(): Promise<readonly RemoteContainer[]> {
    const plans = await this.paginate<{ jira?: JiraFields | null }>('plans', async (start) => {
      const data = await this.graphql<{ getTestPlans?: XrayPage<{ jira?: JiraFields | null }> }>(
        PLANS_QUERY,
        { jql: `project = '${this.projectKey}'`, start, limit: PAGE_SIZE },
        'plans',
      );
      return data.getTestPlans;
    });
    return plans.flatMap((plan) => {
      const key = issueKeyOf(plan.jira);
      if (!key) return [];
      const summary = textOf(plan.jira?.summary);
      return [{ id: key, name: summary ? `${key} - ${summary}` : key }];
    });
  }

  /** Test Plans hold the tests directly; there is no second level to pick. */
  listSuites(): Promise<readonly RemoteContainer[]> {
    return Promise.resolve([]);
  }

  async listCases(location: ExternalCaseLocation): Promise<readonly ExternalTestCase[]> {
    const planKey = parseIssueKey(location.planId, 'planId');
    const tests = await this.paginate<XrayTest>('plan-tests', async (start) => {
      const data = await this.graphql<{
        getTestPlans?: XrayPage<{ tests?: XrayPage<XrayTest> | null }>;
      }>(PLAN_TESTS_QUERY, { jql: `key = '${planKey}'`, start, limit: PAGE_SIZE }, 'plan-tests');
      const plan = data.getTestPlans?.results?.[0];
      if (!plan)
        throw new ApplicationError('TEST_MANAGEMENT_PLAN_NOT_FOUND', 'Test Plan not found.', 404, [
          { provider: this.id, planId: planKey },
        ]);
      return plan.tests;
    });
    return tests.flatMap((test) => this.toCase(test, planKey));
  }

  async getCase(ref: ExternalCaseLocation & { caseId: string }): Promise<ExternalTestCase> {
    const key = parseIssueKey(ref.caseId, 'caseId');
    const data = await this.graphql<{ getTests?: XrayPage<XrayTest> }>(
      TEST_QUERY,
      { jql: `key = '${key}'` },
      'test',
    );
    const test = data.getTests?.results?.[0];
    const [testCase] = test ? this.toCase(test, ref.planId) : [];
    if (!testCase)
      throw new ApplicationError('TEST_MANAGEMENT_CASE_NOT_FOUND', 'Test case not found.', 404, [
        { provider: this.id, caseId: ref.caseId },
      ]);
    return testCase;
  }

  async publishRun(report: TestRunReport): Promise<PublishedTestRun> {
    const warnings: string[] = [];
    const accepted = new Map<string, CaseRunResult>();
    for (const result of report.results) {
      const key = result.testCase.caseId.trim().toUpperCase();
      if (!ISSUE_KEY.test(key)) {
        warnings.push(
          `Test case ${result.testCase.caseId} is not an Xray Test key; it was not published.`,
        );
      } else if (accepted.has(key)) {
        warnings.push(`Test ${key} appears more than once; only its first result was published.`);
      } else accepted.set(key, result);
    }
    if (!accepted.size)
      throw new ApplicationError(
        'TEST_RUN_NOTHING_TO_PUBLISH',
        'No result has a valid Xray Test key.',
        400,
        [{ provider: this.id, warnings }],
      );

    const dropped = selectEvidence([...accepted.values()], warnings);
    const testPlanKey = this.testPlanOf(report, [...accepted.values()]);
    const execution = await this.call<{ key?: unknown }>(
      'api/v2/import/execution',
      'import-execution',
      {
        info: {
          project: this.projectKey,
          summary: report.name.slice(0, MAX_SUMMARY),
          description: report.environment.slice(0, MAX_TEXT),
          startDate: xrayDate(report.startedAt),
          finishDate: xrayDate(report.finishedAt),
          ...(testPlanKey ? { testPlanKey } : {}),
        },
        tests: [...accepted].map(([key, result]) => testPayload(key, result, dropped, warnings)),
      },
    );
    const key = textOf(execution.key);
    if (!key)
      throw new ApplicationError(
        'TEST_MANAGEMENT_REQUEST_FAILED',
        'Xray did not return the Test Execution key.',
        502,
        [{ provider: this.id, stage: 'import-execution' }],
      );
    return {
      provider: this.id,
      remoteRunId: key,
      url: this.browseUrl(key),
      publishedCases: accepted.size,
      warnings,
    };
  }

  /** The report's plan wins; otherwise the plan shared by every result, if any. */
  private testPlanOf(report: TestRunReport, results: readonly CaseRunResult[]): string | null {
    if (report.target.planId) return parseIssueKey(report.target.planId, 'planId');
    const plans = new Set(results.map((result) => result.testCase.planId?.trim().toUpperCase()));
    const [plan] = plans;
    return plans.size === 1 && plan && ISSUE_KEY.test(plan) ? plan : null;
  }

  private toCase(test: XrayTest, planId: string | undefined): ExternalTestCase[] {
    const key = issueKeyOf(test.jira);
    if (!key) return [];
    const url = this.browseUrl(key);
    const customFields: Record<string, CustomFieldValue> = {};
    const testType = textOf(test.testType?.name);
    if (testType) customFields['testType'] = testType;
    for (const field of Object.keys(JIRA_CASE_FIELDS)) {
      const value = customFieldValue(test.jira?.[field]);
      if (value !== undefined && value !== null && value !== '') customFields[field] = value;
    }
    // Jira Cloud may answer the description as a document tree; only plain text is kept.
    const description = textOf(test.jira?.description);
    return [
      {
        provider: this.id,
        caseId: key,
        ...(planId ? { planId } : {}),
        title: textOf(test.jira?.summary) || key,
        ...(description ? { description } : {}),
        // Every step is kept, even an empty one: Xray matches step results by position.
        steps: (test.steps ?? []).map((step, index) => toStep(step, index)),
        ...(Object.keys(customFields).length
          ? {
              customFields,
              customFieldLabels: Object.fromEntries(
                Object.keys(customFields).map((field) => [
                  field,
                  JIRA_CASE_FIELDS[field] ?? 'Test Type',
                ]),
              ),
            }
          : {}),
        ...(url ? { url } : {}),
      },
    ];
  }

  private browseUrl(key: string): string | null {
    return this.jiraBaseUrl ? `${this.jiraBaseUrl}/browse/${key}` : null;
  }

  private async paginate<T>(
    stage: string,
    fetchPage: (start: number) => Promise<XrayPage<T> | null | undefined>,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let start = 0, page = 0; ; page++) {
      if (page >= MAX_PAGES)
        throw new ApplicationError(
          'TEST_MANAGEMENT_REQUEST_FAILED',
          'Xray pagination did not finish.',
          502,
          [{ provider: this.id, stage }],
        );
      const data = await fetchPage(start);
      const results = data?.results ?? [];
      items.push(...results.filter((item): item is T => Boolean(item)));
      start += results.length;
      if (!results.length || start >= (data?.total ?? 0)) return items;
    }
  }

  private async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    stage: string,
  ): Promise<T> {
    const response = await this.call<{ data?: T | null; errors?: readonly unknown[] }>(
      'api/v2/graphql',
      stage,
      { query, variables },
    );
    // Server messages may quote JQL or issue data, so they are not echoed.
    if (!response.data)
      throw new ApplicationError(
        'TEST_MANAGEMENT_REQUEST_FAILED',
        response.errors?.length
          ? `Xray rejected the query (${stage}).`
          : `Xray returned no data (${stage}).`,
        502,
        [{ provider: this.id, stage }],
      );
    return response.data;
  }

  private async call<T>(path: string, stage: string, body: unknown): Promise<T> {
    return this.http.json<T>(`${this.baseUrl}/${path}`, {
      method: 'POST',
      stage,
      body,
      headers: { authorization: `Bearer ${await this.authenticate()}` },
    });
  }

  private authenticate(): Promise<string> {
    this.token ??= this.requestToken().catch((error: unknown) => {
      this.token = undefined;
      throw error;
    });
    return this.token;
  }

  private async requestToken(): Promise<string> {
    const token = await this.http.json<unknown>(`${this.baseUrl}/api/v2/authenticate`, {
      method: 'POST',
      stage: 'authenticate',
      body: { client_id: this.options.clientId, client_secret: this.options.clientSecret },
    });
    if (typeof token !== 'string' || !token.trim())
      throw new ApplicationError(
        'TEST_MANAGEMENT_REQUEST_FAILED',
        'Xray did not return an access token.',
        502,
        [{ provider: this.id, stage: 'authenticate' }],
      );
    return token.trim();
  }
}

function testPayload(
  key: string,
  result: CaseRunResult,
  dropped: ReadonlySet<TestEvidence>,
  warnings: string[],
) {
  const remoteSteps = result.testCase.steps.length;
  const steps = Array.from({ length: remoteSteps }, (): XrayStepResult => ({
    status: STATUSES.not_executed,
    evidence: [],
  }));
  // Without remote steps the screenshots still belong to the test, so they move up a level.
  const evidence: XrayEvidence[] = [];
  for (const step of result.steps) {
    const target = steps[step.position - 1];
    const files = step.evidence.filter((item) => !dropped.has(item)).map(toEvidence);
    if (!target) {
      if (remoteSteps)
        warnings.push(
          `Step ${step.position} of ${key} does not exist in Xray; it was not published.`,
        );
      else evidence.push(...files);
      continue;
    }
    target.status = STATUSES[step.outcome];
    if (step.actualResult) target.actualResult = step.actualResult.slice(0, MAX_TEXT);
    target.evidence.push(...files);
  }
  evidence.push(...result.attachments.filter((item) => !dropped.has(item)).map(toEvidence));
  const comment = [result.errorMessage, result.comment]
    .filter((text): text is string => Boolean(text?.trim()))
    .join('\n\n')
    .slice(0, MAX_TEXT);
  return {
    testKey: key,
    start: xrayDate(result.startedAt),
    finish: xrayDate(result.finishedAt),
    status: STATUSES[result.outcome],
    ...(comment ? { comment } : {}),
    ...(evidence.length ? { evidence } : {}),
    ...(steps.length ? { steps } : {}),
  };
}

/**
 * Picks the evidence left out of the import: files Xray would reject on their own, then,
 * while the payload is over budget, the case recordings and finally the largest screenshots.
 */
function selectEvidence(results: readonly CaseRunResult[], warnings: string[]): Set<TestEvidence> {
  const dropped = new Set<TestEvidence>();
  const kept: { evidence: TestEvidence; key: string; caseLevel: boolean; size: number }[] = [];
  for (const result of results) {
    const key = result.testCase.caseId;
    const all = [
      ...result.attachments.map((evidence) => ({ evidence, caseLevel: true })),
      ...result.steps.flatMap((step) =>
        step.evidence.map((evidence) => ({ evidence, caseLevel: false })),
      ),
    ];
    for (const { evidence, caseLevel } of all) {
      if (evidence.content.byteLength > MAX_EVIDENCE_BYTES) {
        dropped.add(evidence);
        warnings.push(`${evidence.fileName} of ${key} is larger than 10 MB; it was not attached.`);
      } else {
        kept.push({
          evidence,
          key,
          caseLevel,
          size: Math.ceil(evidence.content.byteLength / 3) * 4,
        });
      }
    }
  }
  let total = kept.reduce((sum, item) => sum + item.size, 0);
  const candidates = kept.sort(
    (a, b) => Number(b.caseLevel) - Number(a.caseLevel) || b.size - a.size,
  );
  for (const item of candidates) {
    if (total <= MAX_PAYLOAD_BASE64) break;
    total -= item.size;
    dropped.add(item.evidence);
    warnings.push(
      `${item.evidence.fileName} of ${item.key} was not attached to keep the Xray import within its size limit.`,
    );
  }
  return dropped;
}

function toEvidence(evidence: TestEvidence): XrayEvidence {
  return {
    data: Buffer.from(evidence.content).toString('base64'),
    filename: evidence.fileName,
    contentType: evidence.contentType,
  };
}

function toStep(step: XrayStep | null, index: number): ExternalTestStep {
  const action = textOf(step?.action);
  const data = textOf(step?.data);
  return {
    id: textOf(step?.id) || String(index + 1),
    action: data ? `${action}\n${data}` : action,
    expectedResult: textOf(step?.result),
  };
}

/** Xray documents dates with an explicit offset, e.g. 2024-01-31T10:00:00+00:00. */
function xrayDate(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function issueKeyOf(jira: JiraFields | null | undefined): string | null {
  const key = textOf(jira?.key);
  return ISSUE_KEY.test(key) ? key : null;
}

function parseIssueKey(value: string | undefined, field: string): string {
  const key = value?.trim().toUpperCase() ?? '';
  if (!ISSUE_KEY.test(key))
    throw new ApplicationError('TEST_MANAGEMENT_INVALID_ID', `Invalid ${field}.`, 400, [{ field }]);
  return key;
}
