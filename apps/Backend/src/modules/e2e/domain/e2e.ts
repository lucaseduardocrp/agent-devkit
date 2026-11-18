import { ApplicationError } from '../../../shared/errors.js';
import type {
  ExternalTestCase,
  TestManagementProviderId,
} from '../../test-management/domain/test-run.js';
import type { E2eMode } from './e2e-mode.js';

export type { E2eMode };
/** Where the browser runs: the ADK workers, or the user's computer through `devkit runner`. */
export type E2eExecutionTarget = 'remote' | 'local';
export type E2eScope = 'codebase' | 'diff';
export type E2eCreationStatus =
  'draft' | 'queued' | 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
export type E2eTestStatus =
  'pending' | 'generating' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
export type E2ePriority = 'high' | 'medium' | 'low';
export type E2eVerdict = 'app_bug' | 'test_issue' | 'environment';
/**
 * Who decided the status of a test: the run itself, the success criteria the user wrote (the AI
 * found the evidence meets them although the script failed) or the user, by hand.
 */
export type E2eResultSource = 'run' | 'criteria' | 'manual';
/** The Git hosts reached through an integration of the workspace. */
export type E2eRepositoryProvider = 'github' | 'azure_devops';
/** Where specs can live: a Git host, or `local`, a folder on the computer running ADK (desktop). */
export type E2eRepositoryLocation = E2eRepositoryProvider | 'local';

/** Where the run's Playwright specs live. The repository is the source of truth for scripts. */
export interface E2eRepositoryRef {
  provider: E2eRepositoryLocation;
  /** GitHub numeric id, Azure DevOps repository GUID or, for `local`, the absolute folder path. */
  id: string;
  /** GitHub "owner/repo", Azure DevOps "Project/Repo" or, for `local`, the folder name. */
  name: string;
  branch: string;
  /** Folder inside the repository, without leading or trailing slashes. */
  path: string;
}

