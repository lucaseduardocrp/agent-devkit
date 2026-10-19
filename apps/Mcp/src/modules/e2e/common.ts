import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import { id, untrusted } from '../shared.js';

export const runId = id('E2E run id (from e2e_list or e2e_create).');
export const testId = id('E2E test case id (from e2e_get).');
export const QUEUE_NOTICE =
  'Runs are executed asynchronously by the E2E worker: poll e2e_get until the status is completed, failed or cancelled.';

export const runPath = (value: string) => `/e2e/creations/${segment(value)}`;
export const testPath = (value: string) => `/e2e/tests/${segment(value)}`;

/** Most cases one import may bring into a run (backend limit). */
const MAX_IMPORTED_CASES = 100;

export const testManagementProvider = z
  .enum(['azure_devops', 'testrail', 'xray'])
  .describe(
    'Test management platform: azure_devops (Azure Test Plans), testrail or xray. See e2e_test_management_providers.',
  );
export const remoteId = (description: string) =>
  z.string().trim().min(1).max(200).describe(description);
export const remotePlanId = remoteId(
  'Plan id from e2e_list_remote_plans (capabilities.planLabel names it: Test Plan, project...).',
);
export const remoteSuiteId = remoteId(
  'Suite id from e2e_list_remote_suites (capabilities.suiteLabel; required when capabilities.suiteRequired).',
);

/** Which cases of a plan/suite to automate. */
export const caseSelection = {
  provider: testManagementProvider,
  planId: remotePlanId.optional(),
  suiteId: remoteSuiteId.optional(),
  caseIds: z
    .array(remoteId('Case id from e2e_list_remote_cases.'))
    .min(1)
    .max(MAX_IMPORTED_CASES)
    .optional()
    .describe('Only these cases of the plan/suite; every case of it when omitted.'),
};

/** Reference to a case on a test management platform; titles and steps are resolved by ADK. */
export const caseReference = z.object({
  provider: testManagementProvider,
  caseId: remoteId(
    'Case id on the platform (capabilities.caseIdLabel), from e2e_list_remote_cases.',
  ),
  planId: remotePlanId.optional(),
  suiteId: remoteSuiteId.optional(),
});

/** Where the results of a run are published. */
export const reportingTarget = z
  .object({
    provider: testManagementProvider,
    planId: remotePlanId.nullable().optional(),
    suiteId: remoteSuiteId.nullable().optional(),
    autoPublish: z
      .boolean()
      .default(true)
      .describe('Publish the results automatically whenever an execution of the run finishes.'),
  })
  .describe('Test management platform, plan and suite that receive the results of the run.');

export interface ExternalCaseDto {
  readonly provider: string;
  readonly caseId: string;
  readonly planId?: string;
  readonly suiteId?: string;
  readonly title: string;
  readonly url?: string;
  readonly steps: readonly { readonly action: string; readonly expectedResult: string }[];
}

interface StepResultDto {
  readonly error?: string | null;
}

export interface TestDto {
  readonly error?: string | null;
  readonly logs?: string | null;
  readonly analysis?: string | null;
  readonly steps?: readonly string[];
  readonly externalCase?: ExternalCaseDto | null;
  readonly stepResults?: readonly StepResultDto[];
}

export interface RunDto {
  readonly prd?: string;
  readonly diff?: string | null;
  readonly tests?: readonly TestDto[];
  readonly lastReport?: { readonly error?: string | null } | null;
}

/** Same one-line form ADK gives the steps of an imported case ("action => expected"). */
export function describeStep(step: ExternalCaseDto['steps'][number]): string {
  const action = step.action.replace(/\s+/g, ' ').trim();
  const expected = step.expectedResult.replace(/\s+/g, ' ').trim();
  return (expected ? `${action} => ${expected}` : action).slice(0, 1_000);
}

const wrap = (label: string, value: string | null | undefined) =>
  value ? untrusted(label, value) : value;

const caseLabel = (item: ExternalCaseDto) => `test-case:${item.provider}:${item.caseId}`;

/**
 * Case titles and steps are written by people on external platforms, so they stay inside an
 * untrusted block; ids, location and link remain plain so the case can be referenced.
 */
export function guardCase(item: ExternalCaseDto, withSteps: boolean) {
  const { title, steps, ...reference } = item;
  const lines = withSteps
    ? steps.map(
        (step, index) =>
          `Step ${index + 1}: ${step.action}${step.expectedResult ? `\nExpected: ${step.expectedResult}` : ''}`,
      )
    : [];
  return {
    ...reference,
    stepCount: steps.length,
    content: untrusted(caseLabel(item), [`Title: ${title}`, ...lines].join('\n')),
  };
}

/** A linked test's steps come from its external case: they are wrapped as untrusted too. */
export function guardLinkedSteps(test: Pick<TestDto, 'steps' | 'externalCase'>) {
  const { externalCase } = test;
  if (!externalCase) return {};
  const steps = (test.steps ?? []).map((step, index) => `${index + 1}. ${step}`).join('\n');
  return {
    externalCase: guardCase(externalCase, false),
    steps: untrusted(`${caseLabel(externalCase)}:steps`, steps),
  };
}

/** Errors and logs echo text from the tested application, so they are marked as untrusted. */
export function guardTest(test: TestDto) {
  return {
    ...test,
    error: wrap('e2e-error', test.error),
    logs: wrap('e2e-logs', test.logs),
    analysis: wrap('e2e-analysis', test.analysis),
    ...guardLinkedSteps(test),
    ...(test.stepResults
      ? {
          stepResults: test.stepResults.map((step) => ({
            ...step,
            error: wrap('e2e-step-error', step.error),
          })),
        }
      : {}),
  };
}

/** Documents, test output and platform errors of a run view. */
export function guardRun(run: RunDto) {
  return {
    ...run,
    ...(run.prd ? { prd: untrusted('e2e-prd', run.prd) } : {}),
    ...(run.diff ? { diff: untrusted('e2e-diff', run.diff) } : {}),
    ...(run.tests ? { tests: run.tests.map(guardTest) } : {}),
    ...(run.lastReport?.error
      ? {
          lastReport: {
            ...run.lastReport,
            error: untrusted('e2e-report-error', run.lastReport.error),
          },
        }
      : {}),
  };
}
