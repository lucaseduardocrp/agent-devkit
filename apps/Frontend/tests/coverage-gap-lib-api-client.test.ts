import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';
import type { AgentWorkflowDto } from '../src/features/agents/agent-types.js';
import { attachmentKind, fileKind, formatBytes } from '../src/features/shared/attachment-types.js';
import { sanitizeHtml } from '../src/lib/sanitize-html.js';

interface Reply {
  readonly status?: number;
  readonly json?: unknown;
  readonly blob?: Blob;
  readonly headers?: Record<string, string>;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

function setup(spec: Reply = {}) {
  const calls: Call[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : (init?.body ?? undefined),
      signal: init?.signal,
    });
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(spec.headers ?? {}),
      json: async () => spec.json,
      blob: async () => spec.blob ?? new Blob([]),
    } as Response;
  });
  const client = new ApiClient({ baseUrl: 'http://api', fetcher, token: 't' });
  const last = (): Call => {
    const call = calls.at(-1);
    if (!call) throw new Error('no call recorded');
    return call;
  };
  return { client, last };
}

const workflow: AgentWorkflowDto = {
  enabled: true,
  autonomy: 'supervised',
  finalReview: false,
  uncertaintyBehavior: 'assume',
  issueCreationBehavior: 'ask',
  defaultAction: 'deny',
  steps: [{ id: 's1', name: 'Plan', instructions: 'Plan it' }],
  rules: [],
};

describe('ApiClient attachments and media', () => {
  it('uploads a file as octet-stream with scope and name, falling back to "file"', async () => {
    const attachment = { id: 'a1', name: 'file', scope: 'issue', source: 'adk', url: '/x' };
    const { client, last } = setup({ json: { attachment } });
    const file = new File(['x'], '');
    await expect(client.uploadAttachment('issue', file)).resolves.toEqual(attachment);
    expect(last().url).toBe('http://api/attachments/files?scope=issue&name=file');
    expect(last().method).toBe('POST');
    expect(last().headers['content-type']).toBe('application/octet-stream');
    expect(last().body).toBe(file);
  });

  it('surfaces upload and delete errors from the server', async () => {
    const { client } = setup({ status: 413, json: { message: 'Arquivo grande demais' } });
    await expect(client.uploadAttachment('pbi', new File(['x'], 'a.png'))).rejects.toThrow(
      'Arquivo grande demais',
    );
    await expect(client.deleteAttachment('a b')).rejects.toBeInstanceOf(ApiClientError);
  });

  it('deletes an attachment by encoded id', async () => {
    const { client, last } = setup();
    await client.deleteAttachment('a b');
    expect(last()).toMatchObject({ url: 'http://api/attachments/files/a%20b', method: 'DELETE' });
  });

  it('loads ADK files directly and external media through the proxy', async () => {
    const blob = new Blob(['img']);
    const { client, last } = setup({ blob });
    await expect(client.getMedia('/attachments/files/1')).resolves.toBe(blob);
    expect(last().url).toBe('http://api/attachments/files/1');
    await client.getMedia('https://dev.azure.com/a?b=1');
    expect(last().url).toBe(
      'http://api/attachments/proxy?url=https%3A%2F%2Fdev.azure.com%2Fa%3Fb%3D1',
    );
  });

  it('rejects when media cannot be loaded', async () => {
    const { client } = setup({ status: 404, json: { error: 'missing' } });
    await expect(client.getMedia('/attachments/files/1')).rejects.toThrow('missing');
  });

  it('saves document attachments with PUT', async () => {
    const { client, last } = setup({ json: { attachments: [] } });
    await expect(client.saveDocumentAttachments('p/1', [])).resolves.toEqual([]);
    expect(last()).toMatchObject({
      url: 'http://api/knowledge/documents/p%2F1/attachments',
      method: 'PUT',
      body: { attachments: [] },
    });
  });
});

