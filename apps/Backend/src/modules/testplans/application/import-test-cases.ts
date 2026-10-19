import { ApplicationError } from '../../../shared/errors.js';
import type { TestManagementResolver } from '../../test-management/application/test-management-provider.js';
import type {
  ExternalTestCase,
  RemoteContainer,
  TestManagementProviderId,
} from '../../test-management/domain/test-run.js';
import type { TestPlan } from '../domain/test-plan.js';
import {
  createSavedTestPlan,
  listAllSavedTestPlans,
  withCaseIds,
  type SavedTestPlan,
  type SavedTestPlanStore,
} from './saved-test-plans.js';
import { TestSuiteService, type TestSuite, type TestSuiteStore } from './test-suites.js';

/** `sourceType` of the Test Plans created by an import; `sourceId` names the remote suite. */
export const IMPORT_SOURCE_TYPE = 'test_management';
/** Bounds of one import, so a whole plan still fits in a single request. */
export const MAX_IMPORTED_SUITES = 300;
export const MAX_IMPORTED_CASES = 2_000;

export interface ImportTestCasesInput {
  readonly provider: TestManagementProviderId;
  /** Remote plan (Azure Test Plan, TestRail project, Xray Test Plan). */
  readonly planId: string;
  /** Only this remote suite; every suite of the plan when absent. */
  readonly suiteId?: string;
  /** With `suiteId`, also the suites nested under it. */
  readonly includeChildSuites?: boolean;
  /** Only these remote cases of the chosen suites. */
  readonly caseIds?: readonly string[];
  /** Local suite that receives the import; one named after the remote plan when absent. */
  readonly localSuiteId?: string;
}

export interface ImportTestCasesResult {
  /** Local suite at the top of the imported hierarchy. */
  readonly rootSuiteId: string;
  readonly suitesCreated: number;
  /** One Test Plan per remote suite that had cases. */
  readonly plans: readonly SavedTestPlan[];
  readonly created: number;
  readonly updated: number;
}

interface Location {
  /** Absent on platforms without suites (Xray): the plan itself holds the cases. */
  readonly suite?: RemoteContainer;
  readonly cases: readonly ExternalTestCase[];
}

/**
 * Brings test plans, suites and cases kept on a test management platform into ADK. The remote
 * suite hierarchy becomes local suites and each remote suite one Test Plan whose cases keep
 * their remote ids, location, link and fields. Importing again refreshes those Test Plans in
 * place, keeping the local id (and so the history) of every case.
 */
export class ImportTestCases {
  private readonly suites: TestSuiteService;

  constructor(
    private readonly savedPlans: SavedTestPlanStore,
    private readonly suiteStore: TestSuiteStore,
    private readonly testManagement: TestManagementResolver,
  ) {
    this.suites = new TestSuiteService(suiteStore);
  }

