export type E2eMode = 'frontend' | 'backend';
export type E2eScope = 'codebase' | 'diff';
export type E2eCreationStatus =
  'draft' | 'queued' | 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
export type E2eTestStatus =
  'pending' | 'generating' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type E2ePriority = 'high' | 'medium' | 'low';
export type E2eVerdict = 'app_bug' | 'test_issue' | 'environment';
export type E2eRepositoryProvider = 'github' | 'azure_devops';
export type TestManagementProviderId = 'azure_devops' | 'testrail' | 'xray';
export type E2eReportStatus = 'publishing' | 'published' | 'failed';

/** How a test management platform names its levels; drives the plan/suite pickers. */
export interface TestManagementCapabilities {
  readonly planLabel: string;
  /** Null when the platform has no second level (e.g. Xray). */
  readonly suiteLabel: string | null;
  readonly suiteRequired: boolean;
  readonly caseIdLabel: string;
  readonly stepEvidence: boolean;
}

export interface TestManagementProvider {
  readonly id: TestManagementProviderId;
  readonly name: string;
  readonly configured: boolean;
  readonly capabilities: TestManagementCapabilities;
}

/** A plan or suite on a test management platform. */
export interface RemoteContainer {
  readonly id: string;
  readonly name: string;
  /** Parent container on platforms with nested levels (Azure suites). */
  readonly parentId?: string;
}

export interface ExternalTestStep {
  readonly id: string;
  readonly action: string;
  readonly expectedResult: string;
}

export interface ExternalCaseRef {
  readonly provider: TestManagementProviderId;
  readonly caseId: string;
  readonly planId?: string;
  readonly suiteId?: string;
}

export interface ExternalTestCase extends ExternalCaseRef {
  readonly title: string;
  readonly url?: string;
  readonly steps: readonly ExternalTestStep[];
  readonly description?: string;
  /** Standard and custom fields of the case on the platform, by field key. */
  readonly customFields?: Readonly<Record<string, string | number | boolean | null>>;
  readonly customFieldLabels?: Readonly<Record<string, string>>;
}

/** Test cases saved in ADK to automate: a suite (with its children) or a Test Plan. */
export interface E2eSavedCasesInput {
  readonly suiteId?: string;
  readonly planId?: string;
  /** Local case ids (metadata.caseId); every case of the suite or plan when absent. */
  readonly caseIds?: readonly string[];
}

/** Test management cases to automate: a plan/suite and, optionally, only some of its cases. */
export interface E2eImportCasesInput {
  readonly provider: TestManagementProviderId;
  readonly planId?: string;
  readonly suiteId?: string;
  readonly caseIds?: readonly string[];
}

/** Platform that receives the run's results. */
export interface E2eReporting {
  readonly provider: TestManagementProviderId;
  readonly planId: string | null;
  readonly suiteId: string | null;
  /** Publishes automatically whenever a run of the tests finishes. */
  readonly autoPublish: boolean;
}

export interface E2eReportingInput {
  readonly provider: TestManagementProviderId;
  readonly planId?: string | null;
  readonly suiteId?: string | null;
  readonly autoPublish?: boolean;
}

/** Outcome of the latest publication of the run's results. */
export interface E2eLastReport {
  readonly status: E2eReportStatus;
  readonly provider: TestManagementProviderId;
  readonly remoteRunId: string | null;
  readonly url: string | null;
  readonly publishedCases: number;
  readonly warnings: readonly string[];
  readonly error: string | null;
  readonly updatedAt: string;
}

/** One top-level `test.step` of the latest execution of a test. */
export interface E2eStepResult {
  readonly position: number;
  readonly title: string;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly error: string | null;
  readonly hasScreenshot: boolean;
}

export interface E2eRepositoryRef {
  readonly provider: E2eRepositoryProvider;
  readonly id: string;
  /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
  readonly name: string;
  readonly branch: string;
  readonly path: string;
}

export interface E2eRepository {
  readonly id: string;
  readonly provider: E2eRepositoryProvider;
  readonly name: string;
  readonly defaultBranch: string;
  readonly webUrl?: string;
}

export interface E2eRepositoryWarning {
  readonly provider: E2eRepositoryProvider;
  readonly code: 'CREDENTIALS_MISSING' | 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE';
}

export interface E2eBranch {
  readonly name: string;
  readonly isDefault: boolean;
}

export interface E2eScript {
  readonly path: string;
  readonly content: string | null;
  readonly url: string | null;
  readonly repository: E2eRepositoryRef;
}

export interface E2ePullResult {
  readonly linked: number;
  readonly imported: number;
  readonly missing: number;
}

/** Where the browser runs: the ADK servers, or the user's computer through `devkit runner`. */
export type E2eExecutionTarget = 'remote' | 'local';

/** A computer running `devkit runner` for the signed-in user. */
export interface E2eLocalRunner {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
  readonly lastSeenAt: string;
  readonly online: boolean;
}