export interface E2eCreation {
  id: string;
  workspaceId: string;
  ownerId: string;
  actorId: string;
  agentId: string;
  name: string;
  mode: E2eMode;
  scope: E2eScope;
  baseUrl: string;
  /** Optional browser origin kept as localhost while traffic uses baseUrl. */
  localOrigin?: string | null;
  /** Where the browser runs; local runs wait for the requesting user's `devkit runner`. */
  executionTarget: E2eExecutionTarget;
  path: string;
  username: string | null;
  /** AES-GCM ciphertext; never returned by the API. */
  passwordSecret: string | null;
  /** Saved environment the run was configured from; its custom variables reach the specs. */
  environmentId?: string | null;
  /** The hidden run that explores the workspace's Source: it is not listed and has no tests. */
  internal?: boolean;
  /** Encrypted Cloudflare Access service token, scoped to this target origin. */
  accessSecret?: string | null;
  prd: string;
  prdFileNames: string[];
  /** Plans and writes the tests from the Brain instead of (or besides) an uploaded PRD. */
  useBrain: boolean;
  diff: string | null;
  instructions: string | null;
  locale: string;
  /** Null only for runs created before scripts moved to repositories. */
  repository: E2eRepositoryRef | null;
  /** Test management platform that receives the run's results; null when not reported. */
  reporting: E2eReportingTarget | null;
  /** Outcome of the latest publication of the results. */
  lastReport: E2eReportState | null;
  prdSummary: string | null;
  status: E2eCreationStatus;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface E2eReportingTarget {
  provider: TestManagementProviderId;
  /** Default location for linked cases that do not carry their own (e.g. Azure plan/suite). */
  planId: string | null;
  suiteId: string | null;
  /** Publish automatically whenever a run of the tests finishes. */
  autoPublish: boolean;
}

export type E2eReportStatus = 'publishing' | 'published' | 'failed';

export interface E2eReportState {
  status: E2eReportStatus;
  provider: TestManagementProviderId;
  remoteRunId: string | null;
  url: string | null;
  publishedCases: number;
  warnings: string[];
  error: string | null;
  updatedAt: string;
}

/** What one top-level `test.step` of a spec produced; matched to external steps by position. */
export interface E2eStepResult {
  position: number;
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
  error: string | null;
  /** Artifact key of the screenshot taken when the step ended. */
  screenshotKey: string | null;
  /** The user's own verdict on this step; it overrules `status` until the next execution. */
  manualStatus?: 'passed' | 'failed';
  /** Why the user decided the step by hand. */
  manualNote?: string | null;
}

/** What a step counts as: the user's verdict when there is one, the run's otherwise. */
export function effectiveStepStatus(
  step: Pick<E2eStepResult, 'status' | 'manualStatus'>,
): E2eStepResult['status'] {
  return step.manualStatus ?? step.status;
}

/** Test case saved in ADK (Test Plans): the plan that holds it and its stable `metadata.caseId`. */
export interface E2eSavedCaseLink {
  planId: string;
  caseId: string;
}

export interface E2eTestCase {
  id: string;
  creationId: string;
  workspaceId: string;
  position: number;
  code: string;
  title: string;
  description: string;
  steps: string[];
  priority: E2ePriority;
  /** Feature area the test belongs to; groups the tests of a run. Null when not planned by the AI. */
  category?: string | null;
  /** File path of the spec inside the creation's repository; the content is never stored here. */
  scriptPath: string | null;
  /** What the user tells the AI about how to write the Before Run (e.g. screens to go through). */
  beforeRunInstructions: string | null;
  /** What the user tells the AI about how to write the After Run. */
  afterRunInstructions: string | null;
  /** What the user tells the AI about how to write the spec; applies to every rewrite of it. */
  scriptInstructions: string | null;
  /**
   * How the user decides this test passes (what the screen must show, what must be absent). The
   * spec asserts it, and a run that fails on something else but meets it counts as passed.
   */
  successCriteria: string | null;
  /**
   * Saved environment this test runs with (its URL, account and variables) instead of the run's.
   * Null inherits the run's environment.
   */
  environmentId: string | null;
  /** JSON of {@link RegenerationFeedback}: read once by the next rewrite of the spec, then cleared. */
  regenerationFeedback: string | null;
  /** Test case on a test management platform that this test automates. */
  externalCase: ExternalTestCase | null;
  /**
   * Test case saved in ADK this test is linked to. Title, description and steps follow it, and
   * editing either side updates the other.
   */
  savedCase: E2eSavedCaseLink | null;
  /** Steps of the latest execution, with their evidence. */
  stepResults: E2eStepResult[];
  status: E2eTestStatus;
  /** Who decided `status`; anything but `run` is reset by the next execution. */
  resultSource: E2eResultSource;
  /** Why the user set the status by hand. */
  resultNote: string | null;
  error: string | null;
  analysis: string | null;
  verdict: E2eVerdict | null;
  logs: string | null;
  videoKey: string | null;
  durationMs: number | null;
  /** Computer that ran the latest execution; null when it ran on the ADK workers. */
  executedOn: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt: Date | null;
}

export const ACTIVE_CREATION_STATUSES: readonly E2eCreationStatus[] = [
  'queued',
  'planning',
  'running',
];
export const ACTIVE_TEST_STATUSES: readonly E2eTestStatus[] = ['pending', 'generating', 'running'];

/** Artifact key of the page snapshot the worker captures for plans written by the MCP host. */
export function snapshotKey(creation: Pick<E2eCreation, 'workspaceId' | 'id'>): string {
  return `${creation.workspaceId}/${creation.id}/snapshot.json`;
}

/** Folder of the step screenshots of a test's latest execution. */
export function stepEvidencePrefix(test: Pick<E2eTestCase, 'workspaceId' | 'creationId' | 'id'>) {
  return `${test.workspaceId}/${test.creationId}/steps/${test.id}`;
}

export function testCaseCode(position: number): string {
  return `TC${String(position).padStart(3, '0')}`;
}

const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata', '169.254.169.254']);

/**
 * The browser runs inside the backend, so the target must be reachable from it. Local
 * addresses are the main use case and stay allowed; cloud metadata endpoints do not.
 */
export function normalizeTargetUrl(baseUrl: string, path = ''): { baseUrl: string; path: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new ApplicationError('E2E_INVALID_URL', 'Target URL is invalid.', 400, [
      { field: 'baseUrl' },
    ]);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    BLOCKED_HOSTS.has(host) ||
    host.startsWith('169.254.')
  ) {
    throw new ApplicationError('E2E_INVALID_URL', 'Target URL is not allowed.', 400, [
      { field: 'baseUrl' },
    ]);
  }
  const requestedPath = path.trim() || parsed.pathname;
  const normalizedPath = `/${requestedPath.replace(/^\/+/, '')}`;
  return { baseUrl: parsed.origin, path: normalizedPath };
}

