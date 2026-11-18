import { ApplicationError } from '../../../shared/errors.js';
import { explorationCode } from '../domain/e2e-exploration-code.js';
import {
  contextRefs,
  saveExplorationContext,
  type E2eContextReader,
  type E2eContextRequest,
} from './e2e-context.js';
import type { RequestContext } from '../../../shared/context.js';
import { encryptSecret } from '../../../shared/encryption.js';
import { decryptAccessToken, encryptAccessToken, type AccessServiceToken } from './access-token.js';
import { resolveLocale } from '../../../shared/i18n.js';
import type { AgentService } from '../../agents/application/agent-service.js';
import {
  HOOK_KINDS,
  HOOK_INSTRUCTION_FIELDS,
  HOOK_LABELS,
  hookFilePath,
  MAX_RESULT_NOTE_LENGTH,
  normalizeScriptFolder,
  normalizeLocalBrowserOrigin,
  normalizeTargetUrl,
  buildRegenerationFeedback,
  effectiveStepStatus,
  scriptFilePath,
  snapshotKey,
  targetUrl,
  testCaseCode,
  type E2eCreation,
  type E2eCreationStatus,
  type E2eExecutionTarget,
  type E2eReportingTarget,
  type E2eSavedCaseLink,
  type E2eStepResult,
  type E2eMode,
  type E2ePriority,
  type E2eRepositoryLocation,
  type E2eRepositoryRef,
  type E2eScope,
  type E2eScriptKind,
  type E2eHookKind,
  type E2eTestCase,
  type E2eTestStatus,
  type RegenerationFeedback,
} from '../domain/e2e.js';
import {
  buildActionMap,
  explorationLiveKey,
  MAX_EXPLORATION_CONTEXT,
  MAX_EXPLORATION_DESCRIPTION,
  explorationPageKey,
  explorationCodeKey,
  explorationVideoKey,
  explorationStepKey,
  liveFrameKey,
  liveLabelKey,
  trailImageKey,
  trailKey,
  trailPrefix,
  type E2eActionMap,
  type E2eEnvironment,
  type E2eExploration,
  type E2eLiveActivity,
  type E2eStoredTrail,
} from '../domain/e2e-insight.js';
import {
  buildSourceMap,
  sourceDiscovery,
  sourcePageKey,
  type E2eSource,
  type E2eSourceMap,
} from '../domain/e2e-source.js';
import type { z } from 'zod';
import type { KnowledgeSearchPort } from '../../knowledge/application/knowledge-search.js';
import {
  SOURCE_RESPONSE_FORMAT,
  sourceDocumentationSchema,
  sourceRules,
  type E2eAuthor,
  type E2eCaseChatMessage,
  type E2eCaseDraft,
  type E2eCaseRevision,
} from './e2e-author.js';
import { attachmentFileUrl } from '../../shared/attachment.js';
import { fileOwner, syncItemFilesSafely } from '../../shared/attachment-files.js';
import { loadImageAttachments } from '../../shared/image-attachment.js';
import { evidenceSteps, meetsCriteria, toLlmImages } from './e2e-judge.js';
import { brainContext, searchSourceBrain } from './e2e-brain.js';
import type { E2eEnvironmentService } from './e2e-environments.js';
import { ExplorationRecorder, readExploration } from './e2e-exploration.js';
import type { E2eScriptRepository } from './script-repository.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eSnapshot, E2eVideoTranscoder } from './e2e-runner.js';
import type { E2eCreationSettings, E2eStore, E2eTestChanges, NewE2eTestCase } from './e2e-store.js';
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
import { MAX_E2E_TESTS, hookRules, planRules, scriptRules } from './e2e-author.js';
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
/** How the user wants a spec rewritten. */
export interface E2eRegenerationGuidance {
  /** Instructions and extra information for the AI; empty clears the ones saved on the test. */
  readonly instructions?: string;
  /** Starts from the spec being replaced and what its last run produced. */
  readonly useLastRun?: boolean;
  /** How the user decides the test passes; empty clears it. Kept on the test for every run. */
  readonly successCriteria?: string;
}

/** What the user decides about the result of a finished test: pass it, fail it, or go back to the run's. */
export type E2eResultDecision = 'passed' | 'failed' | 'run';