describe('ApiClient agents', () => {
  it('continues a run with the chosen action', async () => {
    const { client, last } = setup({ json: { run: { id: 'r1' } } });
    await expect(
      client.continueAgentRun('r1', { action: 'answer', answer: 'sim' }),
    ).resolves.toEqual({ id: 'r1' });
    expect(last()).toMatchObject({
      url: 'http://api/runs/r1/continue',
      method: 'POST',
      body: { action: 'answer', answer: 'sim' },
    });
  });

  it('normalizes a loaded workflow, dropping invalid steps and rules', async () => {
    const { client } = setup({
      json: {
        workflow: {
          enabled: true,
          autonomy: 'autonomous',
          finalReview: false,
          uncertaintyBehavior: 'assume',
          steps: [{ id: 's', name: 'n', instructions: 'i' }, { id: 1 }, null],
          rules: [
            {
              id: 'r1',
              name: 'Full',
              toolset: 'brain',
              effect: 'deny',
              toolName: 'brain_search',
              allowedProviders: ['azure'],
              createIssueForAction: true,
              requireApproval: false,
            },
            { id: 'r2', name: 'Bare', toolset: 'all', effect: 'allow' },
            { id: 'r3', name: 'Bad toolset', toolset: 'nope', effect: 'allow' },
            { id: 'r4', name: 'Bad effect', toolset: 'all', effect: 'maybe' },
            {
              id: 'r5',
              name: 'Bad providers',
              toolset: 'all',
              effect: 'allow',
              allowedProviders: [1],
            },
            {
              id: 'r6',
              name: 'Bad providers',
              toolset: 'all',
              effect: 'allow',
              allowedProviders: 'x',
            },
            'garbage',
          ],
        },
      },
    });
    const result = await client.getAgentWorkflow();
    expect(result.enabled).toBe(true);
    expect(result.autonomy).toBe('autonomous');
    expect(result.finalReview).toBe(false);
    expect(result.uncertaintyBehavior).toBe('assume');
    expect(result.steps).toEqual([{ id: 's', name: 'n', instructions: 'i' }]);
    expect(result.rules).toEqual([
      {
        id: 'r1',
        name: 'Full',
        toolset: 'brain',
        effect: 'deny',
        toolName: 'brain_search',
        allowedProviders: ['azure'],
        createIssueForAction: true,
        requireApproval: false,
      },
      { id: 'r2', name: 'Bare', toolset: 'all', effect: 'allow' },
    ]);
  });

  it('falls back to defaults when the workflow payload is missing or malformed', async () => {
    for (const json of [null, [], { workflow: 'x' }, { workflow: { autonomy: 'wild' } }]) {
      const { client } = setup({ json });
      const result = await client.getAgentWorkflow();
      expect(result).toMatchObject({ enabled: false, autonomy: 'balanced', steps: [], rules: [] });
    }
  });

  it('propagates workflow load errors', async () => {
    const { client } = setup({ status: 500, json: { message: 'boom' } });
    await expect(client.getAgentWorkflow()).rejects.toThrow('boom');
  });

  it('saves a workflow and falls back to what was sent for missing fields', async () => {
    const { client, last } = setup({ json: { workflow: { enabled: false } } });
    const saved = await client.saveAgentWorkflow(workflow);
    expect(last()).toMatchObject({ url: 'http://api/agents/workflow', method: 'PUT' });
    expect(last().body).toMatchObject({ enabled: true, steps: workflow.steps, rules: [] });
    expect(saved).toMatchObject({
      enabled: false,
      autonomy: 'supervised',
      defaultAction: 'deny',
      steps: workflow.steps,
    });
    const { client: other } = setup({ json: 'nope' });
    await expect(other.saveAgentWorkflow(workflow)).resolves.toMatchObject({ enabled: true });
    const { client: failing } = setup({ status: 400, json: { message: 'inválido' } });
    await expect(failing.saveAgentWorkflow(workflow)).rejects.toThrow('inválido');
  });

  it('lists, installs and updates hub agents', async () => {
    const { client, last } = setup({ json: { agents: [{ id: 'a' }], agent: { id: 'b' } } });
    await expect(client.listHubAgents()).resolves.toMatchObject({ agents: [{ id: 'a' }] });
    await expect(client.installHubAgent({ plugin: 'qa' })).resolves.toEqual([{ id: 'a' }]);
    expect(last()).toMatchObject({
      url: 'http://api/agents/hub/install',
      method: 'POST',
      body: { plugin: 'qa' },
    });
    await expect(client.updateHubAgent('x/y')).resolves.toEqual({ id: 'b' });
    expect(last()).toMatchObject({ url: 'http://api/agents/x%2Fy/hub-update', method: 'POST' });
  });

  it('rejects hub calls the server refuses', async () => {
    const { client } = setup({ status: 403, json: { message: 'proibido' } });
    await expect(client.listHubAgents()).rejects.toThrow('proibido');
    await expect(client.installHubAgent({ name: 'a' })).rejects.toThrow('proibido');
    await expect(client.updateHubAgent('a')).rejects.toThrow('proibido');
  });
});

describe('ApiClient capabilities', () => {
  it('treats servers without the endpoint as having no capabilities', async () => {
    const { client } = setup({ status: 404 });
    await expect(client.getCapabilities()).resolves.toEqual({ workersReachLocalhost: false });
  });
});

