import { ApplicationError } from '../../../shared/errors.js';
import type { SavedTestPlan, SavedTestPlanStore } from './saved-test-plans.js';
import type { TestSuite, TestSuiteStore } from './test-suites.js';
import type { TestPlan } from '../domain/test-plan.js';
import type { FieldDefinition, FieldMappingTemplate } from '../../field-mapping/field-mapping.js';

export interface PublishableTestSuite {
  readonly id: string;
  readonly name: string;
  readonly cases: readonly TestPlan[];
  readonly children: readonly PublishableTestSuite[];
}

export interface PublishedTestSuite {
  readonly provider: string;
  readonly remotePlanId: string;
  readonly remoteSuiteId: string;
  readonly remoteUrl: string;
  readonly suitesCount: number;
  readonly casesCount: number;
  readonly caseLinks?: Readonly<Record<string, string>>;
  readonly caseLocations?: Readonly<Record<string, { planId: string; suiteId: string }>>;
}

export interface RemoteTestPlan {
  readonly id: string;
  readonly name: string;
}

export interface RemoteTestSuite {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly suiteType: string;
}

export interface TestSuiteDestinationProvider extends TestSuitePublisher {
  listPlans(): Promise<readonly RemoteTestPlan[]>;
  listSuites(remotePlanId: string): Promise<readonly RemoteTestSuite[]>;
  listCaseFields?(): Promise<readonly FieldDefinition[]>;
}

/** Destination-neutral port. A provider owns remote plan, suite and case creation. */
export interface TestSuitePublisher {
  publish(
    suite: PublishableTestSuite,
    options: {
      readonly remotePlanId?: string;
      readonly remoteParentSuiteId?: string;
      readonly remoteSuiteId?: string;
      readonly remoteSuiteName?: string;
      readonly fieldTemplate?: FieldMappingTemplate;
    },
  ): Promise<PublishedTestSuite>;
}

export class PublishTestSuite {
  public constructor(
    private readonly suites: TestSuiteStore,
    private readonly plans: SavedTestPlanStore,
  ) {}

  public async execute(
    workspaceId: string,
    suiteId: string,
    publisher: TestSuitePublisher,
    options: {
      readonly remotePlanId?: string;
      readonly remoteParentSuiteId?: string;
      readonly remoteSuiteId?: string;
      readonly remoteSuiteName?: string;
      readonly fieldTemplate?: FieldMappingTemplate;
    } = {},
  ): Promise<PublishedTestSuite> {
    const root = await this.suites.find(suiteId, workspaceId);
    if (!root)
      throw new ApplicationError('TEST_SUITE_NOT_FOUND', 'Suíte de testes não encontrada.', 404);

    const allSuites = await this.suites.list(workspaceId);
    const allPlans: SavedTestPlan[] = [];
    const count = await this.plans.count(workspaceId);
    for (let offset = 0; offset < count; offset += 100) {
      allPlans.push(...(await this.plans.list(workspaceId, offset, 100)));
    }
    const visited = new Set<string>();
    const build = (suite: TestSuite): PublishableTestSuite => {
      if (visited.has(suite.id))
        throw new ApplicationError(
          'TEST_SUITE_CYCLE',
          'A hierarquia de suítes contém um ciclo.',
          409,
        );
      visited.add(suite.id);
      return {
        id: suite.id,
        name: suite.name,
        cases: allPlans.filter((plan) => plan.suiteId === suite.id).flatMap((plan) => plan.plans),
        children: allSuites.filter((child) => child.parentId === suite.id).map(build),
      };
    };
    const tree = build(root);
    const hasCases = (node: PublishableTestSuite): boolean =>
      node.cases.length > 0 || node.children.some(hasCases);
    if (!hasCases(tree))
      throw new ApplicationError(
        'TEST_SUITE_EMPTY',
        'A suíte não possui test cases para publicar.',
        400,
      );
    const result = await publisher.publish(tree, options);
    if (result.caseLinks && Object.keys(result.caseLinks).length) {
      for (const saved of allPlans) {
        const plans = saved.plans.map((testCase) => {
          const caseId = testCase.metadata?.['caseId'];
          const externalId = typeof caseId === 'string' ? result.caseLinks?.[caseId] : undefined;
          return externalId
            ? {
                ...testCase,
                metadata: {
                  ...testCase.metadata,
                  remoteCaseIds: {
                    ...(testCase.metadata?.['remoteCaseIds'] as Record<string, string> | undefined),
                    [result.provider]: externalId,
                  },
                  ...(typeof caseId === 'string' && result.caseLocations?.[caseId]
                    ? {
                        remoteCaseLocations: {
                          ...(testCase.metadata?.['remoteCaseLocations'] as
                            Record<string, { planId: string; suiteId: string }> | undefined),
                          [result.provider]: result.caseLocations[caseId],
                        },
                      }
                    : {}),
                },
              }
            : testCase;
        });
        if (plans.some((item, index) => item !== saved.plans[index]))
          await this.plans.save({ ...saved, plans, updatedAt: new Date().toISOString() });
      }
    }
    return result;
  }
}