export interface HostPlanInput {
  readonly summary?: string;
  readonly tests: readonly {
    readonly title: string;
    readonly description: string;
    readonly priority: E2ePriority;
    /** Feature area that groups the test in the run view. */
    readonly category?: string | null;
    readonly steps: readonly string[];
    readonly script: string;
    /** Before Run and After Run of the test, committed next to its spec. */
    readonly beforeRun?: string | null;
    readonly afterRun?: string | null;
    /** Keeps the test linked to its test management case (as returned by the brief). */
    readonly externalCase?: ExternalTestCase | null;
    /**
     * Keeps the test linked to its test case saved in ADK (as returned by the brief); null
     * unlinks it. Omitted, a plan that keeps the run's tests keeps their links too.
     */
    readonly savedCase?: E2eSavedCaseLink | null;
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
  /** The Test Plan that holds the case; the case is only linkable to tests when it is known. */
  readonly planId?: string;
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

/** Where a test case saved in ADK lives: its Test Plan and its stable case id. */
export type LinkSavedCaseInput = E2eSavedCaseLink;

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
    /** The tests come from the Brain: the host agent searches it with `brainTools`. */
    readonly useBrain: boolean;
    readonly brainTools?: readonly string[];
  };
  readonly snapshot:
    | { readonly status: 'capturing' }
    | { readonly status: 'failed'; readonly capturedAt: string; readonly error: string }
    | { readonly status: 'ready'; readonly capturedAt: string; readonly data: E2eSnapshot };
  readonly rules: {
    readonly plan: readonly string[];
    readonly script: readonly string[];
    readonly beforeRun: readonly string[];
    readonly afterRun: readonly string[];
  };
  readonly limits: { readonly maxTests: number; readonly maxScriptLength: number };
  readonly existingTests: readonly {
    readonly code: string;
    readonly title: string;
    readonly status: E2eTestStatus;
    readonly scriptPath: string | null;
    readonly beforeRunInstructions: string | null;
    readonly afterRunInstructions: string | null;
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
  /**
   * Saved environment the run is configured from: its custom variables reach the specs and,
   * for the same username, its password is used when none is given. Null unlinks the run;
   * omitted keeps what an edited run already has.
   */
  readonly environmentId?: string | null;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  readonly clearAccessServiceToken?: boolean;
  readonly prd: string;
  readonly prdFileNames?: readonly string[];
  /** Plans and writes the tests from the Brain; the PRD is then optional extra context. */
  readonly useBrain?: boolean;
  readonly diff?: string;
  readonly instructions?: string;
  /** Automates these test management cases instead of planning tests from the PRD. */
  readonly importCases?: ImportCasesInput;
  /** Automates these test cases saved in ADK instead of planning tests from the PRD. */
  readonly savedCases?: SavedCasesInput;
  /** Where results are published; defaults to the source of the imported cases. */
  readonly reporting?: ReportingInput | null;
  /**
   * False creates the run and leaves it alone: nothing is explored, planned or executed until
   * the user asks (see `generate`, `explore` and `rerun`). Defaults to true.
   */
  readonly start?: boolean;
  /** Repository, branch and folder where the generated specs are pushed. */
  readonly repository: {
    readonly provider: E2eRepositoryLocation;
    readonly id: string;
    readonly branch: string;
    readonly path: string;
  };
}

export interface E2eScriptView {
  readonly kind: E2eScriptKind;
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
export type E2eTestSummary = Omit<
  E2eTestCase,
  'logs' | 'videoKey' | 'stepResults' | 'regenerationFeedback'
> & {
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
  /** Where a run executes when the request does not say; the ADK worker ("remote") by default. */
  readonly defaultExecutionTarget?: E2eExecutionTarget;
  readonly store: E2eStore;
  /** Durable queue consumed by the workers; the API never runs browsers itself. */
  readonly queue: E2eJobQueue;
  readonly dispatcher: E2eDispatcher;
  readonly artifacts: E2eArtifactStore;
  /**
   * Where uploaded files live. The pictures in the instructions of a test are kept here for as
   * long as the instructions reference them; without it they are left for the cleanup of unsaved
   * uploads.
   */
  readonly attachments?: E2eArtifactStore;
  /** Where specs are pulled from and pushed to; the database never stores their content. */
  readonly scripts: E2eScriptRepository;
  readonly agents: Pick<AgentService, 'getAgent'>;
  /** Test management platforms (Azure Test Plans, TestRail, Xray...) for import and reporting. */
  readonly testManagement?: TestManagementResolver;
  /** Test cases saved in ADK, automated with `savedCases`. */
  readonly savedCases?: SavedCaseReader;
  /** Converts recordings made before MP4 conversion existed; optional. */
  readonly transcoder?: E2eVideoTranscoder | null;
  /** Saved environments runs can be configured from. */
  readonly environments?: Pick<E2eEnvironmentService, 'find' | 'variables'>;
  /** The Brain: the documentation of the system is written from it. */
  readonly knowledge?: KnowledgeSearchPort;
  /** Judges a finished test against the user's success criteria without running it again. */
  readonly author?: Pick<E2eAuthor, 'analyze' | 'reviseCase' | 'adaptScript' | 'fixStep'>;
  /** Reads the PBIs, issues and Brain documents chosen as context of an exploration. */
  readonly contextReader?: E2eContextReader;
  /**
   * The API runs on the user's own computer (the desktop app): the browser is always this
   * process's own, so no run waits for a runner or a worker and the choice is not offered.
   */
  readonly runsLocally?: boolean;
}

/** The Source with its flows, and whether an exploration or a documentation is being written. */
export interface E2eSourceState {
  readonly source: (E2eSource & E2eSourceMap) | null;
  /** Hidden run carrying the Source's jobs; its exploration can be followed like a run's. */
  readonly anchorId: string | null;
  /** The agent that documents the system; the one of the last exploration. */
  readonly agentId: string | null;
  readonly busy: boolean;
}

/** Loopback applications are only reachable from the user's computer. */
function isLoopback(baseUrl: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname.toLowerCase());
}

/**
 * HTTP-facing E2E operations. Work is put on the queue and a dispatcher wakes a worker,
 * so several runs (from any number of users) execute in parallel on separate machines.
 */
/** A little over the time a running job may go without heartbeats before it counts as abandoned. */
const ABANDONED_JOB_RECHECK_MS = 130_000;

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
    // A job whose worker died with the previous process is only seen as abandoned once its
    // heartbeats have been missing for a while, and the worker looks for abandoned jobs only when
    // it is woken: without this, such a run would stay "in progress" until something else woke it.
    setTimeout(() => this.wakeWorker(), ABANDONED_JOB_RECHECK_MS).unref();
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
    const start = input.start !== false;
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
    const environment = input.environmentId
      ? await this.findEnvironment(workspaceId, input.environmentId)
      : null;
    const creation = await this.options.store.createCreation({
      ...settings,
      workspaceId,
      ownerId: context.ownerId ?? workspaceId,
      actorId: context.actorId ?? 'unknown',
      environmentId: environment?.id ?? null,
      passwordSecret: input.password
        ? encryptSecret(input.password)
        : environmentPassword(environment, settings.username),
      accessSecret: encryptAccessToken(
        input.accessClientId,
        input.accessClientSecret,
        settings.baseUrl,
      ),
      locale: resolveLocale(context.locale),
      reporting,
      ...(host || !start ? { status: 'draft' as const } : {}),
    });
    if (!imported) {
      if (start) await this.enqueue(creation, host ? 'explore' : 'generate', [], context.actorId);
      return toView(creation);
    }
    const tests = await this.options.store.appendTests(creation, imported);
    if (start)
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
    await this.assertIdle(await this.findCreation(workspaceId, test.creationId), test.id);
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

  /**
   * Links a test to a test case saved in ADK, or unlinks it. From then on the test takes the
   * case's title, description and steps, and every edit of the case reaches the test.
   */
  async linkSavedCase(workspaceId: string, testId: string, input: LinkSavedCaseInput | null) {
    const test = await this.findTest(workspaceId, testId);
    await this.assertIdle(await this.findCreation(workspaceId, test.creationId), test.id);
    if (!input) {
      await this.options.store.updateTest(workspaceId, testId, { savedCase: null });
      return this.getTest(workspaceId, testId);
    }
    const found = await this.requireSavedCase(workspaceId, input);
    await this.options.store.updateTest(workspaceId, testId, {
      savedCase: input,
      ...savedCaseContent(found),
    });
    return this.getTest(workspaceId, testId);
  }

