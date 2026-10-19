import { ApplicationError } from '../../../shared/errors.js';
import type { RequestContext } from '../../../shared/context.js';
import { encryptSecret } from '../../../shared/encryption.js';
import { decryptAccessToken, encryptAccessToken, type AccessServiceToken } from './access-token.js';
import { resolveLocale } from '../../../shared/i18n.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import {
  normalizeScriptFolder,
  normalizeLocalBrowserOrigin,
  normalizeTargetUrl,
  scriptFilePath,
  snapshotKey,
  targetUrl,
  testCaseCode,
  type E2eCreation,
  type E2eCreationStatus,
  type E2eExecutionTarget,
  type E2eReportingTarget,
  type E2eStepResult,
  type E2eMode,
  type E2ePriority,
  type E2eRepositoryProvider,
  type E2eRepositoryRef,
  type E2eScope,
  type E2eTestCase,
  type E2eTestStatus,
} from '../domain/e2e.js';
import type { E2eScriptRepository } from './script-repository.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eSnapshot, E2eVideoTranscoder } from './e2e-runner.js';
import type { E2eCreationSettings, E2eStore, NewE2eTestCase } from './e2e-store.js';
import {
  describeStep,
  htmlToText,
  isTestManagementProvider,
  type ExternalTestCase,
  type TestManagementProviderId,
} from '../../test-management/domain/test-run.js';
import type {
  TestManagementProvider,
  TestManagementResolver,
} from '../../test-management/application/test-management-provider.js';
import type { E2eJobKind, E2eJobQueue } from './e2e-queue.js';
import { MAX_E2E_TESTS, planRules, scriptRules } from './e2e-author.js';
import {
  closeActiveTests,
  markInterrupted,
  requireRepository,
  type StoredSnapshot,
} from './e2e-executor.js';
import { checkScript } from './script-guard.js';

/** Who writes the plan and the specs: the workspace agent on the worker, or the MCP host. */
export type E2ePlanning = 'server' | 'host';

/** Longest spec accepted from a person or the MCP host. */
export const MAX_SCRIPT_LENGTH = 60_000;

/** A plan written by the MCP host: test cases with their full Playwright specs. */
export interface HostPlanInput {
  readonly summary?: string;
  readonly tests: readonly {
    readonly title: string;
    readonly description: string;
    readonly priority: E2ePriority;
    readonly steps: readonly string[];
    readonly script: string;
    /** Keeps the test linked to its test management case (as returned by the brief). */
    readonly externalCase?: ExternalTestCase | null;
  }[];
}

/** Test management cases to automate in a run, chosen by plan/suite and optionally by id. */
export interface ImportCasesInput {
  readonly provider: TestManagementProviderId;
  readonly planId?: string;
  readonly suiteId?: string;
  /** Only these cases of the plan/suite; all of them when omitted. */
  readonly caseIds?: readonly string[];
}

/** Test cases saved in ADK (Test Plans) to automate, by suite, Test Plan and/or case id. */
export interface SavedCasesInput {
  readonly suiteId?: string;
  readonly planId?: string;
  readonly caseIds?: readonly string[];
}

/** A saved test case as the E2E module needs it. */
export interface SavedCaseForRun {
  readonly caseId: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly { readonly action: string; readonly expectedResult: string }[];
  /** The platform case it was imported from: the run then reports to it. */
  readonly remote: {
    readonly provider: string;
    readonly caseId: string;
    readonly planId?: string;
    readonly suiteId?: string;
  } | null;
}

/** Reads the test cases saved in the Test Plans module. */
export interface SavedCaseReader {
  listSavedCases(
    workspaceId: string,
    selection: SavedCasesInput,
  ): Promise<readonly SavedCaseForRun[]>;
}

export interface ReportingInput {
  readonly provider: TestManagementProviderId;
  readonly planId?: string | null;
  readonly suiteId?: string | null;
  readonly autoPublish?: boolean;
}

export interface LinkCaseInput {
  readonly provider: TestManagementProviderId;
  readonly caseId: string;
  readonly planId?: string;
  readonly suiteId?: string;
}

export interface E2eImportResult {
  readonly imported: number;
  readonly skipped: number;
  readonly creation: E2eCreationView;
}

/** Most cases imported into one run; each becomes a spec executed in sequence. */
export const MAX_IMPORTED_CASES = 100;

export interface E2eHostBrief {
  readonly run: {
    readonly id: string;
    readonly name: string;
    readonly status: E2eCreationStatus;
    readonly mode: E2eMode;
    readonly scope: E2eScope;
    readonly targetUrl: string;
    readonly startPath: string;
    readonly locale: string;
    readonly repository: E2eRepositoryRef;
    readonly testAccount: { readonly username: string | null; readonly hasPassword: boolean };
  };
  readonly agent: { readonly id: string; readonly name: string; readonly instructions: string };
  readonly documents: {
    readonly prd: string;
    readonly diff: string | null;
    readonly instructions: string | null;
    readonly standardizedPrd: string | null;
  };
  readonly snapshot:
    | { readonly status: 'capturing' }
    | { readonly status: 'failed'; readonly capturedAt: string; readonly error: string }
    | { readonly status: 'ready'; readonly capturedAt: string; readonly data: E2eSnapshot };
  readonly rules: { readonly plan: readonly string[]; readonly script: readonly string[] };
  readonly limits: { readonly maxTests: number; readonly maxScriptLength: number };
  readonly existingTests: readonly {
    readonly code: string;
    readonly title: string;
    readonly status: E2eTestStatus;
    readonly scriptPath: string | null;
    readonly steps: readonly string[];
    /** Send it back in the plan to keep the test linked to its test management case. */
    readonly externalCase: ExternalTestCase | null;
  }[];
  readonly warnings: readonly string[];
}

