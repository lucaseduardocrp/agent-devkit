import { describe, expect, it, vi } from 'vitest';
import { AzureTestSuitePublisher } from '../src/modules/testplans/adapters/azure-test-suite-publisher.js';
import type { PublishableTestSuite } from '../src/modules/testplans/application/publish-test-suite.js';

const testCase = {
  title: 'Login',
  description: 'Session',
  steps: [{ action: 'Open', expectedResult: 'Form' }],
};

const tree: PublishableTestSuite = {
  id: 'local',
  name: 'Regression',
  cases: [testCase],
  children: [{ id: 'child', name: 'Checkout', cases: [testCase], children: [] }],
};

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A fake Azure DevOps: work item 50 is a PBI, 60 a Task, and test cases get ids from 100. */
function azure(overrides: { failSuiteCreation?: number; caseRelations?: unknown[] } = {}) {
  const calls: Call[] = [];
  let nextCase = 100;
  let nextSuite = 20;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const reply = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => data }) as Response;
    if (url.includes('/wit/workitems/50?'))
      return reply({
        fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': 'Cores' },
      });
    if (url.includes('/wit/workitems/60?'))
      return reply({ fields: { 'System.WorkItemType': 'Task', 'System.Title': 'Ajustar API' } });
    if (url.includes('/wit/workitems/404?')) return reply({}, 404);
    if (url.includes('/wit/workitems/7?') && url.includes('relations'))
      return reply({ relations: overrides.caseRelations ?? [] });
    if (url.includes('/wit/workitemtypecategories'))
      return reply({
        value: [
          {
            referenceName: 'Microsoft.RequirementCategory',
            workItemTypes: [{ name: 'Product Backlog Item' }],
          },
          { referenceName: 'Microsoft.BugCategory', workItemTypes: [{ name: 'Bug' }] },
          { referenceName: 'Microsoft.TaskCategory', workItemTypes: [{ name: 'Task' }] },
        ],
      });
    if (url.endsWith('/testplan/plans?api-version=7.1')) return reply({ id: 10 });
    if (url.includes('/testplan/plans/10?')) return reply({ id: 10, rootSuite: { id: 11 } });
    if (url.includes('/testplan/Plans/10/suites/30?'))
      return reply({ id: 30, suiteType: 'requirementTestSuite' });
    if (url.includes('/testplan/Plans/10/suites?')) {
      if (overrides.failSuiteCreation) return reply({}, overrides.failSuiteCreation);
      return reply({ id: nextSuite++ });
    }
    if (url.includes('/wit/workitems/'))
      return reply({ id: url.includes('/workitems/7?') ? 7 : nextCase++ });
    return reply({});
  });
  return {
    calls,
    publisher: new AzureTestSuitePublisher('https://dev.azure.com/org', 'QA', 'pat', fetcher),
  };
}

const relationsOf = (call: Call | undefined) =>
  (call?.body as { path: string; value: unknown }[] | undefined)?.filter(
    (change) => change.path === '/relations/-',
  ) ?? [];

