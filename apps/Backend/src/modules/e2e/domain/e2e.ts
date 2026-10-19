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
export type E2eRepositoryProvider = 'github' | 'azure_devops';

/** Where the run's Playwright specs live. The repository is the source of truth for scripts. */
export interface E2eRepositoryRef {
  provider: E2eRepositoryProvider;
  /** GitHub numeric id or Azure DevOps repository GUID. */
  id: string;
  /** GitHub "owner/repo" or Azure DevOps "Project/Repo". */
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
  /** Encrypted Cloudflare Access service token, scoped to this target origin. */
  accessSecret?: string | null;
  prd: string;
  prdFileNames: string[];
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
  /** File path of the spec inside the creation's repository; the content is never stored here. */
  scriptPath: string | null;
  /** Test case on a test management platform that this test automates. */
  externalCase: ExternalTestCase | null;
  /** Steps of the latest execution, with their evidence. */
  stepResults: E2eStepResult[];
  status: E2eTestStatus;
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
