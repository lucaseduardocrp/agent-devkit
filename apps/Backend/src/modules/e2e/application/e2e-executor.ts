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
  scriptFilePath,
  snapshotKey,
  stepEvidencePrefix,
  targetUrl,
  type E2eCreation,
  type E2eHookKind,
  type E2eRepositoryRef,
  type E2eStepResult,
  type E2eTestCase,
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
import { sourcePageKey, sourcePrefix, type E2eSourceDocumentation } from '../domain/e2e-source.js';
import type { E2eExplorationLogEntry, E2eExplorationPage } from '../domain/e2e-insight.js';
import type { E2eEnvironmentService } from './e2e-environments.js';
import { ExplorationRecorder, readExploration, type ExplorationKeeper } from './e2e-exploration.js';
import type { E2eRunReporter } from './e2e-reporter.js';
import { formatDuration, type RunNotifier } from '../../messaging/application/run-notifier.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eAnalysis, E2eAuthor } from './e2e-author.js';
import type { E2eJob } from './e2e-queue.js';
import {
  E2eRunnerError,
  type E2eCredentials,
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
  /** Re-encodes WebM recordings to MP4; without it videos are stored as recorded. */
  readonly transcoder?: E2eVideoTranscoder | null;
  /** Sends results to the run's test management platform; without it nothing is reported. */
  readonly reporter?: Pick<E2eRunReporter, 'publish'> | null;
  /** Tells the workspace's paired chats (Telegram) that a run ended. */
  readonly notifier?: RunNotifier | null;
  /** The API runs on the user's computer (desktop app): every run uses this process's browser. */
  readonly runsLocally?: boolean;
  /** Saved environments: their custom variables reach the specs of the runs that use them. */
  readonly environments?: Pick<E2eEnvironmentService, 'variables'> | null;
}

type SnapshotProvider = () => Promise<E2eSnapshot | null>;

/** What an `explore` job leaves in the artifact store: the snapshot or why it failed. */
export type StoredSnapshot =
  | { readonly capturedAt: string; readonly snapshot: E2eSnapshot }
  | { readonly capturedAt: string; readonly error: string };

class Cancelled extends Error {}

/**
 * Runs E2E jobs: explores the target, asks the AI for a plan and scripts, executes them
 * with Playwright and records results. Used by workers, never by HTTP handlers directly.
 */
export class E2eExecutor {
  private readonly healAttempts: number;

