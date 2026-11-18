import { ApplicationError } from '../../../shared/errors.js';
import { decryptSecret } from '../../../shared/encryption.js';
import { decryptAccessToken } from './access-token.js';
import { resolveLocale, translateErrorMessage } from '../../../shared/i18n.js';
import {
  ACTIVE_CREATION_STATUSES,
  ACTIVE_TEST_STATUSES,
  HOOK_KINDS,
  HOOK_LABELS,
  hookFilePath,
  parseRegenerationFeedback,
  scriptFilePath,
  snapshotKey,
  stepEvidencePrefix,
  targetUrl,
  type E2eCreation,
  type E2eHookKind,
  type E2eRepositoryRef,
  type E2eStepResult,
  type E2eTestCase,
  type RegenerationStep,
} from '../domain/e2e.js';
import {
  liveFrameKey,
  liveLabelKey,
  trailImageKey,
  trailKey,
  trailPrefix,
  explorationPageKey,
  type E2eStoredTrail,
} from '../domain/e2e-insight.js';
import {
  scriptExploration,
  sourcePageKey,
  sourcePrefix,
  type E2eScriptExploration,
  type E2eSourceDocumentation,
} from '../domain/e2e-source.js';
import type {
  E2eEnvironment,
  E2eExplorationLogEntry,
  E2eExplorationPage,
} from '../domain/e2e-insight.js';
import type { E2eEnvironmentService } from './e2e-environments.js';
import { ExplorationRecorder, readExploration, type ExplorationKeeper } from './e2e-exploration.js';
import type { E2eRunReporter } from './e2e-reporter.js';
import { formatDuration, type RunNotifier } from '../../messaging/application/run-notifier.js';
import type { E2eArtifactStore } from './artifact-store.js';
import { MAX_CONTEXT_DOCUMENT, readExplorationContext } from './e2e-context.js';
import type { E2eExplorationContextDocument } from '../domain/e2e-insight.js';
import type { E2eAnalysis, E2eAuthor } from './e2e-author.js';
import { evidenceSteps, meetsCriteria, toLlmImages } from './e2e-judge.js';
import { jobScope, type E2eJob, type E2eJobQueue } from './e2e-queue.js';
import {
  E2eRunnerError,
  type E2eCredentials,
  type E2eExploreAgent,
  type E2eLiveFrame,
  type E2eRunHooks,
  type E2eRunResult,
  type E2eRunner,
  type E2eSnapshot,
  type E2eStepEvidence,
  type E2eTrail,
  type E2eVideoTranscoder,
} from './e2e-runner.js';
import type { E2eStore, E2eTestChanges } from './e2e-store.js';
import type { LocalE2eRunner } from './local-runner.js';
import type { E2eScriptRepository } from './script-repository.js';
import { checkScript } from './script-guard.js';
import { replaceStep, type StepSwap } from './script-steps.js';

export interface E2eExecutorOptions {
  readonly store: E2eStore;
  readonly author: E2eAuthor;
  readonly runner: E2eRunner;
  /** Executes runs whose target is `local` on the requesting user's computer. */
  readonly localRunner?: LocalE2eRunner | null;
  readonly artifacts: E2eArtifactStore;
  readonly scripts: E2eScriptRepository;
  /** How many times a failing script is rewritten when the AI blames the test itself. */
  readonly healAttempts?: number;
  /**
   * Tests of one execution that run at the same time, each in its own browser. Defaults to
   * `E2E_TEST_CONCURRENCY` or 3.
   */
  readonly testConcurrency?: number;
  /** Re-encodes WebM recordings to MP4; without it videos are stored as recorded. */
  readonly transcoder?: E2eVideoTranscoder | null;
  /** Sends results to the run's test management platform; without it nothing is reported. */
  readonly reporter?: Pick<E2eRunReporter, 'publish'> | null;
  /** Tells the workspace's paired chats (Telegram) that a run ended. */
  readonly notifier?: RunNotifier | null;
  /** The API runs on the user's computer (desktop app): every run uses this process's browser. */
  readonly runsLocally?: boolean;
  /**
   * Saved environments: their custom variables reach the specs of the runs that use them, and a
   * test with an environment of its own runs with that environment's address and account.
   */
  readonly environments?: Pick<E2eEnvironmentService, 'variables' | 'find'> | null;
  /**
   * The queue the jobs come from. A run's tests execute independently of each other, so a job
   * that runs one test asks it whether others are still working before it closes the run.
   * Without it a job is taken to be the only one.
   */
  readonly queue?: Pick<E2eJobQueue, 'hasActive'> | null;
}

type SnapshotProvider = () => Promise<E2eSnapshot | null>;

/** What an `explore` job leaves in the artifact store: the snapshot or why it failed. */
export type StoredSnapshot =
  | { readonly capturedAt: string; readonly snapshot: E2eSnapshot }
  | { readonly capturedAt: string; readonly error: string };

/** How long a snapshot of the application is reused to write scripts instead of reading it again. */
const SNAPSHOT_REUSE_MS = 30 * 60_000;

/** The snapshot an earlier capture stored, when it is recent enough and it did not fail. */
export function recentSnapshot(stored: unknown, now = Date.now()): E2eSnapshot | null {
  if (!stored || typeof stored !== 'object') return null;
  const { capturedAt, snapshot } = stored as Partial<
    Extract<StoredSnapshot, { snapshot: unknown }>
  >;
  if (!snapshot || typeof capturedAt !== 'string') return null;
  const age = now - Date.parse(capturedAt);
  return age >= 0 && age < SNAPSHOT_REUSE_MS ? snapshot : null;
}

class Cancelled extends Error {}

/** The parts of a job that say what it works on. */
type JobRef = Pick<E2eJob, 'workspaceId' | 'creationId'> &
  Partial<Pick<E2eJob, 'id' | 'kind' | 'testIds'>>;

/**
 * A job that works next to the others of its run instead of taking it whole: the one that runs a
 * single test (beside the run's other tests) and the one that explores the application.
 */
function runsOneTest(job: JobRef): boolean {
  return Boolean(job.kind && job.testIds && jobScope({ kind: job.kind, testIds: job.testIds }));
}

/**
 * Runs E2E jobs: explores the target, asks the AI for a plan and scripts, executes them
 * with Playwright and records results. Used by workers, never by HTTP handlers directly.
 */