export function normalizeLocalBrowserOrigin(
  value: string | undefined,
  mode: E2eMode,
): string | null {
  if (!value?.trim()) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ApplicationError('E2E_INVALID_URL', 'Local browser origin is invalid.', 400, [
      { field: 'localOrigin' },
    ]);
  }
  if (
    mode !== 'frontend' ||
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new ApplicationError('E2E_INVALID_URL', 'Enter an HTTP localhost origin.', 400, [
      { field: 'localOrigin' },
    ]);
  }
  return url.origin;
}

export function targetUrl(
  creation: Pick<E2eCreation, 'baseUrl' | 'path'> & { localOrigin?: string | null },
): string {
  return `${creation.localOrigin ?? creation.baseUrl}${creation.path}`;
}

/** Normalizes the folder chosen for the specs; rejects anything that could escape the repo. */
export function normalizeScriptFolder(value: string): string {
  const folder = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!folder) return '';
  if (
    folder.length > 300 ||
    !/^[\w\-. ]+(\/[\w\-. ]+)*$/.test(folder) ||
    folder.split('/').some((part) => part === '..' || part === '.')
  )
    throw new ApplicationError('E2E_INVALID_SCRIPT_PATH', 'Script folder is invalid.', 400, [
      { field: 'repository.path' },
    ]);
  return folder;
}

export function slugify(value: string, max = 60): string {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'test'
  );
}

export function scriptFilePath(folder: string, test: Pick<E2eTestCase, 'code' | 'title'>): string {
  const file = `${test.code.toLowerCase()}-${slugify(test.title)}.spec.ts`;
  return folder ? `${folder}/${file}` : file;
}

/**
 * The scripts of a test: its spec, the Before Run that prepares the preconditions and the
 * After Run that removes what the test left behind.
 */
export const E2E_SCRIPT_KINDS = ['spec', 'beforeRun', 'afterRun'] as const;
export type E2eScriptKind = (typeof E2E_SCRIPT_KINDS)[number];
export type E2eHookKind = Exclude<E2eScriptKind, 'spec'>;
export const HOOK_KINDS: readonly E2eHookKind[] = ['beforeRun', 'afterRun'];
export const HOOK_LABELS: Readonly<Record<E2eHookKind, string>> = {
  beforeRun: 'Before Run',
  afterRun: 'After Run',
};
export const HOOK_INSTRUCTION_FIELDS = {
  beforeRun: 'beforeRunInstructions',
  afterRun: 'afterRunInstructions',
} as const satisfies Record<E2eHookKind, keyof E2eTestCase>;
export const MAX_HOOK_INSTRUCTIONS_LENGTH = 20_000;
export const MAX_SUCCESS_CRITERIA_LENGTH = 10_000;
export const MAX_RESULT_NOTE_LENGTH = 2_000;
/** Extra instructions of a run: room for acceptance criteria written as Gherkin, not just a hint. */
export const MAX_RUN_INSTRUCTIONS_LENGTH = 20_000;

/** What the next rewrite of a spec starts from: the spec it replaces and what its last run showed. */
export interface RegenerationFeedback {
  readonly script: string;
  readonly problem: string;
  /**
   * Present when only one step of the spec is to be rewritten: every other step, the hooks and the
   * rest of the file stay as they are. `instructions` is what the user told the AI about it.
   */
  readonly step?: RegenerationStep;
}