  constructor(private readonly options: E2eExecutorOptions) {
    this.healAttempts = options.healAttempts ?? 1;
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
  async interrupt(job: Pick<E2eJob, 'workspaceId' | 'creationId'>): Promise<void> {
    const creation = await this.options.store.getCreation(job.workspaceId, job.creationId);
    // Exploring for the MCP host never makes a run active, so there is nothing to fail.
    if (creation && ACTIVE_CREATION_STATUSES.includes(creation.status))
      await markInterrupted(this.options.store, creation);
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
    const recorder =
      creation.mode === 'frontend'
        ? await ExplorationRecorder.start(
            this.options.artifacts,
            creation,
            Boolean(credentials.username && credentials.password),
            Date.now,
            {
              description,
              source,
              keep: source ? this.sourceKeeper(creation, signal) : this.explorationKeeper(),
            },
          )
        : null;
    try {
      const snapshot = await this.runnerFor(creation, job, null).explore({
        mode: creation.mode,
        url: targetUrl(creation),
        transportUrl: creation.localOrigin ? creation.baseUrl : undefined,
        signal,
        accessToken: decryptAccessToken(creation.accessSecret),
        credentials,
        ...(focus ? { focus } : {}),
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
      await this.failCreation(creation, error, signal);
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
    const snapshotProvider: SnapshotProvider = () =>
      (snapshot ??= this.runnerFor(creation, job, null)
        .explore({
          mode: creation.mode,
          url: targetUrl(creation),
          transportUrl: creation.localOrigin ? creation.baseUrl : undefined,
          signal,
          accessToken: decryptAccessToken(creation.accessSecret),
        })
        .catch(() => null));
    try {
      creation = await this.updateCreation(creation, { status: 'running' }, signal);
      const tests = (await this.options.store.listTests(creation.workspaceId, creation.id)).filter(
        (test) => testIds.includes(test.id),
      );
      await this.runTests(creation, job, tests, snapshotProvider, signal);
      creation = await this.updateCreation(
        creation,
        { status: 'completed', finishedAt: new Date() },
        signal,
      );
    } catch (error) {
      await this.failCreation(creation, error, signal);
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
    for (const test of tests) {
      await this.checkpoint(creation, signal);
      try {
        await this.runTest(creation, job, test, snapshot, signal);
      } catch (error) {
        if (signal.aborted || error instanceof Cancelled) throw new Cancelled();
        await this.options.store.updateTest(creation.workspaceId, test.id, {
          status: 'error',
          error: describeError(error, creation.locale),
        });
        // Without a browser (or a connected local runner) no remaining test can run either.
        if (error instanceof E2eRunnerError && STOPS_RUN.has(error.code)) throw error;
      }
    }
  }

  private async runTest(
    creation: E2eCreation,
    job: E2eJob,
    initial: E2eTestCase,
    snapshot: SnapshotProvider,
    signal: AbortSignal,
  ): Promise<void> {
    let test = initial;
    const repository = requireRepository(creation);
    // The repository is the source of truth: run whatever the branch holds right now.
    let script = test.scriptPath
      ? await this.options.scripts.readFile(creation.workspaceId, repository, test.scriptPath)
      : null;
    let hooks: E2eRunHooks;
    if (script === null) {
      // A new or regenerated spec comes with the Before Run and After Run of its test case.
      hooks = await this.authorHooks(creation, test, snapshot, signal);
      script = await this.authorScript(creation, test, snapshot, undefined, signal, hooks);
      test = { ...test, scriptPath: scriptFilePath(repository.path, test) };
    } else {
      const check = checkScript(script);
      if (!check.ok)
        throw new ApplicationError('E2E_SCRIPT_REJECTED', check.violations.join('; '), 422);
      hooks = await this.readHooks(creation, test);
    }
    let result = await this.runOnce(creation, job, test, script, hooks, signal);
    test = { ...test, attempts: test.attempts + 1 };
    let analysis = await this.analyze(creation, test, script, hooks, result, signal);

    // Rewriting the spec cannot fix a failing Before Run or After Run.
    for (
      let heal = 0;
      heal < this.healAttempts && analysis?.verdict === 'test_issue' && !isHookFailure(result);
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
    await this.options.store.updateTest(creation.workspaceId, test.id, {
      status: result.status,
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
    const names = Object.keys(await this.variablesOf(creation));
    const variables = names.length ? { variableNames: names } : {};
    let script = await author.writeScript({
      creation,
      test,
      snapshot: context,
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
    await this.options.scripts.writeFile(
      creation.workspaceId,
      repository,
      path,
      script,
      `test(e2e): ${previous ? 'fix' : 'add'} ${test.code} - ${test.title}`,
    );
    await store.updateTest(creation.workspaceId, test.id, { scriptPath: path });
    return script;
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
    const written: Record<E2eHookKind, string | null> = { beforeRun: null, afterRun: null };
    for (const kind of HOOK_KINDS) {
      const request = {
        creation,
        test,
        kind,
        snapshot: context,
        beforeRun: written.beforeRun,
        signal,
      };
      let hook = await author.writeHook(request);
      let check = hook ? checkScript(hook, 'hook') : null;
      if (hook && check && !check.ok) {
        hook = await author.writeHook({
          ...request,
          previous: {
            script: hook,
            problem: `The script was rejected by the security checks: ${check.violations.join('; ')}.`,
          },
        });
        check = hook ? checkScript(hook, 'hook') : null;
      }
      ensureActive(signal);
      if (!hook) continue;
      if (check && !check.ok)
        throw new ApplicationError(
          'E2E_SCRIPT_REJECTED',
          `${HOOK_LABELS[kind]}: ${check.violations.join('; ')}`,
          422,
        );
      await scripts.writeFile(
        creation.workspaceId,
        repository,
        hookFilePath(specPath, kind),
        hook,
        `test(e2e): add ${HOOK_LABELS[kind]} of ${test.code} - ${test.title}`,
      );
      written[kind] = hook;
    }
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
    try {
      return await this.options.author.analyze({
        creation,
        test,
        script,
        hooks,
        error: result.error ?? '',
        logs: result.logs,
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
  ): Promise<void> {
    if (signal.aborted || error instanceof Cancelled) return;
    const message = describeError(error, creation.locale);
    await this.options.store.updateCreation(creation.workspaceId, creation.id, {
      status: 'failed',
      error: message,
      finishedAt: new Date(),
    });
    await this.closeActiveTests(creation, { status: 'error', error: message });
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

  private async closeActiveTests(creation: E2eCreation, changes: E2eTestChanges): Promise<void> {
    for (const test of await this.options.store.listTests(creation.workspaceId, creation.id))
      if (ACTIVE_TEST_STATUSES.includes(test.status))
        await this.options.store.updateTest(creation.workspaceId, test.id, changes);
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

/** Puts every pending or running test of a run in a final state. */
export async function closeActiveTests(
  store: E2eStore,
  creation: E2eCreation,
  changes: E2eTestChanges,
): Promise<void> {
  for (const test of await store.listTests(creation.workspaceId, creation.id))
    if (ACTIVE_TEST_STATUSES.includes(test.status))
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
