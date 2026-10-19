import { ApplicationError } from '../../../shared/errors.js';
import type { TestManagementProvider } from '../application/test-management-provider.js';
import {
  customFieldValue,
  decodeEntities,
  htmlToText,
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
import { ProviderHttp, parsePositiveId, type HttpMethod } from './provider-http.js';

export interface AzureTestManagementOptions {
  /** Organization URL, e.g. https://dev.azure.com/contoso. */
  readonly organizationUrl: string;
  readonly project: string;
  /** Personal access token, or a full "Basic ..." / "Bearer ..." header value. */
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly retryDelayMs?: number;
}

interface WorkItem {
  readonly id?: number;
  readonly fields?: Record<string, unknown>;
}

interface TestPoint {
  readonly id?: number;
  readonly testCaseReference?: { readonly id?: number };
}

interface RunResult {
  readonly id?: number;
  readonly testCase?: { readonly id?: string | number };
  readonly testPoint?: { readonly id?: string | number };
}

const API_VERSION = '7.1';
/** The attachments API is still a preview in Azure DevOps Services. */
const ATTACHMENT_API_VERSION = '7.1-preview.1';
const BATCH_SIZE = 200;
const MAX_PAGES = 1_000;
const MAX_ERROR = 4_000;

/** Fields that are part of the case itself (title, description and steps). */
const CASE_FIELDS = new Set([
  'System.Id',
  'System.Title',
  'System.Description',
  'Microsoft.VSTS.TCM.Steps',
]);

/** Bookkeeping and raw XML fields that mean nothing to a tester. */
const INTERNAL_FIELDS = new Set([
  'System.Rev',
  'System.Watermark',
  'System.AuthorizedDate',
  'System.RevisedDate',
  'System.AuthorizedAs',
  'System.PersonId',
  'System.CommentCount',
  'System.WorkItemType',
  'System.TeamProject',
  'System.AreaId',
  'System.IterationId',
  'System.NodeName',
  'System.BoardColumnDone',
  'Microsoft.VSTS.TCM.Parameters',
  'Microsoft.VSTS.TCM.LocalDataSource',
]);

const OUTCOMES: Record<TestOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  not_executed: 'NotExecuted',
};

/**
 * Azure Test Plans. Cases are "Test Case" work items whose steps are stored as XML; a run is
 * created from the cases' test points, then every result gets one iteration whose action
 * results mirror the case steps, with each step's screenshot attached to it.
 */
export class AzureTestManagementProvider implements TestManagementProvider {
  readonly id = 'azure_devops' as const;
  readonly name = 'Azure DevOps Test Plans';
  readonly capabilities = {
    planLabel: 'Test Plan',
    suiteLabel: 'Suite',
    suiteRequired: true,
    caseIdLabel: 'Test Case ID',
    stepEvidence: true,
  };
  private readonly http: ProviderHttp;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private labels: Promise<Readonly<Record<string, string>>> | undefined;

  constructor(options: AzureTestManagementOptions) {
    this.http = new ProviderHttp('Azure DevOps', options.fetcher, {
      retryDelayMs: options.retryDelayMs,
    });
    this.baseUrl = `${options.organizationUrl.replace(/\/+$/, '')}/${encodeURIComponent(options.project)}`;
    this.authorization = /^(Basic|Bearer) /.test(options.token)
      ? options.token
      : `Basic ${Buffer.from(`:${options.token}`).toString('base64')}`;
  }