/** The step of a spec the user asked the AI to fix, and how. */
export interface RegenerationStep {
  /** Position of the top-level step, starting at 1. */
  readonly position: number;
  readonly title: string;
  /** What the user wants or knows about the screens of the step (Markdown, may hold images). */
  readonly instructions: string;
}
const MAX_FEEDBACK_LOGS = 6_000;
const MAX_FEEDBACK_ERROR = 4_000;

/**
 * Gathers what the last execution of a test produced (error, AI analysis, failed steps, run log)
 * so that rewriting its spec can learn from it. The user's own instructions travel separately.
 */
export function buildRegenerationFeedback(
  test: Pick<E2eTestCase, 'status' | 'error' | 'analysis' | 'logs' | 'stepResults'> &
    Partial<Pick<E2eTestCase, 'resultSource' | 'resultNote'>>,
  script: string,
): RegenerationFeedback {
  const sections: string[] = [];
  // What the user decided overrules what the run reported, so it comes first.
  const decisions = test.stepResults
    .filter((step) => step.manualStatus)
    .map((step) => {
      const note = step.manualNote ? ` - ${step.manualNote.slice(0, 1_000)}` : '';
      return `${step.position}. ${step.title}: the user decided "${step.manualStatus}" (the run reported "${step.status}")${note}`;
    });
  if (test.resultSource === 'manual' && !decisions.length) {
    const note = test.resultNote ? ` - ${test.resultNote.slice(0, 1_000)}` : '';
    decisions.push(`The whole test: the user decided "${test.status}"${note}`);
  }
  if (decisions.length)
    sections.push(
      joinSection(
        'Decisions of the user (they overrule the run: the script must agree with them)',
        decisions.join('\n'),
      ),
    );
  if (test.error)
    sections.push(joinSection('Error of the last run', test.error.slice(0, MAX_FEEDBACK_ERROR)));
  if (test.analysis) sections.push(joinSection('AI analysis of the last run', test.analysis));
  const steps = test.stepResults.map((step) => {
    const detail = step.error ? ` - ${step.error.slice(0, 1_000)}` : '';
    return `${step.position}. ${step.title}: ${step.status}${detail}`;
  });
  if (steps.length) sections.push(joinSection('Steps of the last run', steps.join('\n')));
  if (test.logs)
    sections.push(joinSection('End of the last run output', test.logs.slice(-MAX_FEEDBACK_LOGS)));
  return {
    script,
    problem: sections.length
      ? [
          `The user asked for a rewrite. The previous script ended as "${test.status}". What its last run produced:`,
          '',
          ...sections,
        ].join('\n')
      : 'The user asked for a rewrite of this script; no output of a previous run is available.',
  };
}

const joinSection = (title: string, text: string): string => [`${title}:`, text, ''].join('\n');

/** The feedback stored on a test; null when there is none or it cannot be read. */
export function parseRegenerationFeedback(value: string | null): RegenerationFeedback | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RegenerationFeedback>;
    if (typeof parsed.script !== 'string' || typeof parsed.problem !== 'string') return null;
    const step = parsed.step;
    return step &&
      Number.isInteger(step.position) &&
      typeof step.title === 'string' &&
      typeof step.instructions === 'string'
      ? {
          script: parsed.script,
          problem: parsed.problem,
          step: { position: step.position, title: step.title, instructions: step.instructions },
        }
      : { script: parsed.script, problem: parsed.problem };
  } catch {
    return null;
  }
}

/**
 * Before Run and After Run live next to the spec (`tc001-x.before.ts`, `tc001-x.after.ts`);
 * without the `.spec` suffix Playwright never collects them as tests.
 */
export function hookFilePath(specPath: string, kind: E2eHookKind): string {
  const suffix = kind === 'beforeRun' ? '.before.ts' : '.after.ts';
  return `${specPath.replace(/\.spec\.(ts|js|mjs)$/, '')}${suffix}`;
}