describe('ApiClient integration tests', () => {
  it('reads collections, environments and mock values', async () => {
    const { client, last } = setup({
      json: { collections: [1], collection: { id: 'c' }, environments: [2], values: [3] },
    });
    await expect(client.listApiCollections()).resolves.toEqual([1]);
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/collections',
      method: 'GET',
    });
    expect(last().headers['content-type']).toBeUndefined();
    await expect(client.getApiCollection('c 1')).resolves.toEqual({ id: 'c' });
    expect(last().url).toBe('http://api/integration-tests/collections/c%201');
    await expect(client.listApiEnvironments()).resolves.toEqual([2]);
    await expect(client.listApiMockValues()).resolves.toEqual([3]);
    expect(last().url).toBe('http://api/integration-tests/dynamic-values');
  });

  it('creates or replaces collections and environments', async () => {
    const { client, last } = setup({ json: { collection: { id: 'c' }, environment: { id: 'e' } } });
    await client.saveApiCollection({ name: 'n' });
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/collections',
      method: 'POST',
      body: { name: 'n' },
    });
    expect(last().headers['content-type']).toBe('application/json');
    await client.saveApiCollection({ name: 'n' }, 'c');
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/collections/c',
      method: 'PUT',
    });
    await expect(client.saveApiEnvironment({ name: 'e', variables: [] })).resolves.toEqual({
      id: 'e',
    });
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/environments',
      method: 'POST',
    });
    await client.saveApiEnvironment({ name: 'e', variables: [] }, 'e');
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/environments/e',
      method: 'PUT',
    });
    await client.deleteApiCollection('c');
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/collections/c',
      method: 'DELETE',
    });
    await client.deleteApiEnvironment('e');
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/environments/e',
      method: 'DELETE',
    });
  });

  it('imports collections with an optional name', async () => {
    const { client, last } = setup({ json: { format: 'postman', collection: { id: 'c' } } });
    await expect(client.importApiCollection('{}', 'Nome')).resolves.toMatchObject({
      format: 'postman',
    });
    expect(last().body).toEqual({ content: '{}', name: 'Nome' });
    await client.importApiCollection('{}');
    expect(last().body).toEqual({ content: '{}' });
  });

  it('exports collections using the server file name or a default one', async () => {
    const blob = new Blob(['z']);
    const named = setup({
      blob,
      headers: { 'content-disposition': 'attachment; filename="c.zip"' },
    });
    await expect(named.client.exportApiCollection('c', 'bruno', ['e1', 'e2'])).resolves.toEqual({
      fileName: 'c.zip',
      blob,
    });
    expect(named.last().url).toBe(
      'http://api/integration-tests/collections/c/export?format=bruno&environmentIds=e1%2Ce2',
    );
    const plain = setup({ blob });
    await expect(plain.client.exportApiCollection('c', 'bruno')).resolves.toMatchObject({
      fileName: 'collection.zip',
    });
    expect(plain.last().url).toBe('http://api/integration-tests/collections/c/export?format=bruno');
    await expect(plain.client.exportApiCollection('c', 'postman')).resolves.toMatchObject({
      fileName: 'collection.json',
    });
    const failing = setup({ status: 404, json: { message: 'não encontrada' } });
    await expect(failing.client.exportApiCollection('c', 'postman')).rejects.toThrow(
      'não encontrada',
    );
  });

  it('starts, lists, reads, cancels and deletes runs of both kinds', async () => {
    const { client, last } = setup({ json: { run: { id: 'r' }, runs: [{ id: 'r' }] } });
    await expect(
      client.startIntegrationRun({ collectionId: 'c', target: 'server' as never }),
    ).resolves.toEqual({ id: 'r' });
    expect(last()).toMatchObject({ url: 'http://api/integration-tests/runs', method: 'POST' });
    await client.listApiRuns('integration', { collectionId: 'c', scenarioId: '' });
    expect(last().url).toBe('http://api/integration-tests/runs?collectionId=c');
    await expect(client.listApiRuns('load')).resolves.toEqual([{ id: 'r' }]);
    expect(last().url).toBe('http://api/load-tests/runs?');
    await client.getApiRun('integration', 'r');
    expect(last().url).toBe('http://api/integration-tests/runs/r');
    await client.getApiRun('load', 'r');
    expect(last().url).toBe('http://api/load-tests/runs/r');
    await client.cancelApiRun('integration', 'r');
    expect(last()).toMatchObject({
      url: 'http://api/integration-tests/runs/r/cancel',
      method: 'POST',
    });
    await client.cancelApiRun('load', 'r');
    expect(last().url).toBe('http://api/load-tests/runs/r/cancel');
    await client.deleteApiRun('integration', 'r');
    expect(last()).toMatchObject({ url: 'http://api/integration-tests/runs/r', method: 'DELETE' });
    await client.deleteApiRun('load', 'r');
    expect(last().url).toBe('http://api/load-tests/runs/r');
  });

  it('generates tests through the matching endpoint', async () => {
    const { client, last } = setup({ json: { collection: null } });
    const input = { prompt: 'p' } as never;
    await expect(client.generateApiTests('integration', input)).resolves.toEqual({
      collection: null,
    });
    expect(last().url).toBe('http://api/integration-tests/generate');
    await client.generateApiTests('load', input);
    expect(last().url).toBe('http://api/load-tests/generate');
  });

  it('rejects with the server message when a request fails', async () => {
    const { client } = setup({ status: 500, json: { message: 'falhou' } });
    await expect(client.listApiCollections()).rejects.toThrow('falhou');
  });
});