export class E2eExecutor {
  private readonly healAttempts: number;
  private readonly testConcurrency: number;
  /** Commits to the repository go one at a time: two pushes to one branch would collide. */
  private repositoryWrites: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: E2eExecutorOptions) {
    this.healAttempts = options.healAttempts ?? 1;
    this.testConcurrency = Math.max(
      1,
      Math.floor(options.testConcurrency ?? (Number(process.env['E2E_TEST_CONCURRENCY']) || 3)),
    );
  }

  private writeToRepository(write: () => Promise<void>): Promise<void> {
    const turn = this.repositoryWrites.then(write, write);
    this.repositoryWrites = turn.catch(() => undefined);
    return turn;
  }

  /** Runs one claimed job; aborting the signal stops it at the next step. */
  async run(job: E2eJob, signal: AbortSignal): Promise<void> {
    const creation = await this.options.store.getCreation(job.workspaceId, job.creationId);
    if (!creation || signal.aborted) return;
    if (job.kind === 'generate') await this.generate(creation, job, signal);
    else if (job.kind === 'explore') await this.explore(creation, job, signal);
    else if (job.kind === 'publish') await this.publish(creation);
    else if (job.kind === 'document') await this.document(creation, signal);
    else await this.execute(creation, job, signal);
  }

  /**
   * The browser for this run: the worker's own, or the computer of the user who started the
   * job when the run executes locally. Orchestration (AI, healing, results) stays here.
   */
  private runnerFor(creation: E2eCreation, job: E2eJob, testId: string | null): E2eRunner {
    if (creation.executionTarget !== 'local' || this.options.runsLocally)
      return this.options.runner;
    if (!this.options.localRunner)
      throw new E2eRunnerError('E2E_LOCAL_RUNNER_UNAVAILABLE', 'Local runners are not enabled.');
    return this.options.localRunner.for({
      workspaceId: creation.workspaceId,
      creationId: creation.id,
      testId,
      userId: job.requestedBy ?? creation.actorId,
    });
  }

  /** Publishes on request; the run's own status is left alone. */
  private async publish(creation: E2eCreation): Promise<void> {
    if (creation.reporting && this.options.reporter) {
      await this.options.reporter.publish(creation, creation.reporting);
      return;
    }
    // The destination was cleared after the request: close the pending publication.
    if (creation.lastReport?.status === 'publishing')
      await this.options.store.updateCreation(creation.workspaceId, creation.id, {
        lastReport: {
          ...creation.lastReport,
          status: 'failed',
          error: translateErrorMessage('E2E_REPORTING_REQUIRED', resolveLocale(creation.locale)),
          updatedAt: new Date().toISOString(),
        },
      });
  }

  /** After a finished execution, reports it when the run asks for automatic publication. */
  private async autoPublish(creation: E2eCreation, testIds?: readonly string[]): Promise<void> {
    if (!creation.reporting?.autoPublish || !this.options.reporter) return;
    try {
      await this.options.reporter.publish(creation, creation.reporting, testIds);
    } catch (error) {
      console.error('[E2eExecutor] Publishing the results failed:', error);
    }
  }

  /** Marks the job's run as interrupted after its workers kept dying on it. */
  async interrupt(job: JobRef): Promise<void> {
    const creation = await this.options.store.getCreation(job.workspaceId, job.creationId);
    // Exploring for the MCP host never makes a run active, so there is nothing to fail.
    if (!creation || !ACTIVE_CREATION_STATUSES.includes(creation.status)) return;
    if (job.kind === 'explore') {
      // A test may be executing while the run is explored: the loss of the exploration fails none
      // of them, and the run is over once nothing else works on it.
      await this.settle(job);
      return;
    }
    if (await this.sharesRun(job)) {
      // Other tests of the run are still executing: only this job's test is lost.
      await closeActiveTests(
        this.options.store,
        creation,
        {
          status: 'error',
          error: translateErrorMessage('E2E_INTERRUPTED', resolveLocale(creation.locale)),
        },
        job.testIds,
      );
      return;
    }
    await markInterrupted(this.options.store, creation);
  }

  /**
   * After a job that ran a single test ended: the run is over once no other job works on it.
   * The jobs of one run end independently, so none of them can tell on its own that it was
   * the last; this runs once the job no longer counts as active.
   */
  async settle(job: JobRef): Promise<void> {
    if (!this.options.queue || !runsOneTest(job)) return;
    const creation = await this.options.store.getCreation(job.workspaceId, job.creationId);
    if (!creation || !ACTIVE_CREATION_STATUSES.includes(creation.status)) return;
    if (await this.options.queue.hasActive(job.workspaceId, job.creationId)) return;
    await this.options.store.updateCreation(job.workspaceId, job.creationId, {
      status: 'completed',
      finishedAt: new Date(),
    });
  }

  /** True when the job runs one test of a run and other jobs are still working on that run. */
  private async sharesRun(job: JobRef): Promise<boolean> {
    if (!this.options.queue || !runsOneTest(job)) return false;
    return this.options.queue.hasActive(job.workspaceId, job.creationId, { exceptJobId: job.id });
  }

  /**
   * Captures the application for a plan written by the MCP host (no AI involved). The
   * run's status is left alone; failures are stored so the brief can explain them.
   */
  private async explore(creation: E2eCreation, job: E2eJob, signal: AbortSignal): Promise<void> {
    let stored: StoredSnapshot;
    try {
      const snapshot = await this.exploreApplication(creation, job, signal);
      stored = { capturedAt: new Date().toISOString(), snapshot };
    } catch (error) {
      stored = {
        capturedAt: new Date().toISOString(),
        error: describeError(error, creation.locale),
      };
    }
    if (signal.aborted) return;
    await this.options.artifacts.put(
      snapshotKey(creation),
      Buffer.from(JSON.stringify(stored), 'utf8'),
    );
  }

  /**
   * Opens the application and reads it for the plan. The exploration of a UI signs in with the
   * run's test account and is recorded step by step, so it can be followed while it happens.
   */
  private async exploreApplication(
    creation: E2eCreation,
    job: E2eJob,
    signal: AbortSignal,
  ): Promise<E2eSnapshot> {
    const credentials = credentialsOf(creation);
    // The user's description of an explicit exploration waits in the run's state; the one
    // that precedes planning has none.
    const requested =
      job.kind === 'explore' ? await readExploration(this.options.artifacts, creation) : null;
    const description = requested?.description ?? null;
    const source = requested?.source === true;
    // A run's exploration is scoped to the tests of that run: the Source (the whole application)
    // is the only exploration that stays open.
    const focus = source ? description : await this.testsFocus(creation, description);
    // The agent explores only when it is asked to (an exploration job); planning tests reads the
    // application without it.
    const recorder =
      creation.mode === 'frontend' && job.kind === 'explore'
        ? await ExplorationRecorder.start(
            this.options.artifacts,
            creation,
            Boolean(credentials.username && credentials.password),
            Date.now,
            {
              description,
              source,
              // The recorder starts again here: what the exploration read stays on its state.
              ...(requested?.context ? { context: requested.context } : {}),
              ...(requested?.agent ? { agent: requested.agent } : {}),
              keep: source ? this.sourceKeeper(creation, signal) : this.explorationKeeper(),
              transcoder: this.options.transcoder ?? null,
            },
          )
        : null;
    try {
      // Only an exploration the user started carries context; the one before planning has none.
      const context =
        !source && job.kind === 'explore'
          ? await readExplorationContext(this.options.artifacts, creation)
          : [];
      // The Source maps the whole application: no test narrows it down.
      const tests = source
        ? []
        : (await this.options.store.listTests(creation.workspaceId, creation.id)).map((test) => ({
            code: test.code,
            title: test.title,
            description: test.description,
            steps: test.steps,
          }));
      const agent = recorder
        ? this.explorationAgent(creation, {
            description,
            source,
            signal,
            recorder,
            context,
            tests,
            agentId: requested?.agent?.id ?? null,
          })
        : undefined;
      const snapshot = await this.runnerFor(creation, job, null).explore({
        mode: creation.mode,
        url: targetUrl(creation),
        transportUrl: creation.localOrigin ? creation.baseUrl : undefined,
        signal,
        accessToken: decryptAccessToken(creation.accessSecret),
        credentials,
        ...(focus ? { focus } : {}),
        ...(agent ? { agent } : {}),
        ...(agent && tests.length
          ? { tests: tests.map((test) => ({ ...test, id: test.code })) }
          : {}),
        // The Source maps every flow of the application, not a sample of it.
        thorough: source,
        ...(recorder ? { onProgress: recorder.onProgress } : {}),
      });
      await recorder?.finish();
      return snapshot;
    } catch (error) {
      await recorder?.fail(describeError(error, creation.locale));
      throw error;
    }
  }

  /**
   * The AI agent that decides each step of the exploration like a person would, from the tests of
   * the run. Undefined when the author cannot, or when the browser is on another computer (the
   * local runner only receives a description of the exploration, not a way to ask the AI).
   */
  private explorationAgent(
    creation: E2eCreation,
    context: {
      description: string | null;
      source: boolean;
      signal: AbortSignal;
      recorder: ExplorationRecorder;
      context: readonly E2eExplorationContextDocument[];
      /** The tests the exploration is for; none for the Source. */
      tests: readonly { code: string; title: string; description: string; steps: string[] }[];
      /** The agent the user chose to explore; null for the agent of the run. */
      agentId: string | null;
    },
  ): E2eExploreAgent | undefined {
    const exploreStep = this.options.author.exploreStep?.bind(this.options.author);
    if (!exploreStep) return undefined;
    if (creation.executionTarget === 'local' && !this.options.runsLocally) {
      context.recorder.onProgress({
        kind: 'log',
        action: 'note',
        target: 'agent_unavailable',
        result: null,
      });
      return undefined;
    }
    const tests = context.tests;
    const instructions = context.description ?? creation.instructions ?? null;
    // What the user chose, and the specification the run was created with.
    const documents: E2eExplorationContextDocument[] = [
      ...context.context,
      ...(!context.source && creation.prd.trim()
        ? [
            {
              kind: 'spec' as const,
              id: creation.id,
              title: creation.name,
              content: creation.prd.slice(0, MAX_CONTEXT_DOCUMENT),
            },
          ]
        : []),
    ];
    // Parallel browsers each get the tests of their piece of work, so none repeats another's flows.
    return (observation, signal) =>
      exploreStep({
        creation,
        observation,
        tests: observation.assignment
          ? tests.filter((test) => observation.assignment!.tests.includes(test.code))
          : tests,
        instructions,
        context: documents,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        signal: signal ?? context.signal,
      });
  }

  /**
   * What a run's exploration looks for: its own tests (title, description and first steps) and
   * the user's description. Nothing outside the run gives it context. Null when the run has
   * neither, which leaves the exploration open.
   */
  private async testsFocus(
    creation: E2eCreation,
    description: string | null,
  ): Promise<string | null> {
    const tests = await this.options.store.listTests(creation.workspaceId, creation.id);
    const text = [
      description,
      ...tests.flatMap((test) => [test.title, test.description, ...test.steps.slice(0, 4)]),
    ]
      .filter(Boolean)
      .join(' ');
    return text || null;
  }

  /** Keeps what was read of the application for the next script to be written; best effort. */
  private async rememberSnapshot(creation: E2eCreation, snapshot: E2eSnapshot): Promise<void> {
    const stored: StoredSnapshot = { capturedAt: new Date().toISOString(), snapshot };
    await this.options.artifacts
      .put(snapshotKey(creation), Buffer.from(JSON.stringify(stored), 'utf8'))
      .catch((error: unknown) => console.error('[E2eExecutor] Snapshot not kept:', error));
  }

  /** Scripts of explorations are kept in the database only, never in the repository. */
  private explorationKeeper(): ExplorationKeeper {
    return async (script) => {
      await this.options.store.saveExplorationScript(script);
      return 'database';
    };
  }

  /**
   * Replaces the Source of the workspace with an exploration that ended well: its script and
   * pages go to the database and the pictures of its pages are copied out of the run, which
   * replaces its own on the next exploration. A failed exploration leaves the Source as it was.
   */
  private sourceKeeper(creation: E2eCreation, signal: AbortSignal): ExplorationKeeper {
    const { artifacts, store } = this.options;
    return async (script) => {
      if (script.status !== 'ready') return null;
      const { workspaceId } = creation;
      await artifacts.removePrefix(sourcePrefix(workspaceId));
      const pages = [];
      for (const page of script.pages) {
        const picture = await artifacts.get(explorationPageKey(creation, page.index));
        if (picture) await artifacts.put(sourcePageKey(workspaceId, page.index), picture);
        pages.push({ ...page, hasScreenshot: Boolean(picture) });
      }
      // The AI documents the system from the Brain and from what was just discovered. Without
      // it (no model, an unusable answer) the map is kept and the reason is shown.
      const { documentation, documentationError } = await this.writeDocumentation(
        creation,
        pages,
        script.script,
        signal,
      );
      await store.saveSource({
        workspaceId,
        creationId: creation.id,
        environmentId: creation.environmentId ?? null,
        startUrl: targetUrl(creation),
        signedInMs: script.signedInMs,
        script: script.script,
        pages,
        documentation,
        documentationError,
        startedAt: script.startedAt,
        finishedAt: script.finishedAt,
      });
      return 'source';
    };
  }

  /** The AI's documentation of the system, or why it could not be written; never throws. */
  private async writeDocumentation(
    creation: E2eCreation,
    pages: readonly E2eExplorationPage[],
    script: readonly E2eExplorationLogEntry[],
    signal: AbortSignal,
  ): Promise<{
    documentation: E2eSourceDocumentation | null;
    documentationError: string | null;
  }> {
    const { author } = this.options;
    if (!author.documentSource)
      return {
        documentation: null,
        documentationError: describeError(
          new ApplicationError(
            'E2E_SOURCE_AUTHOR_UNSUPPORTED',
            'This author cannot document the system.',
            503,
          ),
          creation.locale,
        ),
      };
    try {
      return {
        documentation: await author.documentSource({
          creation,
          startUrl: targetUrl(creation),
          pages,
          script,
          signal,
        }),
        documentationError: null,
      };
    } catch (error) {
      return { documentation: null, documentationError: describeError(error, creation.locale) };
    }
  }

  /**
   * Writes the documentation of the Source again from what it already discovered, without
   * exploring. The documentation in use stays when the new one cannot be written.
   */
  private async document(creation: E2eCreation, signal: AbortSignal): Promise<void> {
    const { store } = this.options;
    const source = await store.getSource(creation.workspaceId);
    if (!source) return;
    const { documentation, documentationError } = await this.writeDocumentation(
      creation,
      source.pages,
      source.script,
      signal,
    );
    if (signal.aborted) return;
    await store.saveSource({
      ...source,
      documentation: documentation ?? source.documentation,
      documentationError,
    });
  }

  private async generate(initial: E2eCreation, job: E2eJob, signal: AbortSignal): Promise<void> {
    const { store, author } = this.options;
    const startedAt = Date.now();
    let creation = initial;
    try {
      creation = await this.updateCreation(creation, { status: 'planning' }, signal);
      const snapshot = await this.exploreApplication(creation, job, signal);
      await this.rememberSnapshot(creation, snapshot);
      await this.checkpoint(creation, signal);
      const plan = await author.plan({ creation, snapshot, signal });
      ensureActive(signal);
      creation = await this.updateCreation(
        creation,
        { prdSummary: plan.summary, status: 'running' },
        signal,
      );
      const tests = await store.replaceTests(creation, plan.tests);
      await this.runTests(creation, job, tests, () => Promise.resolve(snapshot), signal);
      creation = await this.updateCreation(
        creation,
        { status: 'completed', finishedAt: new Date() },
        signal,
      );
    } catch (error) {
      await this.failCreation(creation, error, signal, startedAt);
      return;
    }
    await this.notifyFinished(creation, startedAt);
    await this.autoPublish(creation);
  }

  private async execute(initial: E2eCreation, job: E2eJob, signal: AbortSignal): Promise<void> {
    const { testIds } = job;
    const startedAt = Date.now();
    let creation = initial;
    let snapshot: Promise<E2eSnapshot | null> | undefined;
    // Opening the application to read it takes a browser and up to a minute; a snapshot taken a
    // few minutes ago (by the plan, or by the last rewrite of a script) is as good.
    const reusableSnapshot = async (): Promise<E2eSnapshot | null> => {
      const stored = await this.options.artifacts
        .get(snapshotKey(creation))
        .then((bytes) =>
          bytes ? (JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown) : null,
        )
        .catch(() => null);
      const recent = recentSnapshot(stored);
      if (recent) return recent;
      const fresh = await this.runnerFor(creation, job, null)
        .explore({
          mode: creation.mode,
          url: targetUrl(creation),
          transportUrl: creation.localOrigin ? creation.baseUrl : undefined,
          signal,
          accessToken: decryptAccessToken(creation.accessSecret),
        })
        .catch(() => null);
      if (fresh && !signal.aborted) await this.rememberSnapshot(creation, fresh);
      return fresh;
    };
    const snapshotProvider: SnapshotProvider = () => (snapshot ??= reusableSnapshot());
    try {
      creation = await this.updateCreation(creation, { status: 'running' }, signal);
      const tests = (await this.options.store.listTests(creation.workspaceId, creation.id)).filter(
        (test) => testIds.includes(test.id),
      );
      await this.runTests(creation, job, tests, snapshotProvider, signal);
      // Another test of the run may still be executing: the last job to end closes the run.
      if (!(await this.sharesRun(job)))
        creation = await this.updateCreation(
          creation,
          { status: 'completed', finishedAt: new Date() },
          signal,
        );
    } catch (error) {
      await this.failCreation(creation, error, signal, startedAt, job);
      return;
    }
    await this.notifyFinished(creation, startedAt, testIds);
    await this.autoPublish(creation, testIds);
  }

  private async runTests(
    creation: E2eCreation,
    job: E2eJob,
    tests: readonly E2eTestCase[],
    snapshot: SnapshotProvider,
    signal: AbortSignal,
  ): Promise<void> {
    // Each browser takes the next pending test as soon as it is free, so the run lasts about as
    // long as its slowest tests instead of the sum of all of them.
    const pending = [...tests];
    let stopped: unknown = null;
    const browser = async (): Promise<void> => {
      for (let test = pending.shift(); test && !stopped; test = pending.shift()) {
        try {
          await this.checkpoint(creation, signal);
          await this.runTest(creation, job, test, snapshot, signal);
        } catch (error) {
          if (signal.aborted || error instanceof Cancelled) {
            stopped ??= new Cancelled();
            return;
          }
          try {
            await this.options.store.updateTest(creation.workspaceId, test.id, {
              status: 'error',
              error: describeError(error, creation.locale),
            });
          } catch (storeError) {
            stopped ??= storeError;
            return;
          }
          // Without a browser (or a connected local runner) no remaining test can run either.
          if (error instanceof E2eRunnerError && STOPS_RUN.has(error.code)) {
            stopped ??= error;
            return;
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.testConcurrency, tests.length) }, browser),
    );
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrows whatever stopped the run (a cancellation is not an Error)
    if (stopped) throw stopped;
  }

  /**
   * The run as one of its tests sees it. A test with an environment of its own (another account,
   * for instance) opens that environment's address, signs in with its account and gets its
   * variables; without one, or when it was deleted since, it inherits the run's.
   */
  private async creationFor(creation: E2eCreation, test: E2eTestCase): Promise<E2eCreation> {
    const { environments } = this.options;
    if (!test.environmentId || test.environmentId === creation.environmentId || !environments)
      return creation;
    let environment: E2eEnvironment;
    try {
      environment = await environments.find(creation.workspaceId, test.environmentId);
    } catch (error) {
      if (error instanceof ApplicationError && error.code === 'E2E_ENVIRONMENT_NOT_FOUND')
        return creation;
      throw error;
    }
    // The tunnel origin and the Access token belong to the run's address, not to another one.
    const sameAddress = environment.baseUrl === creation.baseUrl;
    return {
      ...creation,
      environmentId: environment.id,
      baseUrl: environment.baseUrl,
      username: environment.username,
      passwordSecret: environment.passwordSecret,
      localOrigin: sameAddress ? creation.localOrigin : null,
      accessSecret: sameAddress ? creation.accessSecret : null,
    };
  }

  private async runTest(
    parent: E2eCreation,
    job: E2eJob,
    initial: E2eTestCase,
    snapshot: SnapshotProvider,
    signal: AbortSignal,
  ): Promise<void> {
    let test = initial;
    const creation = await this.creationFor(parent, initial);
    const repository = requireRepository(creation);
    // The repository is the source of truth: run whatever the branch holds right now.
    let script = test.scriptPath
      ? await this.options.scripts.readFile(creation.workspaceId, repository, test.scriptPath)
      : null;
    let hooks: E2eRunHooks;
    if (script === null) {
      // A new or regenerated spec comes with the Before Run and After Run of its test case.
      hooks = await this.authorHooks(creation, test, snapshot, signal);
      // A rewrite the user asked for may start from the spec it replaces and its last run.
      const feedback = parseRegenerationFeedback(test.regenerationFeedback);
      script = await this.authorScript(
        creation,
        test,
        snapshot,
        feedback ?? undefined,
        signal,
        hooks,
      );
      test = { ...test, scriptPath: scriptFilePath(repository.path, test) };
    } else {
      const check = checkScript(script);
      if (!check.ok)
        throw new ApplicationError('E2E_SCRIPT_REJECTED', check.violations.join('; '), 422);
      hooks = await this.readHooks(creation, test);
      // The user asked for one step of this spec to be rewritten: the rest of it is kept.
      const fix = parseRegenerationFeedback(test.regenerationFeedback)?.step;
      if (fix) script = await this.authorStepFix(creation, test, script, fix, hooks, signal);
    }
    // What the rewrite was asked from is used up: a later run starts afresh.
    if (test.regenerationFeedback) {
      test = { ...test, regenerationFeedback: null };
      await this.options.store.updateTest(creation.workspaceId, test.id, {
        regenerationFeedback: null,
      });
    }
    let result = await this.runOnce(creation, job, test, script, hooks, signal);
    test = { ...test, attempts: test.attempts + 1 };
    let analysis = await this.analyze(creation, test, script, hooks, result, signal);

    // A failure that the user's own success criteria excuse is a pass: it is neither rewritten
    // nor run again, so what is already built is kept. Hooks that fail never count as one.
    const accepted = (): boolean =>
      result.status === 'failed' && !isHookFailure(result) && meetsCriteria(test, analysis);

    // Rewriting the spec cannot fix a failing Before Run or After Run.
    for (
      let heal = 0;
      heal < this.healAttempts &&
      analysis?.verdict === 'test_issue' &&
      !isHookFailure(result) &&
      !accepted();
      heal++
    ) {
      script = await this.authorScript(
        creation,
        test,
        snapshot,
        { script, problem: `${result.error ?? ''}\n\n${analysis.summary}` },
        signal,
        hooks,
      );
      result = await this.runOnce(creation, job, test, script, hooks, signal);
      test = { ...test, attempts: test.attempts + 1 };
      analysis = await this.analyze(creation, test, script, hooks, result, signal);
    }

    ensureActive(signal);
    const videoKey = await this.replaceVideo(creation, initial, result.video);
    const stepResults = await this.replaceStepEvidence(initial, result.steps);
    await this.replaceTrail(initial, result.trail ?? null);
    const byCriteria = accepted();
    await this.options.store.updateTest(creation.workspaceId, test.id, {
      status: byCriteria ? 'passed' : result.status,
      resultSource: byCriteria ? 'criteria' : 'run',
      resultNote: null,
      error: result.error,
      analysis: analysis?.summary ?? null,
      verdict: analysis?.verdict ?? null,
      logs: result.logs,
      durationMs: result.durationMs,
      executedOn: result.executedOn ?? null,
      videoKey,
      stepResults,
    });
  }

  /** Keeps only the latest execution's screenshots, one per top-level step. */
  private async replaceStepEvidence(
    test: E2eTestCase,
    steps: readonly E2eStepEvidence[],
  ): Promise<E2eStepResult[]> {
    const prefix = stepEvidencePrefix(test);
    await this.options.artifacts.removePrefix(prefix);
    const results: E2eStepResult[] = [];
    for (const step of steps) {
      let screenshotKey: string | null = null;
      if (step.screenshot) {
        screenshotKey = `${prefix}/${String(step.position).padStart(2, '0')}.png`;
        await this.options.artifacts.put(screenshotKey, step.screenshot);
      }
      results.push({
        position: step.position,
        title: step.title,
        status: step.status,
        durationMs: step.durationMs,
        error: step.error,
        screenshotKey,
      });
    }
    return results;
  }

  /**
   * Keeps the trail of the latest execution only: what the test touched, with one image per
   * screen and per element. A test that left none (API tests, local runs) loses its old one.
   */
  private async replaceTrail(test: E2eTestCase, trail: E2eTrail | null): Promise<void> {
    const { artifacts } = this.options;
    await artifacts.removePrefix(trailPrefix(test));
    if (!trail) return;
    for (const page of trail.pages)
      if (page.screenshot)
        await artifacts.put(trailImageKey(test, 'page', page.index), page.screenshot);
    for (const element of trail.elements)
      if (element.screenshot)
        await artifacts.put(trailImageKey(test, 'element', element.index), element.screenshot);
    const stored: E2eStoredTrail = {
      pages: trail.pages.map(({ screenshot, ...page }) => ({
        ...page,
        hasScreenshot: Boolean(screenshot),
      })),
      elements: trail.elements.map(({ screenshot, ...element }) => ({
        ...element,
        hasScreenshot: Boolean(screenshot),
      })),
      touches: [...trail.touches],
      visits: [...trail.visits],
    };
    await artifacts.put(trailKey(test), Buffer.from(JSON.stringify(stored), 'utf8'));
  }

  /** The latest frame of a running test and the action it is on, for the run's live view. */
  private async storeLive(test: E2eTestCase, frame: E2eLiveFrame): Promise<void> {
    await this.options.artifacts.put(liveFrameKey(test), frame.image);
    await this.options.artifacts.put(
      liveLabelKey(test),
      Buffer.from(JSON.stringify(frame.activity), 'utf8'),
    );
  }

  private async replaceVideo(
    creation: E2eCreation,
    test: E2eTestCase,
    video: Uint8Array | null,
  ): Promise<string | null> {
    let key: string | null = null;
    if (video) {
      const mp4 = await this.options.transcoder?.toMp4(video);
      key = `${creation.workspaceId}/${creation.id}/${test.id}.${mp4 ? 'mp4' : 'webm'}`;
      await this.options.artifacts.put(key, mp4 ?? video);
    }
    if (test.videoKey && test.videoKey !== key)
      await this.options.artifacts.removePrefix(test.videoKey);
    return key;
  }

  /**
   * What the AI agent found exploring the site, for the author of a script: the exploration of
   * this run and the Source of the workspace. While the run is being explored again, what it has
   * found so far is not used: the last exploration that finished stands in for it, and when there
   * is none the script is written without. Never blocks a script: a failure to read them leaves
   * the script written without.
   */
  private async explorationContext(creation: E2eCreation): Promise<E2eScriptExploration | null> {
    try {
      const own = await readExploration(this.options.artifacts, creation);
      const finished =
        own?.status === 'ready'
          ? { pages: own.pages, script: own.log }
          : await this.lastFinishedExploration(creation).catch(() => null);
      const source = await this.options.store.getSource(creation.workspaceId);
      return scriptExploration([finished, source]);
    } catch {
      return null;
    }
  }

  /** The newest exploration of the run that ended well; its state is gone once a new one starts. */
  private async lastFinishedExploration(creation: E2eCreation) {
    const scripts = await this.options.store.listExplorationScripts(
      creation.workspaceId,
      creation.id,
    );
    return scripts.find((script) => script.status === 'ready') ?? null;
  }

  private async authorScript(
    creation: E2eCreation,
    test: E2eTestCase,
    snapshot: SnapshotProvider,
    previous: { script: string; problem: string } | undefined,
    signal: AbortSignal,
    hooks: E2eRunHooks,
  ): Promise<string> {
    const { store, author } = this.options;
    await this.updateTest(creation, test.id, { status: 'generating' }, signal);
    const context = await snapshot();
    const exploration = await this.explorationContext(creation);
    const names = Object.keys(await this.variablesOf(creation));
    const variables = names.length ? { variableNames: names } : {};
    let script = await author.writeScript({
      creation,
      test,
      snapshot: context,
      exploration,
      previous,
      hooks,
      signal,
      ...variables,
    });
    let check = checkScript(script);
    if (!check.ok) {
      script = await author.writeScript({
        creation,
        test,
        snapshot: context,
        exploration,
        previous: {
          script,
          problem: `The script was rejected by the security checks: ${check.violations.join('; ')}.`,
        },
        hooks,
        signal,
        ...variables,
      });
      check = checkScript(script);
    }
    ensureActive(signal);
    if (!check.ok)
      throw new ApplicationError('E2E_SCRIPT_REJECTED', check.violations.join('; '), 422);
    const repository = requireRepository(creation);
    const path = test.scriptPath ?? scriptFilePath(repository.path, test);
    await this.writeToRepository(() =>
      this.options.scripts.writeFile(
        creation.workspaceId,
        repository,
        path,
        script,
        `test(e2e): ${previous ? 'fix' : 'add'} ${test.code} - ${test.title}`,
      ),
    );
    await store.updateTest(creation.workspaceId, test.id, { scriptPath: path });
    return script;
  }

  /**
   * Rewrites one top-level step of the spec the user asked to fix and commits the result. The AI
   * gets the user's words, what the last run produced and the screen where the step stopped; a
   * file the security checks reject is tried once more.
   */
  private async authorStepFix(
    creation: E2eCreation,
    test: E2eTestCase,
    current: string,
    fix: RegenerationStep,
    hooks: E2eRunHooks,
    signal: AbortSignal,
  ): Promise<string> {
    const { author, artifacts, scripts } = this.options;
    if (!author.fixStep)
      throw new ApplicationError(
        'E2E_STEP_FIX_UNAVAILABLE',
        'Fixing a step with AI is not available.',
        503,
      );
    await this.updateTest(creation, test.id, { status: 'generating' }, signal);
    const feedback = parseRegenerationFeedback(test.regenerationFeedback);
    const names = Object.keys(await this.variablesOf(creation));
    // The screenshots of the last run stay until this execution replaces them.
    const screen = await artifacts
      .get(`${stepEvidencePrefix(test)}/${String(fix.position).padStart(2, '0')}.png`)
      .catch(() => null);
    const request = {
      creation,
      test,
      script: current,
      step: { position: fix.position, title: fix.title },
      instructions: fix.instructions,
      problem: feedback?.problem ?? '',
      images: toLlmImages([screen]),
      hooks,
      signal,
      ...(names.length ? { variableNames: names } : {}),
    };
    // The AI answers with the step alone and it is put back in the spec here, so the login, the
    // helpers and the other steps are never rewritten, whatever the model does.
    let rewritten = await author.fixStep(request);
    let result = this.swapStep(current, fix.position, rewritten);
    if (!result.ok) {
      rewritten = await author.fixStep({
        ...request,
        previous: { script: rewritten, problem: result.problem },
      });
      result = this.swapStep(current, fix.position, rewritten);
    }
    ensureActive(signal);
    if (!result.ok) throw new ApplicationError('E2E_SCRIPT_REJECTED', result.problem, 422);
    const script = result.script;
    const repository = requireRepository(creation);
    const path = test.scriptPath ?? scriptFilePath(repository.path, test);
    await this.writeToRepository(() =>
      scripts.writeFile(
        creation.workspaceId,
        repository,
        path,
        script,
        `test(e2e): fix step ${fix.position} of ${test.code} - ${test.title}`,
      ),
    );
    return script;
  }

  /** The spec with the rewritten step in place, or what is wrong with the answer of the AI. */
  private swapStep(current: string, position: number, rewritten: string): StepSwap {
    const swapped = replaceStep(current, position, rewritten);
    if (!swapped.ok) return swapped;
    const check = checkScript(swapped.script);
    return check.ok
      ? swapped
      : {
          ok: false,
          problem: `The script was rejected by the security checks: ${check.violations.join('; ')}.`,
        };
  }

  /** The Before Run and After Run committed next to the test's spec; blank files count as none. */
  private async readHooks(creation: E2eCreation, test: E2eTestCase): Promise<E2eRunHooks> {
    const repository = requireRepository(creation);
    const specPath = test.scriptPath ?? scriptFilePath(repository.path, test);
    const [beforeRun, afterRun] = await Promise.all(
      HOOK_KINDS.map(async (kind) => {
        const content = await this.options.scripts.readFile(
          creation.workspaceId,
          repository,
          hookFilePath(specPath, kind),
        );
        if (!content?.trim()) return null;
        const check = checkScript(content, 'hook');
        if (!check.ok)
          throw new ApplicationError(
            'E2E_SCRIPT_REJECTED',
            `${HOOK_LABELS[kind]}: ${check.violations.join('; ')}`,
            422,
          );
        return content;
      }),
    );
    return { beforeRun: beforeRun ?? null, afterRun: afterRun ?? null };
  }

  /**
   * Writes the Before Run and After Run of a test from its test case and commits them next to
   * the spec. When the author finds nothing to prepare or clean up, what the repository already
   * holds is kept.
   */
  private async authorHooks(
    creation: E2eCreation,
    test: E2eTestCase,
    snapshot: SnapshotProvider,
    signal: AbortSignal,
  ): Promise<E2eRunHooks> {
    const { author, scripts } = this.options;
    if (!author.writeHook) return this.readHooks(creation, test);
    await this.updateTest(creation, test.id, { status: 'generating' }, signal);
    const repository = requireRepository(creation);
    const specPath = test.scriptPath ?? scriptFilePath(repository.path, test);
    const context = await snapshot();
    // Both hooks are written at once: each is an AI call of its own and they find their records
    // by the name that carries the test code, so After Run does not have to wait for Before Run.
    const authored = await Promise.all(
      HOOK_KINDS.map(async (kind): Promise<string | null> => {
        const request = { creation, test, kind, snapshot: context, signal };
        let hook = await author.writeHook!(request);
        let check = hook ? checkScript(hook, 'hook') : null;
        if (hook && check && !check.ok) {
          hook = await author.writeHook!({
            ...request,
            previous: {
              script: hook,
              problem: `The script was rejected by the security checks: ${check.violations.join('; ')}.`,
            },
          });
          check = hook ? checkScript(hook, 'hook') : null;
        }
        ensureActive(signal);
        if (!hook) return null;
        if (check && !check.ok)
          throw new ApplicationError(
            'E2E_SCRIPT_REJECTED',
            `${HOOK_LABELS[kind]}: ${check.violations.join('; ')}`,
            422,
          );
        await this.writeToRepository(() =>
          scripts.writeFile(
            creation.workspaceId,
            repository,
            hookFilePath(specPath, kind),
            hook,
            `test(e2e): add ${HOOK_LABELS[kind]} of ${test.code} - ${test.title}`,
          ),
        );
        return hook;
      }),
    );
    const written: Record<E2eHookKind, string | null> = {
      beforeRun: authored[HOOK_KINDS.indexOf('beforeRun')] ?? null,
      afterRun: authored[HOOK_KINDS.indexOf('afterRun')] ?? null,
    };
    const stored = await this.readHooks(creation, test);
    return {
      beforeRun: written.beforeRun ?? stored.beforeRun,
      afterRun: written.afterRun ?? stored.afterRun,
    };
  }

  private async runOnce(
    creation: E2eCreation,
    job: E2eJob,
    test: E2eTestCase,
    script: string,
    hooks: E2eRunHooks,
    signal: AbortSignal,
  ): Promise<E2eRunResult> {
    await this.updateTest(
      creation,
      test.id,
      { status: 'running', attempts: test.attempts + 1, lastRunAt: new Date() },
      signal,
    );
    const { artifacts } = this.options;
    // Frames are stored one after the other, so the last one written is the latest.
    let live: Promise<void> = Promise.resolve();
    let result: E2eRunResult;
    try {
      result = await this.runnerFor(creation, job, test.id).run({
        script,
        hooks,
        mode: creation.mode,
        baseUrl: creation.baseUrl,
        localOrigin: creation.localOrigin,
        locale: creation.locale,
        credentials: credentialsOf(creation),
        accessToken: decryptAccessToken(creation.accessSecret),
        signal,
        variables: await this.variablesOf(creation),
        onLive: (frame) => {
          live = live
            .then(() => this.storeLive(test, frame))
            .catch((error: unknown) => console.error('[E2eExecutor] Live frame lost:', error));
        },
      });
    } finally {
      await live;
      await artifacts.removePrefix(liveFrameKey(test));
      await artifacts.removePrefix(liveLabelKey(test));
    }
    ensureActive(signal);
    return result;
  }

  /** Custom variables of the environment the run was configured from. */
  private async variablesOf(creation: E2eCreation): Promise<Record<string, string>> {
    return (
      (await this.options.environments?.variables(creation.workspaceId, creation.environmentId)) ??
      {}
    );
  }

  private async analyze(
    creation: E2eCreation,
    test: E2eTestCase,
    script: string,
    hooks: E2eRunHooks,
    result: E2eRunResult,
    signal: AbortSignal,
  ): Promise<E2eAnalysis | null> {
    if (result.status === 'passed') return null;
    // With success criteria the judge looks at the screens too: that is what tells a script that
    // tripped on a technicality from a defect.
    const criteria = Boolean(test.successCriteria?.trim());
    try {
      return await this.options.author.analyze({
        creation,
        test,
        script,
        hooks,
        error: result.error ?? '',
        logs: result.logs,
        steps: result.steps,
        ...(criteria
          ? { images: toLlmImages(evidenceSteps(result.steps).map((step) => step.screenshot)) }
          : {}),
        signal,
      });
    } catch (error) {
      ensureActive(signal);
      console.error('[E2eService] Failure analysis failed:', error);
      return null;
    }
  }

  private async failCreation(
    creation: E2eCreation,
    error: unknown,
    signal: AbortSignal,
    startedAt?: number,
    job?: E2eJob,
  ): Promise<void> {
    if (signal.aborted || error instanceof Cancelled) return;
    const message = describeError(error, creation.locale);
    // A job that runs one test never fails the tests, nor the run, that others are working on.
    const alone = !job || !(await this.sharesRun(job));
    if (alone)
      await this.options.store.updateCreation(creation.workspaceId, creation.id, {
        status: 'failed',
        error: message,
        finishedAt: new Date(),
      });
    await closeActiveTests(
      this.options.store,
      creation,
      { status: 'error', error: message },
      job && runsOneTest(job) ? job.testIds : undefined,
    );
    if (startedAt !== undefined)
      await this.options.notifier?.runFinished({
        workspaceId: creation.workspaceId,
        kind: 'e2e',
        name: creation.name,
        status: 'error',
        summary: message.split('\n')[0]!.slice(0, 300),
      });
  }

  /** Counts the tests of a finished execution for the paired chats. */
  private async notifyFinished(
    creation: E2eCreation,
    startedAt: number,
    testIds?: readonly string[],
  ): Promise<void> {
    if (!this.options.notifier) return;
    const tests = (await this.options.store.listTests(creation.workspaceId, creation.id)).filter(
      (test) => !testIds || testIds.includes(test.id),
    );
    const passed = tests.filter((test) => test.status === 'passed').length;
    await this.options.notifier.runFinished({
      workspaceId: creation.workspaceId,
      kind: 'e2e',
      name: creation.name,
      status: passed === tests.length ? 'passed' : 'failed',
      summary: `${passed}/${tests.length} passed · ${formatDuration(Date.now() - startedAt)}`,
    });
  }

  /**
   * Before each expensive step (AI calls, browser runs): stop if the run was cancelled or
   * deleted, without waiting for the next heartbeat to notice.
   */
  private async checkpoint(creation: E2eCreation, signal: AbortSignal): Promise<void> {
    ensureActive(signal);
    const current = await this.options.store.getCreation(creation.workspaceId, creation.id);
    if (!current || current.status === 'cancelled') throw new Cancelled();
  }

  private async updateCreation(
    creation: E2eCreation,
    changes: Parameters<E2eStore['updateCreation']>[2],
    signal: AbortSignal,
  ): Promise<E2eCreation> {
    ensureActive(signal);
    const updated = await this.options.store.updateCreation(
      creation.workspaceId,
      creation.id,
      changes,
    );
    // Deleted while running: stop quietly.
    if (!updated) throw new Cancelled();
    return updated;
  }

  private async updateTest(
    creation: E2eCreation,
    testId: string,
    changes: E2eTestChanges,
    signal: AbortSignal,
  ): Promise<void> {
    ensureActive(signal);
    await this.options.store.updateTest(creation.workspaceId, testId, changes);
  }
}