describe('Azure requirement-based suites', () => {
  it('creates a requirement suite for the work item with every case of the tree', async () => {
    const { calls, publisher } = azure();
    const result = await publisher.publish(tree, { suiteKind: 'requirement', workItemId: '50' });
    const suiteCreation = calls.find(
      (call) => call.method === 'POST' && call.url.includes('/testplan/Plans/10/suites?'),
    );
    expect(suiteCreation?.body).toEqual({
      suiteType: 'requirementTestSuite',
      requirementId: 50,
      parentSuite: { id: 11 },
    });
    // Requirement suites hold no child suites: the whole tree lands in the one suite.
    expect(calls.filter((call) => call.url.includes('/suites/20/testcases/'))).toHaveLength(2);
    // Azure links cases added to a requirement suite; no manual link is added.
    const cases = calls.filter((call) => call.url.includes('/wit/workitems/$Test%20Case'));
    expect(cases.flatMap(relationsOf)).toEqual([]);
    expect(result).toMatchObject({
      remoteSuiteId: '20',
      suitesCount: 1,
      casesCount: 2,
      suiteKind: 'requirement',
      workItem: { id: '50', type: 'Product Backlog Item', title: 'Cores' },
    });
  });

  it('refuses a task as requirement before creating anything', async () => {
    const { calls, publisher } = azure();
    await expect(
      publisher.publish(tree, { suiteKind: 'requirement', workItemId: '60' }),
    ).rejects.toMatchObject({
      code: 'REQUIREMENT_SUITE_REJECTED',
      messageParams: { id: 60, type: 'Task' },
    });
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('explains when Azure rejects the requirement (bugs off the backlog)', async () => {
    const { publisher } = azure({ failSuiteCreation: 400 });
    await expect(
      publisher.publish(tree, { suiteKind: 'requirement', workItemId: '50' }),
    ).rejects.toMatchObject({ code: 'REQUIREMENT_SUITE_REJECTED' });
    const other = azure({ failSuiteCreation: 500 });
    await expect(
      other.publisher.publish(tree, { suiteKind: 'requirement', workItemId: '50' }),
    ).rejects.toMatchObject({ code: 'TEST_SUITE_PUBLISH_FAILED' });
  });

  it('requires a work item, a new suite and an existing item', async () => {
    const { publisher } = azure();
    await expect(publisher.publish(tree, { suiteKind: 'requirement' })).rejects.toMatchObject({
      code: 'WORK_ITEM_REQUIRED',
    });
    await expect(
      publisher.publish(tree, {
        suiteKind: 'requirement',
        workItemId: '50',
        remotePlanId: '10',
        remoteSuiteId: '30',
      }),
    ).rejects.toMatchObject({ code: 'REQUIREMENT_SUITE_NEEDS_NEW_SUITE' });
    await expect(publisher.publish(tree, { workItemId: '404' })).rejects.toMatchObject({
      code: 'WORK_ITEM_NOT_FOUND',
      messageParams: { id: 404 },
    });
  });
});

describe('Azure static suites linked to a work item', () => {
  it('links every new case to the item with a Tests link, whatever its type', async () => {
    const { calls, publisher } = azure();
    const result = await publisher.publish(tree, { suiteKind: 'static', workItemId: '60' });
    const cases = calls.filter((call) => call.url.includes('/wit/workitems/$Test%20Case'));
    expect(cases).toHaveLength(2);
    for (const call of cases)
      expect(relationsOf(call)).toEqual([
        {
          op: 'add',
          path: '/relations/-',
          value: {
            rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
            url: 'https://dev.azure.com/org/_apis/wit/workItems/60',
          },
        },
      ]);
    expect(result).toMatchObject({
      suitesCount: 2,
      suiteKind: 'static',
      workItem: { id: '60', type: 'Task' },
    });
  });

  it('links a republished case only when it is not linked yet', async () => {
    const republished = {
      ...tree,
      cases: [{ ...testCase, metadata: { caseId: 'c1', remoteCaseIds: { azure_devops: '7' } } }],
      children: [],
    };
    const unlinked = azure();
    await unlinked.publisher.publish(republished, { workItemId: '50' });
    const update = unlinked.calls.find((call) => call.method === 'PATCH');
    expect(relationsOf(update)).toHaveLength(1);

    const linked = azure({
      caseRelations: [
        {
          rel: 'Microsoft.VSTS.Common.TestedBy-Reverse',
          url: 'https://dev.azure.com/org/_apis/wit/workItems/50',
        },
      ],
    });
    await linked.publisher.publish(republished, { workItemId: '50' });
    expect(relationsOf(linked.calls.find((call) => call.method === 'PATCH'))).toEqual([]);
  });

  it('leaves the link to Azure when cases go into an existing requirement suite', async () => {
    const { calls, publisher } = azure();
    const result = await publisher.publish(tree, {
      remotePlanId: '10',
      remoteSuiteId: '30',
      workItemId: '50',
    });
    expect(calls.filter((call) => call.url.includes('/suites/30/testcases/'))).toHaveLength(2);
    const cases = calls.filter((call) => call.url.includes('/wit/workitems/$Test%20Case'));
    expect(cases.flatMap(relationsOf)).toEqual([]);
    expect(result).toMatchObject({ workItem: { id: '50' } });
    expect(result).not.toHaveProperty('suiteKind');
  });
});