export { describeError } from './e2e-executor.js';

/** Starts whoever consumes the queue: an in-process worker or a remote, on-demand one. */
export interface E2eDispatcher {
  wake(): Promise<void>;
}

export interface CreateE2eInput {
  readonly name: string;
  readonly agentId: string;
  readonly mode: E2eMode;
  readonly scope: E2eScope;
  readonly baseUrl: string;
  readonly localOrigin?: string;
  /** `local` runs the browser on the requesting user's computer through `devkit runner`. */
  readonly executionTarget?: E2eExecutionTarget;
  readonly path?: string;
  readonly username?: string;
  readonly password?: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  readonly clearAccessServiceToken?: boolean;
  readonly prd: string;
  readonly prdFileNames?: readonly string[];
  readonly diff?: string;
  readonly instructions?: string;
  /** Automates these test management cases instead of planning tests from the PRD. */
  readonly importCases?: ImportCasesInput;
  /** Automates these test cases saved in ADK instead of planning tests from the PRD. */
  readonly savedCases?: SavedCasesInput;
  /** Where results are published; defaults to the source of the imported cases. */
  readonly reporting?: ReportingInput | null;
  /** Repository, branch and folder where the generated specs are pushed. */
  readonly repository: {
    readonly provider: E2eRepositoryProvider;
    readonly id: string;
    readonly branch: string;
    readonly path: string;
  };
}

export interface E2eScriptView {
  readonly path: string;
  /** Null when the spec has not been written yet or was removed from the repository. */
  readonly content: string | null;
  readonly url: string | null;
  readonly repository: E2eRepositoryRef;
}

export interface E2ePullResult {
  readonly linked: number;
  readonly imported: number;
  readonly missing: number;
}

export type E2eCreationView = Omit<E2eCreation, 'passwordSecret' | 'accessSecret'> & {
  hasPassword: boolean;
  hasAccessServiceToken: boolean;
};
export type E2eStepView = Omit<E2eStepResult, 'screenshotKey'> & { hasScreenshot: boolean };
export type E2eTestSummary = Omit<E2eTestCase, 'logs' | 'videoKey' | 'stepResults'> & {
  hasVideo: boolean;
  stepResults: E2eStepView[];
};
export interface E2eCreationListItem extends Omit<
  E2eCreationView,
  'prd' | 'diff' | 'prdSummary' | 'instructions'
> {
  readonly passed: number;
  readonly total: number;
  readonly tests: readonly E2eTestSummary[];
}

export interface E2eServiceOptions {
  readonly store: E2eStore;
  /** Durable queue consumed by the workers; the API never runs browsers itself. */
  readonly queue: E2eJobQueue;
  readonly dispatcher: E2eDispatcher;
  readonly artifacts: E2eArtifactStore;
  /** Where specs are pulled from and pushed to; the database never stores their content. */
  readonly scripts: E2eScriptRepository;
  readonly agents: Pick<AgentService, 'getAgent'>;
  /** Test management platforms (Azure Test Plans, TestRail, Xray...) for import and reporting. */
  readonly testManagement?: TestManagementResolver;
  /** Test cases saved in ADK, automated with `savedCases`. */
  readonly savedCases?: SavedCaseReader;
  /** Converts recordings made before MP4 conversion existed; optional. */
  readonly transcoder?: E2eVideoTranscoder | null;
}

/**
 * HTTP-facing E2E operations. Work is put on the queue and a dispatcher wakes a worker,
 * so several runs (from any number of users) execute in parallel on separate machines.
 */
export class E2eService {
  constructor(private readonly options: E2eServiceOptions) {}

  /**
   * Startup housekeeping: fails runs left active without a queued or running job (e.g.
   * created before the queue existed) and wakes a worker for whatever is still queued.
   * Runs touched in the last minute are skipped: their job may be about to be enqueued.
   */
  async recover(graceMs = 60_000): Promise<void> {
    const cutoff = Date.now() - graceMs;
    for (const creation of await this.options.store.incompleteCreations()) {
      if (creation.updatedAt.getTime() > cutoff) continue;
      if (!(await this.options.queue.hasActive(creation.workspaceId, creation.id)))
        await markInterrupted(this.options.store, creation);
    }
    this.wakeWorker();
  }

  /**
   * Creates a run. The workspace agent plans and writes it on the worker, unless the plan
   * is written by the MCP host: then the run waits as a draft while the worker only
   * captures the application for the host's brief.
   * With `importCases` the tests are the given test management cases instead of a plan:
   * the agent (or the host) writes one spec per case following its steps, and the results
   * are published back to that platform.
   */
  async create(
    context: RequestContext,
    input: CreateE2eInput & { readonly planning?: E2ePlanning },
  ): Promise<E2eCreationView> {
    const workspaceId = requireWorkspace(context);
    const settings = await this.resolveSettings(workspaceId, input);
    const host = input.planning === 'host';
    // Fetched before the run exists, so an unreachable platform leaves nothing behind.
    const cases = input.importCases ? await this.fetchCases(workspaceId, input.importCases) : null;
    const saved = input.savedCases
      ? await this.resolveSavedCases(workspaceId, input.savedCases)
      : null;
    const defaultReporting = input.importCases
      ? { ...input.importCases, autoPublish: true }
      : saved?.reporting;
    const reporting =
      input.reporting === undefined
        ? defaultReporting
          ? reportingTarget(defaultReporting)
          : null
        : input.reporting
          ? reportingTarget(input.reporting)
          : null;
    const imported = cases?.map(testFromCase) ?? saved?.tests ?? null;
    const creation = await this.options.store.createCreation({
      ...settings,
      workspaceId,
      ownerId: context.ownerId ?? workspaceId,
      actorId: context.actorId ?? 'unknown',
      passwordSecret: input.password ? encryptSecret(input.password) : null,
      accessSecret: encryptAccessToken(
        input.accessClientId,
        input.accessClientSecret,
        settings.baseUrl,
      ),
      locale: resolveLocale(context.locale),
      reporting,
      ...(host ? { status: 'draft' as const } : {}),
    });
    if (!imported) {
      await this.enqueue(creation, host ? 'explore' : 'generate', [], context.actorId);
      return toView(creation);
    }
    const tests = await this.options.store.appendTests(creation, imported);
    await this.enqueue(
      creation,
      host ? 'explore' : 'execute',
      host ? [] : tests.map((test) => test.id),
      context.actorId,
    );
    return toView(creation);
  }