/** Runner failures that every remaining test of the run would hit too. */
const STOPS_RUN = new Set<E2eRunnerError['code']>([
  'E2E_BROWSER_NOT_INSTALLED',
  'E2E_LOCAL_RUNNER_UNAVAILABLE',
  'E2E_LOCAL_RUNNER_LOST',
]);

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled();
}

/** The runner prefixes errors of Before Run and After Run with their name. */
function isHookFailure(result: E2eRunResult): boolean {
  return Object.values(HOOK_LABELS).some((label) => result.error?.includes(`${label}: `));
}

function credentialsOf(creation: E2eCreation): E2eCredentials {
  return {
    username: creation.username,
    password: creation.passwordSecret ? decryptSecret(creation.passwordSecret) : null,
  };
}

/** Fails a run whose execution was lost (worker crash or restart). */
export async function markInterrupted(store: E2eStore, creation: E2eCreation): Promise<void> {
  const message = translateErrorMessage('E2E_INTERRUPTED', resolveLocale(creation.locale));
  await store.updateCreation(creation.workspaceId, creation.id, {
    status: 'failed',
    error: message,
    finishedAt: new Date(),
  });
  await closeActiveTests(store, creation, { status: 'error', error: message });
}

/**
 * Puts every pending or running test of a run in a final state; with `only`, just those tests,
 * so the tests another job is executing are left alone.
 */
