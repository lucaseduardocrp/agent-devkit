import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';

interface FakeReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly jsonError?: boolean;
  readonly text?: string;
  readonly blob?: Blob;
  readonly headers?: Record<string, string>;
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

function reply(spec: FakeReply = {}): Response {
  const status = spec.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(spec.headers ?? {}),
    json: async () => {
      if (spec.jsonError) throw new SyntaxError('Unexpected end of JSON input');
      return spec.json;
    },
    text: async () => spec.text ?? '',
    blob: async () => spec.blob ?? new Blob([]),
  } as Response;
}

function setup(replies: FakeReply | FakeReply[] = {}, options: { token?: string } = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: RecordedCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal,
    });
    return reply(queue.length > 1 ? queue.shift() : queue[0]);
  });
  const client = new ApiClient({ baseUrl: 'http://api', fetcher, ...options });
  return { client, calls, fetcher };
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected a recorded call at index ${index}`);
  return item;
}

const R = { id: 'r1', marker: true };
const F = { title: 'Fields', value: 1 };

type Endpoint = readonly [
  name: string,
  call: (client: ApiClient) => Promise<unknown>,
  method: string,
  path: string,
  body: unknown,
  response: unknown,
  expected: unknown,
];

/* Every endpoint that maps 1:1 to a JSON request, with the payload it sends and its unwrapping. */
const endpoints: readonly Endpoint[] = [
  ['getIssues', (c) => c.getIssues(), 'GET', '/issues', undefined, { issues: [R] }, [R]],
  [
    'getReleaseNotes',
    (c) => c.getReleaseNotes(),
    'GET',
    '/release-notes',
    undefined,
    { releaseNotes: [R] },
    [R],
  ],
  [
    'createReleaseNote',
    (c) => c.createReleaseNote(F),
    'POST',
    '/release-notes',
    F,
    { releaseNote: R },
    R,
  ],
  [
    'generateReleaseNote',
    (c) => c.generateReleaseNote(F as never),
    'POST',
    '/release-notes/generate',
    F,
    { releaseNote: R },
    R,
  ],
  [
    'updateReleaseNote',
    (c) => c.updateReleaseNote('a b', F),
    'PATCH',
    '/release-notes/a%20b',
    F,
    { releaseNote: R },
    R,
  ],
  [
    'deleteReleaseNote',
    (c) => c.deleteReleaseNote('n1'),
    'DELETE',
    '/release-notes/n1',
    undefined,
    {},
    undefined,
  ],
  // The list carries an excerpt of each description; items are marked partial.
  [
    'getPbiItems',
    (c) => c.getPbiItems(),
    'GET',
    '/pbi?view=summary',
    undefined,
    { items: [{ ...R, descriptionExcerpt: 'Start' }] },
    [{ ...R, description: 'Start', partial: true }],
  ],
  ['getPbiItem', (c) => c.getPbiItem('p 1'), 'GET', '/pbi/items/p%201', undefined, { item: R }, R],
  ['getPbiContext', (c) => c.getPbiContext('p1'), 'GET', '/pbi/items/p1/context', undefined, R, R],
  [
    'getPbiComments',
    (c) => c.getPbiComments('p1'),
    'GET',
    '/pbi/items/p1/comments',
    undefined,
    { comments: [R] },
    [R],
  ],
  [
    'syncPbiChildren',
    (c) => c.syncPbiChildren('p1'),
    'POST',
    '/pbi/items/p1/sync-children',
    undefined,
    { items: [R] },
    [R],
  ],
  [
    'getPbiProviders',
    (c) => c.getPbiProviders(),
    'GET',
    '/pbi/providers',
    undefined,
    { providers: [R] },
    [R],
  ],
  [
    'getPbiCurrentIteration',
    (c) => c.getPbiCurrentIteration(),
    'GET',
    '/pbi/current-iteration',
    undefined,
    { currentIteration: 'Sprint 4' },
    'Sprint 4',
  ],
  ['pullPbiBoards', (c) => c.pullPbiBoards(), 'POST', '/pbi/pull', undefined, R, R],
  ['createPbiItem', (c) => c.createPbiItem(F as never), 'POST', '/pbi/items', F, { item: R }, R],
  ['updatePbiItem', (c) => c.updatePbiItem('p1', F), 'PATCH', '/pbi/items/p1', F, { item: R }, R],
  [
    'deletePbiItem',
    (c) => c.deletePbiItem('p1'),
    'DELETE',
    '/pbi/items/p1',
    undefined,
    {},
    undefined,
  ],
  [
    'getPbiPushContract (default values)',
    (c) => c.getPbiPushContract('p1', 'jira'),
    'POST',
    '/pbi/items/p1/push-contract',
    { providerId: 'jira', values: {} },
    { contract: R },
    R,
  ],
  [
    'getPbiPushContract (values)',
    (c) => c.getPbiPushContract('p1', 'trello', { list: 'L1' }),
    'POST',
    '/pbi/items/p1/push-contract',
    { providerId: 'trello', values: { list: 'L1' } },
    { contract: R },
    R,
  ],
  [
    'pushPbiItem',
    (c) => c.pushPbiItem('p1', { providerId: 'azure_devops' }),
    'POST',
    '/pbi/items/p1/push',
    { providerId: 'azure_devops' },
    { item: R, warnings: [] },
    { item: R, warnings: [] },
  ],
  [
    'getPbiRelations',
    (c) => c.getPbiRelations('p1'),
    'GET',
    '/pbi/items/p1/relations',
    undefined,
    { relations: [R] },
    [R],
  ],
  [
    'addPbiRelations',
    (c) => c.addPbiRelations('p1', 'related', ['p2']),
    'POST',
    '/pbi/items/p1/relations',
    { type: 'related', targetIds: ['p2'] },
    { relations: [R] },
    [R],
  ],
  [
    'removePbiRelation',
    (c) => c.removePbiRelation('p1', 'related', 'p 2'),
    'DELETE',
    '/pbi/items/p1/relations/related/p%202',
    undefined,
    { relations: [] },
    [],
  ],
  [
    'createIssueFromPbi',
    (c) => c.createIssueFromPbi('p1'),
    'POST',
    '/pbi/items/p1/issues',
    undefined,
    { issue: R },
    R,
  ],
  [
    'createIssue',
    (c) => c.createIssue({ title: 'Bug' }),
    'POST',
    '/issues',
    { title: 'Bug' },
    { issue: R },
    R,
  ],
  [
    'getIssue',
    (c) => c.getIssue('i1'),
    'GET',
    '/issues/i1',
    undefined,
    { issue: R, comments: [] },
    { issue: R, comments: [] },
  ],
  ['updateIssue', (c) => c.updateIssue('i1', F), 'PATCH', '/issues/i1', F, { issue: R }, R],
  ['deleteIssue', (c) => c.deleteIssue('i1'), 'DELETE', '/issues/i1', undefined, {}, undefined],
  [
    'addIssueComment',
    (c) => c.addIssueComment('i1', 'hello'),
    'POST',
    '/issues/i1/comments',
    { body: 'hello' },
    { comment: R },
    { comment: R },
  ],
  // An API older than the private inbox answers without runs: the client fills them in.
  [
    'getInbox',
    (c) => c.getInbox(),
    'GET',
    '/inbox',
    undefined,
    { items: [R] },
    [{ ...R, runs: [] }],
  ],
  [
    'updateInboxItem',
    (c) => c.updateInboxItem('n1', { read: true }),
    'PATCH',
    '/inbox/n1',
    { read: true },
    { ok: true },
    undefined,
  ],
  ['getDashboard', (c) => c.getDashboard(), 'GET', '/dashboard', undefined, R, R],
  ['getAgentRuns (all)', (c) => c.getAgentRuns(), 'GET', '/runs', undefined, { runs: [R] }, [R]],
  [
    'getAgentRuns (issue)',
    (c) => c.getAgentRuns('i 1'),
    'GET',
    '/runs?issueId=i%201',
    undefined,
    { runs: [] },
    [],
  ],
  [
    'startIssueRun',
    (c) => c.startIssueRun('i1'),
    'POST',
    '/issues/i1/runs',
    { mode: 'server' },
    { run: R },
    R,
  ],
  [
    'cancelAgentRun',
    (c) => c.cancelAgentRun('run1'),
    'POST',
    '/runs/run1/cancel',
    undefined,
    { run: R },
    R,
  ],
  ['getCosts', (c) => c.getCosts(), 'GET', '/costs', undefined, R, R],
  [
    'setMonthlyBudget',
    (c) => c.setMonthlyBudget(5000),
    'PATCH',
    '/costs/budget',
    { monthlyBudgetMicros: 5000 },
    R,
    R,
  ],
  ['setCostRate', (c) => c.setCostRate(F as never), 'PUT', '/costs/rates', F, { rate: R }, R],
  [
    'deleteCostRate',
    (c) => c.deleteCostRate('open ai', 'gpt/4'),
    'DELETE',
    '/costs/rates/open%20ai/gpt%2F4',
    undefined,
    {},
    undefined,
  ],
  [
    'getAuditHistory (defaults)',
    (c) => c.getAuditHistory('issue'),
    'GET',
    '/audit/history?entityType=issue&page=1&pageSize=20',
    undefined,
    R,
    R,
  ],
  [
    'getAuditHistory (entity)',
    (c) => c.getAuditHistory('pbi', 3, undefined, 'p1'),
    'GET',
    '/audit/history?entityType=pbi&page=3&pageSize=20&entityId=p1',
    undefined,
    R,
    R,
  ],
  [
    'updateSavedTestPlan',
    (c) => c.updateSavedTestPlan('t1', F as never),
    'PUT',
    '/TestPlan/t1',
    F,
    R,
    R,
  ],
  [
    'deleteSavedTestPlan',
    (c) => c.deleteSavedTestPlan('t1'),
    'DELETE',
    '/TestPlan/t1',
    undefined,
    {},
    undefined,
  ],
  ['getTestSuites', (c) => c.getTestSuites(), 'GET', '/TestPlan/suites', undefined, [R], [R]],
  [
    'createTestSuite (root)',
    (c) => c.createTestSuite('Root'),
    'POST',
    '/TestPlan/suites',
    { name: 'Root' },
    R,
    R,
  ],
  [
    'createTestSuite (child)',
    (c) => c.createTestSuite('Child', 's0'),
    'POST',
    '/TestPlan/suites',
    { name: 'Child', parentId: 's0' },
    R,
    R,
  ],
  [
    'updateTestSuite',
    (c) => c.updateTestSuite('s1', { name: 'Renamed', parentId: null }),
    'PUT',
    '/TestPlan/suites/s1',
    { name: 'Renamed', parentId: null },
    R,
    R,
  ],
  [
    'deleteTestSuite',
    (c) => c.deleteTestSuite('s1'),
    'DELETE',
    '/TestPlan/suites/s1',
    undefined,
    {},
    undefined,
  ],
  [
    'getTestSuiteProviders',
    (c) => c.getTestSuiteProviders(),
    'GET',
    '/TestPlan/publish/providers',
    undefined,
    { providers: [R] },
    [R],
  ],
  [
    'getRemoteTestPlans',
    (c) => c.getRemoteTestPlans('azure'),
    'GET',
    '/TestPlan/publish/plans?providerId=azure',
    undefined,
    { plans: [R] },
    [R],
  ],
  [
    'getRemoteTestSuites',
    (c) => c.getRemoteTestSuites('azure', 'pl1'),
    'GET',
    '/TestPlan/publish/plans/pl1/suites?providerId=azure',
    undefined,
    { suites: [R] },
    [R],
  ],
  [
    'pushTestSuite',
    (c) => c.pushTestSuite('s1', { providerId: 'azure' }),
    'POST',
    '/TestPlan/suites/s1/push',
    { providerId: 'azure' },
    R,
    R,
  ],
  ['getSpecTemplates', (c) => c.getSpecTemplates(), 'GET', '/spec/templates', undefined, [R], [R]],
  [
    'saveSpecTemplate (new)',
    (c) => c.saveSpecTemplate({ name: 'T', sections: [] }),
    'POST',
    '/spec/templates',
    { name: 'T', sections: [] },
    R,
    R,
  ],
  [
    'saveSpecTemplate (existing)',
    (c) => c.saveSpecTemplate({ id: 'tp1', name: 'T', sections: [] }),
    'PUT',
    '/spec/templates/tp1',
    { id: 'tp1', name: 'T', sections: [] },
    R,
    R,
  ],
  [
    'deleteSpecTemplate',
    (c) => c.deleteSpecTemplate('tp1'),
    'DELETE',
    '/spec/templates/tp1',
    undefined,
    {},
    undefined,
  ],
  [
    'getSpecifications',
    (c) => c.getSpecifications(),
    'GET',
    '/spec/specifications',
    undefined,
    [R],
    [R],
  ],
  [
    'saveSpecification (new)',
    (c) => c.saveSpecification({ title: 'S', sections: [] }),
    'POST',
    '/spec/specifications',
    { title: 'S', sections: [] },
    R,
    R,
  ],
  [
    'saveSpecification (existing)',
    (c) => c.saveSpecification({ id: 'sp1', title: 'S', sections: [] }),
    'PUT',
    '/spec/specifications/sp1',
    { id: 'sp1', title: 'S', sections: [] },
    R,
    R,
  ],
  [
    'chatSpecification',
    (c) => c.chatSpecification('sp1', 'a1', 'Refine'),
    'POST',
    '/spec/specifications/sp1/chat',
    { agentId: 'a1', content: 'Refine' },
    R,
    R,
  ],
  [
    'clearSpecificationMessages',
    (c) => c.clearSpecificationMessages('sp1'),
    'DELETE',
    '/spec/specifications/sp1/messages',
    {},
    R,
    R,
  ],
  [
    'publishSpecification',
    (c) => c.publishSpecification('sp1'),
    'POST',
    '/spec/specifications/sp1/knowledge',
    {},
    R,
    R,
  ],
  [
    'createSpecificationFromKnowledge',
    (c) =>
      c.createSpecificationFromKnowledge({ pageId: 'p', source: 's', title: 't', agentId: 'a' }),
    'POST',
    '/spec/from-knowledge',
    { pageId: 'p', source: 's', title: 't', agentId: 'a' },
    R,
    R,
  ],
  [
    'deleteSpecification',
    (c) => c.deleteSpecification('sp1'),
    'DELETE',
    '/spec/specifications/sp1',
    undefined,
    {},
    undefined,
  ],
  [
    'getDesignProviders',
    (c) => c.getDesignProviders(),
    'GET',
    '/design/providers',
    undefined,
    { providers: ['github'] },
    ['github'],
  ],
  [
    'getDesignProjects',
    (c) => c.getDesignProjects('github'),
    'GET',
    '/design/projects?provider=github',
    undefined,
    { projects: [R] },
    [R],
  ],
  [
    'getDesignProject',
    (c) => c.getDesignProject('d1', 'azure'),
    'GET',
    '/design/projects/d1?provider=azure',
    undefined,
    R,
    R,
  ],
  [
    'createDesignProject',
    (c) => c.createDesignProject({ title: 't', agentId: 'a', prompt: 'p', provider: 'github' }),
    'POST',
    '/design/projects',
    { title: 't', agentId: 'a', prompt: 'p', provider: 'github' },
    R,
    R,
  ],
  [
    'chatDesignProject (text only)',
    (c) => c.chatDesignProject('d1', 'Darker', 'github'),
    'POST',
    '/design/projects/d1/messages?provider=github',
    { content: 'Darker' },
    R,
    R,
  ],
  [
    'chatDesignProject (empty images)',
    (c) => c.chatDesignProject('d1', 'Darker', 'github', 'a1', []),
    'POST',
    '/design/projects/d1/messages?provider=github',
    { content: 'Darker', agentId: 'a1' },
    R,
    R,
  ],
  [
    'chatDesignProject (images)',
    (c) =>
      c.chatDesignProject('d1', 'Like this', 'azure', 'a1', [
        { mimeType: 'image/png', data: 'AAA' },
      ]),
    'POST',
    '/design/projects/d1/messages?provider=azure',
    { content: 'Like this', agentId: 'a1', images: [{ mimeType: 'image/png', data: 'AAA' }] },
    R,
    R,
  ],
  [
    'updateDesignFiles',
    (c) =>
      c.updateDesignFiles('d1', [{ name: 'a.html', language: 'html', content: '<p>' }], 'github'),
    'PUT',
    '/design/projects/d1/files?provider=github',
    { files: [{ name: 'a.html', language: 'html', content: '<p>' }] },
    R,
    R,
  ],
  [
    'deleteDesignProject',
    (c) => c.deleteDesignProject('d1', 'github'),
    'DELETE',
    '/design/projects/d1?provider=github',
    undefined,
    {},
    undefined,
  ],
  [
    'getDesignSystems',
    (c) => c.getDesignSystems('azure'),
    'GET',
    '/design/systems?provider=azure',
    undefined,
    { systems: [R] },
    [R],
  ],
  [
    'saveDesignSystem',
    (c) => c.saveDesignSystem('github', { name: 'DS', content: '# DS' }),
    'PUT',
    '/design/systems?provider=github',
    { name: 'DS', content: '# DS' },
    R,
    R,
  ],
  [
    'generateDesignSystem',
    (c) => c.generateDesignSystem('a1', 'Calm'),
    'POST',
    '/design/systems/generate',
    { agentId: 'a1', prompt: 'Calm' },
    { content: '# DS' },
    { content: '# DS' },
  ],
  [
    'deleteDesignSystem',
    (c) => c.deleteDesignSystem('ds1', 'azure'),
    'DELETE',
    '/design/systems/ds1?provider=azure',
    undefined,
    {},
    undefined,
  ],
  [
    'getE2eCreations',
    (c) => c.getE2eCreations(),
    'GET',
    '/e2e/creations',
    undefined,
    { creations: [R] },
    [R],
  ],
  [
    'createE2eCreation',
    (c) => c.createE2eCreation(F as never),
    'POST',
    '/e2e/creations',
    F,
    { creation: R },
    R,
  ],
  [
    'getE2eCreation',
    (c) => c.getE2eCreation('e1'),
    'GET',
    '/e2e/creations/e1',
    undefined,
    { creation: R },
    R,
  ],
  [
    'updateE2eCreation',
    (c) => c.updateE2eCreation('e1', F as never),
    'PUT',
    '/e2e/creations/e1',
    F,
    { creation: R },
    R,
  ],
  [
    'rerunE2eCreation',
    (c) => c.rerunE2eCreation('e1'),
    'POST',
    '/e2e/creations/e1/run',
    {},
    {},
    undefined,
  ],
  [
    'cancelE2eCreation',
    (c) => c.cancelE2eCreation('e1'),
    'POST',
    '/e2e/creations/e1/cancel',
    {},
    {},
    undefined,
  ],
  [
    'deleteE2eCreation',
    (c) => c.deleteE2eCreation('e1'),
    'DELETE',
    '/e2e/creations/e1',
    undefined,
    {},
    undefined,
  ],
  [
    'getE2eRepositories',
    (c) => c.getE2eRepositories(),
    'GET',
    '/e2e/repositories',
    undefined,
    { repositories: [], warnings: [] },
    { repositories: [], warnings: [] },
  ],
  [
    'getE2eBranches',
    (c) => c.getE2eBranches('github', 'org/repo'),
    'GET',
    '/e2e/repositories/branches?provider=github&repositoryId=org%2Frepo',
    undefined,
    { branches: [R] },
    [R],
  ],
  [
    'getE2eScript',
    (c) => c.getE2eScript('t1'),
    'GET',
    '/e2e/tests/t1/script',
    undefined,
    { script: R },
    R,
  ],
  [
    'pushE2eScript',
    (c) => c.pushE2eScript('t1', 'test()'),
    'PUT',
    '/e2e/tests/t1/script',
    { content: 'test()' },
    { script: R },
    R,
  ],
  [
    'pullE2eCreation',
    (c) => c.pullE2eCreation('e1'),
    'POST',
    '/e2e/creations/e1/pull',
    {},
    { result: R },
    R,
  ],
  ['getE2eTest', (c) => c.getE2eTest('t1'), 'GET', '/e2e/tests/t1', undefined, { test: R }, R],
  [
    'rerunE2eTest (default)',
    (c) => c.rerunE2eTest('t1'),
    'POST',
    '/e2e/tests/t1/run',
    { regenerate: false },
    {},
    undefined,
  ],
  [
    'rerunE2eTest (regenerate)',
    (c) => c.rerunE2eTest('t1', true),
    'POST',
    '/e2e/tests/t1/run',
    { regenerate: true },
    {},
    undefined,
  ],
  [
    'getE2eTestVideoUrl',
    (c) => c.getE2eTestVideoUrl('t1'),
    'GET',
    '/e2e/tests/t1/video-url',
    undefined,
    { video: { url: 'https://r2/v.webm', mimeType: 'video/webm' } },
    { url: 'https://r2/v.webm', mimeType: 'video/webm' },
  ],
  [
    'getTestManagementProviders',
    (c) => c.getTestManagementProviders(),
    'GET',
    '/e2e/test-management/providers',
    undefined,
    { providers: [R] },
    [R],
  ],
  [
    'getTestManagementPlans',
    (c) => c.getTestManagementPlans('testrail'),
    'GET',
    '/e2e/test-management/testrail/plans',
    undefined,
    { plans: [R] },
    [R],
  ],
  [
    'getTestManagementSuites',
    (c) => c.getTestManagementSuites('xray', 'pl 1'),
    'GET',
    '/e2e/test-management/xray/plans/pl%201/suites',
    undefined,
    { suites: [R] },
    [R],
  ],
  [
    'getTestManagementCases (no location)',
    (c) => c.getTestManagementCases('azure_devops'),
    'GET',
    '/e2e/test-management/azure_devops/cases',
    undefined,
    { cases: [R] },
    [R],
  ],
  [
    'getTestManagementCases (plan + suite)',
    (c) => c.getTestManagementCases('azure_devops', { planId: 'p1', suiteId: 's1' }),
    'GET',
    '/e2e/test-management/azure_devops/cases?planId=p1&suiteId=s1',
    undefined,
    { cases: [] },
    [],
  ],
  [
    'importE2eCases',
    (c) => c.importE2eCases('e1', F as never),
    'POST',
    '/e2e/creations/e1/import-cases',
    F,
    { result: R },
    R,
  ],
  [
    'setE2eReporting',
    (c) => c.setE2eReporting('e1', null),
    'PUT',
    '/e2e/creations/e1/reporting',
    { reporting: null },
    { creation: R },
    R,
  ],
  [
    'publishE2eCreation',
    (c) => c.publishE2eCreation('e1'),
    'POST',
    '/e2e/creations/e1/publish',
    {},
    { creation: R },
    R,
  ],
  [
    'linkE2eTestCase',
    (c) => c.linkE2eTestCase('t1', null),
    'PUT',
    '/e2e/tests/t1/external-case',
    { externalCase: null },
    { test: R },
    R,
  ],
  [
    'requestPasswordReset',
    (c) => c.requestPasswordReset('a@b.c'),
    'POST',
    '/auth/password/forgot',
    { email: 'a@b.c' },
    { success: true },
    { success: true },
  ],
  [
    'getAuthOptions',
    (c) => c.getAuthOptions(),
    'GET',
    '/auth/options',
    undefined,
    { oauthProviders: ['google'] },
    { oauthProviders: ['google'] },
  ],
  ['getMe', (c) => c.getMe(), 'GET', '/auth/me', undefined, { user: R }, R],
  [
    'getIntegrations (wrapped)',
    (c) => c.getIntegrations(),
    'GET',
    '/integrations',
    undefined,
    { integrations: [R] },
    [R],
  ],
  [
    'getIntegrations (array)',
    (c) => c.getIntegrations(),
    'GET',
    '/integrations',
    undefined,
    [R],
    [R],
  ],
  [
    'saveIntegration (wrapped)',
    (c) => c.saveIntegration('LLM', 'openai', { isEnabled: true }),
    'PUT',
    '/integrations/LLM/openai',
    { isEnabled: true },
    { integration: R },
    R,
  ],
  [
    'saveIntegration (plain)',
    (c) => c.saveIntegration('LLM', 'openai', { secret: 's' }),
    'PUT',
    '/integrations/LLM/openai',
    { secret: 's' },
    R,
    R,
  ],
  [
    'deleteIntegration',
    (c) => c.deleteIntegration('LLM', 'openai'),
    'DELETE',
    '/integrations/LLM/openai',
    undefined,
    {},
    undefined,
  ],
  [
    'testIntegration (saved settings)',
    (c) => c.testIntegration('LLM', 'openai'),
    'POST',
    '/integrations/LLM/openai/test',
    {},
    { ok: true, message: 'ok' },
    { ok: true, message: 'ok' },
  ],
  [
    'testIntegration (draft settings)',
    (c) => c.testIntegration('LLM', 'openai', { settings: { model: 'x' } }),
    'POST',
    '/integrations/LLM/openai/test',
    { settings: { model: 'x' } },
    { ok: false, message: 'no' },
    { ok: false, message: 'no' },
  ],
  [
    'getAzureDevOpsProjectMembers',
    (c) => c.getAzureDevOpsProjectMembers(),
    'GET',
    '/integrations/azure-devops/members',
    undefined,
    R,
    R,
  ],
  [
    'getAzureDevOpsProjectMembers (test options)',
    (c) => c.getAzureDevOpsProjectMembers(undefined, true),
    'GET',
    '/integrations/azure-devops/members?testOptions=true',
    undefined,
    R,
    R,
  ],
  ['syncKnowledge', (c) => c.syncKnowledge(), 'POST', '/knowledge/sync', undefined, R, R],
  [
    'getKnowledgePushProviders',
    (c) => c.getKnowledgePushProviders(),
    'GET',
    '/knowledge/push-providers',
    undefined,
    { providers: [R] },
    [R],
  ],
  [
    'getKnowledgePushDestinations',
    (c) => c.getKnowledgePushDestinations('notion'),
    'GET',
    '/knowledge/push-destinations/notion',
    undefined,
    { destinations: [R] },
    [R],
  ],
  [
    'pushKnowledgeDocument (default destination)',
    (c) => c.pushKnowledgeDocument('pg1'),
    'POST',
    '/knowledge/documents/pg1/push',
    undefined,
    { success: true, remoteUrl: 'u' },
    { success: true, remoteUrl: 'u' },
  ],
  [
    'pushKnowledgeDocument (destination)',
    (c) => c.pushKnowledgeDocument('pg1', { providerId: 'notion', destination: { listId: 'l' } }),
    'POST',
    '/knowledge/documents/pg1/push',
    { providerId: 'notion', destination: { listId: 'l' } },
    { success: true, remoteUrl: 'u' },
    { success: true, remoteUrl: 'u' },
  ],
  [
    'getKnowledgeStats',
    (c) => c.getKnowledgeStats(),
    'GET',
    '/knowledge/stats',
    undefined,
    { documentsCount: 1, chunksCount: 2 },
    { documentsCount: 1, chunksCount: 2 },
  ],
  [
    'getKnowledgeDocuments',
    (c) => c.getKnowledgeDocuments(),
    'GET',
    '/knowledge/documents',
    undefined,
    { documents: [R] },
    [R],
  ],
  [
    'getKnowledgeRelations',
    (c) => c.getKnowledgeRelations(),
    'GET',
    '/knowledge/relations',
    undefined,
    { relations: [R] },
    [R],
  ],
  [
    'createKnowledgeRelation',
    (c) => c.createKnowledgeRelation('a', 'b'),
    'POST',
    '/knowledge/relations',
    { sourcePageId: 'a', targetPageId: 'b' },
    { relations: [R] },
    [R],
  ],
  [
    'deleteKnowledgeRelation',
    (c) => c.deleteKnowledgeRelation('a', 'b'),
    'DELETE',
    '/knowledge/relations?sourcePageId=a&targetPageId=b',
    undefined,
    {},
    undefined,
  ],
  [
    'createKnowledgeDocument (root)',
    (c) => c.createKnowledgeDocument('T', 'C'),
    'POST',
    '/knowledge/documents',
    { title: 'T', content: 'C' },
    { document: R },
    R,
  ],
  [
    'createKnowledgeDocument (child)',
    (c) => c.createKnowledgeDocument('T', 'C', undefined, 'parent'),
    'POST',
    '/knowledge/documents',
    { title: 'T', content: 'C', parentPageId: 'parent' },
    { document: R },
    R,
  ],
  [
    'updateKnowledgeDocument',
    (c) => c.updateKnowledgeDocument('pg1', 'T', 'C'),
    'PUT',
    '/knowledge/documents/pg1',
    { title: 'T', content: 'C' },
    { document: R },
    R,
  ],
  [
    'deleteKnowledgeDocument',
    (c) => c.deleteKnowledgeDocument('pg1'),
    'DELETE',
    '/knowledge/documents/pg1',
    undefined,
    {},
    undefined,
  ],
  [
    'deleteKnowledgeDocument (source)',
    (c) => c.deleteKnowledgeDocument('pg1', 'notion'),
    'DELETE',
    '/knowledge/documents/pg1?source=notion',
    undefined,
    {},
    undefined,
  ],
  ['getWorkspaces', (c) => c.getWorkspaces(), 'GET', '/workspaces', undefined, [R], [R]],
  [
    'createWorkspace',
    (c) => c.createWorkspace({ name: 'W' }),
    'POST',
    '/workspaces',
    { name: 'W' },
    R,
    R,
  ],
  [
    'listAccessTokens',
    (c) => c.listAccessTokens(),
    'GET',
    '/auth/tokens',
    undefined,
    { tokens: [R] },
    [R],
  ],
  [
    'createAccessToken',
    (c) => c.createAccessToken({ name: 'ci', scope: 'read', expiresInDays: 30 }),
    'POST',
    '/auth/tokens',
    { name: 'ci', scope: 'read', expiresInDays: 30 },
    { token: 'adk_x', accessToken: R },
    { token: 'adk_x', accessToken: R },
  ],
  [
    'revokeAccessToken',
    (c) => c.revokeAccessToken('tk1'),
    'DELETE',
    '/auth/tokens/tk1',
    undefined,
    {},
    undefined,
  ],
  [
    'getWorkspaceMembers',
    (c) => c.getWorkspaceMembers('w1'),
    'GET',
    '/workspaces/w1/members',
    undefined,
    [R],
    [R],
  ],
  [
    'addWorkspaceMember',
    (c) => c.addWorkspaceMember('w1', { email: 'a@b.c', role: 'member' as never }),
    'POST',
    '/workspaces/w1/members',
    { email: 'a@b.c', role: 'member' },
    R,
    R,
  ],
  [
    'updateWorkspaceMember',
    (c) => c.updateWorkspaceMember('w1', 'm1', { groupIds: ['g1'] }),
    'PATCH',
    '/workspaces/w1/members/m1',
    { groupIds: ['g1'] },
    R,
    R,
  ],
  [
    'removeWorkspaceMember',
    (c) => c.removeWorkspaceMember('w1', 'm1'),
    'DELETE',
    '/workspaces/w1/members/m1',
    undefined,
    { success: true },
    { success: true },
  ],
  [
    'renameWorkspace',
    (c) => c.renameWorkspace('w1', 'New'),
    'PATCH',
    '/workspaces/w1',
    { name: 'New' },
    R,
    R,
  ],
  [
    'getPermissionGroups',
    (c) => c.getPermissionGroups('w1'),
    'GET',
    '/workspaces/w1/groups',
    undefined,
    [R],
    [R],
  ],
  [
    'savePermissionGroup (new)',
    (c) => c.savePermissionGroup('w1', { name: 'QA' }),
    'POST',
    '/workspaces/w1/groups',
    { name: 'QA' },
    R,
    R,
  ],
  [
    'savePermissionGroup (existing)',
    (c) => c.savePermissionGroup('w1', { name: 'QA' }, 'g1'),
    'PATCH',
    '/workspaces/w1/groups/g1',
    { name: 'QA' },
    R,
    R,
  ],
  [
    'deletePermissionGroup',
    (c) => c.deletePermissionGroup('w1', 'g1'),
    'DELETE',
    '/workspaces/w1/groups/g1',
    undefined,
    {},
    undefined,
  ],
  [
    'deleteWorkspace',
    (c) => c.deleteWorkspace('w1'),
    'DELETE',
    '/workspaces/w1',
    undefined,
    { success: true },
    { success: true },
  ],
  ['getAgents (array)', (c) => c.getAgents(), 'GET', '/agents', undefined, [R], [R]],
  ['getAgents (wrapped)', (c) => c.getAgents(), 'GET', '/agents', undefined, { agents: [R] }, [R]],
  ['getAgent (wrapped)', (c) => c.getAgent('a1'), 'GET', '/agents/a1', undefined, { agent: R }, R],
  ['getAgent (plain)', (c) => c.getAgent('a1'), 'GET', '/agents/a1', undefined, R, R],
  [
    'createAgent (wrapped)',
    (c) => c.createAgent(F as never),
    'POST',
    '/agents',
    F,
    { agent: R },
    R,
  ],
  ['createAgent (plain)', (c) => c.createAgent(F as never), 'POST', '/agents', F, R, R],
  [
    'updateAgent (wrapped)',
    (c) => c.updateAgent('a1', F as never),
    'PUT',
    '/agents/a1',
    F,
    { agent: R },
    R,
  ],
  [
    'updateAgent (plain)',
    (c) => c.updateAgent('a1', F as never),
    'PUT',
    '/agents/a1',
    F,
    { agent: null, id: 'x' },
    { agent: null, id: 'x' },
  ],
  [
    'deleteAgent',
    (c) => c.deleteAgent('a1'),
    'DELETE',
    '/agents/a1',
    undefined,
    { success: true },
    { success: true },
  ],
  [
    'queryBrain (no history)',
    (c) => c.queryBrain('What is ADK?'),
    'POST',
    '/agents/default/brain-query',
    { prompt: 'What is ADK?' },
    { result: 'Answer', agent: { name: 'Brain' } },
    { content: 'Answer', agentName: 'Brain', provider: undefined },
  ],
  [
    'queryBrain (history)',
    (c) => c.queryBrain('More', 'user: hi'),
    'POST',
    '/agents/default/brain-query',
    { prompt: 'More', history: 'user: hi' },
    { result: 'Answer', agent: { name: 'Brain' }, provider: 'openai' },
    { content: 'Answer', agentName: 'Brain', provider: 'openai' },
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiClient endpoints', () => {
  it.each(endpoints)(
    '%s sends the request and unwraps the response',
    async (_name, call, method, path, body, response, expected) => {
      const { client, calls } = setup({ json: response });
      await expect(call(client)).resolves.toEqual(expected);
      expect(calls).toHaveLength(1);
      const request = nth(calls, 0);
      expect(request.url).toBe(`http://api${path}`);
      expect(request.method).toBe(method);
      expect(request.body).toEqual(body);
      if (body !== undefined) {
        expect(request.headers['content-type'] ?? request.headers['Content-Type']).toBe(
          'application/json',
        );
      }
      expect(request.headers['x-locale']).toBe('pt-BR');
      expect(request.headers['Accept-Language']).toBe('pt-BR');
    },
  );

  it.each(endpoints)('%s rejects with ApiClientError on a non-ok response', async (...row) => {
    const call = row[1];
    const { client } = setup({ status: 409, json: { message: 'Conflict detected' } });
    const error = await call(client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, message: 'Conflict detected' });
  });
});

