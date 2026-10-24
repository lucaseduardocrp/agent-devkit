import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import { LoadTestsView } from '../src/features/apitests/LoadTestsView.js';
import type {
  ApiCollection,
  ApiRun,
  CollectionRunResult,
  LoadScenario,
  LoadSummary,
} from '../src/features/apitests/api-test-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [
    { key: 'baseUrl', value: 'https://api.test' },
    { key: 'password', value: '', secret: true, hasValue: true },
  ],
  auth: { type: 'none' },
  source: { kind: 'postman' },
  updatedAt: '2026-10-24T10:00:00Z',
  items: [
    {
      id: 'login',
      type: 'request',
      name: 'Login',
      method: 'POST',
      url: '{{baseUrl}}/login',
      headers: [],
      query: [],
      body: { mode: 'json', content: '{}' },
      auth: { type: 'inherit' },
      assertions: [{ id: 'a1', source: 'status', operator: 'eq', expected: '200' }],
      captures: [{ variable: 'token', source: 'json', path: 'token' }],
    },
    {
      id: 'f1',
      type: 'folder',
      name: 'Orders',
      items: [
        {
          id: 'list',
          type: 'request',
          name: 'List orders',
          method: 'GET',
          url: '{{baseUrl}}/orders',
          headers: [],
          query: [],
          body: { mode: 'none' },
          auth: { type: 'inherit' },
          assertions: [],
          captures: [],
        },
      ],
    },
  ],
};

const integrationRun: ApiRun<CollectionRunResult> = {
  id: 'r1',
  kind: 'integration',
  collectionId: 'c1',
  scenarioId: null,
  environmentId: null,
  name: 'Orders API',
  target: 'remote',
  status: 'failed',
  claimLabel: 'ADK worker',
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: {
    durationMs: 120,
    total: 2,
    passed: 1,
    failed: 1,
    results: [
      {
        requestId: 'login',
        name: 'Login',
        path: [],
        method: 'POST',
        url: 'https://api.test/login',
        status: 200,
        durationMs: 40,
        sizeBytes: 20,
        passed: true,
        assertions: [{ id: 'a1', label: 'status eq 200', passed: true }],
        response: { headers: {}, bodyPreview: '{"token":"••••••"}' },
      },
      {
        requestId: 'list',
        name: 'List orders',
        path: ['Orders'],
        method: 'GET',
        url: 'https://api.test/orders',
        status: 500,
        durationMs: 80,
        sizeBytes: 5,
        passed: false,
        assertions: [{ id: 'b1', label: 'status eq 200', passed: false, actual: '500' }],
      },
    ],
  },
};

function integrationClient() {
  return {
    listApiCollections: vi.fn(() =>
      Promise.resolve([
        {
          id: 'c1',
          name: 'Orders API',
          description: '',
          source: { kind: 'postman' },
          requestCount: 2,
          updatedAt: '',
        },
      ]),
    ),
    listApiEnvironments: vi.fn(() =>
      Promise.resolve([{ id: 'e1', name: 'Staging', variables: [] }]),
    ),
    getApiCollection: vi.fn(() => Promise.resolve(collection)),
    saveApiCollection: vi.fn((value: ApiCollection) =>
      Promise.resolve({ ...collection, ...value }),
    ),
    listApiRuns: vi.fn(() => Promise.resolve([])),
    startIntegrationRun: vi.fn(() =>
      Promise.resolve({ ...integrationRun, status: 'queued', target: 'local', result: null }),
    ),
    getApiRun: vi.fn(() => Promise.resolve(integrationRun)),
    importApiCollection: vi.fn(() => Promise.resolve({ format: 'openapi', collection })),
    exportApiCollection: vi.fn(() =>
      Promise.resolve({ fileName: 'orders.postman_collection.json', blob: new Blob(['{}']) }),
    ),
  };
}

/** Chooses an option of the app's SearchableSelect. */
function pick(view: ReturnType<typeof render>, testId: string, option: string) {
  fireEvent.click(view.getByTestId(testId));
  fireEvent.click(view.getByRole('option', { name: option }));
}