  async listPlans(): Promise<readonly RemoteContainer[]> {
    const plans = await this.listAll<{ id?: number; name?: string }>('testplan/plans', 'plans');
    return containers(plans).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSuites(planId: string): Promise<readonly RemoteContainer[]> {
    const plan = parsePositiveId(planId, 'planId');
    const suites = await this.listAll<{
      id?: number;
      name?: string;
      parentSuite?: { id?: number } | null;
    }>(`testplan/Plans/${plan}/suites`, 'suites');
    const parents = new Map(
      suites.flatMap((suite) =>
        Number.isSafeInteger(suite.parentSuite?.id) ? [[suite.id, suite.parentSuite!.id!]] : [],
      ),
    );
    return containers(suites).map((suite) => {
      const parent = parents.get(Number(suite.id));
      return parent === undefined ? suite : { ...suite, parentId: String(parent) };
    });
  }

  async listCases(location: ExternalCaseLocation): Promise<readonly ExternalTestCase[]> {
    const plan = parsePositiveId(location.planId, 'planId');
    const suite = parsePositiveId(location.suiteId, 'suiteId');
    const entries = await this.listAll<{ workItem?: { id?: number } }>(
      `testplan/Plans/${plan}/Suites/${suite}/TestCase`,
      'suite-cases',
    );
    const ids = entries
      .map((entry) => entry.workItem?.id)
      .filter((id): id is number => Number.isSafeInteger(id));
    const [items, labels] = await Promise.all([this.workItems(ids), this.fieldLabels()]);
    return items.map((item) =>
      this.toCase(item, { planId: String(plan), suiteId: String(suite) }, labels),
    );
  }

  async getCase(ref: ExternalCaseLocation & { caseId: string }): Promise<ExternalTestCase> {
    const id = parsePositiveId(ref.caseId, 'caseId');
    const [[item], labels] = await Promise.all([this.workItems([id]), this.fieldLabels()]);
    if (!item)
      throw new ApplicationError('TEST_MANAGEMENT_CASE_NOT_FOUND', 'Test case not found.', 404, [
        { provider: this.id, caseId: ref.caseId },
      ]);
    return this.toCase(
      item,
      {
        ...(ref.planId ? { planId: ref.planId } : {}),
        ...(ref.suiteId ? { suiteId: ref.suiteId } : {}),
      },
      labels,
    );
  }

  /**
   * Display names of the project's work item fields, read once per adapter. Labels are a
   * nicety: when they cannot be read the reference names are shown instead.
   */
  private fieldLabels(): Promise<Readonly<Record<string, string>>> {
    this.labels ??= this.call<{ value?: { referenceName?: string; name?: string }[] }>(
      'GET',
      'wit/fields',
      'fields',
    ).then(
      (data) =>
        Object.fromEntries(
          (data.value ?? []).flatMap((field) =>
            field.referenceName && field.name ? [[field.referenceName, field.name]] : [],
          ),
        ),
      () => ({}),
    );
    return this.labels;
  }

  async publishRun(report: TestRunReport): Promise<PublishedTestRun> {
    const warnings: string[] = [];
    const byPlan = new Map<number, CaseRunResult[]>();
    for (const result of report.results) {
      const { planId, suiteId, caseId } = result.testCase;
      if (!planId || !suiteId) {
        warnings.push(`Test case ${caseId} has no Test Plan and suite; it was not published.`);
        continue;
      }
      const plan = parsePositiveId(planId, 'planId');
      byPlan.set(plan, [...(byPlan.get(plan) ?? []), result]);
    }
    const runs: { id: number; cases: number }[] = [];
    for (const [plan, results] of byPlan) {
      const run = await this.publishPlanRun(report, plan, results, warnings);
      if (run) runs.push(run);
    }
    if (!runs.length)
      throw new ApplicationError(
        'TEST_RUN_NOTHING_TO_PUBLISH',
        'No result could be matched to a test point.',
        400,
        [{ provider: this.id, warnings }],
      );
    return {
      provider: this.id,
      remoteRunId: runs.map((run) => run.id).join(','),
      url: `${this.baseUrl}/_testManagement/runs?_a=runCharts&runId=${runs[0]!.id}`,
      publishedCases: runs.reduce((sum, run) => sum + run.cases, 0),
      warnings,
    };
  }

  private async publishPlanRun(
    report: TestRunReport,
    plan: number,
    results: readonly CaseRunResult[],
    warnings: string[],
  ): Promise<{ id: number; cases: number } | null> {
    const points = new Map<string, number>();
    for (const suite of new Set(results.map((result) => result.testCase.suiteId!))) {
      const suiteId = parsePositiveId(suite, 'suiteId');
      for (const point of await this.listAll<TestPoint>(
        `testplan/Plans/${plan}/Suites/${suiteId}/TestPoint`,
        'test-points',
      )) {
        const key = `${suiteId}:${point.testCaseReference?.id}`;
        if (Number.isSafeInteger(point.id) && !points.has(key)) points.set(key, point.id!);
      }
    }
    const matched = results.flatMap((result) => {
      const point = points.get(`${result.testCase.suiteId}:${result.testCase.caseId}`);
      if (point === undefined) {
        warnings.push(
          `Test case ${result.testCase.caseId} has no test point in suite ${result.testCase.suiteId}; it was not published.`,
        );
        return [];
      }
      return [{ result, point }];
    });
    if (!matched.length) return null;

    const run = await this.call<{ id?: number }>('POST', 'test/runs', 'create-run', {
      name: report.name.slice(0, 256),
      plan: { id: String(plan) },
      pointIds: matched.map((entry) => entry.point),
      automated: false,
      state: 'InProgress',
      startDate: report.startedAt.toISOString(),
      comment: report.environment.slice(0, 1_000),
    });
    if (!Number.isSafeInteger(run.id))
      throw new ApplicationError(
        'TEST_MANAGEMENT_REQUEST_FAILED',
        'Azure DevOps did not return the run id.',
        502,
        [{ provider: this.id, stage: 'create-run' }],
      );
    const runId = run.id!;
    const created = await this.call<{ value?: RunResult[] }>(
      'GET',
      `test/runs/${runId}/results`,
      'run-results',
    );
    const resultIds = new Map<number, number>();
    for (const item of created.value ?? []) {
      const point = Number(item.testPoint?.id);
      if (Number.isSafeInteger(item.id) && Number.isSafeInteger(point))
        resultIds.set(point, item.id!);
    }
    const updates = matched.flatMap(({ result, point }) => {
      const id = resultIds.get(point);
      if (id === undefined)
        warnings.push(
          `Test case ${result.testCase.caseId} has no result in run ${runId}; it was not published.`,
        );
      return id === undefined ? [] : [{ id, result }];
    });
    if (updates.length)
      await this.call(
        'PATCH',
        `test/runs/${runId}/results`,
        'update-results',
        updates.map(({ id, result }) => resultPayload(id, result)),
      );
    for (const { id, result } of updates) {
      for (const step of result.steps) {
        const actionPath = actionPathOf(step.stepId);
        for (const evidence of step.evidence)
          await this.attach(runId, id, evidence, warnings, actionPath);
      }
      for (const evidence of result.attachments) await this.attach(runId, id, evidence, warnings);
    }
    await this.call('PATCH', `test/runs/${runId}`, 'complete-run', {
      state: 'Completed',
      completedDate: report.finishedAt.toISOString(),
    });
    return updates.length ? { id: runId, cases: updates.length } : null;
  }

  /** Evidence is best effort: a rejected file is reported instead of failing the run. */
  private async attach(
    runId: number,
    resultId: number,
    evidence: TestEvidence,
    warnings: string[],
    actionPath?: string,
  ): Promise<void> {
    const query: Record<string, string> = actionPath ? { iterationId: '1', actionPath } : {};
    try {
      await this.call(
        'POST',
        `${actionPath ? 'testresults' : 'test'}/runs/${runId}/results/${resultId}/attachments`,
        'attachment',
        {
          stream: Buffer.from(evidence.content).toString('base64'),
          fileName: evidence.fileName,
          comment: evidence.description ?? '',
          attachmentType: 'GeneralAttachment',
        },
        query,
        actionPath ? ATTACHMENT_API_VERSION : API_VERSION,
      );
    } catch {
      warnings.push(`Could not attach ${evidence.fileName} to result ${resultId}.`);
    }
  }

  private toCase(
    item: WorkItem,
    location: ExternalCaseLocation,
    labels: Readonly<Record<string, string>> = {},
  ): ExternalTestCase {
    const fields = item.fields ?? {};
    const title = typeof fields['System.Title'] === 'string' ? fields['System.Title'] : '';
    const steps = fields['Microsoft.VSTS.TCM.Steps'];
    const customFields: Record<string, CustomFieldValue> = {};
    for (const [key, raw] of Object.entries(fields)) {
      if (CASE_FIELDS.has(key) || INTERNAL_FIELDS.has(key)) continue;
      const value = customFieldValue(raw);
      if (value !== undefined) customFields[key] = value;
    }
    return {
      provider: this.id,
      caseId: String(item.id),
      ...location,
      title: title.trim() || `Test Case ${item.id}`,
      description:
        typeof fields['System.Description'] === 'string' ? fields['System.Description'] : '',
      customFields,
      customFieldLabels: Object.fromEntries(
        Object.keys(customFields).flatMap((key) => (labels[key] ? [[key, labels[key]]] : [])),
      ),
      steps: typeof steps === 'string' ? parseAzureSteps(steps) : [],
      url: `${this.baseUrl}/_workitems/edit/${item.id}`,
    };
  }

  private async workItems(ids: readonly number[]): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    for (let index = 0; index < ids.length; index += BATCH_SIZE) {
      const page = await this.call<{ value?: WorkItem[] }>(
        'POST',
        'wit/workitemsbatch',
        'work-items',
        {
          ids: ids.slice(index, index + BATCH_SIZE),
          errorPolicy: 'omit',
        },
      );
      items.push(
        ...(page.value ?? []).filter((item): item is WorkItem =>
          Boolean(item && Number.isSafeInteger(item.id)),
        ),
      );
    }
    return items;
  }