export async function closeActiveTests(
  store: E2eStore,
  creation: E2eCreation,
  changes: E2eTestChanges,
  only?: readonly string[],
): Promise<void> {
  for (const test of await store.listTests(creation.workspaceId, creation.id))
    if (ACTIVE_TEST_STATUSES.includes(test.status) && (!only || only.includes(test.id)))
      await store.updateTest(creation.workspaceId, test.id, changes);
}

export function requireRepository(creation: E2eCreation): E2eRepositoryRef {
  if (!creation.repository)
    throw new ApplicationError(
      'E2E_REPOSITORY_REQUIRED',
      'This run has no repository for its scripts.',
      409,
    );
  return creation.repository;
}

export function describeError(error: unknown, locale: string): string {
  const resolved = resolveLocale(locale);
  if (error instanceof E2eRunnerError) {
    const message = translateErrorMessage(error.code, resolved);
    return error.code === 'E2E_BROWSER_NOT_INSTALLED' ? message : `${message} ${error.message}`;
  }
  if (error instanceof ApplicationError) {
    const message = translateErrorMessage(error.code, resolved, error.technicalMessage);
    const detailed =
      ['E2E_SCRIPT_REJECTED', 'E2E_REPOSITORY_ERROR'].includes(error.code) ||
      error.code.startsWith('LLM_');
    return detailed && message !== error.technicalMessage
      ? `${message} (${error.technicalMessage})`
      : message;
  }
  return error instanceof Error ? error.message : String(error);
}