  /** Platforms the workspace can import cases from and publish runs to. */
  async testManagementProviders(workspaceId: string) {
    return this.requireTestManagement().listTestManagementProviders(workspaceId);
  }

  async remotePlans(workspaceId: string, provider: TestManagementProviderId) {
    return (await this.resolveProvider(workspaceId, provider)).listPlans();
  }

  async remoteSuites(workspaceId: string, provider: TestManagementProviderId, planId: string) {
    return (await this.resolveProvider(workspaceId, provider)).listSuites(planId);
  }

  async remoteCases(
    workspaceId: string,
    provider: TestManagementProviderId,
    location: { readonly planId?: string; readonly suiteId?: string },
  ) {
    return (await this.resolveProvider(workspaceId, provider)).listCases(location);
  }

  /**
   * Adds test management cases to an existing run as tests without a spec; the next run
   * writes their specs. Cases the run already automates are skipped.
   */
  async importCases(
    workspaceId: string,
    id: string,
    input: ImportCasesInput,
  ): Promise<E2eImportResult> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    const existing = await this.options.store.listTests(workspaceId, id);
    const linked = new Set(
      existing.flatMap((test) =>
        test.externalCase ? [`${test.externalCase.provider}:${test.externalCase.caseId}`] : [],
      ),
    );
    const cases = await this.fetchCases(workspaceId, input);
    const fresh = cases.filter((item) => !linked.has(`${item.provider}:${item.caseId}`));
    if (existing.length + fresh.length > MAX_IMPORTED_CASES)
      throw new ApplicationError('E2E_TOO_MANY_TESTS', 'Too many tests in one run.', 400, [
        { max: MAX_IMPORTED_CASES },
      ]);
    if (fresh.length) await this.options.store.appendTests(creation, fresh.map(testFromCase));
    const updated = creation.reporting
      ? creation
      : ((await this.options.store.updateCreation(workspaceId, id, {
          reporting: reportingTarget({ ...input, autoPublish: true }),
        })) as E2eCreation);
    return {
      imported: fresh.length,
      skipped: cases.length - fresh.length,
      creation: toView(updated),
    };
  }

  /** Links a test to a test management case (its steps guide the spec), or unlinks it. */
  async linkCase(workspaceId: string, testId: string, input: LinkCaseInput | null) {
    const test = await this.findTest(workspaceId, testId);
    await this.assertIdle(await this.findCreation(workspaceId, test.creationId));
    const externalCase = input
      ? await (
          await this.resolveProvider(workspaceId, input.provider)
        ).getCase({
          caseId: input.caseId,
          ...(input.planId ? { planId: input.planId } : {}),
          ...(input.suiteId ? { suiteId: input.suiteId } : {}),
        })
      : null;
    await this.options.store.updateTest(workspaceId, testId, {
      externalCase,
      ...(externalCase ? { steps: externalCase.steps.map(describeStep) } : {}),
    });
    return this.getTest(workspaceId, testId);
  }

  /** Chooses (or clears) the platform that receives this run's results. */
  async setReporting(
    workspaceId: string,
    id: string,
    input: ReportingInput | null,
  ): Promise<E2eCreationView> {
    await this.findCreation(workspaceId, id);
    const updated = (await this.options.store.updateCreation(workspaceId, id, {
      reporting: input ? reportingTarget(input) : null,
    })) as E2eCreation;
    return toView(updated);
  }

  /**
   * Publishes the latest results of the run's linked tests to its platform. The upload of
   * results and evidence runs on the worker; poll the run for `lastReport`.
   */
  async publish(workspaceId: string, id: string): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    if (!creation.reporting)
      throw new ApplicationError(
        'E2E_REPORTING_REQUIRED',
        'Choose the test management platform for this run first.',
        400,
        [{ field: 'reporting' }],
      );
    await this.assertIdle(creation);
    await this.resolveProvider(workspaceId, creation.reporting.provider);
    const updated = (await this.options.store.updateCreation(workspaceId, id, {
      lastReport: {
        status: 'publishing',
        provider: creation.reporting.provider,
        remoteRunId: null,
        url: null,
        publishedCases: 0,
        warnings: [],
        error: null,
        updatedAt: new Date().toISOString(),
      },
    })) as E2eCreation;
    await this.enqueue(updated, 'publish', []);
    return toView(updated);
  }

  /** PNG captured at the end of a step of the test's latest execution. */
  async stepScreenshot(workspaceId: string, testId: string, position: number): Promise<Buffer> {
    const test = await this.findTest(workspaceId, testId);
    const key = test.stepResults.find((step) => step.position === position)?.screenshotKey;
    const content = key ? await this.options.artifacts.get(key) : null;
    if (!content)
      throw new ApplicationError('E2E_EVIDENCE_NOT_FOUND', 'No screenshot for this step.', 404);
    return content;
  }

  /**
   * Everything the MCP host needs to plan the run and write its specs without a workspace
   * LLM: the documents, the authoring rules and a snapshot of the application. Without a
   * snapshot (or with `refresh`) a worker is asked to capture one; call again to get it.
   */
  async brief(
    workspaceId: string,
    id: string,
    refresh = false,
    actorId?: string,
  ): Promise<E2eHostBrief> {
    const creation = await this.findCreation(workspaceId, id);
    const repository = requireRepository(creation);
    const agent = await this.options.agents.getAgent(workspaceId, creation.agentId);
    const busy = await this.options.queue.hasActive(workspaceId, id);
    if (refresh && !busy) await this.options.artifacts.removePrefix(snapshotKey(creation));
    const stored = await this.readSnapshot(creation);
    if (!stored && !busy) await this.enqueue(creation, 'explore', [], actorId);
    const tests = await this.options.store.listTests(workspaceId, id);
    const warnings = [
      ...(creation.username && !creation.passwordSecret
        ? [
            'The run has a username but no password: tests cannot log in until the user adds the password by editing the run in the ADK web app.',
          ]
        : []),
      ...(stored && 'error' in stored
        ? [`The application could not be captured: ${stored.error}`]
        : []),
    ];
    return {
      run: {
        id: creation.id,
        name: creation.name,
        status: creation.status,
        mode: creation.mode,
        scope: creation.scope,
        targetUrl: targetUrl(creation),
        startPath: creation.path,
        locale: creation.locale,
        repository,
        testAccount: { username: creation.username, hasPassword: Boolean(creation.passwordSecret) },
      },
      agent: { id: agent.id, name: agent.name, instructions: agent.instructions },
      documents: {
        prd: creation.prd,
        diff: creation.diff,
        instructions: creation.instructions,
        standardizedPrd: creation.prdSummary,
      },
      snapshot: !stored
        ? { status: 'capturing' }
        : 'error' in stored
          ? { status: 'failed', capturedAt: stored.capturedAt, error: stored.error }
          : { status: 'ready', capturedAt: stored.capturedAt, data: stored.snapshot },
      rules: { plan: planRules(creation), script: scriptRules(creation) },
      limits: { maxTests: MAX_E2E_TESTS, maxScriptLength: MAX_SCRIPT_LENGTH },
      existingTests: tests.map((test) => ({
        code: test.code,
        title: test.title,
        status: test.status,
        scriptPath: test.scriptPath,
        steps: test.steps,
        externalCase: test.externalCase,
      })),
      warnings,
    };
  }

  /**
   * Saves a plan written by the MCP host: commits each spec to the run's folder, replaces
   * the run's tests (TC001, TC002… in the given order) and queues them for execution.
   */
  async savePlan(
    workspaceId: string,
    id: string,
    input: HostPlanInput,
    actorId?: string,
  ): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    const repository = requireRepository(creation);
    await this.assertIdle(creation);
    const rejected = input.tests.flatMap((test, index) => {
      const check = checkScript(test.script);
      return check.ok ? [] : [`${testCaseCode(index + 1)}: ${check.violations.join('; ')}`];
    });
    if (rejected.length)
      throw new ApplicationError('E2E_SCRIPT_REJECTED', rejected.join(' | '), 422);
    const cases = input.tests.map(({ script: _script, ...test }, index) => ({
      ...test,
      scriptPath: scriptFilePath(repository.path, { code: testCaseCode(index + 1), ...test }),
    }));
    for (const [index, test] of cases.entries())
      await this.options.scripts.writeFile(
        workspaceId,
        repository,
        test.scriptPath,
        input.tests[index]!.script,
        `test(e2e): add ${testCaseCode(index + 1)} - ${test.title}`,
      );
    const previous = await this.options.store.listTests(workspaceId, id);
    const tests = await this.options.store.replaceTests(creation, cases);
    for (const test of previous)
      if (test.videoKey) await this.options.artifacts.removePrefix(test.videoKey);
    if (input.summary?.trim())
      await this.options.store.updateCreation(workspaceId, id, {
        prdSummary: input.summary.trim(),
      });
    return this.requeue(
      creation,
      'execute',
      tests.map((test) => test.id),
      actorId,
    );
  }

  /**
   * Changes a run's configuration without running it; tests are kept for the next run.
   * Omitting the password keeps the stored one; clearing the username drops it.
   */
  async update(workspaceId: string, id: string, input: CreateE2eInput): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    const settings = await this.resolveSettings(workspaceId, {
      ...input,
      localOrigin:
        input.localOrigin === undefined && input.mode === 'frontend'
          ? (creation.localOrigin ?? undefined)
          : input.localOrigin,
      executionTarget: input.executionTarget ?? creation.executionTarget,
    });
    const passwordSecret = input.password
      ? encryptSecret(input.password)
      : settings.username
        ? creation.passwordSecret
        : null;
    const accessSecret = input.clearAccessServiceToken
      ? null
      : input.accessClientId || input.accessClientSecret
        ? encryptAccessToken(input.accessClientId, input.accessClientSecret, settings.baseUrl)
        : settings.baseUrl === creation.baseUrl
          ? (creation.accessSecret ?? null)
          : null;
    const updated = (await this.options.store.updateCreation(workspaceId, id, {
      ...settings,
      passwordSecret,
      accessSecret,
      // The standardized PRD is rebuilt from the new document on the next planning.
      ...(settings.prd !== creation.prd ? { prdSummary: null } : {}),
    })) as E2eCreation;
    // A snapshot of another page or mode would mislead the next host-written plan.
    if (
      settings.baseUrl !== creation.baseUrl ||
      settings.localOrigin !== (creation.localOrigin ?? null) ||
      settings.executionTarget !== creation.executionTarget ||
      settings.path !== creation.path ||
      settings.mode !== creation.mode
    )
      await this.options.artifacts.removePrefix(snapshotKey(creation));
    // Specs linked to the old location are rewritten (or re-linked by a pull) in the new one.
    if (!sameLocation(creation.repository, settings.repository))
      for (const test of await this.options.store.listTests(workspaceId, id))
        if (test.scriptPath)
          await this.options.store.updateTest(workspaceId, test.id, { scriptPath: null });
    return toView(updated);
  }

  repositories(workspaceId: string) {
    return this.options.scripts.listRepositories(workspaceId);
  }

  branches(workspaceId: string, provider: E2eRepositoryProvider, repositoryId: string) {
    return this.options.scripts.listBranches(workspaceId, provider, repositoryId);
  }

  /** Pulls the current spec of a test straight from its repository. */
  async getScript(workspaceId: string, testId: string): Promise<E2eScriptView> {
    const test = await this.findTest(workspaceId, testId);
    const repository = requireRepository(await this.findCreation(workspaceId, test.creationId));
    const path = test.scriptPath ?? scriptFilePath(repository.path, test);
    const { scripts } = this.options;
    const [content, url] = await Promise.all([
      test.scriptPath ? scripts.readFile(workspaceId, repository, path) : null,
      scripts.fileUrl(workspaceId, repository, path),
    ]);
    return { path, content, url, repository };
  }

  /** Commits an edited spec to the run's branch; it is used by the next execution. */
  async pushScript(workspaceId: string, testId: string, content: string): Promise<E2eScriptView> {
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    const repository = requireRepository(creation);
    await this.assertIdle(creation);
    const check = checkScript(content);
    if (!check.ok)
      throw new ApplicationError('E2E_SCRIPT_REJECTED', check.violations.join('; '), 422);
    const path = test.scriptPath ?? scriptFilePath(repository.path, test);
    await this.options.scripts.writeFile(
      workspaceId,
      repository,
      path,
      content,
      `test(e2e): update ${test.code} - ${test.title}`,
    );
    await this.options.store.updateTest(workspaceId, test.id, { scriptPath: path });
    return this.getScript(workspaceId, testId);
  }

  /**
   * Syncs a run with its repository folder: links tests to their spec files, forgets
   * specs that were removed (they are rewritten on the next run) and imports new specs.
   */
  async pull(workspaceId: string, id: string): Promise<E2ePullResult> {
    const creation = await this.findCreation(workspaceId, id);
    const repository = requireRepository(creation);
    await this.assertIdle(creation);
    const { scripts, store } = this.options;
    const files = (await scripts.listFiles(workspaceId, repository)).filter((path) =>
      /\.spec\.(ts|js|mjs)$/.test(path),
    );
    const tests = await store.listTests(workspaceId, id);
    let linked = 0;
    let missing = 0;
    for (const test of tests) {
      const expected = test.scriptPath ?? scriptFilePath(repository.path, test);
      if (files.includes(expected)) {
        linked += 1;
        if (test.scriptPath !== expected)
          await store.updateTest(workspaceId, test.id, { scriptPath: expected });
      } else if (test.scriptPath) {
        missing += 1;
        await store.updateTest(workspaceId, test.id, { scriptPath: null });
      }
    }
    const known = new Set(
      tests.map((test) => test.scriptPath ?? scriptFilePath(repository.path, test)),
    );
    const imported = [];
    for (const path of files.filter((file) => !known.has(file))) {
      const content = (await scripts.readFile(workspaceId, repository, path)) ?? '';
      imported.push({
        title: specTitle(content, path),
        description: '',
        steps: [],
        priority: 'medium' as const,
        scriptPath: path,
      });
    }
    if (imported.length) await store.appendTests(creation, imported);
    return { linked, imported: imported.length, missing };
  }

  async list(workspaceId: string): Promise<E2eCreationListItem[]> {
    const [creations, tests] = await Promise.all([
      this.options.store.listCreations(workspaceId),
      this.options.store.listTests(workspaceId),
    ]);
    return creations.map((creation) => {
      const owned = tests.filter((test) => test.creationId === creation.id).map(toSummary);
      const {
        prd: _prd,
        diff: _diff,
        prdSummary: _summary,
        instructions: _i,
        ...rest
      } = toView(creation);
      return {
        ...rest,
        passed: owned.filter((test) => test.status === 'passed').length,
        total: owned.length,
        tests: owned,
      };
    });
  }

  async get(
    workspaceId: string,
    id: string,
  ): Promise<E2eCreationView & { tests: E2eTestSummary[] }> {
    const creation = await this.findCreation(workspaceId, id);
    const tests = await this.options.store.listTests(workspaceId, id);
    return { ...toView(creation), tests: tests.map(toSummary) };
  }

  /** Reuses a saved service token only for the run's original public origin. */
  async accessTokenForProbe(
    workspaceId: string,
    id: string,
    url: string,
  ): Promise<AccessServiceToken | null> {
    const creation = await this.findCreation(workspaceId, id);
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    return origin === creation.baseUrl ? decryptAccessToken(creation.accessSecret) : null;
  }

  async getTest(workspaceId: string, testId: string) {
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    const { videoKey, ...rest } = test;
    return {
      ...rest,
      stepResults: test.stepResults.map(toStepView),
      hasVideo: Boolean(videoKey),
      creation: {
        id: creation.id,
        name: creation.name,
        mode: creation.mode,
        baseUrl: creation.baseUrl,
        localOrigin: creation.localOrigin ?? null,
        path: creation.path,
        status: creation.status,
      },
    };
  }

  async video(
    workspaceId: string,
    testId: string,
  ): Promise<{ content: Buffer; mimeType: 'video/mp4' | 'video/webm' }> {
    const test = await this.findTest(workspaceId, testId);
    let key = test.videoKey;
    let content = key ? await this.options.artifacts.get(key) : null;
    if (!key || !content)
      throw new ApplicationError('E2E_VIDEO_NOT_FOUND', 'No video for this test.', 404);
    // Recordings saved before MP4 conversion existed are converted on first view.
    const mp4 = key.endsWith('.webm') ? await this.options.transcoder?.toMp4(content) : null;
    if (mp4) {
      const next = key.replace(/\.webm$/, '.mp4');
      await this.options.artifacts.put(next, mp4);
      await this.options.store.updateTest(workspaceId, test.id, { videoKey: next });
      await this.options.artifacts.removePrefix(key);
      key = next;
      content = Buffer.from(mp4);
    }
    return { content, mimeType: key.endsWith('.mp4') ? 'video/mp4' : 'video/webm' };
  }

  /**
   * Short-lived URL to stream the video straight from object storage. Null when the store
   * cannot sign URLs (Postgres, disk): the client then downloads it through `video()`.
   */
  async videoUrl(
    workspaceId: string,
    testId: string,
  ): Promise<{ url: string; mimeType: string; expiresInSeconds: number } | null> {
    const { artifacts } = this.options;
    let test = await this.findTest(workspaceId, testId);
    if (!test.videoKey)
      throw new ApplicationError('E2E_VIDEO_NOT_FOUND', 'No video for this test.', 404);
    if (!artifacts.signedUrl) return null;
    // Old WebM recordings are converted (and re-stored as MP4) before being shared.
    if (test.videoKey.endsWith('.webm') && this.options.transcoder) {
      await this.video(workspaceId, testId);
      test = await this.findTest(workspaceId, testId);
    }
    const key = test.videoKey as string;
    const expiresInSeconds = 3600;
    return {
      url: await artifacts.signedUrl(key, expiresInSeconds),
      mimeType: key.endsWith('.mp4') ? 'video/mp4' : 'video/webm',
      expiresInSeconds,
    };
  }

  /**
   * Moves a run between the ADK workers and the user's computer. Going local, a tunnel run
   * targets its localhost origin directly and drops the tunnel token.
   */
  async setExecutionTarget(
    workspaceId: string,
    id: string,
    executionTarget: E2eExecutionTarget,
  ): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    if (creation.executionTarget === executionTarget) return toView(creation);
    const baseUrl =
      executionTarget === 'local' && creation.localOrigin ? creation.localOrigin : creation.baseUrl;
    const updated = (await this.options.store.updateCreation(workspaceId, id, {
      executionTarget,
      ...(executionTarget === 'local' ? { localOrigin: null } : {}),
      ...(baseUrl !== creation.baseUrl ? { baseUrl, accessSecret: null } : {}),
    })) as E2eCreation;
    await this.options.artifacts.removePrefix(snapshotKey(creation));
    return toView(updated);
  }

  /** `actorId` is who started it: a local run's browser work goes to that user's runner. */
  async rerun(workspaceId: string, id: string, actorId?: string): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    const tests = await this.options.store.listTests(workspaceId, id);
    // A run that never produced tests (planning failed) starts over from the plan.
    if (!tests.length) return this.requeue(creation, 'generate', [], actorId);
    return this.rerunTests(creation, tests, false, actorId);
  }

  async rerunTest(
    workspaceId: string,
    testId: string,
    regenerate = false,
    actorId?: string,
  ): Promise<E2eCreationView> {
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    await this.assertIdle(creation);
    return this.rerunTests(creation, [test], regenerate, actorId);
  }

  /** Stops a run; the worker executing it notices on its next heartbeat. */
  async cancel(workspaceId: string, id: string): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    if (!(await this.options.queue.cancel(workspaceId, id)))
      throw new ApplicationError('E2E_NOT_RUNNING', 'Run is not active.', 409);
    const cancelled = (await this.options.store.updateCreation(workspaceId, id, {
      status: 'cancelled',
      finishedAt: new Date(),
    })) as E2eCreation;
    await closeActiveTests(this.options.store, creation, { status: 'cancelled' });
    return toView(cancelled);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.findCreation(workspaceId, id);
    await this.options.queue.cancel(workspaceId, id);
    await this.options.artifacts.removePrefix(`${workspaceId}/${id}`);
    await this.options.store.deleteCreation(workspaceId, id);
  }

  private async rerunTests(
    creation: E2eCreation,
    tests: readonly E2eTestCase[],
    regenerate: boolean,
    actorId: string | undefined,
  ): Promise<E2eCreationView> {
    for (const test of tests)
      await this.options.store.updateTest(creation.workspaceId, test.id, {
        status: 'pending',
        error: null,
        analysis: null,
        verdict: null,
        stepResults: [],
        // Without a linked spec the next run asks the AI for a new one and pushes it.
        ...(regenerate ? { scriptPath: null } : {}),
      });
    return this.requeue(
      creation,
      'execute',
      tests.map((test) => test.id),
      actorId,
    );
  }

  private async requeue(
    creation: E2eCreation,
    kind: E2eJobKind,
    testIds: string[],
    actorId?: string,
  ): Promise<E2eCreationView> {
    const queued = (await this.options.store.updateCreation(creation.workspaceId, creation.id, {
      status: 'queued',
      error: null,
      finishedAt: null,
    })) as E2eCreation;
    await this.enqueue(queued, kind, testIds, actorId);
    return toView(queued);
  }

  private async enqueue(
    creation: E2eCreation,
    kind: E2eJobKind,
    testIds: string[],
    actorId?: string,
  ) {
    const job = await this.options.queue.enqueue({
      workspaceId: creation.workspaceId,
      creationId: creation.id,
      kind,
      testIds,
      requestedBy: actorId ?? null,
    });
    // Another request won the race for this run between the check and the insert.
    if (!job) throw new ApplicationError('E2E_ALREADY_RUNNING', 'Run already in progress.', 409);
    this.wakeWorker();
  }

  /** Fire and forget: a worker that cannot be woken drains the queue when it next starts. */
  private wakeWorker(): void {
    void this.options.dispatcher
      .wake()
      .catch((error: unknown) => console.error('[E2eService] Could not wake a worker:', error));
  }

  private async assertIdle(creation: E2eCreation): Promise<void> {
    if (await this.options.queue.hasActive(creation.workspaceId, creation.id))
      throw new ApplicationError('E2E_ALREADY_RUNNING', 'Run already in progress.', 409);
  }

  /** Validates and normalizes the configuration shared by creating and editing a run. */
  private async resolveSettings(
    workspaceId: string,
    input: CreateE2eInput,
  ): Promise<
    Omit<E2eCreationSettings, 'passwordSecret' | 'accessSecret'> & { repository: E2eRepositoryRef }
  > {
    await this.options.agents.getAgent(workspaceId, input.agentId);
    const executionTarget = input.executionTarget ?? 'remote';
    const browserOrigin = normalizeLocalBrowserOrigin(input.localOrigin, input.mode);
    // A local runner opens the application directly: the tunnel's localhost origin is the target.
    const target = normalizeTargetUrl(
      executionTarget === 'local' && browserOrigin ? browserOrigin : input.baseUrl,
      input.path,
    );
    const localOrigin = executionTarget === 'local' ? null : browserOrigin;
    if (localOrigin && !target.baseUrl.startsWith('https://'))
      throw new ApplicationError('E2E_INVALID_URL', 'The tunnel URL must use HTTPS.', 400, [
        { field: 'baseUrl' },
      ]);
    const diff = input.scope === 'diff' ? input.diff?.trim() : undefined;
    if (input.scope === 'diff' && !diff)
      throw new ApplicationError('VALIDATION_ERROR', 'A code diff is required.', 400, [
        { field: 'diff' },
      ]);
    return {
      agentId: input.agentId,
      name: input.name.trim(),
      mode: input.mode,
      scope: input.scope,
      baseUrl: target.baseUrl,
      localOrigin,
      executionTarget,
      path: target.path,
      username: input.username?.trim() || null,
      prd: input.prd,
      prdFileNames: [...(input.prdFileNames ?? [])],
      diff: diff || null,
      instructions: input.instructions?.trim() || null,
      repository: await this.resolveRepository(workspaceId, input.repository),
    };
  }

  private async resolveRepository(
    workspaceId: string,
    input: CreateE2eInput['repository'],
  ): Promise<E2eRepositoryRef> {
    const { repositories } = await this.options.scripts.listRepositories(workspaceId);
    const repository = repositories.find(
      (item) => item.provider === input.provider && item.id === input.id,
    );
    if (!repository)
      throw new ApplicationError('E2E_REPOSITORY_NOT_FOUND', 'Repository not found.', 404, [
        { field: 'repository.id' },
      ]);
    return {
      provider: repository.provider,
      id: repository.id,
      name: repository.name,
      branch: input.branch.trim() || repository.defaultBranch,
      path: normalizeScriptFolder(input.path),
    };
  }

  private async readSnapshot(creation: E2eCreation): Promise<StoredSnapshot | null> {
    const content = await this.options.artifacts.get(snapshotKey(creation));
    if (!content) return null;
    try {
      return JSON.parse(content.toString('utf8')) as StoredSnapshot;
    } catch {
      return null;
    }
  }

  private requireTestManagement(): TestManagementResolver {
    if (!this.options.testManagement)
      throw new ApplicationError(
        'TEST_MANAGEMENT_NOT_CONFIGURED',
        'Test management platforms are not available.',
        400,
      );
    return this.options.testManagement;
  }

  private async resolveProvider(
    workspaceId: string,
    providerId: TestManagementProviderId,
  ): Promise<TestManagementProvider> {
    const provider = await this.requireTestManagement().resolveTestManagementProvider(
      workspaceId,
      providerId,
    );
    if (!provider)
      throw new ApplicationError(
        'TEST_MANAGEMENT_NOT_CONFIGURED',
        'The test management platform is not configured.',
        400,
        [{ provider: providerId }],
      );
    return provider;
  }

  private async fetchCases(
    workspaceId: string,
    input: ImportCasesInput,
  ): Promise<ExternalTestCase[]> {
    const provider = await this.resolveProvider(workspaceId, input.provider);
    const wanted = input.caseIds?.length ? new Set(input.caseIds.map(String)) : null;
    const cases = (
      await provider.listCases({
        ...(input.planId ? { planId: input.planId } : {}),
        ...(input.suiteId ? { suiteId: input.suiteId } : {}),
      })
    ).filter((item) => !wanted || wanted.has(item.caseId));
    if (!cases.length)
      throw new ApplicationError(
        'TEST_MANAGEMENT_CASE_NOT_FOUND',
        'No test case was found to import.',
        404,
        [{ provider: input.provider }],
      );
    if (cases.length > MAX_IMPORTED_CASES)
      throw new ApplicationError('E2E_TOO_MANY_TESTS', 'Too many tests in one run.', 400, [
        { max: MAX_IMPORTED_CASES },
      ]);
    return cases;
  }

  /**
   * Tests for saved test cases. A case imported from a platform is read again from it, so
   * the spec follows the platform's steps and its results are published back there; when
   * the platform cannot be reached, the saved copy is automated without reporting.
   */
  private async resolveSavedCases(
    workspaceId: string,
    input: SavedCasesInput,
  ): Promise<{ tests: NewE2eTestCase[]; reporting: ReportingInput | null }> {
    if (!this.options.savedCases)
      throw new ApplicationError(
        'E2E_SAVED_CASES_UNAVAILABLE',
        'Saved test cases are not available.',
        501,
      );
    const cases = await this.options.savedCases.listSavedCases(workspaceId, input);
    if (!cases.length)
      throw new ApplicationError('E2E_SAVED_CASES_NOT_FOUND', 'No saved test case was found.', 404);
    if (cases.length > MAX_IMPORTED_CASES)
      throw new ApplicationError('E2E_TOO_MANY_TESTS', 'Too many tests in one run.', 400, [
        { max: MAX_IMPORTED_CASES },
      ]);

    const remote = new Map<string, ExternalTestCase>();
    const groups = new Map<string, NonNullable<SavedCaseForRun['remote']>>();
    for (const item of cases)
      if (item.remote && isTestManagementProvider(item.remote.provider))
        groups.set(locationKey(item.remote), item.remote);
    for (const location of groups.values()) {
      const provider = await this.options.testManagement
        ?.resolveTestManagementProvider(workspaceId, location.provider as TestManagementProviderId)
        .catch(() => null);
      if (!provider) continue;
      const found = await provider
        .listCases({
          ...(location.planId ? { planId: location.planId } : {}),
          ...(location.suiteId ? { suiteId: location.suiteId } : {}),
        })
        .catch(() => [] as ExternalTestCase[]);
      for (const item of found) remote.set(`${locationKey(location)}#${item.caseId}`, item);
    }

    const linked: ExternalTestCase[] = [];
    const tests = cases.map((item) => {
      const external = item.remote
        ? remote.get(`${locationKey(item.remote)}#${item.remote.caseId}`)
        : undefined;
      if (!external) return testFromSavedCase(item);
      linked.push(external);
      return testFromCase(external);
    });
    const first = linked[0];
    const same = <K extends 'provider' | 'planId' | 'suiteId'>(key: K) =>
      linked.every((item) => item[key] === first?.[key]) ? first?.[key] : undefined;
    return {
      tests,
      reporting:
        first && same('provider')
          ? {
              provider: first.provider,
              planId: same('planId') ?? null,
              suiteId: same('suiteId') ?? null,
              autoPublish: true,
            }
          : null,
    };
  }

  private async findCreation(workspaceId: string, id: string): Promise<E2eCreation> {
    const creation = await this.options.store.getCreation(workspaceId, id);
    if (!creation) throw new ApplicationError('E2E_CREATION_NOT_FOUND', 'E2E run not found.', 404);
    return creation;
  }

  private async findTest(workspaceId: string, id: string): Promise<E2eTestCase> {
    const test = await this.options.store.getTest(workspaceId, id);
    if (!test) throw new ApplicationError('E2E_TEST_NOT_FOUND', 'E2E test not found.', 404);
    return test;
  }
}

