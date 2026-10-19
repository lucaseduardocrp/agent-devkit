import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

function reply(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => json,
    text: async () => '',
  } as Response;
}

function setup(json: unknown = {}, status = 200) {
  const calls: RecordedCall[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      signal: init?.signal,
    });
    return reply(status, json);
  });
  const client = new ApiClient({ baseUrl: 'http://api', fetcher });
  return { client, calls };
}

function only(calls: readonly RecordedCall[]): RecordedCall {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new Error('expected one recorded call');
  return call;
}

const TEMPLATE = { id: 't1', name: 'Default' };
const FIELD = { key: 'System.Title', label: 'Title' };
const INPUT = { name: 'Default', entityType: 'pbi', providerId: 'jira', mappings: [] } as never;

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
    'getFieldMappingTemplates',
    (c) => c.getFieldMappingTemplates('test_case', 'azure_devops'),
    'GET',
    '/field-mappings?entityType=test_case&providerId=azure_devops',
    undefined,
    { templates: [TEMPLATE] },
    [TEMPLATE],
  ],
  [
    'saveFieldMappingTemplate (create)',
    (c) => c.saveFieldMappingTemplate(INPUT),
    'POST',
    '/field-mappings',
    INPUT,
    { template: TEMPLATE },
    TEMPLATE,
  ],
  [
    'saveFieldMappingTemplate (update)',
    (c) => c.saveFieldMappingTemplate(INPUT, 't 1'),
    'PUT',
    '/field-mappings/t%201',
    INPUT,
    { template: TEMPLATE },
    TEMPLATE,
  ],
  [
    'deleteFieldMappingTemplate',
    (c) => c.deleteFieldMappingTemplate('t/1'),
    'DELETE',
    '/field-mappings/t%2F1',
    undefined,
    {},
    undefined,
  ],
  [
    'getPbiFieldCatalog (defaults)',
    (c) => c.getPbiFieldCatalog('jira'),
    'GET',
    '/pbi/field-catalog?providerId=jira&scope=&itemType=',
    undefined,
    { fields: [FIELD] },
    [FIELD],
  ],
  [
    'getPbiFieldCatalog (scoped)',
    (c) => c.getPbiFieldCatalog('azure_devops', 'Team A', 'Bug'),
    'GET',
    '/pbi/field-catalog?providerId=azure_devops&scope=Team+A&itemType=Bug',
    undefined,
    { fields: [] },
    [],
  ],
  [
    'previewPbiFields (defaults)',
    (c) => c.previewPbiFields('p 1', 'jira', 't1'),
    'POST',
    '/pbi/items/p%201/field-preview',
    { providerId: 'jira', templateId: 't1', scope: '', itemType: '' },
    { definitions: [FIELD], values: { title: 'Login' } },
    { definitions: [FIELD], values: { title: 'Login' } },
  ],
  [
    'previewPbiFields (scoped)',
    (c) => c.previewPbiFields('p1', 'azure_devops', 't1', 'Team A', 'Bug'),
    'POST',
    '/pbi/items/p1/field-preview',
    { providerId: 'azure_devops', templateId: 't1', scope: 'Team A', itemType: 'Bug' },
    { definitions: [], values: {} },
    { definitions: [], values: {} },
  ],
  [
    'getTestCaseFieldCatalog',
    (c) => c.getTestCaseFieldCatalog('azure devops'),
    'GET',
    '/TestPlan/publish/fields?providerId=azure%20devops',
    undefined,
    { fields: [FIELD] },
    [FIELD],
  ],
  [
    'getTestSuiteFieldSources',
    (c) => c.getTestSuiteFieldSources('s 1'),
    'GET',
    '/TestPlan/suites/s%201/field-sources',
    undefined,
    { sources: [{ providerId: 'jira', key: 'summary' }] },
    [{ providerId: 'jira', key: 'summary' }],
  ],
  [
    'previewTestSuiteFields',
    (c) => c.previewTestSuiteFields('s1', 'azure_devops', 't1'),
    'POST',
    '/TestPlan/suites/s1/field-preview',
    { providerId: 'azure_devops', templateId: 't1' },
    { count: 1, previews: [{ title: 'Login', values: {} }] },
    { count: 1, previews: [{ title: 'Login', values: {} }] },
  ],
  [
    'previewTestSuiteFields (filled values)',
    (c) => c.previewTestSuiteFields('s1', 'azure_devops', 't1', { 'Custom.Flow': 'Principal' }),
    'POST',
    '/TestPlan/suites/s1/field-preview',
    { providerId: 'azure_devops', templateId: 't1', fieldValues: { 'Custom.Flow': 'Principal' } },
    { count: 0, previews: [] },
    { count: 0, previews: [] },
  ],
  [
    'getE2eRunners',
    (c) => c.getE2eRunners(),
    'GET',
    '/e2e/runners',
    undefined,
    { runners: [{ id: 'runner-1' }] },
    [{ id: 'runner-1' }],
  ],
  [
    'setE2eExecutionTarget',
    (c) => c.setE2eExecutionTarget('e 1', { type: 'local', runnerId: 'runner-1' } as never),
    'PUT',
    '/e2e/creations/e%201/execution',
    { executionTarget: { type: 'local', runnerId: 'runner-1' } },
    { creation: { id: 'e1' } },
    { id: 'e1' },
  ],
];

describe('ApiClient field mapping, field preview and E2E runner endpoints', () => {
  it.each(endpoints)(
    '%s sends the request and unwraps the response',
    async (_name, call, method, path, body, response, expected) => {
      const { client, calls } = setup(response);
      await expect(call(client)).resolves.toEqual(expected);
      const request = only(calls);
      expect(request.url).toBe(`http://api${path}`);
      expect(request.method).toBe(method);
      expect(request.body).toEqual(body);
      if (body !== undefined) expect(request.headers['content-type']).toBe('application/json');
    },
  );

  it.each(endpoints)('%s rejects with ApiClientError on a non-ok response', async (...row) => {
    const { client } = setup({ message: 'Conflict detected' }, 409);
    const error = await row[1](client).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 409, message: 'Conflict detected' });
  });

  it('forwards the abort signal when listing E2E runners', async () => {
    const { client, calls } = setup({ runners: [] });
    const controller = new AbortController();
    await client.getE2eRunners(controller.signal);
    expect(only(calls).signal).toBe(controller.signal);
  });

  it('exposes the configured and the default API address', () => {
    expect(new ApiClient({ baseUrl: 'https://api.adk.example.com' }).apiUrl).toBe(
      'https://api.adk.example.com',
    );
    expect(new ApiClient().apiUrl).toBe('http://localhost:3000');
  });
});
