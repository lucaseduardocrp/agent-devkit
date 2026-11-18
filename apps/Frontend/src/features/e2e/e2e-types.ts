import { getMessages } from '../../lib/i18n/index.js';

export type E2eMode = 'frontend' | 'backend';
export type E2eScope = 'codebase' | 'diff';
export type E2eCreationStatus =
  'draft' | 'queued' | 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
export type E2eTestStatus =
  'pending' | 'generating' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type E2ePriority = 'high' | 'medium' | 'low';
export type E2eVerdict = 'app_bug' | 'test_issue' | 'environment';
/** Who decided the status of a test: the run, the user's success criteria, or the user by hand. */
export type E2eResultSource = 'run' | 'criteria' | 'manual';
/** What the user can decide about a finished test; "run" gives back the status the run produced. */
export type E2eResultDecision = 'passed' | 'failed' | 'run';
/** `local` is a project folder of this computer, available in the desktop app. */
export type E2eRepositoryProvider = 'github' | 'azure_devops' | 'local';
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
  /** The user's own verdict on this step; it overrules `status` until the next execution. */
  readonly manualStatus?: 'passed' | 'failed';
  /** Why the user decided the step by hand. */
  readonly manualNote?: string | null;
}

/** What a step counts as: the user's verdict when there is one, the run's otherwise. */
export function effectiveStepStatus(
  step: Pick<E2eStepResult, 'status' | 'manualStatus'>,
): E2eStepResult['status'] {
  return step.manualStatus ?? step.status;
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
  readonly code:
    'CREDENTIALS_MISSING' | 'CREDENTIALS_UNREADABLE' | 'NOT_CONFIGURED' | 'PROVIDER_UNAVAILABLE';
}

export interface E2eBranch {
  readonly name: string;
  readonly isDefault: boolean;
}

/**
 * The scripts of a test: its spec, the Before Run that prepares its preconditions and the
 * After Run that removes what it left behind.
 */
export type E2eScriptKind = 'spec' | 'beforeRun' | 'afterRun';

export interface E2eScript {
  readonly kind: E2eScriptKind;
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

/** Test case saved in ADK (Test Plans) a test is linked to. */
export interface E2eSavedCaseLink {
  readonly planId: string;
  readonly caseId: string;
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
  /** Feature area the test belongs to; groups the tests of a run. */
  readonly category?: string | null;
  /** Spec file in the run's repository; null until the AI writes it. */
  readonly scriptPath: string | null;
  /** What the user tells the AI about how to write the Before Run; rich text. */
  readonly beforeRunInstructions: string | null;
  readonly afterRunInstructions: string | null;
  /** What the user told the AI about how to write the spec; kept for every rewrite. */
  readonly scriptInstructions: string | null;
  /** How the user decides this test passes; the spec asserts it and a run that meets it passes. */
  readonly successCriteria?: string | null;
  /** Who decided `status`; absent on servers that predate success criteria. */
  readonly resultSource?: E2eResultSource;
  /** Why the user set the status by hand. */
  readonly resultNote?: string | null;
  /** Saved environment this test runs with; null inherits the run's. */
  readonly environmentId?: string | null;
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
  /** Test case saved in ADK; its title, description and steps follow it. */
  readonly savedCase?: E2eSavedCaseLink | null;
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
    /** The run's saved environment, which a test without its own inherits. */
    readonly environmentId?: string | null;
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
  /** Saved environment the run was configured from. */
  readonly environmentId?: string | null;
  readonly prdFileNames: readonly string[];
  /** The tests are planned and written from the Brain instead of a PRD. */
  readonly useBrain?: boolean;
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
  /** False only saves the run: nothing is explored, planned or run until the user asks. */
  readonly start?: boolean;
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
  /** Saved environment to configure the run from; null unlinks it. */
  readonly environmentId?: string | null;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  readonly clearAccessServiceToken?: boolean;
  /** May be empty when the run automates imported test cases. */
  readonly prd: string;
  readonly prdFileNames?: readonly string[];
  /** Plans and writes the tests from the Brain; `prd` may then be empty. */
  readonly useBrain?: boolean;
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
/** What the API accepts of the instructions to rewrite a script or one of its steps. */
export const MAX_INSTRUCTIONS = 20_000;

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
  const m = getMessages().e2e;
  return value
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s/.test(line))
    .map((line) =>
      line
        .replace(/\/app\/(?:\.e2e-workspaces|node_modules)\/[^\s)]+/gi, m.redactedRuntime)
        .replace(/\b[a-z0-9.-]+\.railway\.(?:app|internal)\b/gi, m.redactedServiceAddress)
        .replace(/\b[A-Z]:\\[^\s)]+/gi, m.redactedLocalPath)
        .replace(/\bRailway\b/gi, m.redactedEnvironment)
        .replace(/Cloudflare Access/gi, m.redactedTunnelAuth)
        .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, m.redactedConnection),
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

