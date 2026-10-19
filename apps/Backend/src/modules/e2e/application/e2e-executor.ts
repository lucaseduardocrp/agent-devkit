import { ApplicationError } from '../../../shared/errors.js';
import { decryptSecret } from '../../../shared/encryption.js';
import { decryptAccessToken } from './access-token.js';
import { resolveLocale, translateErrorMessage } from '../../../shared/i18n.js';
import {
  ACTIVE_CREATION_STATUSES,
  ACTIVE_TEST_STATUSES,
  scriptFilePath,
  snapshotKey,
  stepEvidencePrefix,
  targetUrl,
  type E2eCreation,
  type E2eRepositoryRef,
  type E2eStepResult,
  type E2eTestCase,
} from '../domain/e2e.js';
import type { E2eRunReporter } from './e2e-reporter.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eAnalysis, E2eAuthor } from './e2e-author.js';
import type { E2eJob } from './e2e-queue.js';
import {
  E2eRunnerError,
  type E2eCredentials,
  type E2eRunResult,
  type E2eRunner,
  type E2eSnapshot,
  type E2eStepEvidence,
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
    else await this.execute(creation, job, signal);
  }

  /**
   * The browser for this run: the worker's own, or the computer of the user who started the
   * job when the run executes locally. Orchestration (AI, healing, results) stays here.
   */
  private runnerFor(creation: E2eCreation, job: E2eJob, testId: string | null): E2eRunner {
    if (creation.executionTarget !== 'local') return this.options.runner;
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
      const snapshot = await this.runnerFor(creation, job, null).explore({
        mode: creation.mode,
        url: targetUrl(creation),
        transportUrl: creation.localOrigin ? creation.baseUrl : undefined,
        signal,
        accessToken: decryptAccessToken(creation.accessSecret),
      });
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

  private async generate(initial: E2eCreation, job: E2eJob, signal: AbortSignal): Promise<void> {
    const { store, author } = this.options;
    let creation = initial;
    try {
      creation = await this.updateCreation(creation, { status: 'planning' }, signal);
      const snapshot = await this.runnerFor(creation, job, null).explore({
        mode: creation.mode,
        url: targetUrl(creation),
        transportUrl: creation.localOrigin ? creation.baseUrl : undefined,
        signal,
        accessToken: decryptAccessToken(creation.accessSecret),
      });
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
    await this.autoPublish(creation);
  }

  private async execute(initial: E2eCreation, job: E2eJob, signal: AbortSignal): Promise<void> {
    const { testIds } = job;
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
    if (script === null) {
      script = await this.authorScript(creation, test, snapshot, undefined, signal);
      test = { ...test, scriptPath: scriptFilePath(repository.path, test) };
    } else {
      const check = checkScript(script);
      if (!check.ok)
        throw new ApplicationError('E2E_SCRIPT_REJECTED', check.violations.join('; '), 422);
    }
    let result = await this.runOnce(creation, job, test, script, signal);
    test = { ...test, attempts: test.attempts + 1 };
    let analysis = await this.analyze(creation, test, script, result, signal);

    for (let heal = 0; heal < this.healAttempts && analysis?.verdict === 'test_issue'; heal++) {
      script = await this.authorScript(
        creation,
        test,
        snapshot,
        { script, problem: `${result.error ?? ''}\n\n${analysis.summary}` },
        signal,
      );
      result = await this.runOnce(creation, job, test, script, signal);
      test = { ...test, attempts: test.attempts + 1 };
      analysis = await this.analyze(creation, test, script, result, signal);
    }

    ensureActive(signal);
    const videoKey = await this.replaceVideo(creation, initial, result.video);
    const stepResults = await this.replaceStepEvidence(initial, result.steps);
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
  ): Promise<string> {
    const { store, author } = this.options;
    await this.updateTest(creation, test.id, { status: 'generating' }, signal);
    const context = await snapshot();
    let script = await author.writeScript({ creation, test, snapshot: context, previous, signal });
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
        signal,
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

  private async runOnce(
    creation: E2eCreation,
    job: E2eJob,
    test: E2eTestCase,
    script: string,
    signal: AbortSignal,
  ): Promise<E2eRunResult> {
    await this.updateTest(
      creation,
      test.id,
      { status: 'running', attempts: test.attempts + 1, lastRunAt: new Date() },
      signal,
    );
    const result = await this.runnerFor(creation, job, test.id).run({
      script,
      mode: creation.mode,
      baseUrl: creation.baseUrl,
      localOrigin: creation.localOrigin,
      locale: creation.locale,
      credentials: credentialsOf(creation),
      accessToken: decryptAccessToken(creation.accessSecret),
      signal,
    });
    ensureActive(signal);
    return result;
  }

  private async analyze(
    creation: E2eCreation,
    test: E2eTestCase,
    script: string,
    result: E2eRunResult,
    signal: AbortSignal,
  ): Promise<E2eAnalysis | null> {
    if (result.status === 'passed') return null;
    try {
      return await this.options.author.analyze({
        creation,
        test,
        script,
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
