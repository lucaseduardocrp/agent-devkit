import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';

interface FakeReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly blob?: Blob;
  readonly headers?: Record<string, string>;
}

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly rawBody: unknown;
}

function reply(spec: FakeReply = {}): Response {
  const status = spec.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(spec.headers ?? {}),
    json: async () => spec.json,
    text: async () => spec.text ?? '',
    blob: async () => spec.blob ?? new Blob([]),
  } as Response;
}

function setup(replies: FakeReply | FakeReply[] = {}) {
  const queue = Array.isArray(replies) ? [...replies] : [replies];
  const calls: RecordedCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      rawBody: init?.body,
    });
    return reply(queue.length > 1 ? queue.shift() : queue[0]);
  });
  const client = new ApiClient({ baseUrl: 'http://api', fetcher });
  return { client, calls, fetcher };
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected a recorded call at index ${index}`);
  return item;
}

const R = { id: 'r1', marker: true };
const target = { kind: 'url', baseUrl: 'http://x' } as never;

type Endpoint = readonly [
  name: string,
  call: (client: ApiClient) => Promise<unknown>,
  method: string,
  path: string,
  body: unknown,
  response: unknown,
  expected: unknown,
];

const endpoints: readonly Endpoint[] = [
  [
    'continueAgentRun',
    (c) => c.continueAgentRun('r 1', { action: 'answer', answer: 'yes' }),
    'POST',
    '/runs/r%201/continue',
    { action: 'answer', answer: 'yes' },
    { run: R },
    R,
  ],
  [
    'getWorkItemTypes',
    (c) => c.getWorkItemTypes(),
    'GET',
    '/work-item-types',
    undefined,
    { types: [R] },
    [R],
  ],
  [
    'saveWorkItemTypes',
    (c) => c.saveWorkItemTypes([R as never]),
    'PUT',
    '/work-item-types',
    { types: [R] },
    { types: [R] },
    [R],
  ],
  [
    'getDesignSettings',
    (c) => c.getDesignSettings(),
    'GET',
    '/design/settings',
    undefined,
    { settings: R },
    R,
  ],
  [
    'getDesignSettings (none)',
    (c) => c.getDesignSettings(),
    'GET',
    '/design/settings',
    undefined,
    { settings: null },
    null,
  ],
  [
    'saveDesignSettings',
    (c) => c.saveDesignSettings({ provider: 'github', repositoryId: 'r', branch: 'main' }),
    'PUT',
    '/design/settings',
    { provider: 'github', repositoryId: 'r', branch: 'main' },
    { settings: R },
    R,
  ],
  [
    'getDesignRepositories',
    (c) => c.getDesignRepositories(),
    'GET',
    '/design/repositories',
    undefined,
    { repositories: [R], warnings: [] },
    { repositories: [R], warnings: [] },
  ],
  [
    'getDesignBranches',
    (c) => c.getDesignBranches('azure', 'a b'),
    'GET',
    '/design/repositories/branches?provider=azure&repositoryId=a%20b',
    undefined,
    { branches: [R] },
    [R],
  ],
  [
    'saveE2eHookInstructions',
    (c) => c.saveE2eHookInstructions('t 1', 'beforeRun', 'do it'),
    'PUT',
    '/e2e/tests/t%201/hook-instructions',
    { kind: 'beforeRun', instructions: 'do it' },
    { test: R },
    R,
  ],
  [
    'getTelegramChats',
    (c) => c.getTelegramChats(),
    'GET',
    '/integrations/MESSAGING/telegram/chats',
    undefined,
    { status: R, chats: [] },
    { status: R, chats: [] },
  ],
  [
    'createTelegramPairingCode',
    (c) => c.createTelegramPairingCode(),
    'POST',
    '/integrations/MESSAGING/telegram/pairing-code',
    {},
    R,
    R,
  ],
  [
    'updateTelegramChat',
    (c) => c.updateTelegramChat('c 1', { notifications: false, agentId: null }),
    'PATCH',
    '/integrations/MESSAGING/telegram/chats/c%201',
    { notifications: false, agentId: null },
    { chat: R },
    R,
  ],
  [
    'removeTelegramChat',
    (c) => c.removeTelegramChat('c 1'),
    'DELETE',
    '/integrations/MESSAGING/telegram/chats/c%201',
    {},
    {},
    undefined,
  ],
  ['listHubAgents', (c) => c.listHubAgents(), 'GET', '/agents/hub', undefined, R, R],
  [
    'installHubAgent',
    (c) => c.installHubAgent({ plugin: 'p', name: 'n' }),
    'POST',
    '/agents/hub/install',
    { plugin: 'p', name: 'n' },
    { agents: [R] },
    [R],
  ],
  [
    'updateHubAgent',
    (c) => c.updateHubAgent('a 1'),
    'POST',
    '/agents/a%201/hub-update',
    undefined,
    { agent: R },
    R,
  ],
  [
    'previewPbiFields (with values)',
    (c) => c.previewPbiFields('p1', 'jira', 't1', 'Team', 'Bug', { a: 'b' }),
    'POST',
    '/pbi/items/p1/field-preview',
    {
      providerId: 'jira',
      templateId: 't1',
      scope: 'Team',
      itemType: 'Bug',
      fieldValues: { a: 'b' },
    },
    R,
    R,
  ],
  [
    'listApiCollections',
    (c) => c.listApiCollections(),
    'GET',
    '/integration-tests/collections',
    undefined,
    { collections: [R] },
    [R],
  ],
  [
    'getApiCollection',
    (c) => c.getApiCollection('c 1'),
    'GET',
    '/integration-tests/collections/c%201',
    undefined,
    { collection: R },
    R,
  ],
  [
    'saveApiCollection (create)',
    (c) => c.saveApiCollection({ name: 'N' }),
    'POST',
    '/integration-tests/collections',
    { name: 'N' },
    { collection: R },
    R,
  ],
  [
    'saveApiCollection (replace)',
    (c) => c.saveApiCollection({ name: 'N' }, 'c 1'),
    'PUT',
    '/integration-tests/collections/c%201',
    { name: 'N' },
    { collection: R },
    R,
  ],
  [
    'deleteApiCollection',
    (c) => c.deleteApiCollection('c 1'),
    'DELETE',
    '/integration-tests/collections/c%201',
    undefined,
    {},
    undefined,
  ],
  [
    'importApiCollection',
    (c) => c.importApiCollection('{}', 'Imported'),
    'POST',
    '/integration-tests/collections/import',
    { content: '{}', name: 'Imported' },
    { format: 'postman', collection: R },
    { format: 'postman', collection: R },
  ],
  [
    'importApiCollection (unnamed)',
    (c) => c.importApiCollection('{}'),
    'POST',
    '/integration-tests/collections/import',
    { content: '{}' },
    { format: 'postman', collection: R },
    { format: 'postman', collection: R },
  ],
  [
    'listApiTestRepositories',
    (c) => c.listApiTestRepositories(),
    'GET',
    '/integration-tests/repositories',
    undefined,
    { repositories: [R], warnings: [] },
    { repositories: [R], warnings: [] },
  ],
  [
    'listApiTestBranches',
    (c) => c.listApiTestBranches('github', 'a b'),
    'GET',
    '/integration-tests/repositories/branches?provider=github&repositoryId=a+b',
    undefined,
    { branches: [R] },
    [R],
  ],
  [
    'previewApiCollectionCi',
    (c) => c.previewApiCollectionCi('c 1'),
    'GET',
    '/integration-tests/collections/c%201/ci',
    undefined,
    R,
    R,
  ],
  [
    'publishApiCollectionCi',
    (c) => c.publishApiCollectionCi('c 1'),
    'POST',
    '/integration-tests/collections/c%201/ci',
    undefined,
    R,
    R,
  ],
  [
    'listApiMockValues',
    (c) => c.listApiMockValues(),
    'GET',
    '/integration-tests/dynamic-values',
    undefined,
    { values: [R] },
    [R],
  ],
  [
    'listApiEnvironments',
    (c) => c.listApiEnvironments(),
    'GET',
    '/integration-tests/environments',
    undefined,
    { environments: [R] },
    [R],
  ],
  [
    'saveApiEnvironment (create)',
    (c) => c.saveApiEnvironment({ name: 'E', variables: [] }),
    'POST',
    '/integration-tests/environments',
    { name: 'E', variables: [] },
    { environment: R },
    R,
  ],
  [
    'saveApiEnvironment (replace)',
    (c) => c.saveApiEnvironment({ name: 'E', variables: [] }, 'e 1'),
    'PUT',
    '/integration-tests/environments/e%201',
    { name: 'E', variables: [] },
    { environment: R },
    R,
  ],
  [
    'deleteApiEnvironment',
    (c) => c.deleteApiEnvironment('e 1'),
    'DELETE',
    '/integration-tests/environments/e%201',
    undefined,
    {},
    undefined,
  ],
  [
    'startIntegrationRun',
    (c) => c.startIntegrationRun({ collectionId: 'c1', target }),
    'POST',
    '/integration-tests/runs',
    { collectionId: 'c1', target: { kind: 'url', baseUrl: 'http://x' } },
    { run: R },
    R,
  ],
  [
    'clearPersonalSecret',
    (c) => c.clearPersonalSecret({ scope: 'collection', scopeId: 's', ref: 'r' }),
    'DELETE',
    '/integration-tests/personal-secrets',
    { scope: 'collection', scopeId: 's', ref: 'r' },
    {},
    undefined,
  ],
  [
    'getApiRuntime',
    (c) => c.getApiRuntime('c 1'),
    'GET',
    '/integration-tests/collections/c%201/runtime',
    undefined,
    { runtime: R },
    R,
  ],
  [
    'setApiRuntime',
    (c) => c.setApiRuntime('c 1', R as never),
    'PUT',
    '/integration-tests/collections/c%201/runtime',
    R,
    { runtime: R },
    R,
  ],
  [
    'clearApiRuntime (answered)',
    (c) => c.clearApiRuntime('c 1'),
    'DELETE',
    '/integration-tests/collections/c%201/runtime',
    undefined,
    { runtime: R },
    R,
  ],
  [
    'clearApiRuntime (empty answer)',
    (c) => c.clearApiRuntime('c 1'),
    'DELETE',
    '/integration-tests/collections/c%201/runtime',
    undefined,
    {},
    { variables: [], cookies: [] },
  ],
  [
    'listApiRuns (integration)',
    (c) => c.listApiRuns('integration', { collectionId: 'c1', scenarioId: '' }),
    'GET',
    '/integration-tests/runs?collectionId=c1',
    undefined,
    { runs: [R] },
    [R],
  ],
  [
    'listApiRuns (load)',
    (c) => c.listApiRuns('load'),
    'GET',
    '/load-tests/runs?',
    undefined,
    { runs: [R] },
    [R],
  ],
  [
    'getApiRun (integration)',
    (c) => c.getApiRun('integration', 'r 1'),
    'GET',
    '/integration-tests/runs/r%201',
    undefined,
    { run: R },
    R,
  ],
  [
    'getApiRun (load)',
    (c) => c.getApiRun('load', 'r 1'),
    'GET',
    '/load-tests/runs/r%201',
    undefined,
    { run: R },
    R,
  ],
  [
    'cancelApiRun (integration)',
    (c) => c.cancelApiRun('integration', 'r 1'),
    'POST',
    '/integration-tests/runs/r%201/cancel',
    undefined,
    { run: R },
    R,
  ],
  [
    'cancelApiRun (load)',
    (c) => c.cancelApiRun('load', 'r 1'),
    'POST',
    '/load-tests/runs/r%201/cancel',
    undefined,
    { run: R },
    R,
  ],
  [
    'deleteApiRun (integration)',
    (c) => c.deleteApiRun('integration', 'r 1'),
    'DELETE',
    '/integration-tests/runs/r%201',
    undefined,
    {},
    undefined,
  ],
  [
    'deleteApiRun (load)',
    (c) => c.deleteApiRun('load', 'r 1'),
    'DELETE',
    '/load-tests/runs/r%201',
    undefined,
    {},
    undefined,
  ],
  [
    'generateApiTests (integration)',
    (c) => c.generateApiTests('integration', R as never),
    'POST',
    '/integration-tests/generate',
    R,
    { collection: R },
    { collection: R },
  ],
  [
    'generateApiTests (load)',
    (c) => c.generateApiTests('load', R as never),
    'POST',
    '/load-tests/generate',
    R,
    { scenario: R },
    { scenario: R },
  ],
  [
    'getLoadProfiles',
    (c) => c.getLoadProfiles(10, 30),
    'GET',
    '/load-tests/profiles?vus=10&durationSec=30',
    undefined,
    { profiles: [R] },
    [R],
  ],
  [
    'listLoadScenarios',
    (c) => c.listLoadScenarios(),
    'GET',
    '/load-tests/scenarios',
    undefined,
    { scenarios: [R] },
    [R],
  ],
  [
    'saveLoadScenario (create)',
    (c) => c.saveLoadScenario(R as never),
    'POST',
    '/load-tests/scenarios',
    R,
    { scenario: R },
    R,
  ],
  [
    'saveLoadScenario (replace)',
    (c) => c.saveLoadScenario(R as never, 's 1'),
    'PUT',
    '/load-tests/scenarios/s%201',
    R,
    { scenario: R },
    R,
  ],
  [
    'deleteLoadScenario',
    (c) => c.deleteLoadScenario('s 1'),
    'DELETE',
    '/load-tests/scenarios/s%201',
    undefined,
    {},
    undefined,
  ],
  [
    'exportLoadScenarioK6',
    (c) => c.exportLoadScenarioK6('s 1'),
    'GET',
    '/load-tests/scenarios/s%201/k6',
    undefined,
    { fileName: 'a.js', body: 'x' },
    { fileName: 'a.js', body: 'x' },
  ],
  [
    'startLoadRun',
    (c) => c.startLoadRun({ scenarioId: 's1', target, authorized: true }),
    'POST',
    '/load-tests/runs',
    { scenarioId: 's1', target: { kind: 'url', baseUrl: 'http://x' }, authorized: true },
    { run: R },
    R,
  ],
];

describe('ApiClient endpoints without a test yet', () => {
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
    },
  );

  it.each(endpoints)('%s rejects with ApiClientError on a non-ok response', async (...row) => {
    const { client } = setup({ status: 409, json: { message: 'Conflict detected' } });
    const error = await row[1](client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, message: 'Conflict detected' });
  });

  it('answers nothing for a 204 of the integration and load endpoints', async () => {
    const { client } = setup({ status: 204 });
    await expect(client.deleteApiCollection('c1')).resolves.toBeUndefined();
    await expect(client.clearApiRuntime('c1')).resolves.toEqual({ variables: [], cookies: [] });
  });
});

describe('ApiClient attachments and media', () => {
  it('uploads a file as raw bytes named after it, or as "file" when it has no name', async () => {
    const { client, calls } = setup({ json: { attachment: R } });
    const file = new File(['abc'], 'a b.png', { type: 'image/png' });
    await expect(client.uploadAttachment('issue' as never, file)).resolves.toEqual(R);
    const request = nth(calls, 0);
    expect(request.url).toBe('http://api/attachments/files?scope=issue&name=a+b.png');
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/octet-stream');
    expect(request.rawBody).toBe(file);

    await client.uploadAttachment('issue' as never, new File(['x'], ''));
    expect(nth(calls, 1).url).toBe('http://api/attachments/files?scope=issue&name=file');
  });

  it('fails an upload and a removal with the server message', async () => {
    const { client } = setup({ status: 413, json: { message: 'Too large' } });
    await expect(client.uploadAttachment('issue' as never, new File(['x'], 'a'))).rejects.toThrow(
      'Too large',
    );
    await expect(client.deleteAttachment('a')).rejects.toThrow('Too large');
  });

  it('removes an upload by id', async () => {
    const { client, calls } = setup({});
    await expect(client.deleteAttachment('a 1')).resolves.toBeUndefined();
    expect(nth(calls, 0).url).toBe('http://api/attachments/files/a%201');
    expect(nth(calls, 0).method).toBe('DELETE');
  });

  it('loads ADK files by path and integration files through the proxy', async () => {
    const blob = new Blob(['x']);
    const { client, calls } = setup({ blob });
    await expect(client.getMedia('/attachments/files/1')).resolves.toBe(blob);
    await client.getMedia('https://dev.azure.com/a b.png');
    expect(nth(calls, 0).url).toBe('http://api/attachments/files/1');
    expect(nth(calls, 1).url).toBe(
      'http://api/attachments/proxy?url=https%3A%2F%2Fdev.azure.com%2Fa%20b.png',
    );
    const failing = setup({ status: 404, json: { message: 'Gone' } });
    await expect(failing.client.getMedia('/attachments/x')).rejects.toThrow('Gone');
  });

  it('reads and saves the attachments of a knowledge document', async () => {
    const { client, calls } = setup([
      { json: { attachments: [R] } },
      { json: { attachments: [R] } },
    ]);
    await expect(client.getDocumentAttachments('p 1')).resolves.toEqual([R]);
    await expect(client.saveDocumentAttachments('p 1', [R as never])).resolves.toEqual([R]);
    expect(nth(calls, 0).url).toBe('http://api/knowledge/documents/p%201/attachments');
    expect(nth(calls, 1).method).toBe('PUT');
    expect(nth(calls, 1).body).toEqual({ attachments: [R] });
  });
});

describe('ApiClient collection exports', () => {
  it('names the download after the server header and sends the chosen environments', async () => {
    const blob = new Blob(['zip']);
    const { client, calls } = setup({
      blob,
      headers: { 'content-disposition': 'attachment; filename="my.zip"' },
    });
    await expect(client.exportApiCollection('c 1', 'bruno', ['e1', 'e2'])).resolves.toEqual({
      fileName: 'my.zip',
      blob,
    });
    expect(nth(calls, 0).url).toBe(
      'http://api/integration-tests/collections/c%201/export?format=bruno&environmentIds=e1%2Ce2',
    );
  });

  it('falls back to a default file name per format and fails with the server message', async () => {
    const { client, calls } = setup({});
    await expect(client.exportApiCollection('c1', 'bruno')).resolves.toMatchObject({
      fileName: 'collection.zip',
    });
    await expect(client.exportApiCollection('c1', 'postman' as never)).resolves.toMatchObject({
      fileName: 'collection.json',
    });
    expect(nth(calls, 0).url).toBe(
      'http://api/integration-tests/collections/c1/export?format=bruno',
    );
    const failing = setup({ status: 500, json: { message: 'Broken' } });
    await expect(failing.client.exportApiCollection('c1', 'bruno')).rejects.toThrow('Broken');
  });
});

describe('ApiClient agent workflow normalization', () => {
  const base = {
    enabled: true,
    autonomy: 'autonomous',
    finalReview: false,
    uncertaintyBehavior: 'assume',
    issueCreationBehavior: 'allow',
    defaultAction: 'deny',
    updatedAt: '2026-01-01',
  };

  it('falls back to an empty workflow when the answer is not an object', async () => {
    const { client } = setup({ json: null });
    await expect(client.getAgentWorkflow()).resolves.toEqual({
      enabled: false,
      autonomy: 'balanced',
      finalReview: true,
      uncertaintyBehavior: 'ask',
      issueCreationBehavior: 'ask',
      defaultAction: 'allow',
      steps: [],
      rules: [],
    });
  });

  it('keeps well-formed steps and rules and drops malformed ones', async () => {
    const rule = { id: 'r', name: 'R', toolset: 'issues', effect: 'allow' };
    const { client } = setup({
      json: {
        workflow: {
          ...base,
          steps: [
            { id: 's', name: 'Step', instructions: 'go' },
            { id: 's2', name: 'No instructions' },
            'nope',
          ],
          rules: [
            {
              ...rule,
              toolName: 'tool',
              allowedProviders: ['jira'],
              createIssueForAction: true,
              requireApproval: false,
            },
            rule,
            null,
            { ...rule, id: 7 },
            { ...rule, name: 7 },
            { ...rule, toolset: 7 },
            { ...rule, toolset: 'unknown' },
            { ...rule, effect: 'maybe' },
            { ...rule, allowedProviders: 'jira' },
            { ...rule, allowedProviders: [1] },
            { ...rule, toolName: 5, createIssueForAction: 'yes', requireApproval: 'no' },
          ],
        },
      },
    });
    const workflow = await client.getAgentWorkflow();
    expect(workflow).toMatchObject({
      enabled: true,
      autonomy: 'autonomous',
      finalReview: false,
      uncertaintyBehavior: 'assume',
      issueCreationBehavior: 'allow',
      defaultAction: 'deny',
      updatedAt: '2026-01-01',
    });
    expect(workflow.steps).toEqual([{ id: 's', name: 'Step', instructions: 'go' }]);
    expect(workflow.rules).toEqual([
      {
        ...rule,
        toolName: 'tool',
        allowedProviders: ['jira'],
        createIssueForAction: true,
        requireApproval: false,
      },
      rule,
      rule,
    ]);
  });

  it('ignores unknown option values and keeps what was sent when saving', async () => {
    const sent = {
      enabled: true,
      autonomy: 'supervised' as const,
      finalReview: false,
      uncertaintyBehavior: 'ask' as const,
      issueCreationBehavior: 'allow' as const,
      defaultAction: 'deny' as const,
      steps: [{ id: 's', name: 'Step', instructions: 'go' }],
      rules: [],
      updatedAt: 'before',
    };
    const { client } = setup({
      json: {
        workflow: {
          enabled: 'yes',
          autonomy: 'wild',
          finalReview: 'no',
          uncertaintyBehavior: 'guess',
          issueCreationBehavior: 'never',
          defaultAction: 'maybe',
          steps: 'none',
          rules: 'none',
          updatedAt: 3,
        },
      },
    });
    await expect(client.saveAgentWorkflow(sent)).resolves.toEqual(sent);
  });

  it('fails to read or save with the server message', async () => {
    const { client } = setup({ status: 500, json: { message: 'Down' } });
    await expect(client.getAgentWorkflow()).rejects.toThrow('Down');
    await expect(
      client.saveAgentWorkflow({
        enabled: false,
        autonomy: 'balanced',
        finalReview: true,
        uncertaintyBehavior: 'ask',
        issueCreationBehavior: 'ask',
        defaultAction: 'allow',
        steps: [],
        rules: [],
      }),
    ).rejects.toThrow('Down');
  });
});

describe('ApiClient agent workflow saved without an answer body', () => {
  it('keeps the workflow that was sent when the server answers with no object', async () => {
    const sent = {
      enabled: true,
      autonomy: 'supervised' as const,
      finalReview: false,
      uncertaintyBehavior: 'ask' as const,
      issueCreationBehavior: 'allow' as const,
      defaultAction: 'deny' as const,
      steps: [],
      rules: [],
    };
    const { client } = setup({ json: null });
    await expect(client.saveAgentWorkflow(sent)).resolves.toEqual(sent);
  });
});