export interface E2eTestSummary {
  readonly id: string;
  readonly creationId: string;
  readonly position: number;
  readonly code: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly string[];
  readonly priority: E2ePriority;
  /** Spec file in the run's repository; null until the AI writes it. */
  readonly scriptPath: string | null;
  readonly status: E2eTestStatus;
  readonly error: string | null;
  readonly analysis: string | null;
  readonly verdict: E2eVerdict | null;
  readonly durationMs: number | null;
  /** Computer of the local runner that produced the latest result; null on the ADK servers. */
  readonly executedOn?: string | null;
  readonly attempts: number;
  readonly hasVideo: boolean;
  /** Test management case this test automates. */
  readonly externalCase: ExternalTestCase | null;
  /** Steps of the latest execution, with their evidence. */
  readonly stepResults: readonly E2eStepResult[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt: string | null;
}

export interface E2eTestDetail extends E2eTestSummary {
  readonly logs: string | null;
  readonly creation: {
    readonly id: string;
    readonly name: string;
    readonly mode: E2eMode;
    readonly baseUrl: string;
    readonly localOrigin?: string | null;
    readonly path: string;
    readonly status: E2eCreationStatus;
  };
}

export interface E2eCreationSummary {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly mode: E2eMode;
  readonly scope: E2eScope;
  readonly baseUrl: string;
  readonly localOrigin?: string | null;
  readonly executionTarget?: E2eExecutionTarget;
  readonly path: string;
  readonly username: string | null;
  readonly hasPassword: boolean;
  readonly hasAccessServiceToken?: boolean;
  readonly prdFileNames: readonly string[];
  /** Null only for runs created before scripts moved to repositories. */
  readonly repository: E2eRepositoryRef | null;
  /** Test management platform that receives the results; null when not reported. */
  readonly reporting: E2eReporting | null;
  readonly lastReport: E2eLastReport | null;
  readonly status: E2eCreationStatus;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly passed: number;
  readonly total: number;
  readonly tests: readonly E2eTestSummary[];
}

/** A single run as returned by its own endpoint, with the documents used to plan it. */
export interface E2eCreationDetail extends Omit<E2eCreationSummary, 'passed' | 'total'> {
  readonly prd: string;
  readonly diff: string | null;
  readonly instructions: string | null;
}

/** A run as returned by its mutations (reporting, import, publish): without its tests. */
export type E2eCreationView = Omit<E2eCreationDetail, 'tests'>;

export interface E2eImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly creation: E2eCreationView;
}

export interface E2eCreationInput {
  readonly name: string;
  readonly agentId: string;
  readonly mode: E2eMode;
  readonly scope: E2eScope;
  readonly baseUrl: string;
  readonly localOrigin?: string;
  readonly executionTarget?: E2eExecutionTarget;
  readonly path?: string;
  readonly username?: string;
  readonly password?: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  readonly clearAccessServiceToken?: boolean;
  /** May be empty when the run automates imported test cases. */
  readonly prd: string;
  readonly prdFileNames?: readonly string[];
  readonly diff?: string;
  readonly instructions?: string;
  /** Automates these test management cases instead of planning tests from the PRD. */
  readonly importCases?: E2eImportCasesInput;
  /** Automates test cases saved in ADK (a suite, a Test Plan or chosen cases). */
  readonly savedCases?: E2eSavedCasesInput;
  readonly reporting?: E2eReportingInput | null;
  readonly repository: {
    readonly provider: E2eRepositoryProvider;
    readonly id: string;
    readonly branch: string;
    readonly path: string;
  };
}

export const ACTIVE_CREATION_STATUSES: readonly E2eCreationStatus[] = [
  'queued',
  'planning',
  'running',
];
export const ACTIVE_TEST_STATUSES: readonly E2eTestStatus[] = ['pending', 'generating', 'running'];

export function isQuickTunnelUrl(value: string): boolean {
  try {
    return new URL(value.trim()).hostname.endsWith('.trycloudflare.com');
  } catch {
    return false;
  }
}

export function isCreationActive(status: E2eCreationStatus): boolean {
  return ACTIVE_CREATION_STATUSES.includes(status);
}

/** Removes execution paths and infrastructure details from text shown in the test UI. */
export function safeE2eOutput(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .map((line) =>
      line
        .replace(/\/app\/(?:\.e2e-workspaces|node_modules)\/[^\s)]+/gi, '[test runtime]')
        .replace(/\b[a-z0-9.-]+\.railway\.(?:app|internal)\b/gi, '[service address]')
        .replace(/\b[A-Z]:\\[^\s)]+/gi, '[local path]')
        .replace(/\bRailway\b/gi, 'test environment')
        .replace(/Cloudflare Access/gi, 'tunnel authentication')
        .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, '[connection details hidden]'),
    )
    .join('\n')
    .trim();
}

/** Runs and publications of their results both settle on the worker, so both are polled. */
export function needsPolling(creation: Pick<E2eCreationSummary, 'status' | 'lastReport'>): boolean {
  return isCreationActive(creation.status) || creation.lastReport?.status === 'publishing';
}

/** Product names, for runs whose provider list has not been loaded. */
export const TEST_MANAGEMENT_NAMES: Record<TestManagementProviderId, string> = {
  azure_devops: 'Azure Test Plans',
  testrail: 'TestRail',
  xray: 'Xray Cloud',
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Default folder for a run's specs, derived from its name. */
export function suggestedScriptFolder(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return slug ? `tests/e2e/${slug}` : 'tests/e2e';
}
