/**
 * Platform-neutral model of a test management run: which external test cases were executed,
 * how each step went and the evidence captured for it. Adapters translate it to the contract
 * of each platform (Azure Test Plans, TestRail, Xray...), so nothing here knows about them.
 */

export const TEST_MANAGEMENT_PROVIDERS = ['azure_devops', 'testrail', 'xray'] as const;
export type TestManagementProviderId = (typeof TEST_MANAGEMENT_PROVIDERS)[number];

export type TestOutcome = 'passed' | 'failed' | 'blocked' | 'not_executed';

/**
 * Where an external test case lives. The meaning of each level depends on the platform and
 * is described by the provider's capabilities (e.g. Azure: Test Plan / Suite; TestRail:
 * Project / Suite; Xray: Test Plan issue).
 */
export interface ExternalCaseLocation {
  readonly planId?: string;
  readonly suiteId?: string;
}

export interface ExternalTestStep {
  /** Identifier of the step on the platform; steps are matched to executions by position. */
  readonly id: string;
  readonly action: string;
  readonly expectedResult: string;
}

export interface ExternalTestCaseRef extends ExternalCaseLocation {
  readonly provider: TestManagementProviderId;
  readonly caseId: string;
}

export interface ExternalTestCase extends ExternalTestCaseRef {
  readonly title: string;
  readonly steps: readonly ExternalTestStep[];
  readonly description?: string;
  /** Every other field of the case on the platform (standard and custom), by field key. */
  readonly customFields?: Readonly<Record<string, CustomFieldValue>>;
  /** Display names of the keys in `customFields`; a key without a label is shown as is. */
  readonly customFieldLabels?: Readonly<Record<string, string>>;
  readonly url?: string;
}

export type CustomFieldValue = string | number | boolean | null;

export interface TestEvidence {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly description?: string;
}

export interface StepRunResult {
  /** Position of the step in the external case, starting at 1. */
  readonly position: number;
  readonly stepId: string;
  readonly action: string;
  readonly expectedResult: string;
  readonly outcome: TestOutcome;
  readonly actualResult: string | null;
  readonly durationMs: number;
  readonly evidence: readonly TestEvidence[];
}

export interface CaseRunResult {
  readonly testCase: ExternalTestCase;
  readonly outcome: TestOutcome;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly errorMessage: string | null;
  readonly comment: string | null;
  readonly steps: readonly StepRunResult[];
  /** Evidence of the whole execution, such as the recording. */
  readonly attachments: readonly TestEvidence[];
}

export interface TestRunReport {
  readonly name: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  /** Free text shown on the run, e.g. the tested URL and the browser. */
  readonly environment: string;
  readonly target: ExternalCaseLocation;
  readonly results: readonly CaseRunResult[];
}

export interface PublishedTestRun {
  readonly provider: TestManagementProviderId;
  readonly remoteRunId: string;
  readonly url: string | null;
  readonly publishedCases: number;
  readonly warnings: readonly string[];
}

export interface RemoteContainer {
  readonly id: string;
  readonly name: string;
  /** Parent container on platforms with nested levels (Azure suites); absent at the top. */
  readonly parentId?: string;
}

/** How a platform names its levels and what a run needs; drives pickers in the clients. */
export interface TestManagementCapabilities {
  readonly planLabel: string;
  /** Null when the platform has no second level. */
  readonly suiteLabel: string | null;
  readonly suiteRequired: boolean;
  readonly caseIdLabel: string;
  readonly stepEvidence: boolean;
}

/**
 * Flattens a platform field value for display and storage: people and options become their
 * name and lists are joined. Undefined when the value has no readable form (e.g. XML blobs
 * are strings and kept; nested structures without a name are dropped).
 */
export function customFieldValue(value: unknown): CustomFieldValue | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (Array.isArray(value)) {
    const items = value
      .map(customFieldValue)
      .filter((item) => item !== undefined && item !== null && item !== '');
    return items.length ? items.join(', ') : undefined;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['displayName', 'name', 'value', 'title', 'key'])
      if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return undefined;
}

export function isTestManagementProvider(value: string): value is TestManagementProviderId {
  return (TEST_MANAGEMENT_PROVIDERS as readonly string[]).includes(value);
}

/** The case outcome follows its steps: any failure fails it, a blocked step blocks it. */
export function aggregateOutcome(outcomes: readonly TestOutcome[]): TestOutcome {
  if (!outcomes.length) return 'not_executed';
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('blocked')) return 'blocked';
  if (outcomes.every((outcome) => outcome === 'passed')) return 'passed';
  return outcomes.includes('passed') ? 'blocked' : 'not_executed';
}

/** Readable duration such as "1m 32s"; TestRail requires this format. */
export function formatElapsed(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m${rest ? ` ${rest}s` : ''}` : `${rest}s`;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Rich-text fields (HTML) to the plain text used in prompts and step titles. */
export function htmlToText(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Line used for a step in plans and prompts: the action and what must be verified. */
export function describeStep(step: Pick<ExternalTestStep, 'action' | 'expectedResult'>): string {
  const action = step.action.replace(/\s+/g, ' ').trim();
  const expected = step.expectedResult.replace(/\s+/g, ' ').trim();
  return (expected ? `${action} => ${expected}` : action).slice(0, 1_000);
}