  private async listAll<T>(path: string, stage: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let continuationToken: string | undefined;
    do {
      const { data, headers } = await this.http.request<{ value?: T[] }>(
        this.url(path, continuationToken ? { continuationToken } : {}),
        { headers: { authorization: this.authorization }, stage },
      );
      items.push(...(Array.isArray(data.value) ? data.value : []));
      continuationToken = headers.get('x-ms-continuationtoken') || undefined;
      if (continuationToken && (seen.has(continuationToken) || seen.size >= MAX_PAGES))
        throw new ApplicationError(
          'TEST_MANAGEMENT_REQUEST_FAILED',
          'Azure DevOps pagination did not advance.',
          502,
          [{ provider: this.id, stage }],
        );
      if (continuationToken) seen.add(continuationToken);
    } while (continuationToken);
    return items;
  }

  private call<T = unknown>(
    method: HttpMethod,
    path: string,
    stage: string,
    body?: unknown,
    query: Readonly<Record<string, string>> = {},
    apiVersion = API_VERSION,
  ): Promise<T> {
    return this.http.json<T>(this.url(path, query, apiVersion), {
      method,
      stage,
      body,
      headers: { authorization: this.authorization },
    });
  }

  private url(path: string, query: Readonly<Record<string, string>>, apiVersion = API_VERSION) {
    const url = new URL(`${this.baseUrl}/_apis/${path}`);
    // Iteration attachments live on the Test Results service, which has its own Azure host.
    if (path.startsWith('testresults/') && url.hostname === 'dev.azure.com')
      url.hostname = 'vstmr.dev.azure.com';
    url.searchParams.set('api-version', apiVersion);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url;
  }
}