describe('IntegrationTestsView', () => {
  it('opens the first request, edits it, saves and opens a request inside a folder', async () => {
    const api = integrationClient();
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    // The first collection and its first request open on their own.
    const editor = await view.findByTestId('request-editor');
    expect(within(editor).getByLabelText<HTMLInputElement>('URL').value).toBe('{{baseUrl}}/login');
    const save = within(editor).getByTestId<HTMLButtonElement>('save-collection');
    expect(save.disabled).toBe(true);
    fireEvent.change(within(editor).getByLabelText('URL'), {
      target: { value: '{{baseUrl}}/auth/login' },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.saveApiCollection).toHaveBeenCalled());
    const [saved, id] = api.saveApiCollection.mock.calls[0] as unknown as [ApiCollection, string];
    expect(id).toBe('c1');
    expect(saved.items[0]).toMatchObject({ url: '{{baseUrl}}/auth/login' });

    // The method is picked from a list, never typed.
    const method = view.getByTestId('method-select');
    expect(method.tagName).toBe('BUTTON');
    pick(view, 'method-select', 'PATCH');
    expect(method.textContent).toBe('PATCH');
    fireEvent.keyDown(method, { key: 'ArrowDown' });
    fireEvent.keyDown(method, { key: 'ArrowDown' });
    fireEvent.keyDown(method, { key: 'Enter' });
    expect(method.textContent).toBe('DELETE');

    // Folders start collapsed, as in Bruno.
    expect(view.queryByTestId('tree-request-List orders')).toBeNull();
    fireEvent.click(view.getByText('Orders'));
    fireEvent.click(view.getByTestId('tree-request-List orders'));
    expect(
      within(view.getByTestId('request-editor')).getByLabelText<HTMLInputElement>('URL').value,
    ).toBe('{{baseUrl}}/orders');
    // Both requests stay open as tabs.
    expect(view.getAllByRole('tab', { name: /Login|List orders/ })).toHaveLength(2);
  });

  it('sends the open request and shows its response', async () => {
    const api = integrationClient();
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('request-editor');
    expect(view.getByTestId('response-placeholder')).toBeTruthy();
    fireEvent.click(view.getByTestId('run-request'));
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenCalledWith(
        expect.objectContaining({ collectionId: 'c1', itemIds: ['login'], target: 'remote' }),
      ),
    );
    const status = await view.findByTestId('response-status', {}, { timeout: 4_000 });
    expect(status.textContent).toBe('200 OK');
    expect(view.getByTestId('response-body').textContent).toContain('"token"');
    fireEvent.click(within(view.getByTestId('response-pane')).getByRole('tab', { name: /Testes/ }));
    expect(within(view.getByTestId('response-tests')).getByText('status eq 200')).toBeTruthy();
  });

  it('runs the collection in the runner and shows each request result', async () => {
    const api = integrationClient();
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('request-editor');
    pick(view, 'environment-select', 'Staging');
    pick(view, 'run-target', 'Meu computador (devkit runner)');
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenCalledWith({
        collectionId: 'c1',
        environmentId: 'e1',
        itemIds: [],
        target: 'local',
        bail: false,
      }),
    );
    expect(await view.findByText(/Aguardando o devkit runner/)).toBeTruthy();
    const results = await view.findByTestId('run-results', {}, { timeout: 4_000 });
    await waitFor(() => expect(within(results).getByText('Passaram: 1')).toBeTruthy(), {
      timeout: 4_000,
    });
    expect(within(results).getByText('Falharam: 1')).toBeTruthy();
    fireEvent.click(within(results).getByText('Orders / List orders'));
    expect(within(results).getByTestId('response-status').textContent).toBe(
      '500 Internal Server Error',
    );
    fireEvent.click(within(results).getByRole('tab', { name: /Testes/ }));
    expect(within(results).getByText(/obtido: 500/)).toBeTruthy();
  });

  it('clones a request through its menu', async () => {
    const api = integrationClient();
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('request-editor');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Login' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Clonar' }));
    const input = (await view.findByTestId('name-dialog-input')) as HTMLInputElement;
    expect(input.value).toBe('Login cópia');
    fireEvent.click(view.getByTestId('name-dialog-submit'));
    expect(await view.findByTestId('tree-request-Login cópia')).toBeTruthy();
    // The copy opens in its own tab, with unsaved changes.
    expect(view.getAllByLabelText('Alterações não salvas').length).toBeGreaterThan(0);
  });

  it('keeps the query in the URL and the Query tab in sync, and fills path params', async () => {
    const view = render(
      <IntegrationTestsView apiClient={integrationClient() as unknown as ApiClient} />,
    );
    const editor = await view.findByTestId('request-editor');
    const url = within(editor).getByLabelText<HTMLInputElement>('URL');
    fireEvent.change(url, { target: { value: '{{baseUrl}}/orders/:id?page=2&sort' } });
    // Typed as is: `sort` is not rewritten to `sort=` while typing.
    expect(url.value).toBe('{{baseUrl}}/orders/:id?page=2&sort');

    fireEvent.click(view.getByRole('tab', { name: /Query/ }));
    expect(screen.getByLabelText<HTMLInputElement>('page').value).toBe('2');
    fireEvent.change(view.getByLabelText('page'), { target: { value: '3' } });
    expect(url.value).toBe('{{baseUrl}}/orders/:id?page=3&sort');

    expect(view.queryByRole('tab', { name: /Params/ })).toBeNull();
    fireEvent.change(within(view.getByTestId('path-params')).getByLabelText('id'), {
      target: { value: '{{orderId}}' },
    });
    fireEvent.click(view.getByTestId('generate-code'));
    expect(
      within(await view.findByTestId('code-dialog')).getByText(
        /orders\/\{\{orderId\}\}\?page=3&sort/,
      ),
    ).toBeTruthy();
  });

  it('suggests variables after {{ and completes them', async () => {
    const view = render(
      <IntegrationTestsView apiClient={integrationClient() as unknown as ApiClient} />,
    );
    const editor = await view.findByTestId('request-editor');
    const url = within(editor).getByLabelText<HTMLInputElement>('URL');
    url.focus();
    fireEvent.change(url, { target: { value: '{{ba', selectionStart: 4, selectionEnd: 4 } });
    const suggestions = await view.findByTestId('variable-suggestions');
    expect(within(suggestions).getByText('baseUrl')).toBeTruthy();
    // Secrets never show their value.
    fireEvent.change(url, { target: { value: '{{pass', selectionStart: 6, selectionEnd: 6 } });
    expect(within(view.getByTestId('variable-suggestions')).getByText('••••••')).toBeTruthy();
    fireEvent.keyDown(url, { key: 'Enter' });
    expect(url.value).toBe('{{password}}');
  });

  it('renames a collection and opens the environments page', async () => {
    const api = integrationClient();
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('request-editor');
    fireEvent.click(view.getByTestId('rename-collection'));
    const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    expect(input.value).toBe('Orders API');
    fireEvent.change(input, { target: { value: 'Orders v2' } });
    fireEvent.click(view.getByTestId('name-dialog-submit'));
    await waitFor(() =>
      expect(api.saveApiCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Orders v2' }),
        'c1',
      ),
    );

    fireEvent.click(view.getByTestId('open-environments'));
    const page = await view.findByTestId('environments-page');
    expect(within(page).getByTestId<HTMLInputElement>('environment-name').value).toBe('Staging');
    expect(view.getByRole('tab', { name: /Ambientes/ })).toBeTruthy();
  });

  it('imports a file and hides editing for read-only members', async () => {
    const api = integrationClient();
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    const file = new File(['openapi: 3.0.0'], 'api.yaml');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('openapi: 3.0.0') });
    fireEvent.change(await view.findByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() => expect(api.importApiCollection).toHaveBeenCalledWith('openapi: 3.0.0'));
    expect(await view.findByText('"Orders API" importada (openapi).')).toBeTruthy();

    const readOnly = render(
      <IntegrationTestsView apiClient={integrationClient() as unknown as ApiClient} isReadOnly />,
    );
    await waitFor(() => expect(readOnly.getAllByTestId('request-editor')).toHaveLength(2));
    // Only the editable view offers sending, saving and creating.
    expect(readOnly.queryAllByTestId('run-request')).toHaveLength(1);
    expect(readOnly.queryAllByTestId('save-collection')).toHaveLength(1);
    expect(readOnly.queryAllByTestId('new-collection')).toHaveLength(1);
  });
});

