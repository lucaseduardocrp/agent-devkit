import { ApplicationError } from '../../../shared/errors.js';
import type { TestStep } from '../domain/test-plan.js';
import { listAllSavedTestPlans, type SavedTestPlanStore } from './saved-test-plans.js';
import type { TestSuiteStore } from './test-suites.js';

/** Test cases saved in ADK chosen by suite (with its child suites), Test Plan and/or case id. */
export interface SavedCaseSelection {
  readonly suiteId?: string;
  readonly planId?: string;
  /** Local case ids (`metadata.caseId`); every case of the suite or plan when absent. */
  readonly caseIds?: readonly string[];
}

/** Where an imported case lives on its platform. */
export interface SavedCaseRemote {
  readonly provider: string;
  readonly caseId: string;
  readonly planId?: string;
  readonly suiteId?: string;
}

export interface SavedTestCase {
  readonly planId: string;
  readonly planTitle: string;
  readonly caseId: string;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly TestStep[];
  /** The platform case it was imported from, when there is one. */
  readonly remote: SavedCaseRemote | null;
}

/** Reads saved test cases, e.g. for E2E runs that automate them. */
export class SavedTestCaseReader {
  constructor(
    private readonly plans: SavedTestPlanStore,
    private readonly suites: TestSuiteStore,
  ) {}

  async listSavedCases(
    workspaceId: string,
    selection: SavedCaseSelection,
  ): Promise<SavedTestCase[]> {
    let plans;
    if (selection.planId) {
      const plan = await this.plans.find(selection.planId, workspaceId);
      if (!plan) throw new ApplicationError('TEST_PLAN_NOT_FOUND', 'Test Plan not found.', 404);
      plans = [plan];
    } else if (selection.suiteId) {
      if (!(await this.suites.find(selection.suiteId, workspaceId)))
        throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Local test suite not found.', 404);
      const ids = descendants(await this.suites.list(workspaceId), selection.suiteId);
      plans = (await listAllSavedTestPlans(this.plans, workspaceId))
        .filter((plan) => plan.suiteId && ids.has(plan.suiteId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } else
      throw new ApplicationError('VALIDATION_ERROR', 'Choose a suite or a Test Plan.', 400, [
        { field: 'suiteId' },
      ]);
    const wanted = selection.caseIds?.length ? new Set(selection.caseIds) : null;
    return plans.flatMap((plan) =>
      plan.plans.flatMap((testCase) => {
        const caseId = testCase.metadata?.['caseId'];
        if (typeof caseId !== 'string' || (wanted && !wanted.has(caseId))) return [];
        return [
          {
            planId: plan.id,
            planTitle: plan.title,
            caseId,
            title: testCase.title,
            description: testCase.description,
            steps: testCase.steps,
            remote: remoteOf(testCase.metadata),
          },
        ];
      }),
    );
  }
}

function descendants(
  suites: readonly { id: string; parentId?: string }[],
  rootId: string,
): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const suite of suites)
      if (suite.parentId && ids.has(suite.parentId) && !ids.has(suite.id)) {
        ids.add(suite.id);
        grew = true;
      }
  }
  return ids;
}

/** The platform an imported case came from (the first one when it was published to several). */
function remoteOf(metadata: Record<string, unknown> | undefined): SavedCaseRemote | null {
  const ids = record(metadata?.['remoteCaseIds']);
  const preferred = typeof metadata?.['importedFrom'] === 'string' ? metadata['importedFrom'] : '';
  const provider = preferred && ids[preferred] ? preferred : Object.keys(ids)[0];
  const caseId = provider ? ids[provider] : undefined;
  if (!provider || typeof caseId !== 'string' || !caseId) return null;
  const location = record(record(metadata?.['remoteCaseLocations'])[provider]);
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const planId = text(location['planId']);
  const suiteId = text(location['suiteId']);
  return {
    provider,
    caseId,
    ...(planId ? { planId } : {}),
    ...(suiteId ? { suiteId } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