function containers(items: readonly { id?: number; name?: string }[]): RemoteContainer[] {
  return items
    .filter((item) => Number.isSafeInteger(item.id) && typeof item.name === 'string')
    .map((item) => ({ id: String(item.id), name: item.name! }));
}

function resultPayload(id: number, result: CaseRunResult) {
  const started = result.startedAt.toISOString();
  const completed = result.finishedAt.toISOString();
  const errorMessage = result.errorMessage?.slice(0, MAX_ERROR);
  return {
    id,
    state: 'Completed',
    outcome: OUTCOMES[result.outcome],
    startedDate: started,
    completedDate: completed,
    durationInMs: result.durationMs,
    ...(errorMessage ? { errorMessage } : {}),
    ...(result.comment ? { comment: result.comment.slice(0, 1_000) } : {}),
    iterationDetails: [
      {
        id: 1,
        outcome: OUTCOMES[result.outcome],
        startedDate: started,
        completedDate: completed,
        durationInMs: result.durationMs,
        ...(errorMessage ? { errorMessage } : {}),
        actionResults: result.steps.map((step) => ({
          actionPath: actionPathOf(step.stepId),
          iterationId: 1,
          stepIdentifier: step.stepId,
          outcome: OUTCOMES[step.outcome],
          durationInMs: step.durationMs,
          ...(step.actualResult ? { errorMessage: step.actualResult.slice(0, MAX_ERROR) } : {}),
        })),
      },
    ],
  };
}

/** Azure identifies a step result by the step id in hexadecimal, padded to 8 digits. */
export function actionPathOf(stepId: string): string {
  return Number(stepId).toString(16).padStart(8, '0');
}

/**
 * Reads the steps of a Test Case (Microsoft.VSTS.TCM.Steps). Each step holds two
 * parameterized strings (action and expected result) whose content is escaped HTML.
 * Shared steps (compref) live in other work items and are left out.
 */
export function parseAzureSteps(xml: string): ExternalTestStep[] {
  const withoutShared = xml
    .replace(/<compref\b[^>]*\/>/g, '')
    .replace(/<compref\b[^>]*>[\s\S]*?<\/compref>/g, '');
  const steps: ExternalTestStep[] = [];
  for (const match of withoutShared.matchAll(/<step\b([^>]*)>([\s\S]*?)<\/step>/g)) {
    const id = /\bid="(\d+)"/.exec(match[1]!)?.[1];
    if (!id) continue;
    // Self-closing strings first: otherwise "[^>]*" takes their "/" and the match runs into
    // the next string, shifting the expected result into the action.
    const texts = [
      ...match[2]!.matchAll(
        /<parameterizedString\b[^>]*\/>|<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/g,
      ),
    ].map((part) => htmlToText(decodeEntities(part[1] ?? '')));
    steps.push({ id, action: texts[0] ?? '', expectedResult: texts[1] ?? '' });
  }
  return steps.filter((step) => step.action || step.expectedResult);
}
