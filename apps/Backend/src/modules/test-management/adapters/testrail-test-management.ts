import { ApplicationError } from '../../../shared/errors.js';
import type { TestManagementProvider } from '../application/test-management-provider.js';
import {
  customFieldValue,
  formatElapsed,
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
import { ProviderHttp, basicAuth, parsePositiveId } from './provider-http.js';

export interface TestRailTestManagementOptions {
  /** Instance URL, e.g. https://acme.testrail.io. */
  readonly baseUrl: string;
  /** TestRail user email. */
  readonly username: string;
  readonly apiKey: string;
  readonly fetcher?: typeof fetch;
  readonly retryDelayMs?: number;
}

export interface TestRailCase {
  readonly id?: number;
  readonly title?: string;
  readonly suite_id?: number;
  readonly custom_steps_separated?: readonly { content?: string; expected?: string }[] | null;
  readonly custom_steps?: string | null;
  readonly custom_expected?: string | null;
  /** Standard and `custom_*` fields, read into the case's custom fields. */
  readonly [field: string]: unknown;
}

interface TestRailField {
  readonly system_name?: string;
  readonly label?: string;
  readonly configs?: readonly { readonly options?: { readonly items?: string | null } }[];
}

/** Labels of the case fields and the names of their dropdown options, by field key. */
interface FieldCatalog {
  readonly labels: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, ReadonlyMap<number, string>>>;
}

/** Fields that hold the steps; they become the case's steps instead of custom fields. */
const STEP_FIELDS = new Set(['custom_steps_separated', 'custom_steps', 'custom_expected']);

/** Standard case fields shown with the custom ones. */
const STANDARD_FIELDS: Readonly<Record<string, string>> = {
  priority_id: 'Priority',
  type_id: 'Type',
  refs: 'References',
  estimate: 'Estimate',
  milestone_id: 'Milestone',
};

/** Bulk endpoints answer a plain array (older instances) or a page with a "next" link. */
type Page<T> =
  | readonly T[]
  | ({ readonly _links?: { readonly next?: string | null } } & Record<string, unknown>);

interface CaseGroup {
  readonly project: number;
  readonly suite?: number;
  readonly entries: { result: CaseRunResult; caseId: number }[];
}

const MAX_PAGES = 1_000;
const MAX_NAME = 250;

const CASE_STATUSES: Record<TestOutcome, number> = {
  passed: 1,
  blocked: 2,
  not_executed: 4, // Retest: the case still has to be run.
  failed: 5,
};

const STEP_STATUSES: Record<TestOutcome, number> = { ...CASE_STATUSES, not_executed: 3 };

/**
 * TestRail (API v2). Projects hold the cases, optionally split into suites; a run is created
 * per project and suite with only the executed cases, then each case gets one result whose
 * step results embed the screenshots uploaded to the run. The run is left open so testers
 * can complement it.
 */
export class TestRailTestManagementProvider implements TestManagementProvider {
  readonly id = 'testrail' as const;
  readonly name = 'TestRail';
  readonly capabilities = {
    planLabel: 'Project',
    suiteLabel: 'Suite',
    // Single-suite projects have no suite to pick; multi-suite ones are rejected by TestRail.
    suiteRequired: false,
    caseIdLabel: 'Case ID',
    stepEvidence: true,
  };
  private readonly http: ProviderHttp;
  private readonly baseUrl: string;
  private readonly authorization: string;
  private catalog: Promise<FieldCatalog> | undefined;

  constructor(options: TestRailTestManagementOptions) {
    this.http = new ProviderHttp('TestRail', options.fetcher, {
      retryDelayMs: options.retryDelayMs,
    });
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authorization = basicAuth(options.username, options.apiKey);
  }

  async listPlans(): Promise<readonly RemoteContainer[]> {
    const projects = await this.listAll<{ id?: number; name?: string }>(
      'get_projects&is_completed=0',
      'projects',
      'projects',
    );
    return containers(projects).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSuites(planId: string): Promise<readonly RemoteContainer[]> {
    const project = parsePositiveId(planId, 'planId');
    return containers(
      await this.listAll<{ id?: number; name?: string }>(
        `get_suites/${project}`,
        'suites',
        'suites',
      ),
    );
  }

  async listCases(location: ExternalCaseLocation): Promise<readonly ExternalTestCase[]> {
    const project = parsePositiveId(location.planId, 'planId');
    const suite = location.suiteId ? parsePositiveId(location.suiteId, 'suiteId') : undefined;
    const cases = (
      await this.listAll<TestRailCase>(
        `get_cases/${project}${suite ? `&suite_id=${suite}` : ''}`,
        'cases',
        'cases',
      )
    ).filter((item) => Number.isSafeInteger(item.id));
    const catalog = await this.catalogFor(cases);
    return cases.map((item) =>
      this.toCase(
        item,
        {
          planId: String(project),
          ...(suite ? { suiteId: String(suite) } : {}),
        },
        catalog,
      ),
    );
  }

  async getCase(ref: ExternalCaseLocation & { caseId: string }): Promise<ExternalTestCase> {
    const id = parseCaseId(ref.caseId);
    const item = await this.call<TestRailCase>('GET', `get_case/${id}`, 'case');
    if (!Number.isSafeInteger(item.id))
      throw new ApplicationError('TEST_MANAGEMENT_CASE_NOT_FOUND', 'Test case not found.', 404, [
        { provider: this.id, caseId: ref.caseId },
      ]);
    // TestRail cases do not carry their project, so the caller's location is kept.
    return this.toCase(
      item,
      {
        ...(ref.planId ? { planId: ref.planId } : {}),
        ...(ref.suiteId ? { suiteId: ref.suiteId } : {}),
      },
      await this.catalogFor([item]),
    );
  }

  /**
   * Field labels and option names, read once per adapter and only when a case has fields to
   * show. They are a nicety: when TestRail refuses them, raw keys and ids are shown instead.
   */
  private catalogFor(cases: readonly TestRailCase[]): Promise<FieldCatalog> {
    if (!cases.some((item) => Object.keys(item).some(isCaseField)))
      return Promise.resolve({ labels: {}, options: {} });
    const optional = <T>(path: string, stage: string) =>
      this.call<T[]>('GET', path, stage).then(
        (items) => (Array.isArray(items) ? items : []),
        () => [] as T[],
      );
    this.catalog ??= Promise.all([
      optional<TestRailField>('get_case_fields', 'case-fields'),
      optional<{ id?: number; name?: string }>('get_priorities', 'priorities'),
      optional<{ id?: number; name?: string }>('get_case_types', 'case-types'),
    ]).then(([fields, priorities, types]) => {
      const labels: Record<string, string> = { ...STANDARD_FIELDS };
      const options: Record<string, Map<number, string>> = {
        priority_id: named(priorities),
        type_id: named(types),
      };
      for (const field of fields) {
        if (!field.system_name) continue;
        if (field.label) labels[field.system_name] = field.label;
        const items = new Map<number, string>();
        for (const config of field.configs ?? [])
          for (const line of (config.options?.items ?? '').split('\n')) {
            const match = /^\s*(\d+)\s*,\s*(.+?)\s*$/.exec(line);
            if (match) items.set(Number(match[1]), match[2]!);
          }
        if (items.size) options[field.system_name] = items;
      }
      return { labels, options };
    });
    return this.catalog;
  }

  async publishRun(report: TestRunReport): Promise<PublishedTestRun> {
    const warnings: string[] = [];
    const groups = new Map<string, CaseGroup>();
    for (const result of report.results) {
      const { planId, suiteId, caseId } = result.testCase;
      if (!planId) {
        warnings.push(`Test case ${caseId} has no TestRail project; it was not published.`);
        continue;
      }
      const project = parsePositiveId(planId, 'planId');
      const suite = suiteId ? parsePositiveId(suiteId, 'suiteId') : undefined;
      const key = `${project}:${suite ?? ''}`;
      const group = groups.get(key) ?? { project, ...(suite ? { suite } : {}), entries: [] };
      group.entries.push({ result, caseId: parseCaseId(caseId) });
      groups.set(key, group);
    }
    const runs: { id: number; cases: number }[] = [];
    for (const group of groups.values())
      runs.push(await this.publishGroup(report, group, warnings));
    if (!runs.length)
      throw new ApplicationError(
        'TEST_RUN_NOTHING_TO_PUBLISH',
        'No result has a TestRail project.',
        400,
        [{ provider: this.id, warnings }],
      );
    return {
      provider: this.id,
      remoteRunId: runs.map((run) => run.id).join(','),
      url: `${this.baseUrl}/index.php?/runs/view/${runs[0]!.id}`,
      publishedCases: runs.reduce((sum, run) => sum + run.cases, 0),
      warnings,
    };
  }

  private async publishGroup(
    report: TestRunReport,
    group: CaseGroup,
    warnings: string[],
  ): Promise<{ id: number; cases: number }> {
    const run = await this.call<{ id?: number }>('POST', `add_run/${group.project}`, 'create-run', {
      ...(group.suite ? { suite_id: group.suite } : {}),
      name: report.name.slice(0, MAX_NAME),
      description: report.environment,
      include_all: false,
      case_ids: [...new Set(group.entries.map((entry) => entry.caseId))],
    });
    if (!Number.isSafeInteger(run.id))
      throw new ApplicationError(
        'TEST_MANAGEMENT_REQUEST_FAILED',
        'TestRail did not return the run id.',
        502,
        [{ provider: this.id, stage: 'create-run' }],
      );
    const runId = run.id!;

    // Screenshots go to the run first so each step result can reference them inline.
    const payload = [];
    for (const { result, caseId } of group.entries) {
      const steps = [];
      for (const step of result.steps) {
        const lines = step.actualResult ? [step.actualResult] : [];
        for (const evidence of step.evidence) {
          const attachment = await this.upload(
            `add_attachment_to_run/${runId}`,
            evidence,
            `run ${runId}`,
            warnings,
          );
          if (attachment !== undefined) lines.push(`![](index.php?/attachments/get/${attachment})`);
        }
        steps.push({
          content: step.action,
          expected: step.expectedResult,
          actual: lines.join('\n'),
          status_id: STEP_STATUSES[step.outcome],
        });
      }
      payload.push({
        case_id: caseId,
        status_id: CASE_STATUSES[result.outcome],
        comment: [result.comment, result.errorMessage].filter(Boolean).join('\n\n'),
        elapsed: formatElapsed(result.durationMs),
        custom_step_results: steps,
      });
    }
    const created = await this.call<unknown>(
      'POST',
      `add_results_for_cases/${runId}`,
      'add-results',
      { results: payload },
    );
    // Results come back in the order they were sent.
    const resultIds = Array.isArray(created)
      ? (created as { id?: number }[]).map((item) => item.id)
      : [];
    for (const [index, { result }] of group.entries.entries()) {
      const resultId = resultIds[index];
      for (const evidence of result.attachments) {
        if (!Number.isSafeInteger(resultId)) {
          warnings.push(`Could not attach ${evidence.fileName}: TestRail returned no result id.`);
          continue;
        }
        await this.upload(
          `add_attachment_to_result/${resultId}`,
          evidence,
          `result ${resultId}`,
          warnings,
        );
      }
    }
    return { id: runId, cases: group.entries.length };
  }

  /** Evidence is best effort: a rejected file is reported instead of failing the run. */
  private async upload(
    path: string,
    evidence: TestEvidence,
    target: string,
    warnings: string[],
  ): Promise<string | number | undefined> {
    const form = new FormData();
    form.append(
      'attachment',
      new Blob([new Uint8Array(evidence.content)], { type: evidence.contentType }),
      evidence.fileName,
    );
    try {
      const { attachment_id: id } = await this.call<{ attachment_id?: string | number }>(
        'POST',
        path,
        'attachment',
        form,
      );
      // Newer instances return string identifiers instead of numbers.
      if ((typeof id === 'number' && Number.isSafeInteger(id)) || (typeof id === 'string' && id))
        return id;
    } catch {
      // Reported below.
    }
    warnings.push(`Could not attach ${evidence.fileName} to ${target}.`);
    return undefined;
  }

  private toCase(
    item: TestRailCase,
    location: ExternalCaseLocation,
    catalog: FieldCatalog,
  ): ExternalTestCase {
    const suiteId = Number.isSafeInteger(item.suite_id) ? String(item.suite_id) : location.suiteId;
    const customFields: Record<string, CustomFieldValue> = {};
    for (const [key, raw] of Object.entries(item)) {
      if (!isCaseField(key)) continue;
      const names = catalog.options[key];
      const value = customFieldValue(
        names
          ? Array.isArray(raw)
            ? (raw as unknown[]).map((entry) => names.get(Number(entry)) ?? entry)
            : (names.get(Number(raw)) ?? raw)
          : raw,
      );
      if (value !== undefined) customFields[key] = value;
    }
    const labels = Object.fromEntries(
      Object.keys(customFields).flatMap((key) =>
        catalog.labels[key] ? [[key, catalog.labels[key]]] : [],
      ),
    );
    return {
      provider: this.id,
      caseId: String(item.id),
      ...location,
      ...(suiteId ? { suiteId } : {}),
      title: item.title?.trim() || `Case C${item.id}`,
      steps: testRailSteps(item),
      ...(Object.keys(customFields).length ? { customFields, customFieldLabels: labels } : {}),
      url: `${this.baseUrl}/index.php?/cases/view/${item.id}`,
    };
  }

  /** Follows "_links.next" (a path relative to index.php?) until the last page. */
  private async listAll<T>(path: string, key: string, stage: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>([path]);
    let next: string | undefined = path;
    while (next) {
      const page: Page<T> = await this.call<Page<T>>('GET', next, stage);
      if (Array.isArray(page)) {
        items.push(...(page as readonly T[]));
        break;
      }
      const record = page as Exclude<Page<T>, readonly T[]>;
      const values = record[key];
      if (Array.isArray(values)) items.push(...(values as T[]));
      const link = record._links?.next;
      next = typeof link === 'string' && link ? link.replace(/^\/*api\/v2\//, '') : undefined;
      if (next && (seen.has(next) || seen.size >= MAX_PAGES))
        throw new ApplicationError(
          'TEST_MANAGEMENT_REQUEST_FAILED',
          'TestRail pagination did not advance.',
          502,
          [{ provider: this.id, stage }],
        );
      if (next) seen.add(next);
    }
    return items;
  }

  private call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    stage: string,
    body?: unknown,
  ): Promise<T> {
    return this.http.json<T>(`${this.baseUrl}/index.php?/api/v2/${path}`, {
      method,
      stage,
      body,
      headers: { authorization: this.authorization },
    });
  }
}

function isCaseField(key: string): boolean {
  return (key.startsWith('custom_') && !STEP_FIELDS.has(key)) || key in STANDARD_FIELDS;
}

function named(items: readonly { id?: number; name?: string }[]): Map<number, string> {
  return new Map(
    items.flatMap((item) =>
      Number.isSafeInteger(item.id) && item.name ? [[item.id!, item.name]] : [],
    ),
  );
}

function containers(items: readonly { id?: number; name?: string }[]): RemoteContainer[] {
  return items
    .filter((item) => Number.isSafeInteger(item.id) && typeof item.name === 'string')
    .map((item) => ({ id: String(item.id), name: item.name! }));
}

/** TestRail shows case ids as "C123"; both forms are accepted. */
export function parseCaseId(value: string | undefined): number {
  return parsePositiveId(value?.trim().replace(/^c/i, ''), 'caseId');
}

/**
 * Steps of the "Test Case (Steps)" template, or the single text block of the "Test Case
 * (Text)" template. Step ids are positions in TestRail's list, starting at 1.
 */
export function testRailSteps(item: TestRailCase): ExternalTestStep[] {
  const separated = item.custom_steps_separated;
  if (separated?.length)
    return separated
      .map((step, index) => ({
        id: String(index + 1),
        action: htmlToText(step.content ?? ''),
        expectedResult: htmlToText(step.expected ?? ''),
      }))
      .filter((step) => step.action || step.expectedResult);
  const action = htmlToText(item.custom_steps ?? '');
  const expectedResult = htmlToText(item.custom_expected ?? '');
  return action || expectedResult ? [{ id: '1', action, expectedResult }] : [];
}