function requireWorkspace(context: RequestContext): string {
  if (!context.workspaceId)
    throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return context.workspaceId;
}

function sameLocation(current: E2eRepositoryRef | null, next: E2eRepositoryRef): boolean {
  return (
    current?.provider === next.provider &&
    current.id === next.id &&
    current.branch === next.branch &&
    current.path === next.path
  );
}

function toView(creation: E2eCreation): E2eCreationView {
  const { passwordSecret, accessSecret, ...rest } = creation;
  return {
    ...rest,
    hasPassword: Boolean(passwordSecret),
    hasAccessServiceToken: Boolean(accessSecret),
  };
}

function toSummary(test: E2eTestCase): E2eTestSummary {
  const { logs: _logs, videoKey, ...rest } = test;
  return { ...rest, stepResults: test.stepResults.map(toStepView), hasVideo: Boolean(videoKey) };
}

function toStepView(step: E2eStepResult): E2eStepView {
  const { screenshotKey, ...rest } = step;
  return { ...rest, hasScreenshot: Boolean(screenshotKey) };
}

function reportingTarget(input: ReportingInput): E2eReportingTarget {
  return {
    provider: input.provider,
    planId: input.planId?.trim() || null,
    suiteId: input.suiteId?.trim() || null,
    autoPublish: input.autoPublish ?? true,
  };
}