export interface E2eStepText {
  readonly action: string;
  readonly expectedResult: string;
}

/** Splits a planned step written as "action => expected result". */
export function splitStepText(text: string): E2eStepText {
  const match = /^([\s\S]*?)\s*(?:=>|⇒|→)\s*([\s\S]*)$/.exec(text);
  return match
    ? { action: match[1]!.trim(), expectedResult: match[2]!.trim() }
    : { action: text.trim(), expectedResult: '' };
}

/**
 * Steps of a Before Run or After Run: the numbered list in its first block comment that has one,
 * each item written as "action => expected result" like the planned steps of a test. An item may
 * wrap onto the next lines; a blank line ends the list.
 */
export function hookStepTexts(content: string | null | undefined): readonly E2eStepText[] {
  for (const block of (content ?? '').matchAll(/\/\*([\s\S]*?)\*\//g)) {
    const items: string[] = [];
    let open = false;
    for (const raw of block[1]!.split('\n')) {
      const line = raw.replace(/^\s*\*+/, '').trim();
      const item = /^\d+[.)]\s+(.*)$/.exec(line);
      if (item) {
        items.push(item[1]!);
        open = true;
      } else if (!line) open = false;
      else if (open) items[items.length - 1] += ` ${line}`;
    }
    if (items.length) return items.map(splitStepText);
  }
  return [];
}

/** Steps of a test with their expected results: the linked case's when there is one. */
export function testStepTexts(test: {
  readonly steps: readonly string[];
  readonly externalCase: ExternalTestCase | null;
}): readonly E2eStepText[] {
  return test.externalCase?.steps.length
    ? test.externalCase.steps.map(({ action, expectedResult }) => ({ action, expectedResult }))
    : test.steps.map(splitStepText);
}

export interface E2eFailureReason {
  /** The first step that failed; null when the run did not report steps. */
  readonly step: Pick<E2eStepResult, 'position' | 'title'> | null;
  /** What failed, in the AI analysis' own words; null when there is no usable analysis. */
  readonly summary: string | null;
  /** The analysis' likely cause; null when there is no usable analysis. */
  readonly cause: string | null;
  /** First line of the error the runner reported, e.g. "expect(locator).toHaveCount(expected) failed". */
  readonly headline: string;
  /** "Expected:" and "Received:" of a failed assertion; null when the error has none. */
  readonly expected: string | null;
  readonly received: string | null;
}

/** The AI analysis is written as five paragraphs: Goal, What was executed, What failed, Likely cause, Recommendation. */
const ANALYSIS_SECTIONS = 5;

/** A section of the analysis without its title line. */
function sectionBody(section: string): string | null {
  return section.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim() || null;
}

/**
 * The reason a run failed, as text to read next to the video: the failed step, what the AI said
 * failed and why, and the assertion the runner reported. Null while the run has no failure to explain.
 */