describe('ApiClient request plumbing', () => {
  it('falls back to the global fetch and default base URL', async () => {
    const globalFetch = vi.fn(async () => reply({ json: { issues: [] } }));
    vi.stubGlobal('fetch', globalFetch);
    const client = new ApiClient();
    await expect(client.getIssues()).resolves.toEqual([]);
    expect(globalFetch).toHaveBeenCalledWith(
      'http://localhost:3000/issues',
      expect.objectContaining({ headers: { 'x-locale': 'pt-BR', 'Accept-Language': 'pt-BR' } }),
    );
  });

  it('adds auth, workspace and locale headers and exposes their accessors', async () => {
    const { client, calls } = setup({ json: { issues: [] } });
    expect(client.getToken()).toBeNull();
    expect(client.getWorkspaceId()).toBeNull();
    expect(client.getLocale()).toBe('pt-BR');
    client.setToken('tkn');
    client.setWorkspaceId('ws1');
    client.setLocale('en-US');
    expect(client.getToken()).toBe('tkn');
    expect(client.getWorkspaceId()).toBe('ws1');
    expect(client.getLocale()).toBe('en-US');
    await client.getIssues();
    expect(nth(calls, 0).headers).toEqual({
      authorization: 'Bearer tkn',
      'x-workspace-id': 'ws1',
      'x-locale': 'en-US',
      'Accept-Language': 'en-US',
    });
  });

  it('accepts token, workspace and locale through the constructor', async () => {
    const calls: Record<string, string>[] = [];
    const client = new ApiClient({
      token: 't0',
      workspaceId: 'w0',
      locale: 'en-US',
      fetcher: async (_input, init) => {
        calls.push(init?.headers as Record<string, string>);
        return reply({ json: [] });
      },
    });
    await client.getWorkspaces();
    expect(nth(calls, 0)).toMatchObject({ authorization: 'Bearer t0', 'x-workspace-id': 'w0' });
  });

  it('forwards abort signals and propagates aborts from fetch', async () => {
    const controller = new AbortController();
    const { client, calls } = setup({ json: { issues: [] } });
    await client.getIssues(controller.signal);
    expect(nth(calls, 0).signal).toBe(controller.signal);

    controller.abort();
    const aborting = new ApiClient({
      fetcher: async (_input, init) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return reply();
      },
    });
    await expect(aborting.getHealth(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(aborting.getMe(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('derives error messages from message, error, fallback and unreadable bodies', async () => {
    const statuses: [FakeReply, string][] = [
      [{ status: 400, json: { error: 'Bad input' } }, 'Bad input'],
      [{ status: 500, json: {} }, 'Falha de conexão com o servidor.'],
      [{ status: 502, jsonError: true }, 'Falha de conexão com o servidor.'],
      [{ status: 502, json: { code: 'AZURE_WIKI_ERROR', message: 'Wiki down' } }, 'Wiki down'],
      [
        {
          status: 502,
          json: { code: 'AZURE_WIKI_ERROR', message: 'Wiki down', details: [{ stage: 7 }] },
        },
        'Wiki down',
      ],
      [
        {
          status: 502,
          json: {
            code: 'AZURE_WIKI_ERROR',
            message: 'Wiki down',
            details: [{ stage: 'create-page', upstreamStatus: 400 }],
          },
        },
        'Wiki down (Azure HTTP 400, create-page)',
      ],
      [
        {
          status: 502,
          json: { code: 'AZURE_WIKI_ERROR', message: 'Wiki down', details: [{ stage: 'network' }] },
        },
        'Wiki down (network)',
      ],
    ];
    for (const [spec, message] of statuses) {
      const { client } = setup(spec);
      await expect(client.getIssues()).rejects.toMatchObject({ status: spec.status, message });
    }
    const { client } = setup({ status: 500, jsonError: true });
    client.setLocale('en-US');
    await expect(client.getIssues()).rejects.toThrow('Failed to communicate with server.');
  });

  it('builds the OAuth start URL without a request', () => {
    const { client, fetcher } = setup();
    expect(client.getOAuthStartUrl('github')).toBe('http://api/auth/oauth/github/start');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('ApiClient special responses', () => {
  it('exports release notes with UTF-8, quoted or missing file names', async () => {
    const blob = new Blob(['# Notes']);
    const cases: [Record<string, string>, string | null][] = [
      // The source regex `/filename*=UTF-8''.../` reads `*` as a quantifier on `e`, so it only
      // matches the asterisk-less form; RFC 5987 `filename*=` falls through to null.
      [{ 'content-disposition': "attachment; filename=UTF-8''Notas%20v1.md" }, 'Notas v1.md'],
      [{ 'content-disposition': 'attachment; filename="notes.pdf"' }, 'notes.pdf'],
      [{}, null],
    ];
    for (const [headers, fileName] of cases) {
      const { client, calls } = setup({ headers, blob });
      await expect(client.exportReleaseNote('n 1', 'markdown')).resolves.toEqual({
        blob,
        fileName,
      });
      expect(nth(calls, 0).url).toBe('http://api/release-notes/n%201/export?format=markdown');
    }
    const { client } = setup({ status: 404, json: { message: 'Missing' } });
    await expect(client.exportReleaseNote('n1', 'pdf')).rejects.toThrow('Missing');
  });

  it('downloads videos, screenshots and spec exports', async () => {
    const blob = new Blob(['bytes']);
    const { client, calls } = setup({ blob, text: '# Spec' });
    await expect(client.getE2eTestVideo('t1')).resolves.toBe(blob);
    await expect(client.getE2eStepScreenshot('t1', 2)).resolves.toBe(blob);
    await expect(client.exportSpecification('sp1')).resolves.toBe('# Spec');
    expect(calls.map((c) => c.url)).toEqual([
      'http://api/e2e/tests/t1/video',
      'http://api/e2e/tests/t1/steps/2/screenshot',
      'http://api/spec/specifications/sp1/export',
    ]);

    const failing = setup({ status: 403, json: { message: 'Forbidden' } }).client;
    await expect(failing.getE2eTestVideo('t1')).rejects.toMatchObject({ status: 403 });
    await expect(failing.getE2eStepScreenshot('t1', 1)).rejects.toMatchObject({ status: 403 });
    await expect(failing.exportSpecification('sp1')).rejects.toMatchObject({ status: 403 });
  });

  it('returns an empty audit page on 204', async () => {
    const { client } = setup({ status: 204 });
    await expect(client.getAuditHistory('document', 2)).resolves.toEqual({
      items: [],
      total: 0,
      page: 2,
      totalPages: 0,
    });
  });

  it('validates health responses', async () => {
    const ok = { status: 'ok', requestId: 'req-1' };
    await expect(setup({ json: ok }).client.getHealth()).resolves.toEqual(ok);
    await expect(
      setup({ json: { status: 'down', requestId: 'r' } }).client.getHealth(),
    ).rejects.toMatchObject({ status: 502 });
    await expect(setup({ json: { status: 'ok' } }).client.getHealth()).rejects.toMatchObject({
      status: 502,
    });
    await expect(setup({ status: 500, json: {} }).client.getHealth()).rejects.toMatchObject({
      status: 500,
    });
  });

  it('accepts ready and not-ready readiness payloads and rejects others', async () => {
    const ready = { status: 'ready', checks: [] };
    const notReady = { status: 'not-ready', checks: [{ name: 'db', status: 'not-ready' }] };
    const { client, calls } = setup({ json: ready });
    await expect(client.getReadiness()).resolves.toEqual(ready);
    expect(nth(calls, 0).url).toBe('http://api/health/ready');
    await expect(setup({ status: 503, json: notReady }).client.getReadiness()).resolves.toEqual(
      notReady,
    );
    await expect(
      setup({ json: { status: 'unknown', checks: [] } }).client.getReadiness(),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      setup({ json: { status: 'ready', checks: 'none' } }).client.getReadiness(),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      setup({ status: 401, json: { message: 'Login' } }).client.getReadiness(),
    ).rejects.toMatchObject({ status: 401, message: 'Login' });
  });

  it('searches knowledge with trimming, owner header, empty and invalid results', async () => {
    const chunk = { source: 's', pageId: 'p', chunkIndex: 0, content: 'c', createdAt: 'now' };
    const { client, calls } = setup({ json: [chunk] });
    await expect(client.searchKnowledge('  login flow ', ' owner-1 ')).resolves.toEqual([chunk]);
    expect(nth(calls, 0).url).toBe('http://api/TestPlan/search?prompt=login%20flow');
    expect(nth(calls, 0).headers['x-owner-id']).toBe('owner-1');

    await client.searchKnowledge('flow', '   ');
    expect(nth(calls, 1).headers['x-owner-id']).toBeUndefined();

    await expect(client.searchKnowledge('   ')).rejects.toMatchObject({ status: 400 });
    await expect(setup({ status: 204 }).client.searchKnowledge('x')).resolves.toEqual([]);
    await expect(setup({ json: {} }).client.searchKnowledge('x')).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      setup({ status: 500, json: { message: 'Down' } }).client.searchKnowledge('x'),
    ).rejects.toThrow('Down');
  });

  it('generates test plans with a trimmed payload and validates the response', async () => {
    const result = { plans: [], csv: 'a,b' };
    const { client, calls } = setup({ json: result });
    const controller = new AbortController();
    await expect(
      client.generateTestPlan(' Login ', {
        title: ' T ',
        criteria: ' C ',
        userPrompt: ' U ',
        areaPath: ' A ',
        assignedTo: ' me ',
        platformProvider: ' azure ',
        llmProvider: ' openai ',
        format: 'azure',
        workspaceId: ' w9 ',
        agentId: ' ag ',
        sourceType: 'spec',
        sourceId: ' s1 ',
        suiteId: null,
        signal: controller.signal,
      }),
    ).resolves.toEqual(result);
    expect(nth(calls, 0).url).toBe('http://api/TestPlan/generate');
    expect(nth(calls, 0).method).toBe('POST');
    expect(nth(calls, 0).signal).toBe(controller.signal);
    expect(nth(calls, 0).headers['x-workspace-id']).toBe('w9');
    expect(nth(calls, 0).body).toEqual({
      prompt: 'Login',
      title: 'T',
      criteria: 'C',
      userPrompt: 'U',
      areaPath: 'A',
      assignedTo: 'me',
      platformProvider: 'azure',
      llmProvider: 'openai',
      format: 'azure',
      agentId: 'ag',
      sourceType: 'spec',
      sourceId: 's1',
      suiteId: null,
    });

    await client.generateTestPlan('Only prompt');
    expect(nth(calls, 1).body).toEqual({ prompt: 'Only prompt' });
    await client.generateTestPlan('Blank options', {
      title: ' ',
      criteria: ' ',
      userPrompt: ' ',
      areaPath: ' ',
      assignedTo: ' ',
      platformProvider: ' ',
      llmProvider: ' ',
      workspaceId: ' ',
      agentId: ' ',
      sourceId: ' ',
    });
    expect(nth(calls, 2).body).toEqual({ prompt: 'Blank options' });
    expect(nth(calls, 2).headers['x-workspace-id']).toBeUndefined();

    await expect(client.generateTestPlan(' ')).rejects.toMatchObject({ status: 400 });
    await expect(setup({ json: null }).client.generateTestPlan('x')).rejects.toMatchObject({
      status: 502,
    });
    await expect(
      setup({ json: { plans: {}, csv: '' } }).client.generateTestPlan('x'),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      setup({ json: { plans: [], csv: 1 } }).client.generateTestPlan('x'),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      setup({ status: 422, json: { message: 'No LLM' } }).client.generateTestPlan('x'),
    ).rejects.toThrow('No LLM');
  });

  it('generates CSV test plans with a trimmed payload', async () => {
    const { client, calls } = setup({ text: 'id,title' });
    await expect(
      client.generateTestPlanCsv(' Login ', ' Title ', undefined, {
        criteria: ' C ',
        userPrompt: ' U ',
        areaPath: ' A ',
        assignedTo: ' me ',
        platformProvider: ' azure ',
        llmProvider: ' openai ',
        format: 'standard',
        workspaceId: ' w2 ',
        agentId: ' ag ',
      }),
    ).resolves.toBe('id,title');
    expect(nth(calls, 0).url).toBe('http://api/TestPlan/generate/csv');
    expect(nth(calls, 0).headers['x-workspace-id']).toBe('w2');
    expect(nth(calls, 0).body).toEqual({
      prompt: 'Login',
      title: 'Title',
      criteria: 'C',
      userPrompt: 'U',
      areaPath: 'A',
      assignedTo: 'me',
      platformProvider: 'azure',
      llmProvider: 'openai',
      format: 'standard',
      agentId: 'ag',
    });

    await client.generateTestPlanCsv('Plain');
    expect(nth(calls, 1).body).toEqual({ prompt: 'Plain' });
    await client.generateTestPlanCsv('Blank', ' ', undefined, {
      criteria: ' ',
      userPrompt: ' ',
      areaPath: ' ',
      assignedTo: ' ',
      platformProvider: ' ',
      llmProvider: ' ',
      workspaceId: ' ',
      agentId: ' ',
    });
    expect(nth(calls, 2).body).toEqual({ prompt: 'Blank' });

    await expect(client.generateTestPlanCsv(' ')).rejects.toMatchObject({ status: 400 });
    await expect(
      setup({ status: 500, json: { error: 'Boom' } }).client.generateTestPlanCsv('x'),
    ).rejects.toThrow('Boom');
  });

  it('pages saved test plans and validates the page shape', async () => {
    const page = { items: [], page: 2, pageSize: 5, total: 0, totalPages: 0 };
    const { client, calls } = setup({ json: page });
    await expect(client.getSavedTestPlans(2, 5)).resolves.toEqual(page);
    await client.getSavedTestPlans();
    expect(calls.map((c) => c.url)).toEqual([
      'http://api/TestPlan?page=2&pageSize=5',
      'http://api/TestPlan?page=1&pageSize=10',
    ]);
    await expect(
      setup({ json: { items: null, total: 0 } }).client.getSavedTestPlans(),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      setup({ json: { items: [], total: '0' } }).client.getSavedTestPlans(),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      setup({ status: 500, json: {} }).client.getSavedTestPlans(),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  it('reads every saved test plan across pages', async () => {
    const first = { items: [R], page: 1, pageSize: 50, total: 3, totalPages: 3 };
    const { client, calls } = setup([
      { json: first },
      { json: { ...first, items: [F], page: 2 } },
      { json: { ...first, items: [], page: 3 } },
    ]);
    await expect(client.getAllSavedTestPlans()).resolves.toEqual([R, F]);
    expect(calls.map((c) => c.url)).toEqual([
      'http://api/TestPlan?page=1&pageSize=50',
      'http://api/TestPlan?page=2&pageSize=50',
      'http://api/TestPlan?page=3&pageSize=50',
    ]);
    const single = setup({ json: { ...first, totalPages: 0 } });
    await expect(single.client.getAllSavedTestPlans()).resolves.toEqual([R]);
    expect(single.calls).toHaveLength(1);
  });

  it('imports test cases from a test management platform', async () => {
    const result = { rootSuiteId: 's', suitesCreated: 1, plans: [], created: 2, updated: 0 };
    const { client, calls } = setup({ json: { result, savedPlan: null } });
    const input = { providerId: 'azure_devops', planId: '10', suiteId: '2', caseIds: ['7'] };
    await expect(client.importTestCases(input)).resolves.toEqual(result);
    expect(nth(calls, 0)).toMatchObject({
      url: 'http://api/TestPlan/import',
      method: 'POST',
      body: input,
    });
  });

  it('stores the session token on login, register and password reset', async () => {
    const auth = { token: 'session', user: R };
    const { client, calls } = setup({ json: auth });
    await expect(client.login({ email: 'a@b.c', password: 'pw' })).resolves.toEqual(auth);
    expect(client.getToken()).toBe('session');
    expect(nth(calls, 0)).toMatchObject({ url: 'http://api/auth/login', method: 'POST' });
    expect(nth(calls, 0).body).toEqual({ email: 'a@b.c', password: 'pw' });

    client.setToken(null);
    await expect(client.register({ email: 'a@b.c', password: 'pw', name: 'A' })).resolves.toEqual(
      auth,
    );
    expect(client.getToken()).toBe('session');
    expect(nth(calls, 1)).toMatchObject({ url: 'http://api/auth/register', method: 'POST' });

    client.setToken(null);
    await expect(
      client.resetPassword({ email: 'a@b.c', code: '123456', password: 'new' }),
    ).resolves.toEqual(auth);
    expect(client.getToken()).toBe('session');
    expect(nth(calls, 2).url).toBe('http://api/auth/password/reset');

    const failing = setup({ status: 401, json: { message: 'Invalid credentials' } }).client;
    await expect(failing.login({ email: 'a', password: 'b' })).rejects.toThrow(
      'Invalid credentials',
    );
    await expect(failing.register({ email: 'a', password: 'b' })).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      failing.resetPassword({ email: 'a', code: 'c', password: 'p' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(failing.getToken()).toBeNull();
  });

  it('clears the token on logout even when the request fails', async () => {
    const { client, calls } = setup({ status: 204 }, { token: 't' });
    await client.logout();
    expect(nth(calls, 0)).toMatchObject({ url: 'http://api/auth/logout', method: 'POST' });
    expect(client.getToken()).toBeNull();

    const broken = new ApiClient({
      token: 't',
      fetcher: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(broken.logout()).rejects.toThrow('Failed to fetch');
    expect(broken.getToken()).toBeNull();
  });

  it('sends the owner header for knowledge stats and documents', async () => {
    const { client, calls } = setup({ json: { documents: [], documentsCount: 0 } });
    await client.getKnowledgeStats(' o1 ');
    await client.getKnowledgeDocuments(' o2 ');
    await client.getKnowledgeDocuments('  ');
    expect(nth(calls, 0).headers['x-owner-id']).toBe('o1');
    expect(nth(calls, 1).headers['x-owner-id']).toBe('o2');
    expect(nth(calls, 2).headers['x-owner-id']).toBeUndefined();
  });

  it('returns no agents when the list payload is unrecognised', async () => {
    for (const json of [null, 'agents', { agents: 'none' }, { items: [] }]) {
      await expect(setup({ json }).client.getAgents()).resolves.toEqual([]);
    }
  });

  it('normalises agent execution results and rejects malformed payloads', async () => {
    const agent = { id: 'a1', name: 'QA', role: 'tester', extra: true };
    const { client, calls } = setup([
      { json: { content: 'Done', agent, chunksUsed: 3, provider: 'openai' } },
      { json: { result: 'Done via result', agent } },
    ]);
    await expect(client.executeAgent('a 1', { prompt: 'Go' })).resolves.toEqual({
      content: 'Done',
      agent: { id: 'a1', name: 'QA', role: 'tester' },
      chunksUsed: 3,
      provider: 'openai',
    });
    expect(nth(calls, 0)).toMatchObject({ url: 'http://api/agents/a%201/execute', method: 'POST' });
    expect(nth(calls, 0).body).toEqual({ prompt: 'Go' });
    await expect(client.executeAgent('a1', { prompt: 'Go' })).resolves.toEqual({
      content: 'Done via result',
      agent: { id: 'a1', name: 'QA', role: 'tester' },
      chunksUsed: 0,
      provider: undefined,
    });

    const malformed: unknown[] = [
      null,
      'text',
      { content: 1, result: 2, agent },
      { content: '', agent },
      { content: 'x' },
      { content: 'x', agent: 'QA' },
      { content: 'x', agent: { id: 1, name: 'QA', role: 'tester' } },
      { content: 'x', agent: { id: 'a', name: 1, role: 'tester' } },
      { content: 'x', agent: { id: 'a', name: 'QA', role: 1 } },
    ];
    for (const json of malformed) {
      await expect(setup({ json }).client.executeAgent('a1', {} as never)).rejects.toMatchObject({
        status: 502,
        message: 'O serviço retornou uma resposta inválida.',
      });
    }
    await expect(
      setup({ status: 429, json: { message: 'Slow down' } }).client.executeAgent('a1', {} as never),
    ).rejects.toThrow('Slow down');
  });
});