/** A spec-less test that automates an external case; its steps guide the spec author. */
function testFromCase(item: ExternalTestCase): NewE2eTestCase {
  return {
    title: `${item.caseId} - ${item.title}`.slice(0, 200),
    description: `Automates test case ${item.caseId} (${item.provider}).`,
    steps: item.steps.map(describeStep),
    priority: 'medium',
    externalCase: item,
  };
}

/** A spec-less test for a test case saved in ADK; its steps guide the spec author. */
function testFromSavedCase(item: SavedCaseForRun): NewE2eTestCase {
  const description = htmlToText(item.description).slice(0, 2_000);
  return {
    title: item.title.slice(0, 200),
    description: description || `Automates the saved test case "${item.title}".`,
    steps: item.steps.map(describeStep),
    priority: 'medium',
    externalCase: null,
  };
}

function locationKey(location: {
  readonly provider: string;
  readonly planId?: string;
  readonly suiteId?: string;
}): string {
  return `${location.provider}:${location.planId ?? ''}:${location.suiteId ?? ''}`;
}

/** Title for a spec imported from the repository: its test name, else its file name. */
export function specTitle(content: string, path: string): string {
  const name = /\btest\s*\(\s*(['"`])((?:\\.|(?!\1).)+)\1/.exec(content)?.[2];
  const fallback = path.slice(path.lastIndexOf('/') + 1).replace(/\.spec\.(ts|js|mjs)$/, '');
  return (
    (name ?? fallback)
      .replace(/^TC\d+\s*[-–:]\s*/i, '')
      .trim()
      .slice(0, 200) || fallback
  );
}