  async import(workspaceId: string, input: ImportTestCasesInput): Promise<ImportTestCasesResult> {
    const provider = await this.testManagement.resolveTestManagementProvider(
      workspaceId,
      input.provider,
    );
    if (!provider)
      throw new ApplicationError(
        'TEST_PROVIDER_NOT_CONFIGURED',
        'Test provider is not configured.',
        400,
        [{ provider: input.provider }],
      );
    if (input.localSuiteId && !(await this.suiteStore.find(input.localSuiteId, workspaceId)))
      throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Local test suite not found.', 404);

    const remoteSuites = provider.capabilities.suiteLabel
      ? await provider.listSuites(input.planId)
      : [];
    const selected = selectSuites(remoteSuites, input);
    if (selected.length > MAX_IMPORTED_SUITES)
      throw new ApplicationError('TEST_IMPORT_TOO_LARGE', 'Too many suites in one import.', 400, [
        { max: MAX_IMPORTED_SUITES },
      ]);

    const wanted = input.caseIds?.length ? new Set(input.caseIds) : null;
    const locations: Location[] = [];
    let total = 0;
    for (const suite of selected.length ? selected : [undefined]) {
      const cases = (
        await provider.listCases({
          planId: input.planId,
          ...(suite ? { suiteId: suite.id } : {}),
        })
      ).filter((item) => !wanted || wanted.has(item.caseId));
      total += cases.length;
      if (total > MAX_IMPORTED_CASES)
        throw new ApplicationError('TEST_IMPORT_TOO_LARGE', 'Too many cases in one import.', 400, [
          { max: MAX_IMPORTED_CASES },
        ]);
      locations.push({ ...(suite ? { suite } : {}), cases });
    }
    if (!total)
      throw new ApplicationError('TEST_CASES_NOT_FOUND', 'No test cases matched the import.', 404);

    const planName =
      (await provider.listPlans()).find((plan) => plan.id === input.planId)?.name ??
      `${provider.capabilities.planLabel} ${input.planId}`;
    const local = await this.localSuites(workspaceId, input, planName, locations);
    const existing = new Map(
      (await listAllSavedTestPlans(this.savedPlans, workspaceId))
        .filter((plan) => plan.sourceType === IMPORT_SOURCE_TYPE && plan.sourceId)
        .map((plan) => [plan.sourceId!, plan]),
    );

    const plans: SavedTestPlan[] = [];
    let created = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const location of locations) {
      if (!location.cases.length) continue;
      const sourceId = [input.provider, input.planId, location.suite?.id ?? ''].join(':');
      const previous = existing.get(sourceId);
      const byRemoteId = new Map(
        (previous?.plans ?? []).flatMap((testCase) => {
          const id = remoteCaseId(testCase, input.provider);
          return id ? [[id, testCase]] : [];
        }),
      );
      const fresh = location.cases.map((item) => {
        const before = byRemoteId.get(item.caseId);
        if (before) updated++;
        else created++;
        return toLocalCase(input.provider, item, before, now, {
          planId: input.planId,
          suiteId: location.suite?.id ?? '',
        });
      });
      // A partial import refreshes the chosen cases and keeps the others of the Test Plan.
      const refreshed = new Set(location.cases.map((item) => item.caseId));
      const cases =
        previous && wanted
          ? [
              ...previous.plans.map((testCase) => {
                const id = remoteCaseId(testCase, input.provider);
                return id && refreshed.has(id)
                  ? fresh.find((item) => remoteCaseId(item, input.provider) === id)!
                  : testCase;
              }),
              ...fresh.filter((item) => !byRemoteId.has(remoteCaseId(item, input.provider)!)),
            ]
          : fresh;
      const suiteId = local.bySuite.get(location.suite?.id ?? '')!;
      plans.push(
        await this.savedPlans.save(
          previous
            ? { ...previous, plans: withCaseIds(cases), updatedAt: now }
            : createSavedTestPlan(
                workspaceId,
                {
                  title: location.suite?.name ?? planName,
                  suiteId,
                  sourceType: IMPORT_SOURCE_TYPE,
                  sourceId,
                },
                cases,
              ),
        ),
      );
    }
    return {
      rootSuiteId: local.rootId,
      suitesCreated: local.created,
      plans,
      created,
      updated,
    };
  }

  /**
   * Local suite of every remote suite that has cases, directly or below it. A single top
   * suite (Azure's plan root, or the one suite asked for) is the local root itself; several
   * (TestRail suites) become its children.
   */
  private async localSuites(
    workspaceId: string,
    input: ImportTestCasesInput,
    planName: string,
    locations: readonly Location[],
  ): Promise<{ rootId: string; created: number; bySuite: Map<string, string> }> {
    let created = 0;
    const known = [...(await this.suiteStore.list(workspaceId))];
    const ensure = async (name: string, parentId?: string): Promise<TestSuite> => {
      const found = known.find(
        (suite) => suite.name === name && (suite.parentId ?? undefined) === parentId,
      );
      if (found) return found;
      const suite = await this.suites.create(workspaceId, name, parentId);
      known.push(suite);
      created++;
      return suite;
    };

    const remote = new Map(
      locations.flatMap((location) => (location.suite ? [[location.suite.id, location]] : [])),
    );
    const tops = locations.filter(
      (location) => !location.suite?.parentId || !remote.has(location.suite.parentId),
    );
    const single = tops.length === 1 ? tops[0]! : null;
    const root = input.localSuiteId
      ? (known.find((suite) => suite.id === input.localSuiteId) as TestSuite)
      : await ensure((input.suiteId && single?.suite?.name) || planName);

    // Suites without cases anywhere below them are not created.
    const filled = new Set<string>();
    for (const location of locations) {
      let id = location.cases.length ? location.suite?.id : undefined;
      while (id && !filled.has(id)) {
        filled.add(id);
        id = remote.get(id)?.suite?.parentId;
      }
    }

    const bySuite = new Map<string, string>();
    const resolve = async (location: Location): Promise<string> => {
      const key = location.suite?.id ?? '';
      const done = bySuite.get(key);
      if (done) return done;
      let id: string;
      if (location === single || !location.suite) id = root.id;
      else {
        const parent = location.suite.parentId ? remote.get(location.suite.parentId) : undefined;
        const parentId = parent && !tops.includes(location) ? await resolve(parent) : root.id;
        id = (await ensure(location.suite.name, parentId)).id;
      }
      bySuite.set(key, id);
      return id;
    };
    for (const location of locations)
      if (!location.suite || filled.has(location.suite.id)) await resolve(location);
    return { rootId: root.id, created, bySuite };
  }
}