const scenario: LoadScenario = {
  id: 's1',
  name: 'Peak',
  collectionId: 'c1',
  environmentId: null,
  requests: [{ requestId: 'list', weight: 3 }],
  profile: 'load',
  stages: [{ durationSec: 60, targetVus: 20 }],
  thinkTimeMs: 1000,
  thresholds: [{ metric: 'p95', operator: 'lt', value: 500 }],
  updatedAt: '',
};

const summary: LoadSummary = {
  durationSec: 60,
  maxVus: 20,
  totalRequests: 1200,
  failedRequests: 12,
  errorRate: 0.01,
  rps: 20,
  latency: { min: 5, avg: 90, p50: 80, p90: 150, p95: 210, p99: 400, max: 900 },
  checks: { passed: 10, failed: 0 },
  statusCodes: { '200': 1188, '500': 12 },
  errors: { 'HTTP 500': 12 },
  perRequest: [
    { requestId: 'list', name: 'List orders', count: 1200, failed: 12, avg: 90, p95: 210 },
  ],
  thresholds: [{ metric: 'p95', operator: 'lt', value: 500, actual: 210, passed: true }],
  passed: true,
  timeline: [
    { t: 1, vus: 5, requests: 10, errors: 0, avg: 80, p50: 70, p95: 120, p99: 150 },
    { t: 2, vus: 10, requests: 20, errors: 1, avg: 90, p50: 80, p95: 210, p99: 300 },
  ],
};

