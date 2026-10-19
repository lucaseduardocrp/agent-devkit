import { ApplicationError } from '../../../shared/errors.js';
import {
  targetUrl,
  type E2eCreation,
  type E2eReportState,
  type E2eReportingTarget,
  type E2eTestCase,
} from '../domain/e2e.js';
import type {
  CaseRunResult,
  StepRunResult,
  TestEvidence,
  TestOutcome,
  TestRunReport,
} from '../../test-management/domain/test-run.js';
import type { TestManagementResolver } from '../../test-management/application/test-management-provider.js';
import type { E2eArtifactStore } from './artifact-store.js';
import type { E2eStore } from './e2e-store.js';
import { describeError } from './e2e-executor.js';

export interface E2eRunReporterOptions {
  readonly store: E2eStore;
  readonly artifacts: E2eArtifactStore;
  readonly testManagement: TestManagementResolver;
  /** Recordings above this size are not attached; platforms cap uploads. */
  readonly maxVideoBytes?: number;
}

/**
 * Turns the latest execution of a run into a platform-neutral test run and sends it to the
 * test management platform chosen for the run. Only tests linked to a case of that platform
 * and executed to a verdict are reported.
 */
export class E2eRunReporter {
  constructor(private readonly options: E2eRunReporterOptions) {}

  /** Publishes and records the outcome on the run; failures are recorded, not thrown. */
  async publish(
    creation: E2eCreation,
    target: E2eReportingTarget,
    testIds?: readonly string[],
  ): Promise<E2eReportState> {
    const { store } = this.options;
    let state: E2eReportState;
    try {
      const provider = await this.options.testManagement.resolveTestManagementProvider(
        creation.workspaceId,
        target.provider,
      );
      if (!provider)
        throw new ApplicationError(
          'TEST_MANAGEMENT_NOT_CONFIGURED',
          'The test management platform is not configured.',
          400,
          [{ provider: target.provider }],
        );
      const report = await this.buildReport(creation, target, testIds);
      const published = await provider.publishRun(report.run);
      state = {
        status: 'published',
        provider: target.provider,
        remoteRunId: published.remoteRunId,
        url: published.url,
        publishedCases: published.publishedCases,
        warnings: [...report.warnings, ...published.warnings],
        error: null,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      state = {
        status: 'failed',
        provider: target.provider,
        remoteRunId: null,
        url: null,
        publishedCases: 0,
        warnings: [],
        error: describeError(error, creation.locale),
        updatedAt: new Date().toISOString(),
      };
    }
    await store.updateCreation(creation.workspaceId, creation.id, { lastReport: state });
    return state;
  }

  async buildReport(
    creation: E2eCreation,
    target: E2eReportingTarget,
    testIds?: readonly string[],
  ): Promise<{ run: TestRunReport; warnings: string[] }> {
    const warnings: string[] = [];
    const tests = (await this.options.store.listTests(creation.workspaceId, creation.id)).filter(
      (test) =>
        (!testIds || testIds.includes(test.id)) &&
        test.externalCase?.provider === target.provider &&
        (test.status === 'passed' || test.status === 'failed'),
    );
    if (!tests.length)
      throw new ApplicationError(
        'TEST_RUN_NOTHING_TO_PUBLISH',
        'No executed test is linked to a case of this platform.',
        400,
        [{ provider: target.provider }],
      );
    const results: CaseRunResult[] = [];
    for (const test of tests) results.push(await this.caseResult(test, target, warnings));
    const startedAt = new Date(Math.min(...results.map((result) => result.startedAt.getTime())));
    const finishedAt = new Date(Math.max(...results.map((result) => result.finishedAt.getTime())));
    return {
      run: {
        name: `${creation.name} (ADK E2E)`,
        startedAt,
        finishedAt,
        environment: `${targetUrl(creation)} · Chromium (Playwright) · ADK E2E automation`,
        target: {
          ...(target.planId ? { planId: target.planId } : {}),
          ...(target.suiteId ? { suiteId: target.suiteId } : {}),
        },
        results,
      },
      warnings,
    };
  }

  private async caseResult(
    test: E2eTestCase,
    target: E2eReportingTarget,
    warnings: string[],
  ): Promise<CaseRunResult> {
    const external = test.externalCase!;
    const passed = test.status === 'passed';
    const durationMs =
      test.durationMs ?? test.stepResults.reduce((sum, s) => sum + s.durationMs, 0);
    const finishedAt = test.lastRunAt
      ? new Date(test.lastRunAt.getTime() + durationMs)
      : test.updatedAt;
    const startedAt = new Date(finishedAt.getTime() - durationMs);
    if (test.stepResults.length !== external.steps.length)
      warnings.push(
        `${test.code}: the script ran ${test.stepResults.length} step(s) for the ${external.steps.length} of test case ${external.caseId}.`,
      );
    const steps: StepRunResult[] = [];
    for (const [index, step] of external.steps.entries()) {
      const executed = test.stepResults[index];
      // Steps the script never reached (or did not write) cannot be vouched for.
      const outcome: TestOutcome = executed?.status ?? 'not_executed';
      const screenshot = executed?.screenshotKey
        ? await this.options.artifacts.get(executed.screenshotKey)
        : null;
      steps.push({
        position: index + 1,
        stepId: step.id,
        action: step.action,
        expectedResult: step.expectedResult,
        outcome,
        actualResult: executed?.error ?? null,
        durationMs: executed?.durationMs ?? 0,
        evidence: screenshot
          ? [
              {
                fileName: `${test.code}-passo-${String(index + 1).padStart(2, '0')}.png`,
                contentType: 'image/png',
                content: screenshot,
                description: executed!.title,
              },
            ]
          : [],
      });
    }
    return {
      testCase: {
        ...external,
        ...(external.planId || !target.planId ? {} : { planId: target.planId }),
        ...(external.suiteId || !target.suiteId ? {} : { suiteId: target.suiteId }),
      },
      outcome: passed ? 'passed' : 'failed',
      startedAt,
      finishedAt,
      durationMs,
      errorMessage: passed ? null : test.error,
      comment: test.analysis,
      steps,
      attachments: await this.recording(test),
    };
  }

  private async recording(test: E2eTestCase): Promise<TestEvidence[]> {
    if (!test.videoKey) return [];
    const video = await this.options.artifacts.get(test.videoKey);
    if (!video || video.byteLength > (this.options.maxVideoBytes ?? 25_000_000)) return [];
    const mp4 = test.videoKey.endsWith('.mp4');
    return [
      {
        fileName: `${test.code}.${mp4 ? 'mp4' : 'webm'}`,
        contentType: mp4 ? 'video/mp4' : 'video/webm',
        content: video,
        description: `Recording of ${test.code} - ${test.title}`,
      },
    ];
  }
}