/** The chosen suite and, when asked, everything nested under it; the whole plan otherwise. */
function selectSuites(
  suites: readonly RemoteContainer[],
  input: ImportTestCasesInput,
): RemoteContainer[] {
  if (!input.suiteId) return [...suites];
  const chosen = suites.find((suite) => suite.id === input.suiteId) ?? {
    id: input.suiteId,
    name: `Suite ${input.suiteId}`,
  };
  if (!input.includeChildSuites) return [chosen];
  const ids = new Set([chosen.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const suite of suites)
      if (suite.parentId && ids.has(suite.parentId) && !ids.has(suite.id)) {
        ids.add(suite.id);
        grew = true;
      }
  }
  return [chosen, ...suites.filter((suite) => suite.id !== chosen.id && ids.has(suite.id))];
}

export function remoteCaseId(testCase: TestPlan, provider: string): string | undefined {
  const ids = testCase.metadata?.['remoteCaseIds'];
  const id =
    ids && typeof ids === 'object' ? (ids as Record<string, unknown>)[provider] : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

function byProvider(
  metadata: Record<string, unknown> | undefined,
  key: string,
  provider: string,
  value: unknown,
): Record<string, unknown> {
  const current = metadata?.[key];
  return {
    ...(current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {}),
    [provider]: value,
  };
}

/** A remote case as a local test case; the local id of an earlier import is kept. */
function toLocalCase(
  provider: TestManagementProviderId,
  item: ExternalTestCase,
  previous: TestPlan | undefined,
  importedAt: string,
  /** Where the case was read, for platforms whose cases do not say it. */
  location: { readonly planId: string; readonly suiteId: string },
): TestPlan {
  const metadata = previous?.metadata;
  return {
    title: item.title,
    description: item.description ?? '',
    steps: item.steps.map((step, index) => ({
      order: index + 1,
      action: step.action,
      expectedResult: step.expectedResult,
    })),
    metadata: {
      ...metadata,
      remoteCaseIds: byProvider(metadata, 'remoteCaseIds', provider, item.caseId),
      remoteCaseLocations: byProvider(metadata, 'remoteCaseLocations', provider, {
        planId: item.planId ?? location.planId,
        suiteId: item.suiteId ?? location.suiteId,
      }),
      remoteUrls: byProvider(metadata, 'remoteUrls', provider, item.url ?? ''),
      remoteStepIds: byProvider(
        metadata,
        'remoteStepIds',
        provider,
        item.steps.map((step) => step.id),
      ),
      customFields: byProvider(metadata, 'customFields', provider, item.customFields ?? {}),
      customFieldLabels: byProvider(
        metadata,
        'customFieldLabels',
        provider,
        item.customFieldLabels ?? {},
      ),
      importedFrom: provider,
      importedAt,
    },
  };
}