describe('ApiClient load tests', () => {
  it('manages scenarios, profiles, k6 exports and runs', async () => {
    const { client, last } = setup({
      json: {
        profiles: [1],
        scenarios: [2],
        scenario: { id: 's' },
        run: { id: 'r' },
        fileName: 's.js',
        body: 'k6',
      },
    });
    await expect(client.getLoadProfiles(10, 60)).resolves.toEqual([1]);
    expect(last().url).toBe('http://api/load-tests/profiles?vus=10&durationSec=60');
    await expect(client.listLoadScenarios()).resolves.toEqual([2]);
    const scenario = { name: 's' } as never;
    await expect(client.saveLoadScenario(scenario)).resolves.toEqual({ id: 's' });
    expect(last()).toMatchObject({ url: 'http://api/load-tests/scenarios', method: 'POST' });
    await client.saveLoadScenario(scenario, 's');
    expect(last()).toMatchObject({ url: 'http://api/load-tests/scenarios/s', method: 'PUT' });
    await client.deleteLoadScenario('s');
    expect(last()).toMatchObject({ url: 'http://api/load-tests/scenarios/s', method: 'DELETE' });
    await expect(client.exportLoadScenarioK6('s')).resolves.toMatchObject({ fileName: 's.js' });
    expect(last().url).toBe('http://api/load-tests/scenarios/s/k6');
    await expect(
      client.startLoadRun({ scenarioId: 's', target: 'server' as never, authorized: true }),
    ).resolves.toEqual({ id: 'r' });
    expect(last()).toMatchObject({
      url: 'http://api/load-tests/runs',
      method: 'POST',
      body: { scenarioId: 's', authorized: true },
    });
  });
});

describe('attachment helpers', () => {
  it('infers the kind from explicit kind, mime type or defaults to image', () => {
    expect(attachmentKind({ kind: 'document', name: 'a' })).toBe('document');
    expect(attachmentKind({ mimeType: 'video/mp4', name: 'a' })).toBe('video');
    expect(attachmentKind({ mimeType: 'application/pdf', name: 'a' })).toBe('document');
    expect(attachmentKind({ mimeType: 'image/png', name: 'a' })).toBe('image');
    expect(attachmentKind({ name: 'a' })).toBe('image');
  });

  it('classifies local files by type or extension', () => {
    expect(fileKind(new File([''], 'a.png', { type: 'image/png' }))).toBe('image');
    expect(fileKind(new File([''], 'a', { type: 'video/webm' }))).toBe('video');
    expect(fileKind(new File([''], 'clip.MOV'))).toBe('video');
    expect(fileKind(new File([''], 'report.PDF'))).toBe('document');
    expect(fileKind(new File([''], 'noext'))).toBeNull();
    expect(fileKind(new File([''], 'a.exe'))).toBeNull();
  });

  it('formats sizes', () => {
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
  });
});

describe('sanitizeHtml images', () => {
  it('drops images without a source', () => {
    expect(sanitizeHtml('<p>a<img alt="x">b</p>')).not.toContain('<img');
  });
});

describe('ApiClient remaining paths', () => {
  it('keeps valid behaviors and timestamps from the server or the sent workflow', async () => {
    const { client } = setup({
      json: {
        workflow: { issueCreationBehavior: 'allow', defaultAction: 'deny', updatedAt: 'T1' },
      },
    });
    await expect(client.getAgentWorkflow()).resolves.toMatchObject({
      issueCreationBehavior: 'allow',
      defaultAction: 'deny',
      updatedAt: 'T1',
    });
    const { client: saver } = setup({ json: { workflow: {} } });
    await expect(saver.saveAgentWorkflow({ ...workflow, updatedAt: 'T0' })).resolves.toMatchObject({
      updatedAt: 'T0',
    });
  });

  it('reads server capabilities and document attachments', async () => {
    const { client, last } = setup({ json: { workersReachLocalhost: true, attachments: [] } });
    await expect(client.getCapabilities()).resolves.toEqual({ workersReachLocalhost: true });
    await expect(client.getDocumentAttachments('p 1')).resolves.toEqual([]);
    expect(last().url).toBe('http://api/knowledge/documents/p%201/attachments');
  });
});
