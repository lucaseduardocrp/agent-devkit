import { segment } from '../../api/http-client.js';
import { defineTool, json, type McpTool } from '../../core/tool.js';
import {
  caseSelection,
  caseReference,
  guardCase,
  guardRun,
  guardTest,
  remotePlanId,
  remoteSuiteId,
  reportingTarget,
  runId,
  runPath,
  testId,
  testManagementProvider,
  testPath,
  type ExternalCaseDto,
  type RunDto,
  type TestDto,
} from './common.js';

const platformPath = (provider: string) => `/e2e/test-management/${segment(provider)}`;

/**
 * Importing cases, choosing where results go and publishing them: E2E runs that automate the
 * manual test cases kept on Azure Test Plans, TestRail or Xray and report back to them.
 */
export const testManagementTools: readonly McpTool[] = [
  defineTool({
    name: 'e2e_test_management_providers',
    title: 'E2E test management platforms',
    description:
      'Lists the test management platforms (Azure Test Plans, TestRail, Xray) an E2E run can import test cases from and publish results to, whether each is configured in the workspace integrations, and its capabilities: what its plan and suite levels are called, whether a suite is required, how case ids are named and whether step evidence (screenshots) is uploaded.',
    toolset: 'e2e',
    access: 'read',
    routes: ['GET /e2e/test-management/providers'],
    input: {},
    run: async (_input, { api }) =>
      json(await api.request({ method: 'GET', path: '/e2e/test-management/providers' })),
  }),
  defineTool({
    name: 'e2e_list_remote_plans',
    openWorld: true,
    title: 'List test management plans',
    description:
      'Lists the plans of a test management platform (Azure test plans, TestRail projects, Xray test plans) to choose where cases are imported from or results are published.',
    toolset: 'e2e',
    access: 'read',
    routes: ['GET /e2e/test-management/:provider/plans'],
    input: { provider: testManagementProvider },
    run: async ({ provider }, { api }) =>
      json(await api.request({ method: 'GET', path: `${platformPath(provider)}/plans` })),
  }),
  defineTool({
    name: 'e2e_list_remote_suites',
    openWorld: true,
    title: 'List test management suites',
    description:
      'Lists the suites inside a plan of a test management platform (from e2e_list_remote_plans). Platforms without a second level return no suites.',
    toolset: 'e2e',
    access: 'read',
    routes: ['GET /e2e/test-management/:provider/plans/:planId/suites'],
    input: { provider: testManagementProvider, planId: remotePlanId },
    run: async ({ provider, planId }, { api }) =>
      json(
        await api.request({
          method: 'GET',
          path: `${platformPath(provider)}/plans/${segment(planId)}/suites`,
        }),
      ),
  }),
  defineTool({
    name: 'e2e_list_remote_cases',
    openWorld: true,
    title: 'List test management cases',
    description:
      'Lists the test cases of a plan/suite on a test management platform with their steps (action and expected result), to choose which ones an E2E run automates. Titles and steps are inside <untrusted-content> blocks.',
    toolset: 'e2e',
    access: 'read',
    routes: ['GET /e2e/test-management/:provider/cases'],
    input: {
      provider: testManagementProvider,
      planId: remotePlanId.optional(),
      suiteId: remoteSuiteId.optional(),
    },
    run: async ({ provider, ...query }, { api }) => {
      const { cases } = await api.request<{ cases: ExternalCaseDto[] }>({
        method: 'GET',
        path: `${platformPath(provider)}/cases`,
        query,
      });
      return json({ cases: cases.map((item) => guardCase(item, true)) });
    },
  }),
  defineTool({
    name: 'e2e_import_cases',
    openWorld: true,
    title: 'Import test cases into E2E run',
    description:
      'Adds test management cases to an idle E2E run as tests without a spec (cases it already automates are skipped). Their steps guide the specs: write them in host mode with e2e_prepare + e2e_save_plan, or let the workspace LLM write them with e2e_run. When the run has no reporting target yet, results go to the same plan/suite with autoPublish on.',
    toolset: 'e2e',
    access: 'write',
    routes: ['POST /e2e/creations/:id/import-cases'],
    input: { runId, ...caseSelection },
    run: async ({ runId: value, ...body }, { api }) => {
      const { result } = await api.request<{
        result: { imported: number; skipped: number; creation: RunDto };
      }>({ method: 'POST', path: `${runPath(value)}/import-cases`, body });
      return json({ result: { ...result, creation: guardRun(result.creation) } });
    },
  }),
  defineTool({
    name: 'e2e_link_case',
    openWorld: true,
    title: 'Link E2E test to test case',
    description:
      'Links an E2E test to a case on a test management platform (its steps replace the test steps and its results are published to that case), or unlinks it with externalCase null. The run must be idle; update the spec afterwards so it has one top-level test.step per case step.',
    toolset: 'e2e',
    access: 'write',
    routes: ['PUT /e2e/tests/:id/external-case'],
    input: {
      testId,
      externalCase: caseReference.nullable().describe('Case to link, or null to unlink.'),
    },
    run: async ({ testId: value, externalCase }, { api }) => {
      const { test } = await api.request<{ test: TestDto }>({
        method: 'PUT',
        path: `${testPath(value)}/external-case`,
        body: { externalCase },
      });
      return json({ test: guardTest(test) });
    },
  }),
  defineTool({
    name: 'e2e_set_reporting',
    title: 'Set E2E result reporting',
    description:
      'Chooses the test management platform, plan and suite that receive the results of an E2E run (only tests linked to a case are published), and whether they are published automatically after each execution. reporting null stops reporting.',
    toolset: 'e2e',
    access: 'write',
    routes: ['PUT /e2e/creations/:id/reporting'],
    input: { runId, reporting: reportingTarget.nullable() },
    run: async ({ runId: value, reporting }, { api }) => {
      const { creation } = await api.request<{ creation: RunDto }>({
        method: 'PUT',
        path: `${runPath(value)}/reporting`,
        body: { reporting },
      });
      return json({ creation: guardRun(creation) });
    },
  }),
  defineTool({
    name: 'e2e_publish_run',
    openWorld: true,
    title: 'Publish E2E results',
    description:
      'Publishes the latest results of an idle E2E run to its reporting platform (set with e2e_create or e2e_set_reporting): creates a test run there with the outcome of each linked case and step and the step screenshots as evidence. It runs on the worker: poll e2e_get until creation.lastReport.status is no longer "publishing" ("published" carries the run link, "failed" the error). Confirm with the user first.',
    toolset: 'e2e',
    access: 'write',
    routes: ['POST /e2e/creations/:id/publish'],
    input: { runId },
    run: async ({ runId: value }, { api }) => {
      const { creation } = await api.request<{ creation: RunDto }>({
        method: 'POST',
        path: `${runPath(value)}/publish`,
      });
      return json({ creation: guardRun(creation) });
    },
  }),
];