  /**
   * Links a whole saved suite (or Test Plan) to a run: each of its cases not yet linked in the
   * run is added as a test, with no spec until the next run writes it.
   */
  async linkSavedCases(
    workspaceId: string,
    id: string,
    input: SavedCasesInput,
  ): Promise<E2eImportResult> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    const existing = await this.options.store.listTests(workspaceId, id);
    const linked = new Set(
      existing.flatMap((test) => (test.savedCase ? [savedCaseKey(test.savedCase)] : [])),
    );
    const saved = await this.resolveSavedCases(workspaceId, input);
    const fresh = saved.tests.filter(
      (test) => !test.savedCase || !linked.has(savedCaseKey(test.savedCase)),
    );
    if (existing.length + fresh.length > MAX_IMPORTED_CASES)
      throw new ApplicationError('E2E_TOO_MANY_TESTS', 'Too many tests in one run.', 400, [
        { max: MAX_IMPORTED_CASES },
      ]);
    if (fresh.length) await this.options.store.appendTests(creation, fresh);
    const updated =
      !creation.reporting && saved.reporting
        ? ((await this.options.store.updateCreation(workspaceId, id, {
            reporting: reportingTarget(saved.reporting),
          })) as E2eCreation)
        : creation;
    return {
      imported: fresh.length,
      skipped: saved.tests.length - fresh.length,
      creation: toView(updated),
    };
  }

  /**
   * A saved Test Plan changed: the tests linked to its cases take the new title, description
   * and steps, and a test whose case is gone is unlinked.
   */
  async syncSavedPlan(
    workspaceId: string,
    planId: string,
    cases: readonly SavedCaseForRun[],
  ): Promise<void> {
    const byId = new Map(cases.map((item) => [item.caseId, item]));
    for (const test of await this.options.store.listLinkedTests(workspaceId, planId)) {
      const current = byId.get(test.savedCase!.caseId);
      if (!current) {
        await this.options.store.updateTest(workspaceId, test.id, { savedCase: null });
        continue;
      }
      const content = savedCaseContent(current);
      if (
        content.title !== test.title ||
        content.description !== test.description ||
        JSON.stringify(content.steps) !== JSON.stringify(test.steps)
      )
        await this.options.store.updateTest(workspaceId, test.id, content);
    }
  }

  /** A saved Test Plan was deleted: its linked tests stay, unlinked. */
  async unlinkSavedPlan(workspaceId: string, planId: string): Promise<void> {
    for (const test of await this.options.store.listLinkedTests(workspaceId, planId))
      await this.options.store.updateTest(workspaceId, test.id, { savedCase: null });
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
        useBrain: creation.useBrain,
        // The host agent searches the Brain itself with these tools.
        ...(creation.useBrain
          ? {
              brainTools: [
                'brain_search',
                'brain_ask',
                'brain_get_document',
                'brain_list_relations',
              ],
            }
          : {}),
      },
      snapshot: !stored
        ? { status: 'capturing' }
        : 'error' in stored
          ? { status: 'failed', capturedAt: stored.capturedAt, error: stored.error }
          : { status: 'ready', capturedAt: stored.capturedAt, data: stored.snapshot },
      rules: {
        plan: planRules(creation),
        script: scriptRules(
          creation,
          Object.keys(
            (await this.options.environments?.variables(workspaceId, creation.environmentId)) ?? {},
          ),
        ),
        beforeRun: hookRules(creation, 'beforeRun'),
        afterRun: hookRules(creation, 'afterRun'),
      },
      limits: { maxTests: MAX_E2E_TESTS, maxScriptLength: MAX_SCRIPT_LENGTH },
      existingTests: tests.map((test) => ({
        code: test.code,
        title: test.title,
        status: test.status,
        scriptPath: test.scriptPath,
        steps: test.steps,
        externalCase: test.externalCase,
        savedCase: test.savedCase,
        beforeRunInstructions: test.beforeRunInstructions,
        afterRunInstructions: test.afterRunInstructions,
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
      const violations = [
        ...checkScript(test.script).violations,
        ...HOOK_KINDS.flatMap((kind) => {
          const hook = test[kind];
          return hook?.trim()
            ? checkScript(hook, 'hook').violations.map((v) => `${HOOK_LABELS[kind]}: ${v}`)
            : [];
        }),
      ];
      return violations.length ? [`${testCaseCode(index + 1)}: ${violations.join('; ')}`] : [];
    });
    if (rejected.length)
      throw new ApplicationError('E2E_SCRIPT_REJECTED', rejected.join(' | '), 422);
    const previous = await this.options.store.listTests(workspaceId, id);
    // A plan with as many tests as the run has keeps what each position was linked to.
    const keepLinks = previous.length === input.tests.length;
    const cases = [];
    for (const [index, planned] of input.tests.entries()) {
      const { script: _script, beforeRun: _before, afterRun: _after, ...test } = planned;
      const savedCase =
        test.savedCase === undefined
          ? keepLinks
            ? (previous[index]!.savedCase ?? null)
            : null
          : test.savedCase;
      if (savedCase && test.savedCase !== undefined)
        await this.requireSavedCase(workspaceId, savedCase);
      cases.push({
        ...test,
        savedCase,
        scriptPath: scriptFilePath(repository.path, { code: testCaseCode(index + 1), ...test }),
      });
    }
    for (const [index, test] of cases.entries()) {
      const planned = input.tests[index]!;
      const code = testCaseCode(index + 1);
      await this.options.scripts.writeFile(
        workspaceId,
        repository,
        test.scriptPath,
        planned.script,
        `test(e2e): add ${code} - ${test.title}`,
      );
      for (const kind of HOOK_KINDS) {
        const hook = planned[kind];
        if (hook?.trim())
          await this.options.scripts.writeFile(
            workspaceId,
            repository,
            hookFilePath(test.scriptPath, kind),
            hook,
            `test(e2e): add ${HOOK_LABELS[kind]} of ${code} - ${test.title}`,
          );
      }
    }
    const tests = await this.options.store.replaceTests(creation, cases);
    for (const test of previous) {
      if (test.videoKey) await this.options.artifacts.removePrefix(test.videoKey);
      await this.options.artifacts.removePrefix(trailPrefix(test));
    }
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
    const environment = input.environmentId
      ? await this.findEnvironment(workspaceId, input.environmentId)
      : null;
    // A run moved to another environment takes that environment's password for the same account.
    const inherited =
      environment && environment.id !== creation.environmentId
        ? environmentPassword(environment, settings.username)
        : null;
    const passwordSecret = input.password
      ? encryptSecret(input.password)
      : settings.username
        ? (inherited ?? creation.passwordSecret)
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
      ...(input.environmentId === undefined ? {} : { environmentId: environment?.id ?? null }),
      // The standardized PRD is rebuilt from the new document on the next planning.
      ...(settings.prd !== creation.prd || settings.useBrain !== creation.useBrain
        ? { prdSummary: null }
        : {}),
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

  branches(workspaceId: string, provider: E2eRepositoryLocation, repositoryId: string) {
    return this.options.scripts.listBranches(workspaceId, provider, repositoryId);
  }

  /**
   * Pulls one script of a test straight from its repository: the spec, or the Before Run or
   * After Run kept next to it.
   */
  async getScript(
    workspaceId: string,
    testId: string,
    kind: E2eScriptKind = 'spec',
  ): Promise<E2eScriptView> {
    const test = await this.findTest(workspaceId, testId);
    const repository = requireRepository(await this.findCreation(workspaceId, test.creationId));
    const specPath = test.scriptPath ?? scriptFilePath(repository.path, test);
    const path = kind === 'spec' ? specPath : hookFilePath(specPath, kind);
    const { scripts } = this.options;
    const [content, url] = await Promise.all([
      // A spec being regenerated is unlinked; its hooks stay readable meanwhile.
      kind !== 'spec' || test.scriptPath ? scripts.readFile(workspaceId, repository, path) : null,
      scripts.fileUrl(workspaceId, repository, path),
    ]);
    return { kind, path, content, url, repository };
  }

  /**
   * Commits an edited script to the run's branch; it is used by the next execution. An empty
   * Before Run or After Run turns it off.
   */
  async pushScript(
    workspaceId: string,
    testId: string,
    content: string,
    kind: E2eScriptKind = 'spec',
  ): Promise<E2eScriptView> {
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    const repository = requireRepository(creation);
    await this.assertIdle(creation, test.id);
    const check =
      kind !== 'spec' && !content.trim()
        ? { ok: true, violations: [] }
        : checkScript(content, kind === 'spec' ? 'spec' : 'hook');
    if (!check.ok)
      throw new ApplicationError('E2E_SCRIPT_REJECTED', check.violations.join('; '), 422);
    const specPath = test.scriptPath ?? scriptFilePath(repository.path, test);
    await this.options.scripts.writeFile(
      workspaceId,
      repository,
      kind === 'spec' ? specPath : hookFilePath(specPath, kind),
      content,
      kind === 'spec'
        ? `test(e2e): update ${test.code} - ${test.title}`
        : `test(e2e): update ${HOOK_LABELS[kind]} of ${test.code} - ${test.title}`,
    );
    if (kind === 'spec')
      await this.options.store.updateTest(workspaceId, test.id, { scriptPath: specPath });
    return this.getScript(workspaceId, testId, kind);
  }

  /** Saves what the user wants the AI to follow when writing the test's Before Run or After Run. */
  async updateHookInstructions(
    workspaceId: string,
    testId: string,
    kind: E2eHookKind,
    instructions: string,
  ) {
    const test = await this.findTest(workspaceId, testId);
    await this.options.store.updateTest(workspaceId, test.id, {
      [HOOK_INSTRUCTION_FIELDS[kind]]: instructions.trim() || null,
    });
    return this.getTest(workspaceId, testId);
  }

  /**
   * Saves how the user decides the test passes. The next spec asserts it, and a failure that
   * still meets it counts as a pass. Nothing is rewritten or run: the work already done is kept.
   */
  async updateSuccessCriteria(workspaceId: string, testId: string, criteria: string) {
    const test = await this.findTest(workspaceId, testId);
    await this.options.store.updateTest(workspaceId, test.id, {
      successCriteria: criteria.trim() || null,
    });
    return this.getTest(workspaceId, testId);
  }

  /**
   * The user's own decision about a finished test: pass it, fail it, or give the status the run
   * produced back. Script, video and evidence stay; the next execution decides afresh.
   */
  async setResult(workspaceId: string, testId: string, decision: E2eResultDecision, note?: string) {
    const test = await this.findTest(workspaceId, testId);
    assertReviewable(test);
    const resultNote = note?.trim().slice(0, MAX_RESULT_NOTE_LENGTH) || null;
    await this.options.store.updateTest(
      workspaceId,
      test.id,
      decision === 'run'
        ? {
            status: ranStatus(test),
            resultSource: 'run',
            resultNote: null,
            // Giving the run's result back also drops what the user decided step by step.
            stepResults: test.stepResults.map(withoutManualVerdict),
          }
        : { status: decision, resultSource: 'manual', resultNote },
    );
    if (decision !== 'run')
      await this.adaptScriptToDecisions(workspaceId, test, {
        result: { decided: decision, note: resultNote },
      });
    return this.getTest(workspaceId, testId);
  }

  /**
   * Rewrites the spec of a finished test so that it agrees with what the user decided about it
   * (the test or its steps marked as passed or failed): it asserts what the user accepts or
   * rejects and carries no expected result, step or check beyond that. It is best effort: the
   * decision itself is already saved, so a script that cannot be adapted stays as it was.
   */
  private async adaptScriptToDecisions(
    workspaceId: string,
    before: E2eTestCase,
    decisions: { result?: { decided: 'passed' | 'failed'; note: string | null } },
  ): Promise<void> {
    const { author, scripts } = this.options;
    if (!author?.adaptScript || !before.scriptPath) return;
    try {
      const test = await this.findTest(workspaceId, before.id);
      const creation = await this.findCreation(workspaceId, test.creationId);
      const repository = requireRepository(creation);
      const steps = test.stepResults.flatMap((step) =>
        step.manualStatus
          ? [
              {
                position: step.position,
                title: step.title,
                decided: step.manualStatus,
                ran: step.status,
                note: step.manualNote ?? null,
                error: step.error,
              },
            ]
          : [],
      );
      const current = await scripts.readFile(workspaceId, repository, before.scriptPath);
      if (!current?.trim()) return;
      const specPath = before.scriptPath;
      const [beforeRun, afterRun] = await Promise.all(
        HOOK_KINDS.map(async (kind) => {
          const hook = await scripts.readFile(
            workspaceId,
            repository,
            hookFilePath(specPath, kind),
          );
          return hook?.trim() ? hook : null;
        }),
      );
      const adapted = await author.adaptScript({
        creation,
        test,
        script: current,
        steps,
        result: decisions.result ?? null,
        hooks: { beforeRun: beforeRun ?? null, afterRun: afterRun ?? null },
      });
      if (!adapted.trim() || adapted.trim() === current.trim()) return;
      // pushScript checks the new script and refuses one the guard rejects.
      await this.pushScript(workspaceId, test.id, adapted);
    } catch (error) {
      console.error('[E2eService] Could not adapt the script to the decisions of the user:', error);
    }
  }

  /**
   * The user's own decision about one step of a finished test: pass it, fail it, or give the
   * status the run produced back. The test passes when no step counts as failed any more. Script,
   * video and evidence stay; the next execution decides afresh.
   */
  async setStepResult(
    workspaceId: string,
    testId: string,
    position: number,
    decision: E2eResultDecision,
    note?: string,
  ) {
    const test = await this.findTest(workspaceId, testId);
    assertReviewable(test);
    if (!test.stepResults.some((step) => step.position === position))
      throw new ApplicationError('E2E_STEP_NOT_FOUND', 'The test has no such step.', 404);
    const stepResults = test.stepResults.map((step) => {
      if (step.position !== position) return step;
      const ran = withoutManualVerdict(step);
      return decision === 'run'
        ? ran
        : {
            ...ran,
            manualStatus: decision,
            manualNote: note?.trim().slice(0, MAX_RESULT_NOTE_LENGTH) || null,
          };
    });
    const changes: E2eTestChanges = { stepResults };
    if (stepResults.some((step) => step.manualStatus)) {
      // An error outside the steps (setup, a crash) is still there when every step passes.
      const unexplained =
        Boolean(test.error) && !stepResults.some((step) => step.status === 'failed');
      changes.status =
        unexplained || stepResults.some((step) => effectiveStepStatus(step) === 'failed')
          ? 'failed'
          : 'passed';
      changes.resultSource = 'manual';
      changes.resultNote = null;
    } else if (test.resultSource === 'manual') {
      changes.status = ranStatus(test);
      changes.resultSource = 'run';
      changes.resultNote = null;
    }
    await this.options.store.updateTest(workspaceId, test.id, changes);
    if (decision !== 'run') await this.adaptScriptToDecisions(workspaceId, test, {});
    return this.getTest(workspaceId, testId);
  }

  /**
   * Judges the last execution of a test again against its success criteria, from what it left
   * (steps, screenshots, output), with no new run. A failure the evidence excuses becomes a pass;
   * a pass the criteria had given that the evidence no longer supports goes back to the run's.
   */
  async reevaluate(workspaceId: string, testId: string, locale?: string) {
    const { author, artifacts, scripts } = this.options;
    if (!author)
      throw new ApplicationError(
        'E2E_REVIEW_UNAVAILABLE',
        'The AI review of results is not available.',
        503,
      );
    const test = await this.findTest(workspaceId, testId);
    if (!test.successCriteria?.trim())
      throw new ApplicationError(
        'E2E_SUCCESS_CRITERIA_REQUIRED',
        'Write the success criteria before reviewing the result.',
        409,
      );
    const reviewable =
      test.lastRunAt !== null &&
      (test.status === 'failed' || (test.status === 'passed' && test.resultSource !== 'run'));
    if (!reviewable)
      throw new ApplicationError(
        'E2E_RESULT_NOT_REVIEWABLE',
        'Only a failed test, or one passed by criteria or by hand, can be reviewed.',
        409,
      );
    const creation = await this.findCreation(workspaceId, test.creationId);
    const script =
      test.scriptPath && creation.repository
        ? ((await scripts
            .readFile(workspaceId, creation.repository, test.scriptPath)
            .catch(() => null)) ?? '')
        : '';
    const pictures = await Promise.all(
      evidenceSteps(test.stepResults).map(async (step) =>
        step.screenshotKey ? await artifacts.get(step.screenshotKey).catch(() => null) : null,
      ),
    );
    const analysis = await author.analyze({
      creation: locale ? { ...creation, locale: resolveLocale(locale) } : creation,
      test,
      script,
      error: test.error ?? '',
      logs: test.logs ?? '',
      steps: test.stepResults,
      images: toLlmImages(pictures),
    });
    const changes: E2eTestChanges = { analysis: analysis.summary, verdict: analysis.verdict };
    if (meetsCriteria(test, analysis)) {
      changes.status = 'passed';
      changes.resultSource = 'criteria';
      changes.resultNote = null;
    } else if (test.resultSource === 'criteria') {
      changes.status = ranStatus(test);
      changes.resultSource = 'run';
    }
    await this.options.store.updateTest(workspaceId, test.id, changes);
    return this.getTest(workspaceId, testId);
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
    // The feedback of a rewrite (the previous spec and run output) is internal.
    const { videoKey, regenerationFeedback: _feedback, ...rest } = test;
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
        environmentId: creation.environmentId ?? null,
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
    if (this.options.runsLocally) executionTarget = 'remote';
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

  /**
   * What the agent saw the last time it explored the run's application: the pages it captured
   * and what it did, updated while an exploration is in progress. Null when it never explored.
   */
  async exploration(workspaceId: string, id: string): Promise<E2eExploration | null> {
    const creation = await this.findCreation(workspaceId, id);
    const state = await readExploration(this.options.artifacts, creation);
    if (!state || state.status === 'ready' || state.status === 'failed') return state;
    // Still marked as in progress with no job behind it: the worker stopped half way.
    return (await this.options.queue.hasActive(workspaceId, id))
      ? state
      : { ...state, status: 'failed', hasLiveFrame: false };
  }

  /**
   * Asks a worker to explore the application again; the run and its tests are left alone.
   * The optional description says what to explore (the whole site, one feature, a bug…): the
   * agent follows it and it is kept with the exploration's script, which only ever goes to the
   * database. The agent explores with the context of the run's own tests.
   * `agentId` picks the agent that decides each step, with its own instructions, skills and
   * model; without it the agent of the run explores.
   */
  async explore(
    workspaceId: string,
    id: string,
    actorId?: string,
    options: {
      description?: string;
      source?: boolean;
      /** PBIs, issues and Brain documents that give the agent more to go on. */
      context?: readonly E2eContextRequest[];
      /** The agent that explores, when not the run's own. */
      agentId?: string;
    } = {},
  ): Promise<E2eExploration> {
    const { description, source = false } = options;
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    // Checked now, so an agent that is gone fails the request instead of the worker.
    const agent = options.agentId
      ? await this.options.agents.getAgent(workspaceId, options.agentId)
      : null;
    await this.options.artifacts.removePrefix(snapshotKey(creation));
    // The text is read now, with the permissions of the request, and kept for the worker.
    const documents =
      options.context?.length && this.options.contextReader
        ? await this.options.contextReader.read(
            {
              requestId: `e2e-context-${creation.id}`,
              ownerId: creation.ownerId,
              workspaceId,
              actorId: actorId ?? creation.actorId,
            },
            options.context.slice(0, MAX_EXPLORATION_CONTEXT),
          )
        : [];
    await saveExplorationContext(this.options.artifacts, creation, documents);
    // Shown as started right away, before a worker picks the job up. The worker reads the
    // description back from this state.
    await ExplorationRecorder.start(
      this.options.artifacts,
      creation,
      Boolean(creation.username && creation.passwordSecret),
      Date.now,
      {
        description: description?.slice(0, MAX_EXPLORATION_DESCRIPTION),
        source,
        context: contextRefs(documents),
        ...(agent ? { agent: { id: agent.id, name: agent.name } } : {}),
      },
    );
    await this.enqueue(creation, 'explore', [], actorId);
    return (await readExploration(this.options.artifacts, creation)) as E2eExploration;
  }

  /**
   * The Source of the workspace (null before its first exploration) with its script turned into
   * the map of the application: every flow the agent found, page by page.
   */
  async source(workspaceId: string): Promise<E2eSourceState> {
    const { store } = this.options;
    const source = await store.getSource(workspaceId);
    const run =
      (await store.getSourceAnchor(workspaceId)) ??
      (source ? await store.getCreation(workspaceId, source.creationId) : null);
    return {
      source: source && { ...source, ...buildSourceMap(source) },
      anchorId: run?.id ?? null,
      agentId: run?.agentId ?? null,
      // An exploration or a new documentation is being written.
      busy: run ? await this.options.queue.hasActive(workspaceId, run.id) : false,
    };
  }

  /**
   * Explores the application of a saved environment, as a whole, to replace the Source of the
   * workspace. A hidden run of the workspace carries the job (its address, account and agent
   * come from the environment and the request); the Source in use stays until the new
   * exploration ends well.
   */
  async exploreSource(
    context: RequestContext,
    input: {
      readonly environmentId: string;
      /** The agent that documents the system; the one of the last exploration when omitted. */
      readonly agentId?: string;
      /** Where the browser runs; a localhost environment runs on the user's computer. */
      readonly executionTarget?: E2eExecutionTarget;
    },
  ): Promise<E2eExploration> {
    const workspaceId = requireWorkspace(context);
    const environment = await this.findEnvironment(workspaceId, input.environmentId);
    const anchor = await this.options.store.getSourceAnchor(workspaceId);
    const agentId = input.agentId ?? anchor?.agentId;
    if (!agentId)
      throw new ApplicationError(
        'E2E_AGENT_REQUIRED',
        'Choose the agent that documents the system.',
        400,
        [{ field: 'agentId' }],
      );
    await this.options.agents.getAgent(workspaceId, agentId);
    const target = normalizeTargetUrl(environment.baseUrl);
    const executionTarget = this.options.runsLocally
      ? 'remote'
      : (input.executionTarget ??
        (isLoopback(target.baseUrl) ? 'local' : (this.options.defaultExecutionTarget ?? 'remote')));
    const settings = {
      agentId,
      baseUrl: target.baseUrl,
      localOrigin: null,
      executionTarget,
      path: '/',
      username: environment.username,
      passwordSecret: environment.passwordSecret,
      accessSecret: null,
      environmentId: environment.id,
      ownerId: context.ownerId ?? workspaceId,
      actorId: context.actorId ?? 'unknown',
      locale: resolveLocale(context.locale),
    };
    let creation: E2eCreation;
    if (anchor) {
      await this.assertIdle(anchor);
      creation = (await this.options.store.updateCreation(
        workspaceId,
        anchor.id,
        settings,
      )) as E2eCreation;
    } else
      creation = await this.options.store.createCreation({
        ...settings,
        workspaceId,
        name: 'Source',
        mode: 'frontend',
        scope: 'codebase',
        prd: '',
        prdFileNames: [],
        diff: null,
        instructions: null,
        repository: null,
        status: 'draft',
        useBrain: true,
        internal: true,
      });
    return this.explore(workspaceId, creation.id, context.actorId, { source: true });
  }

  /**
   * Writes the documentation of the Source again from what it already discovered, without
   * exploring. Runs on a worker; the documentation in use stays if the new one fails.
   */
  async documentSource(context: RequestContext): Promise<{ readonly busy: true }> {
    const workspaceId = requireWorkspace(context);
    const source = await this.requireSource(workspaceId);
    const anchor = await this.options.store.getSourceAnchor(workspaceId);
    const creation =
      anchor ?? (await this.options.store.getCreation(workspaceId, source.creationId));
    if (!creation)
      throw new ApplicationError(
        'E2E_SOURCE_RUN_MISSING',
        'The run that explored the Source no longer exists. Update the Source.',
        409,
      );
    await this.assertIdle(creation);
    // The documentation is written as the person asking and in their language.
    if (creation.internal)
      await this.options.store.updateCreation(workspaceId, creation.id, {
        ownerId: context.ownerId ?? workspaceId,
        actorId: context.actorId ?? 'unknown',
        locale: resolveLocale(context.locale),
      });
    await this.enqueue(creation, 'document', [], context.actorId);
    return { busy: true };
  }

  /**
   * What an MCP host needs to write the documentation of the system itself: what the agent
   * discovered, the Brain documents about the system and the rules to follow.
   */
  async sourceBrief(context: RequestContext) {
    const workspaceId = requireWorkspace(context);
    const source = await this.requireSource(workspaceId);
    const requester = {
      id: 'source',
      workspaceId,
      ownerId: context.ownerId ?? workspaceId,
      actorId: context.actorId ?? 'unknown',
      locale: resolveLocale(context.locale),
    };
    const documents = this.options.knowledge
      ? await searchSourceBrain(this.options.knowledge, requester, source.pages)
      : [];
    return {
      applicationUrl: source.startUrl,
      ...brainContext(documents),
      ...sourceDiscovery(source),
      rules: sourceRules(requester),
      responseFormat: SOURCE_RESPONSE_FORMAT,
      currentDocumentation: source.documentation,
    };
  }

  /** Keeps the documentation an MCP host wrote; it replaces the one in use. */
  async saveSourceDocumentation(
    workspaceId: string,
    input: z.input<typeof sourceDocumentationSchema> & {
      readonly brainDocuments?: readonly { readonly title: string; readonly source: string }[];
    },
  ): Promise<E2eSource> {
    const source = await this.requireSource(workspaceId);
    const parsed = sourceDocumentationSchema.parse(input);
    return this.options.store.saveSource({
      ...source,
      documentation: {
        ...parsed,
        brainDocuments: input.brainDocuments ?? [],
        generatedAt: new Date().toISOString(),
      },
      documentationError: null,
    });
  }

  private async requireSource(workspaceId: string): Promise<E2eSource> {
    const source = await this.options.store.getSource(workspaceId);
    if (!source)
      throw new ApplicationError(
        'E2E_SOURCE_NOT_FOUND',
        'The workspace has no Source yet. Explore the application first.',
        404,
      );
    return source;
  }

  /** JPEG of a page of the Source. */
  async sourceImage(workspaceId: string, page: number): Promise<Buffer> {
    return this.evidence(sourcePageKey(workspaceId, page));
  }

  /** Scripts of the finished explorations, newest first; one run's, or the whole workspace's. */
  async explorationScripts(workspaceId: string, creationId?: string) {
    if (creationId) await this.findCreation(workspaceId, creationId);
    return this.options.store.listExplorationScripts(workspaceId, creationId);
  }

  async explorationScript(workspaceId: string, id: string) {
    const script = await this.options.store.getExplorationScript(workspaceId, id);
    if (!script)
      throw new ApplicationError('E2E_EXPLORATION_NOT_FOUND', 'Exploration script not found.', 404);
    return script;
  }

  async deleteExplorationScript(workspaceId: string, id: string): Promise<void> {
    if (!(await this.options.store.deleteExplorationScript(workspaceId, id)))
      throw new ApplicationError('E2E_EXPLORATION_NOT_FOUND', 'Exploration script not found.', 404);
  }

  /**
   * The Playwright code of the last exploration: the one the user saved, or else the code made
   * from what the agent did. Only a finished exploration has code.
   */
  async explorationCode(
    workspaceId: string,
    id: string,
  ): Promise<{ readonly code: string; readonly edited: boolean }> {
    const creation = await this.findCreation(workspaceId, id);
    const saved = await this.options.artifacts.get(explorationCodeKey(creation));
    if (saved) return { code: saved.toString('utf8'), edited: true };
    const state = await this.finishedExploration(workspaceId, id);
    return { code: explorationCode(state, creation.name), edited: false };
  }

  /** Keeps the code the user edited; an empty code goes back to the one made from the log. */
  async saveExplorationCode(workspaceId: string, id: string, code: string) {
    const creation = await this.findCreation(workspaceId, id);
    await this.finishedExploration(workspaceId, id);
    if (code.trim())
      await this.options.artifacts.put(explorationCodeKey(creation), Buffer.from(code));
    else await this.options.artifacts.removePrefix(explorationCodeKey(creation));
    return this.explorationCode(workspaceId, id);
  }

  private async finishedExploration(workspaceId: string, id: string): Promise<E2eExploration> {
    const state = await this.exploration(workspaceId, id);
    if (!state || state.status === 'signing_in' || state.status === 'exploring')
      throw new ApplicationError(
        'E2E_EXPLORATION_NOT_READY',
        'The exploration has no code until it finishes.',
        409,
      );
    return state;
  }

  /** The recording of one browser of the last exploration. */
  async explorationVideo(
    workspaceId: string,
    id: string,
    worker: number,
  ): Promise<{ content: Buffer; mimeType: 'video/mp4' | 'video/webm' }> {
    const creation = await this.findCreation(workspaceId, id);
    const state = await readExploration(this.options.artifacts, creation);
    const video = state?.videos?.find((item) => item.worker === worker);
    const content = video
      ? await this.options.artifacts.get(explorationVideoKey(creation, worker, video.mimeType))
      : null;
    if (!video || !content)
      throw new ApplicationError('E2E_VIDEO_NOT_FOUND', 'No video for this exploration.', 404);
    return { content, mimeType: video.mimeType };
  }

  /** JPEG of a page the exploration captured, of one of its actions, or the latest frame of the agent's browser. */
  async explorationImage(
    workspaceId: string,
    id: string,
    page: number | 'live' | { readonly step: number },
  ): Promise<Buffer> {
    const creation = await this.findCreation(workspaceId, id);
    return this.evidence(
      page === 'live'
        ? explorationLiveKey(creation)
        : typeof page === 'object'
          ? explorationStepKey(creation, page.step)
          : explorationPageKey(creation, page),
    );
  }

  /**
   * The pages the run's tests went through, merged into one graph: which tests reached each
   * page, the elements they touched there and the order each test followed.
   */
  async actionMap(workspaceId: string, id: string): Promise<E2eActionMap> {
    await this.findCreation(workspaceId, id);
    const tests = await this.options.store.listTests(workspaceId, id);
    return buildActionMap(
      await Promise.all(
        tests.map(async (test) => ({
          test,
          trail: await this.readJson<E2eStoredTrail>(trailKey(test)),
          live:
            test.status === 'running'
              ? await this.readJson<E2eLiveActivity>(liveLabelKey(test))
              : null,
        })),
      ),
    );
  }

  /** JPEG of a page or element of the trail of the test's latest execution. */
  async trailImage(
    workspaceId: string,
    testId: string,
    kind: 'page' | 'element',
    index: number,
  ): Promise<Buffer> {
    return this.evidence(trailImageKey(await this.findTest(workspaceId, testId), kind, index));
  }

  /** JPEG of the browser of a test that is running right now. */
  async liveFrame(workspaceId: string, testId: string): Promise<Buffer> {
    return this.evidence(liveFrameKey(await this.findTest(workspaceId, testId)));
  }

  private async evidence(key: string): Promise<Buffer> {
    const content = await this.options.artifacts.get(key);
    if (!content)
      throw new ApplicationError('E2E_EVIDENCE_NOT_FOUND', 'This image is not available.', 404);
    return content;
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const content = await this.options.artifacts.get(key);
    if (!content) return null;
    try {
      return JSON.parse(content.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  private async findEnvironment(workspaceId: string, id: string): Promise<E2eEnvironment> {
    if (!this.options.environments)
      throw new ApplicationError('E2E_ENVIRONMENT_NOT_FOUND', 'Environment not found.', 404, [
        { field: 'environmentId' },
      ]);
    return this.options.environments.find(workspaceId, id);
  }

  /**
   * Writes the tests of a run that has none: the agent plans them from the PRD or the Brain, or,
   * with `savedCases`, they are the test cases saved in ADK (Test Plans), which are added to the
   * run and automated. The application is only read, never explored by the agent: that is asked
   * for on its own.
   */
  async generate(
    workspaceId: string,
    id: string,
    input: {
      readonly savedCases?: SavedCasesInput;
      /** Planning from this document instead of the one the run was created with. */
      readonly prd?: string;
      readonly prdFileNames?: readonly string[];
    } = {},
    actorId?: string,
  ): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    if (!input.savedCases) {
      // Planning again would replace the tests the user already has.
      if ((await this.options.store.listTests(workspaceId, id)).length)
        throw new ApplicationError('E2E_TESTS_EXIST', 'This run already has tests.', 409);
      if (!input.prd) requireTestSource(creation);
      const target = input.prd
        ? ((await this.options.store.updateCreation(workspaceId, id, {
            prd: input.prd,
            prdFileNames: [...(input.prdFileNames ?? [])],
            // A document written now is the source, not the Brain; its summary is rebuilt from it.
            useBrain: false,
            prdSummary: null,
          })) as E2eCreation)
        : creation;
      return this.requeue(target, 'generate', [], actorId);
    }
    const saved = await this.resolveSavedCases(workspaceId, input.savedCases);
    const tests = await this.options.store.appendTests(creation, saved.tests);
    const target =
      !creation.reporting && saved.reporting
        ? ((await this.options.store.updateCreation(workspaceId, id, {
            reporting: reportingTarget(saved.reporting),
          })) as E2eCreation)
        : creation;
    return this.requeue(
      target,
      'execute',
      tests.map((test) => test.id),
      actorId,
    );
  }

  /** `actorId` is who started it: a local run's browser work goes to that user's runner. */
  async rerun(
    workspaceId: string,
    id: string,
    actorId?: string,
    locale?: string,
  ): Promise<E2eCreationView> {
    const creation = await this.findCreation(workspaceId, id);
    await this.assertIdle(creation);
    const tests = await this.options.store.listTests(workspaceId, id);
    // A run that never produced tests (planning failed) starts over from the plan.
    if (!tests.length) {
      requireTestSource(creation);
      return this.requeue(creation, 'generate', [], actorId, locale);
    }
    return this.rerunTests(creation, tests, false, actorId, locale);
  }

  /**
   * Runs one test again. With `regenerate` its spec is rewritten and `guidance` tells the AI how:
   * the instructions are kept on the test for every later rewrite, and `useLastRun` hands it the
   * spec being replaced with what its last run produced (error, analysis, steps, output).
   * `environmentId` picks the saved environment the test runs with from now on (another account,
   * for instance); null goes back to the run's, and omitting it keeps what the test has.
   * `locale` is the language of the person asking: the report of this execution is written in it.
   */
  async rerunTest(
    workspaceId: string,
    testId: string,
    regenerate = false,
    actorId?: string,
    guidance: E2eRegenerationGuidance = {},
    environmentId?: string | null,
    locale?: string,
  ): Promise<E2eCreationView> {
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    await this.assertIdle(creation, test.id);
    if (environmentId !== undefined) {
      // Checked before anything changes, so an unknown environment leaves the test as it was.
      const environment = environmentId
        ? await this.findEnvironment(workspaceId, environmentId)
        : null;
      await this.options.store.updateTest(workspaceId, test.id, {
        environmentId: environment?.id ?? null,
      });
    }
    if (guidance.successCriteria !== undefined)
      await this.options.store.updateTest(workspaceId, test.id, {
        successCriteria: guidance.successCriteria.trim() || null,
      });
    // A step fix that never got to run (the AI failed) must not come back with a plain rerun.
    if (!regenerate && test.regenerationFeedback)
      await this.options.store.updateTest(workspaceId, test.id, { regenerationFeedback: null });
    if (regenerate) {
      const changes: E2eTestChanges = {};
      if (guidance.instructions !== undefined)
        changes.scriptInstructions = guidance.instructions.trim() || null;
      changes.regenerationFeedback = guidance.useLastRun
        ? await this.lastRunFeedback(creation, test)
        : null;
      await this.options.store.updateTest(workspaceId, test.id, changes);
      // The pictures of the new instructions are kept; those they no longer show are removed.
      if (guidance.instructions !== undefined)
        await syncItemFilesSafely(
          this.options.attachments,
          workspaceId,
          fileOwner('e2e-test', test.id),
          test.scriptInstructions,
          changes.scriptInstructions,
        );
    }
    return this.rerunTests(creation, [test], regenerate, actorId, locale);
  }

  /**
   * Fixes one failed step of a test: the AI rewrites only that step of its spec, from what the
   * user said about it (`instructions`, with images when they want) and what the last run
   * produced, and the test runs again. Every other step, the hooks and the instructions of the
   * test stay as they are. Images of the instructions are read when the job starts, so they stay
   * pending uploads (the sweep removes them an hour later) instead of belonging to the test.
   */
  async fixTestStep(
    workspaceId: string,
    testId: string,
    position: number,
    instructions: string,
    actorId?: string,
    locale?: string,
  ): Promise<E2eCreationView> {
    if (!this.options.author?.fixStep)
      throw new ApplicationError(
        'E2E_STEP_FIX_UNAVAILABLE',
        'Fixing a step with AI is not available.',
        503,
      );
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    await this.assertIdle(creation, test.id);
    const step = test.stepResults.find((item) => item.position === position);
    if (!step) throw new ApplicationError('E2E_STEP_NOT_FOUND', 'The test has no such step.', 404);
    const feedback = await this.readRunFeedback(creation, test);
    if (!feedback)
      throw new ApplicationError(
        'E2E_STEP_FIX_NO_SCRIPT',
        'The test has no script to fix yet; rewrite it instead.',
        409,
      );
    const fix: RegenerationFeedback = {
      ...feedback,
      step: { position, title: step.title, instructions: instructions.trim() },
    };
    await this.options.store.updateTest(workspaceId, test.id, {
      regenerationFeedback: JSON.stringify(fix),
    });
    // The spec stays linked: the executor rewrites the step in it before running it.
    return this.rerunTests(creation, [test], false, actorId, locale);
  }

  /**
   * One turn of "Fix with AI": the user talks to the AI (with images, when they want) about what
   * the test does wrong, and the AI answers and rewrites the test case to match. Nothing is saved
   * and nothing runs here: the user applies the case and then rewrites the spec from it.
   * `testCase` is the case as the user has it open, which may differ from the saved one.
   */
  async reviseTestCase(
    workspaceId: string,
    testId: string,
    input: {
      readonly messages: readonly E2eCaseChatMessage[];
      readonly testCase: E2eCaseDraft;
      /** Ids of the images uploaded as attachments in this conversation; the AI looks at them all. */
      readonly imageIds?: readonly string[];
    },
    locale?: string,
  ): Promise<E2eCaseRevision> {
    const { author, artifacts, scripts } = this.options;
    if (!author?.reviseCase)
      throw new ApplicationError(
        'E2E_CASE_CHAT_UNAVAILABLE',
        'Fixing a test case with AI is not available.',
        503,
      );
    const test = await this.findTest(workspaceId, testId);
    const creation = await this.findCreation(workspaceId, test.creationId);
    const script =
      test.scriptPath && creation.repository
        ? ((await scripts
            .readFile(workspaceId, creation.repository, test.scriptPath)
            .catch(() => null)) ?? '')
        : '';
    const images = await loadImageAttachments(
      artifacts,
      workspaceId,
      (input.imageIds ?? []).map((id) => ({
        id,
        name: 'image',
        kind: 'image' as const,
        scope: 'e2e' as const,
        source: 'adk' as const,
        url: attachmentFileUrl(id),
      })),
    );
    return author.reviseCase({
      creation: locale ? { ...creation, locale: resolveLocale(locale) } : creation,
      test,
      testCase: input.testCase,
      messages: input.messages,
      script,
      lastRun: test.lastRunAt ? buildRegenerationFeedback(test, script).problem : null,
      images,
    });
  }

  /** The spec a test has now and what its last run produced, as stored text; null without a spec. */
  private async lastRunFeedback(creation: E2eCreation, test: E2eTestCase): Promise<string | null> {
    const feedback = await this.readRunFeedback(creation, test);
    return feedback ? JSON.stringify(feedback) : null;
  }

  private async readRunFeedback(
    creation: E2eCreation,
    test: E2eTestCase,
  ): Promise<RegenerationFeedback | null> {
    if (!test.scriptPath) return null;
    const script = await this.options.scripts.readFile(
      creation.workspaceId,
      requireRepository(creation),
      test.scriptPath,
    );
    return script?.trim() ? buildRegenerationFeedback(test, script) : null;
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
    const tests = await this.options.store.listTests(workspaceId, id);
    await this.options.queue.cancel(workspaceId, id);
    await this.options.artifacts.removePrefix(`${workspaceId}/${id}`);
    await this.options.store.deleteCreation(workspaceId, id);
    // The pictures of the instructions of its tests go away with them.
    for (const test of tests)
      await syncItemFilesSafely(
        this.options.attachments,
        workspaceId,
        fileOwner('e2e-test', test.id),
        test.scriptInstructions,
        null,
      );
  }

  private async rerunTests(
    creation: E2eCreation,
    tests: readonly E2eTestCase[],
    regenerate: boolean,
    actorId: string | undefined,
    locale?: string,
  ): Promise<E2eCreationView> {
    for (const test of tests)
      await this.options.store.updateTest(creation.workspaceId, test.id, {
        status: 'pending',
        // The new execution decides afresh: neither the criteria nor the user's verdict outlive it.
        resultSource: 'run',
        resultNote: null,
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
      locale,
    );
  }

  private async requeue(
    creation: E2eCreation,
    kind: E2eJobKind,
    testIds: string[],
    actorId?: string,
    locale?: string,
  ): Promise<E2eCreationView> {
    const queued = (await this.options.store.updateCreation(creation.workspaceId, creation.id, {
      status: 'queued',
      error: null,
      finishedAt: null,
      // The AI analysis and the errors of this execution follow the language the person uses now.
      ...(locale ? { locale: resolveLocale(locale) } : {}),
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

  /**
   * Refuses while the run is working. With `testId` only that test's own execution (or one that
   * takes the whole run) counts: another test running never keeps this one from being changed.
   */
  private async assertIdle(creation: E2eCreation, testId?: string): Promise<void> {
    if (
      await this.options.queue.hasActive(
        creation.workspaceId,
        creation.id,
        testId === undefined ? {} : { testId },
      )
    )
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
    const executionTarget = this.options.runsLocally
      ? 'remote'
      : (input.executionTarget ?? this.options.defaultExecutionTarget ?? 'remote');
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
      useBrain: Boolean(input.useBrain),
      diff: diff || null,
      instructions: input.instructions?.trim() || null,
      repository: await this.resolveRepository(workspaceId, input.repository),
    };
  }

  private async resolveRepository(
    workspaceId: string,
    input: CreateE2eInput['repository'],
  ): Promise<E2eRepositoryRef> {
    if (input.provider === 'local') {
      // A folder of the computer running ADK: only where the app can read it (desktop).
      const { scripts } = this.options;
      if (!scripts.resolveFolder)
        throw new ApplicationError(
          'E2E_LOCAL_FOLDER_UNAVAILABLE',
          'Local folders are only available in the ADK desktop app.',
          409,
          [{ field: 'repository.provider' }],
        );
      const folder = await scripts.resolveFolder(input.id);
      return {
        provider: 'local',
        id: folder.id,
        name: folder.name,
        branch: input.branch.trim() || folder.defaultBranch,
        path: normalizeScriptFolder(input.path),
      };
    }
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
    const cases = await this.requireSavedCases().listSavedCases(workspaceId, input);
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
      return { ...testFromCase(external), ...savedCaseLink(item) };
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

  private async requireSavedCase(
    workspaceId: string,
    link: E2eSavedCaseLink,
  ): Promise<SavedCaseForRun> {
    const [found] = await this.requireSavedCases().listSavedCases(workspaceId, {
      planId: link.planId,
      caseIds: [link.caseId],
    });
    if (!found)
      throw new ApplicationError('E2E_SAVED_CASES_NOT_FOUND', 'No saved test case was found.', 404);
    return found;
  }

  private requireSavedCases(): SavedCaseReader {
    if (!this.options.savedCases)
      throw new ApplicationError(
        'E2E_SAVED_CASES_UNAVAILABLE',
        'Saved test cases are not available.',
        501,
      );
    return this.options.savedCases;
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

/**
 * A run is saved without a product document, so planning from what it holds needs one: without a
 * PRD or the Brain the AI would invent the tests.
 */
function requireTestSource(creation: Pick<E2eCreation, 'prd' | 'useBrain'>): void {
  if (!creation.prd.trim() && !creation.useBrain)
    throw new ApplicationError(
      'E2E_PRD_REQUIRED',
      'A product document is required to plan the tests: attach one when generating them.',
      400,
      [{ field: 'prd' }],
    );
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
  const { logs: _logs, videoKey, regenerationFeedback: _feedback, ...rest } = test;
  return { ...rest, stepResults: test.stepResults.map(toStepView), hasVideo: Boolean(videoKey) };
}

function toStepView(step: E2eStepResult): E2eStepView {
  const { screenshotKey, ...rest } = step;
  return { ...rest, hasScreenshot: Boolean(screenshotKey) };
}

/** The environment's password signs in the environment's account only. */
function environmentPassword(
  environment: E2eEnvironment | null,
  username: string | null,
): string | null {
  return environment && username && environment.username === username
    ? environment.passwordSecret
    : null;
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
  return {
    ...savedCaseContent(item),
    priority: 'medium',
    externalCase: null,
    ...savedCaseLink(item),
  };
}

/** Title, description and steps a test takes from the saved case it is linked to. */
function savedCaseContent(item: SavedCaseForRun): {
  title: string;
  description: string;
  steps: string[];
} {
  const description = htmlToText(item.description).slice(0, 2_000);
  return {
    title: item.title.slice(0, 200),
    description: description || `Automates the saved test case "${item.title}".`,
    steps: item.steps.map(describeStep),
  };
}

/** The link a test keeps to its saved case; absent when the reader did not say which plan holds it. */
function savedCaseLink(item: SavedCaseForRun): { savedCase?: E2eSavedCaseLink } {
  return item.planId ? { savedCase: { planId: item.planId, caseId: item.caseId } } : {};
}

function savedCaseKey(link: E2eSavedCaseLink): string {
  return `${link.planId}:${link.caseId}`;
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

/** What the run itself produced for a finished test, ignoring what the user or the criteria decided. */
function ranStatus(
  test: Pick<E2eTestCase, 'error' | 'stepResults'>,
): Extract<E2eTestStatus, 'passed' | 'failed'> {
  return test.error || test.stepResults.some((step) => step.status === 'failed')
    ? 'failed'
    : 'passed';
}

/** A test that never ran (or ended in an error of the platform) has no result to overrule. */
function assertReviewable(test: Pick<E2eTestCase, 'status' | 'lastRunAt'>): void {
  if (!['passed', 'failed'].includes(test.status) || !test.lastRunAt)
    throw new ApplicationError(
      'E2E_RESULT_NOT_REVIEWABLE',
      'The test has no finished result to review.',
      409,
    );
}

/** The step as the run left it, without what the user decided about it. */
function withoutManualVerdict(step: E2eStepResult): E2eStepResult {
  const ran = { ...step };
  delete ran.manualStatus;
  delete ran.manualNote;
  return ran;
}