function loadClient() {
  return {
    listLoadScenarios: vi.fn(() => Promise.resolve([scenario])),
    listApiCollections: vi.fn(() =>
      Promise.resolve([
        {
          id: 'c1',
          name: 'Orders API',
          description: '',
          source: { kind: 'manual' },
          requestCount: 2,
          updatedAt: '',
        },
      ]),
    ),
    listApiEnvironments: vi.fn(() => Promise.resolve([])),
    getApiCollection: vi.fn(() => Promise.resolve(collection)),
    getLoadProfiles: vi.fn(() =>
      Promise.resolve([
        {
          profile: 'spike',
          stages: [
            { durationSec: 10, targetVus: 5 },
            { durationSec: 5, targetVus: 50 },
          ],
          thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.05 }],
        },
      ]),
    ),
    saveLoadScenario: vi.fn((value: LoadScenario) => Promise.resolve({ ...scenario, ...value })),
    listApiRuns: vi.fn(() => Promise.resolve([])),
    startLoadRun: vi.fn(() =>
      Promise.resolve({ ...integrationRun, kind: 'load', status: 'passed', result: summary }),
    ),
    exportLoadScenarioK6: vi.fn(() => Promise.resolve({ fileName: 'peak.k6.js', body: '' })),
  };
}

describe('LoadTestsView', () => {
  it('applies a test type preset and saves the scenario', async () => {
    const api = loadClient();
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    fireEvent.click(await view.findByTestId('scenario-Peak'));
    await view.findByLabelText('List orders');
    fireEvent.click(view.getByTestId('profile-spike'));
    await waitFor(() => expect(api.getLoadProfiles).toHaveBeenCalledWith(20, 300));
    await waitFor(() => expect(view.getByText('Pico de 50 VUs · 15 s')).toBeInTheDocument());
    fireEvent.click(view.getByTestId('save-scenario'));
    await waitFor(() => expect(api.saveLoadScenario).toHaveBeenCalled());
    expect(api.saveLoadScenario.mock.calls[0]).toEqual([
      expect.objectContaining({
        profile: 'spike',
        thresholds: [{ metric: 'errorRate', operator: 'lt', value: 0.05 }],
      }),
      's1',
    ]);
  });

  it('creates a scenario with every request of the collection selected', async () => {
    const api = loadClient();
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    await view.findByTestId('scenario-Peak');
    fireEvent.click(view.getByTestId('new-scenario'));
    const name = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
    fireEvent.change(name, { target: { value: 'Black Friday' } });
    fireEvent.click(view.getByTestId('name-dialog-submit'));
    expect(view.getByTestId('scenario-title').textContent).toBe('Black Friday');
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Login').checked).toBe(true));
    expect(screen.getByLabelText<HTMLInputElement>('List orders').checked).toBe(true);
    fireEvent.click(view.getByTestId('save-scenario'));
    await waitFor(() =>
      expect(api.saveLoadScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Black Friday',
          collectionId: 'c1',
          requests: [
            { requestId: 'login', weight: 1 },
            { requestId: 'list', weight: 1 },
          ],
        }),
        undefined,
      ),
    );
  });

  it('requires the authorization confirmation and shows the run metrics', async () => {
    const api = loadClient();
    const view = render(<LoadTestsView apiClient={api as unknown as ApiClient} />);
    fireEvent.click(await view.findByTestId('scenario-Peak'));
    await view.findByLabelText('List orders');
    // A saved scenario opens the confirmation directly; nothing to save first.
    fireEvent.click(view.getByTestId('open-run'));
    const dialog = await view.findByTestId('load-run-dialog');
    expect(api.saveLoadScenario).not.toHaveBeenCalled();
    const start = within(dialog).getByTestId('run-load');
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByTestId('authorized'));
    fireEvent.click(start);
    await waitFor(() =>
      expect(api.startLoadRun).toHaveBeenCalledWith({
        scenarioId: 's1',
        target: 'remote',
        authorized: true,
      }),
    );
    const detail = await view.findByTestId('load-run-detail');
    expect(within(detail).getByText('1200', { selector: 'dd' })).toBeInTheDocument();
    expect(within(detail).getByText('210 ms', { selector: 'dd' })).toBeInTheDocument();
    expect(within(detail).getByTestId('timeline-chart')).toBeInTheDocument();
    expect(within(detail).getByText('HTTP 500')).toBeInTheDocument();
  });
});