export function failureReason(
  test: Pick<E2eTestDetail, 'status' | 'error' | 'analysis' | 'stepResults'>,
): E2eFailureReason | null {
  if (test.status !== 'failed' && test.status !== 'error') return null;
  const failedStep = test.stepResults.find((step) => step.status === 'failed') ?? null;
  const lines = safeE2eOutput(failedStep?.error || test.error || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = (lines[0] ?? '').replace(/^Error:\s*/i, '');
  const field = (name: string) =>
    lines
      .find((line) => line.startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim() || null;

  const sections = safeE2eOutput(test.analysis ?? '')
    .split(/\n\s*\n/)
    .map((section) => section.trim())
    .filter(Boolean);
  const analysed = sections.length === ANALYSIS_SECTIONS;
  const summary = analysed ? sectionBody(sections[2]!) : null;
  const cause = analysed ? sectionBody(sections[3]!) : null;
  if (!headline && !summary) return null;

  return {
    step: failedStep && { position: failedStep.position, title: failedStep.title },
    summary,
    cause,
    headline,
    expected: field('Expected'),
    received: field('Received'),
  };
}

/** Longest "Extra instructions" the API accepts for a run. */
export const MAX_RUN_INSTRUCTIONS_LENGTH = 20_000;

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

// --- Environments: where an application runs and how the agent signs in to it. ---

export interface E2eEnvironment {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly username: string | null;
  readonly hasPassword: boolean;
  /** The first environment of the workspace. */
  readonly isDefault: boolean;
  /** Names of the custom variables; their values never leave the server. */
  readonly variableNames: readonly string[];
}

export interface E2eEnvironmentInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly username?: string;
  readonly password?: string;
  /** A variable sent without a value keeps the saved one. */
  readonly variables: readonly { readonly key: string; readonly value?: string }[];
}

// --- Exploration: the agent signs in and browses the site before the tests are planned. ---

export type E2eExplorationStatus = 'signing_in' | 'exploring' | 'ready' | 'failed';

export interface E2eExplorationPage {
  readonly index: number;
  readonly url: string;
  readonly title: string;
  readonly summary: string;
  readonly elements: readonly string[];
  readonly hasScreenshot: boolean;
  /** The flow of the agent's plan this capture is the evidence of; `title` is then its name. */
  readonly flow?: string;
}

export interface E2eExplorationLogEntry {
  readonly atMs: number;
  /** A `note` explains a decision of the agent; its target is a code, optionally `code:detail`. */
  readonly action:
    'navigate' | 'sign_in' | 'click' | 'type' | 'select' | 'press' | 'scroll' | 'note';
  readonly target: string;
  readonly result: string | null;
  /** Why the AI agent did it, in its own words (or what went wrong, for a note). */
  readonly reason?: string;
  /** A picture of the screen once the action was done (see `e2eImagePath.explorationStep`). */
  readonly hasScreenshot?: boolean;
  /** The address the browser was on after the action. */
  readonly url?: string;
  /** Which browser did it, when several explored at once (1-based). */
  readonly worker?: number;
}

export type E2eExplorationContextKind = 'pbi' | 'brain' | 'issue';

/** A PBI, issue or Brain document that gave the agent context. */
export interface E2eExplorationContextRef {
  readonly kind: E2eExplorationContextKind;
  readonly id: string;
  readonly title: string;
}

export interface E2eExploration {
  readonly status: E2eExplorationStatus;
  /** What the agent read before exploring, besides the tests of the run. */
  readonly context?: readonly E2eExplorationContextRef[];
  /** The agent the user chose to explore; absent when the agent of the run did. */
  readonly agent?: { readonly id: string; readonly name: string };
  /** What the exploration was asked to cover; null or absent when it was open. */
  readonly description?: string | null;
  /** True when the exploration replaces the Source of the workspace when it ends well. */
  readonly source?: boolean;
  /** Where it ended up: "database" or "source". */
  readonly savedTo?: string | null;
  /** Why the script could not be kept. */
  readonly saveError?: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly signedInMs: number | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
  readonly pages: readonly E2eExplorationPage[];
  readonly log: readonly E2eExplorationLogEntry[];
  readonly hasLiveFrame: boolean;
  /** The recording of each browser that explored; absent when there is none. */
  readonly videos?: readonly E2eExplorationVideo[];
}

/** The recording of one browser of an exploration; `worker` is 1 when a single one explored. */
export interface E2eExplorationVideo {
  readonly worker: number;
  readonly mimeType: string;
}

/** Playwright code of an exploration; `edited` is false while it is the one made from the log. */
export interface E2eExplorationCode {
  readonly code: string;
  readonly edited: boolean;
}

export function isExplorationActive(exploration: E2eExploration | null): boolean {
  return exploration?.status === 'signing_in' || exploration?.status === 'exploring';
}

// --- Action map: the pages the tests of a run went through and what they touched. ---

export type E2eTouchAction = 'click' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'hover';

export interface E2eMapImage {
  readonly testId: string;
  readonly index: number;
}

export interface E2eMapTouch {
  readonly testId: string;
  readonly step: number;
  readonly action: E2eTouchAction;
  readonly value: string | null;
}

export interface E2eMapElement {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  /** Part of the page the element occupies, each value between 0 and 1. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly image: E2eMapImage | null;
  readonly touches: readonly E2eMapTouch[];
}

export interface E2eMapPage {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly image: E2eMapImage | null;
  readonly testIds: readonly string[];
  readonly touches: number;
  readonly failedTestIds: readonly string[];
  readonly elements: readonly E2eMapElement[];
}

export interface E2eMapEdge {
  /** Null for the edge that leaves the start of the run. */
  readonly from: string | null;
  readonly to: string;
  readonly testIds: readonly string[];
}

export interface E2eLiveActivity {
  readonly step: number;
  readonly action: E2eTouchAction;
  readonly kind: string;
  readonly name: string;
}

export interface E2eActionMap {
  readonly pages: readonly E2eMapPage[];
  readonly edges: readonly E2eMapEdge[];
  readonly tests: readonly {
    readonly id: string;
    readonly status: E2eTestStatus;
    readonly path: readonly string[];
    readonly live: E2eLiveActivity | null;
  }[];
}

// --- Source: the single map of the application, replaced by each Source exploration. ---

/** One way through the application: the action that ends it; `map.tests` has its pages. */
export interface E2eSourceFlow {
  readonly id: string;
  /** Position of the action in the script, starting at 1. */
  readonly step: number;
  readonly action: E2eExplorationLogEntry['action'];
  readonly target: string;
  /** Name of the page the flow ends on; flows are grouped by it. */
  readonly group: string;
}

export type E2eSourceFlowOrigin = 'documented' | 'discovered' | 'both';

/** The system documented by the AI from the Brain and from what the agent discovered. */
export interface E2eSourceDocumentation {
  /** Markdown: what the system is, who uses it, its modules and main rules. */
  readonly overview: string;
  readonly areas: readonly {
    readonly name: string;
    readonly description: string;
    readonly flows: readonly {
      readonly title: string;
      readonly description: string;
      readonly steps: readonly string[];
      readonly pages: readonly string[];
      readonly origin: E2eSourceFlowOrigin;
    }[];
  }[];
  readonly brainDocuments: readonly { readonly title: string; readonly source: string }[];
  readonly generatedAt: string;
}

export interface E2eSource {
  readonly workspaceId: string;
  /** Hidden run that carried the exploration. */
  readonly creationId: string;
  /** Saved environment whose application was explored; null when it was deleted. */
  readonly environmentId: string | null;
  readonly startUrl: string;
  readonly signedInMs: number | null;
  /** What the agent did, in order: the script kept in the database. */
  readonly script: readonly E2eExplorationLogEntry[];
  readonly pages: readonly E2eExplorationPage[];
  /** Overview and flows of the system; null when the AI could not write them. */
  readonly documentation: E2eSourceDocumentation | null;
  readonly documentationError: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly updatedAt: string;
  /** The graph of pages, with one "test" per flow. */
  readonly map: E2eActionMap;
  readonly flows: readonly E2eSourceFlow[];
}

/** The Source, and whether an exploration or a documentation is being written. */
export interface E2eSourceState {
  readonly source: E2eSource | null;
  /** Hidden run carrying the jobs of the Source; its exploration is followed like a run's. */
  readonly anchorId: string | null;
  /** The agent that documents the system; the one of the last exploration. */
  readonly agentId: string | null;
  readonly busy: boolean;
}

/** Where the images of the E2E module are served, relative to `/e2e`. */
export const e2eImagePath = {
  sourcePage: (index: number) => `source/images/${index}`,
  explorationPage: (creationId: string, index: number) =>
    `creations/${encodeURIComponent(creationId)}/exploration/images/${index}`,
  /** The picture of an action; `index` is its 1-based position in the log. */
  explorationStep: (creationId: string, index: number) =>
    `creations/${encodeURIComponent(creationId)}/exploration/steps/${index}`,
  explorationLive: (creationId: string) =>
    `creations/${encodeURIComponent(creationId)}/exploration/images/live`,
  trail: (image: E2eMapImage, kind: 'page' | 'element') =>
    `tests/${encodeURIComponent(image.testId)}/trail/${kind}/${image.index}`,
  live: (testId: string) => `tests/${encodeURIComponent(testId)}/live`,
  /** Screenshot taken by a step of the latest execution. */
  step: (testId: string, position: number) =>
    `tests/${encodeURIComponent(testId)}/steps/${position}/screenshot`,
};

/**
 * The planned steps a run that went wrong never got to, with their position: all of them when it
 * failed before the first step (signing in, opening the screen), the ones after the failed step
 * otherwise. Empty for runs that passed or were stopped.
 */
export function stepsNotRun(
  test: Pick<E2eTestDetail, 'status' | 'stepResults' | 'steps' | 'externalCase'>,
): readonly (E2eStepText & { readonly position: number })[] {
  if (test.status !== 'failed' && test.status !== 'error') return [];
  return testStepTexts(test)
    .map((text, index) => ({ ...text, position: index + 1 }))
    .slice(test.stepResults.length);
}
