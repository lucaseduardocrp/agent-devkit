import type {
  ExternalTestCase,
  ExternalTestCaseRef,
  ExternalCaseLocation,
  PublishedTestRun,
  RemoteContainer,
  TestManagementCapabilities,
  TestManagementProviderId,
  TestRunReport,
} from '../domain/test-run.js';

/**
 * Destination-neutral port for test management platforms. Each adapter owns its platform's
 * contract (authentication, identifiers, step and evidence formats); callers only see the
 * neutral run model.
 */
export interface TestManagementProvider {
  readonly id: TestManagementProviderId;
  readonly name: string;
  readonly capabilities: TestManagementCapabilities;
  /** First level of the platform (Test Plans, projects...). */
  listPlans(): Promise<readonly RemoteContainer[]>;
  /** Second level inside a plan (suites); empty when the platform has none. */
  listSuites(planId: string): Promise<readonly RemoteContainer[]>;
  /** Test cases of a plan or suite, with their steps. */
  listCases(location: ExternalCaseLocation): Promise<readonly ExternalTestCase[]>;
  getCase(ref: Omit<ExternalTestCaseRef, 'provider'>): Promise<ExternalTestCase>;
  /** Creates a run with one result per case, step outcomes and evidence attached. */
  publishRun(report: TestRunReport): Promise<PublishedTestRun>;
}

export interface TestManagementProviderSummary {
  readonly id: TestManagementProviderId;
  readonly name: string;
  readonly configured: boolean;
  readonly capabilities: TestManagementCapabilities;
}

/** Finds the platforms a workspace has configured; implemented over the integrations. */
export interface TestManagementResolver {
  listTestManagementProviders(
    workspaceId: string,
  ): Promise<readonly TestManagementProviderSummary[]>;
  resolveTestManagementProvider(
    workspaceId: string,
    providerId: TestManagementProviderId,
  ): Promise<TestManagementProvider | null>;
}
