import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import type {
  ApiCollection,
  ApiRun,
  CollectionRunResult,
} from '../src/features/apitests/api-test-types.js';
import type { ApiClient } from '../src/lib/api-client.js';

const orders: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [{ key: 'baseUrl', value: 'https://api.test' }],
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
      assertions: [],
      captures: [],
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

const users: ApiCollection = { ...orders, id: 'c2', name: 'Users API', items: [] };

const summary = (collection: ApiCollection) => ({
  id: collection.id,
  name: collection.name,
  description: '',
  source: { kind: 'postman' as const },
  requestCount: 0,
  updatedAt: '',
});

const run = (patch: Partial<ApiRun<CollectionRunResult>> = {}): ApiRun<CollectionRunResult> => ({
  id: 'r1',
  kind: 'integration',
  collectionId: 'c1',
  scenarioId: null,
  environmentId: null,
  name: 'Orders API',
  target: 'remote',
  status: 'passed',
  claimLabel: null,
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: null,
  ...patch,
});

function client() {
  return {
    listApiCollections: vi.fn(() => Promise.resolve([summary(orders), summary(users)])),
    listApiEnvironments: vi.fn(() =>
      Promise.resolve([{ id: 'e1', name: 'Staging', variables: [] }]),
    ),
    listApiMockValues: vi.fn(() => Promise.resolve([])),
    getApiCollection: vi.fn((id: string) => Promise.resolve(id === 'c2' ? users : orders)),
    saveApiCollection: vi.fn((value: ApiCollection) =>
      Promise.resolve({ ...orders, ...value, id: value.id ?? 'c9' }),
    ),
    deleteApiCollection: vi.fn(() => Promise.resolve()),
    startIntegrationRun: vi.fn(() => Promise.resolve(run())),
    getApiRun: vi.fn(() => Promise.resolve(run())),
    cancelApiRun: vi.fn(() => Promise.resolve(run({ status: 'cancelled' }))),
    importApiCollection: vi.fn((): Promise<{ format: string; collection: ApiCollection }> =>
      Promise.reject(new Error('bad file')),
    ),
    exportApiCollection: vi.fn(() =>
      Promise.resolve({ fileName: 'orders.json', blob: new Blob(['{}']) }),
    ),
    generateApiTests: vi.fn(() => Promise.resolve({ collection: { id: 'c1' } })),
    getAllSavedTestPlans: vi.fn(() => Promise.resolve([])),
    saveApiEnvironment: vi.fn(),
    deleteApiEnvironment: vi.fn(),
  };
}

type Client = ReturnType<typeof client>;

async function mount(api: Client = client(), readOnly = false) {
  const view = render(
    <IntegrationTestsView apiClient={api as unknown as ApiClient} isReadOnly={readOnly} />,
  );
  await view.findByTestId('request-editor');
  return { view, api };
}

/** Picks an entry of a row's "..." menu in the sidebar. */
async function menu(name: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: `Ações de ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

async function nameDialog(value?: string) {
  const input = await screen.findByTestId<HTMLInputElement>('name-dialog-input');
  if (value !== undefined) fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByTestId('name-dialog-submit'));
}

async function confirmDialog() {
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
}

const openTabs = () =>
  within(screen.getByRole('tablist', { name: 'Requisições abertas' })).queryAllByRole('tab');
const tabNames = () => openTabs().map((tab) => tab.textContent);
const editUrl = (value: string) =>
  fireEvent.change(within(screen.getByTestId('request-editor')).getByLabelText('URL'), {
    target: { value },
  });

beforeEach(() => {
  window.localStorage.clear();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

describe('IntegrationTestsView split pane and layout', () => {
  it('resizes the panes by dragging, double click and the keyboard, in both layouts', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 1000,
      height: 500,
    } as DOMRect);
    const { view } = await mount();
    const separator = () =>
      view.getByRole('separator', { name: 'Redimensionar requisição e resposta' });
    fireEvent(separator(), new MouseEvent('pointerdown', { bubbles: true, button: 2 }));
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
    expect(separator().getAttribute('aria-valuenow')).toBe('50');

    fireEvent(separator(), new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(document.body.style.cursor).toBe('col-resize');
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300 }));
    });
    expect(separator().getAttribute('aria-valuenow')).toBe('30');
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(document.body.style.cursor).toBe('');
    fireEvent.doubleClick(separator());
    expect(separator().getAttribute('aria-valuenow')).toBe('50');
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(separator().getAttribute('aria-valuenow')).toBe('55');
    fireEvent.keyDown(separator(), { key: 'Home' });
    expect(separator().getAttribute('aria-valuenow')).toBe('55');

    fireEvent.click(view.getByTestId('toggle-layout'));
    expect(window.localStorage.getItem('adk.integrationTests.layout')).toBe('vertical');
    expect(separator().getAttribute('aria-orientation')).toBe('horizontal');
    fireEvent(separator(), new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(document.body.style.cursor).toBe('row-resize');
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 450 }));
    });
    expect(separator().getAttribute('aria-valuenow')).toBe('80');
    act(() => {
      window.dispatchEvent(new MouseEvent('pointercancel'));
    });
    fireEvent.click(view.getByTestId('toggle-layout'));
    expect(window.localStorage.getItem('adk.integrationTests.layout')).toBe('horizontal');
  });
});

describe('IntegrationTestsView shortcuts and sending', () => {
  it('saves with Ctrl+S and sends with Ctrl+Enter', async () => {
    const { view, api } = await mount();
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveApiCollection).not.toHaveBeenCalled();
    editUrl('{{baseUrl}}/v2/login');
    fireEvent.keyDown(window, { key: 'S', metaKey: true });
    await waitFor(() => expect(api.saveApiCollection).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenCalledWith(
        expect.objectContaining({ itemIds: ['login'], environmentId: null }),
      ),
    );
    // The run finished without a result for the request: its status is shown instead.
    expect(await view.findByText('Passou')).toBeTruthy();

    // Other pages ignore Ctrl+Enter, and the environments page has nothing to save.
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    fireEvent.click(view.getByTestId('open-environments'));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.startIntegrationRun).toHaveBeenCalledTimes(1);
    expect(api.saveApiCollection).toHaveBeenCalledTimes(1);
  });

  it('polls a running send, ignores a second send and cancels it', async () => {
    const api = client();
    api.startIntegrationRun.mockResolvedValue(run({ status: 'running' }));
    api.getApiRun
      .mockRejectedValueOnce(new Error('restarting'))
      .mockResolvedValue(run({ status: 'failed', error: 'timeout' }));
    api.cancelApiRun.mockRejectedValueOnce('cannot cancel');
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('run-request'));
    fireEvent.click(await view.findByTestId('cancel-request'));
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect((await view.findByRole('alert')).textContent).toContain('cannot cancel');
    fireEvent.click(within(view.getByTestId('response-pane')).getByText('Cancelar requisição'));
    await waitFor(() => expect(api.cancelApiRun).toHaveBeenCalledTimes(2));
    expect(await view.findByText('timeout', {}, { timeout: 4_000 })).toBeTruthy();
    expect(api.startIntegrationRun).toHaveBeenCalledTimes(1);
    expect(api.getApiRun).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('shows send failures, and does not send when saving fails', async () => {
    const api = client();
    api.startIntegrationRun.mockRejectedValueOnce(new Error('no worker'));
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('run-request'));
    expect((await view.findByRole('alert')).textContent).toContain('no worker');
    fireEvent.click(view.getByRole('button', { name: 'Fechar' }));
    expect(view.queryByRole('alert')).toBeNull();

    api.saveApiCollection.mockRejectedValueOnce('conflict');
    editUrl('{{baseUrl}}/x');
    fireEvent.click(view.getByTestId('run-request'));
    expect((await view.findByRole('alert')).textContent).toContain('conflict');
    expect(api.startIntegrationRun).toHaveBeenCalledTimes(1);
  });

  it('never sends for read-only members', async () => {
    const { api } = await mount(client(), true);
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(api.startIntegrationRun).not.toHaveBeenCalled();
  });
});

describe('IntegrationTestsView runner', () => {
  it('cancels, resets and reruns the collection, and opens a result request', async () => {
    const api = client();
    api.startIntegrationRun.mockResolvedValueOnce(run({ status: 'running' }));
    api.getApiRun.mockResolvedValueOnce(
      run({
        status: 'passed',
        result: {
          durationMs: 5,
          total: 1,
          passed: 1,
          failed: 0,
          results: [
            {
              requestId: 'list',
              name: 'List orders',
              path: ['Orders'],
              method: 'GET',
              url: 'https://api.test/orders',
              status: 200,
              durationMs: 5,
              sizeBytes: 2,
              passed: true,
              assertions: [],
            },
          ],
        },
      }),
    );
    api.cancelApiRun.mockRejectedValueOnce(new Error('too late'));
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    fireEvent.click(await view.findByRole('button', { name: /Cancelar execução/ }));
    expect((await view.findByRole('alert')).textContent).toContain('too late');
    fireEvent.click(view.getByRole('button', { name: /Cancelar execução/ }));
    await waitFor(() => expect(api.cancelApiRun).toHaveBeenCalledTimes(2));
    const results = await view.findByTestId('run-results');
    await waitFor(() => expect(within(results).getByText('Orders / List orders')).toBeTruthy(), {
      timeout: 4_000,
    });
    fireEvent.click(within(results).getByRole('button', { name: 'Abrir requisição' }));
    expect(
      within(view.getByTestId('request-editor')).getByLabelText<HTMLInputElement>('URL').value,
    ).toBe('{{baseUrl}}/orders');
    // The request got the run's response in its own tab.
    expect(view.getByTestId('response-status').textContent).toBe('200 OK');

    fireEvent.click(view.getByRole('button', { name: /Runner · Orders API/ }));
    fireEvent.click(view.getByRole('button', { name: 'Limpar' }));
    expect(await view.findByTestId('run-collection')).toBeTruthy();
  }, 20_000);

  it('reports runner failures and stops when saving fails', async () => {
    const api = client();
    api.startIntegrationRun.mockRejectedValueOnce(new Error('queue full'));
    const { view } = await mount(api);
    editUrl('{{baseUrl}}/y');
    api.saveApiCollection.mockRejectedValueOnce(new Error('save failed'));
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    expect((await view.findByRole('alert')).textContent).toContain('save failed');
    expect(api.startIntegrationRun).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('run-collection'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('queue full'));
  });
});

describe('IntegrationTestsView tabs', () => {
  it('closes tabs with the button and the middle click, down to the empty page', async () => {
    const api = client();
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(view.getByTestId('open-environments'));
    expect(tabNames()).toHaveLength(4);
    // Closing an inactive tab keeps the active one.
    const loginTab = openTabs().find((tab) => tab.textContent?.includes('Login'))!;
    fireEvent.click(within(loginTab).getByRole('button', { name: 'Fechar aba' }));
    expect(view.getByTestId('environments-page')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Runner · Orders API/ }));
    const runnerTab = openTabs().find((tab) => tab.textContent?.includes('Runner'))!;
    fireEvent(runnerTab, new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(tabNames()).toHaveLength(3);
    fireEvent(runnerTab, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    // The neighbour (settings) becomes active.
    expect(view.getByTestId('collection-settings')).toBeTruthy();
    while (openTabs().length)
      fireEvent.click(within(openTabs()[0]!).getByRole('button', { name: 'Fechar aba' }));
    // Without tabs, shortcuts do nothing.
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(view.getByRole('button', { name: /Importar coleção/ }));
    expect(click).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: /Importar Postman/ }));
    expect(click).toHaveBeenCalledTimes(2);

    // Creating a collection from the empty page opens its first request.
    fireEvent.click(view.getByRole('button', { name: /Criar coleção/ }));
    await nameDialog('Payments');
    await waitFor(() =>
      expect(api.saveApiCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Payments' }),
      ),
    );
    expect(await view.findByTestId('request-editor')).toBeTruthy();
  });

  it('shows a failed creation and a failed import', async () => {
    const api = client();
    api.saveApiCollection.mockRejectedValueOnce(new Error('quota'));
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('new-collection'));
    await nameDialog();
    expect((await view.findByRole('alert')).textContent).toContain('quota');
    const file = new File(['x'], 'x.json');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('x') });
    fireEvent.change(view.getByTestId('import-input'), { target: { files: [file] } });
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('bad file'));
    fireEvent.change(view.getByTestId('import-input'), { target: { files: [] } });
    expect(api.importApiCollection).toHaveBeenCalledTimes(1);
  });

  it('dismisses the import notice', async () => {
    const api = client();
    api.importApiCollection.mockResolvedValueOnce({ format: 'postman', collection: orders });
    const { view } = await mount(api);
    const file = new File(['{}'], 'x.json');
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{}') });
    fireEvent.change(view.getByTestId('import-input'), { target: { files: [file] } });
    expect(await view.findByRole('status')).toBeTruthy();
    fireEvent.click(within(view.getByRole('status')).getByRole('button', { name: 'Fechar' }));
    expect(view.queryByText(/importada/)).toBeNull();
  });
});

describe('IntegrationTestsView sidebar actions', () => {
  it('creates requests and folders, renames, clones and deletes items', async () => {
    const { view } = await mount();
    // A new request at the root of the collection and in a folder.
    await menu('Orders API', 'Nova requisição');
    expect(await view.findByTestId('tree-request-Nova requisição')).toBeTruthy();
    fireEvent.click(view.getByText('Orders'));
    await menu('Orders', 'Nova requisição');
    await waitFor(() =>
      expect(view.getAllByTestId('tree-request-Nova requisição')).toHaveLength(2),
    );
    fireEvent.click(view.getByTestId('add-request'));
    await waitFor(() =>
      expect(view.getAllByTestId('tree-request-Nova requisição')).toHaveLength(3),
    );

    await menu('Orders API', 'Nova pasta');
    await nameDialog('Admin');
    expect(await view.findByText('Admin')).toBeTruthy();
    await menu('Orders', 'Nova pasta');
    await nameDialog('Nested');
    expect(await view.findByText('Nested')).toBeTruthy();

    // Renaming a request renames its tab; renaming a folder marks the collection as changed.
    await menu('Login', 'Renomear');
    await nameDialog('Sign in');
    expect(await view.findByTestId('tree-request-Sign in')).toBeTruthy();
    await menu('Admin', 'Renomear');
    await nameDialog('Admins');
    expect(await view.findByText('Admins')).toBeTruthy();

    // A cloned folder opens no tab.
    const tabs = openTabs().length;
    await menu('Admins', 'Clonar');
    await nameDialog();
    expect(await view.findByText('Admins cópia')).toBeTruthy();
    expect(openTabs()).toHaveLength(tabs);

    // Deleting a request closes its tab; deleting a folder closes the tabs of its requests.
    fireEvent.click(view.getByTestId('tree-request-List orders'));
    await menu('Sign in', 'Excluir');
    fireEvent.click(await view.findByRole('button', { name: 'Cancelar' }));
    await menu('Sign in', 'Excluir');
    await confirmDialog();
    await waitFor(() => expect(view.queryByTestId('tree-request-Sign in')).toBeNull());
    expect(tabNames().some((name) => name?.includes('Sign in'))).toBe(false);
    await menu('Orders', 'Excluir');
    await confirmDialog();
    await waitFor(() => expect(view.queryByText('List orders')).toBeNull());
  }, 20_000);

  it('runs a single request or opens the runner from the menus', async () => {
    const { view, api } = await mount();
    await menu('Login', 'Executar');
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenCalledWith(
        expect.objectContaining({ itemIds: ['login'] }),
      ),
    );
    expect(await view.findByTestId('collection-runner')).toBeTruthy();
    fireEvent.click(openTabs()[0]!.querySelector('button')!);
    await menu('Users API', 'Executar');
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledWith('c2'));
    expect(await view.findByRole('button', { name: /Runner · Users API/ })).toBeTruthy();
    expect(view.getByText('A coleção não tem requisições.')).toBeTruthy();
  });

  it('edits, exports and deletes a collection from its settings', async () => {
    const api = client();
    api.exportApiCollection.mockRejectedValueOnce(new Error('export failed'));
    const { view } = await mount(api);
    await menu('Orders API', 'Configurações');
    fireEvent.change(await view.findByTestId('collection-name'), {
      target: { value: 'Orders v2' },
    });
    expect(
      view
        .getByRole('tab', { name: /Configurações · Orders v2/ })
        .querySelector('[aria-label="Alterações não salvas"]'),
    ).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Postman v2.1/ }));
    expect((await view.findByRole('alert')).textContent).toContain('export failed');
    // Pending edits are saved before exporting, with the chosen environment.
    fireEvent.click(view.getByTestId('environment-select'));
    fireEvent.click(view.getByRole('option', { name: 'Staging' }));
    fireEvent.click(view.getByRole('button', { name: /Postman v2.1/ }));
    await waitFor(() =>
      expect(api.exportApiCollection).toHaveBeenLastCalledWith('c1', 'postman', ['e1']),
    );
    expect(URL.createObjectURL).toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Excluir coleção' }));
    expect(await view.findByText(/Excluir "Orders v2"\?/)).toBeTruthy();
    await confirmDialog();
    await waitFor(() => expect(api.deleteApiCollection).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(view.queryByTestId('collection-settings')).toBeNull());
  });

  it('renames and deletes a collection that was never opened, and shows failures', async () => {
    const api = client();
    api.deleteApiCollection.mockRejectedValueOnce(new Error('in use'));
    const { view } = await mount(api);
    await menu('Users API', 'Renomear');
    expect(((await view.findByTestId('name-dialog-input')) as HTMLInputElement).value).toBe(
      'Users API',
    );
    await nameDialog('People API');
    await waitFor(() =>
      expect(api.saveApiCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'People API' }),
        'c2',
      ),
    );
    api.getApiCollection.mockRejectedValueOnce(new Error('gone'));
    await menu('Users API', 'Renomear');
    await nameDialog('Again');
    expect((await view.findByRole('alert')).textContent).toContain('gone');

    await menu('Users API', 'Excluir coleção');
    expect(await view.findByText(/Excluir "Users API"\?/)).toBeTruthy();
    await confirmDialog();
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('in use'));

    // Closing the name dialog drops the prompt.
    await menu('Users API', 'Renomear');
    fireEvent.click(await view.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(view.queryByTestId('name-dialog')).toBeNull());
  });

  it('expands and collapses collections, loading them once', async () => {
    const api = client();
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('collection-Users API'));
    expect(await view.findByText('Nenhuma requisição ainda.', { exact: false })).toBeTruthy();
    fireEvent.click(view.getByTestId('collection-Users API'));
    fireEvent.click(view.getByTestId('collection-Users API'));
    expect(api.getApiCollection.mock.calls.filter(([id]) => id === 'c2')).toHaveLength(1);
    fireEvent.click(view.getByText('Orders'));
    fireEvent.click(view.getByText('Orders'));
    expect(api.getApiCollection).toHaveBeenCalledTimes(2);
  });

  it('does nothing more when a collection fails to load', async () => {
    const api = client();
    const { view } = await mount(api);
    api.getApiCollection.mockRejectedValue('offline');
    await menu('Users API', 'Nova requisição');
    expect((await view.findByRole('alert')).textContent).toContain('offline');
    // An item added to a collection that is not loaded changes nothing on screen.
    await menu('Users API', 'Nova pasta');
    await nameDialog('Lost');
    expect(view.queryByText('Lost')).toBeNull();
    await menu('Users API', 'Configurações');
    // The settings tab has no collection to show; saving it has nothing to save.
    await waitFor(() =>
      expect(view.getByText('Integration Tests', { selector: 'h2' })).toBeTruthy(),
    );
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveApiCollection).not.toHaveBeenCalled();
  });
});

describe('IntegrationTestsView loading and generation', () => {
  it('shows a failed listing and a collection that does not load', async () => {
    const api = client();
    api.listApiCollections.mockRejectedValueOnce(new Error('down'));
    const view = render(<IntegrationTestsView apiClient={api as unknown as ApiClient} />);
    expect((await view.findByRole('alert')).textContent).toContain('down');

    const other = client();
    other.getApiCollection.mockRejectedValueOnce(new Error('missing'));
    const second = render(<IntegrationTestsView apiClient={other as unknown as ApiClient} />);
    await waitFor(() =>
      expect(within(second.container).getByRole('alert').textContent).toContain('missing'),
    );
    expect(within(second.container).queryByTestId('request-editor')).toBeNull();
  });

  it('opens what the AI generated', async () => {
    const api = client();
    const { view } = await mount(api);
    const generate = async () => {
      fireEvent.click(view.getByRole('button', { name: 'Gerar com IA' }));
      const dialog = await view.findByTestId('generate-dialog');
      fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'login flow' } });
      fireEvent.click(within(dialog).getByTestId('generate-submit'));
    };
    await generate();
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledTimes(2));
    api.generateApiTests.mockResolvedValueOnce({} as never);
    await generate();
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
    await waitFor(() => expect(api.listApiCollections).toHaveBeenCalledTimes(3));
    expect(api.getApiCollection).toHaveBeenCalledTimes(2);
    fireEvent.click(view.getByRole('button', { name: 'Gerar com IA' }));
    fireEvent.click(
      within(await view.findByTestId('generate-dialog')).getByRole('button', { name: 'Fechar' }),
    );
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
  });
});

describe('IntegrationTestsView responses and reloads', () => {
  it('clears the response history of a request', async () => {
    const api = client();
    api.startIntegrationRun.mockResolvedValueOnce(
      run({ status: 'failed', error: 'refused', result: null }),
    );
    const { view } = await mount(api);
    fireEvent.click(view.getByTestId('run-request'));
    expect(await view.findByText('refused')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(await view.findByRole('menuitem', { name: /Limpar resposta/ }));
    await waitFor(() => expect(view.queryByText('refused')).toBeNull());
  });

  it('closes the tab of a request the server no longer has', async () => {
    const api = client();
    const { view } = await mount(api);
    expect(tabNames().some((name) => name?.includes('Login'))).toBe(true);
    api.getApiCollection.mockResolvedValue({ ...orders, items: [] });
    fireEvent.click(view.getByRole('button', { name: 'Gerar com IA' }));
    const dialog = await view.findByTestId('generate-dialog');
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'orders' } });
    fireEvent.click(within(dialog).getByTestId('generate-submit'));
    await waitFor(() => expect(tabNames().some((name) => name?.includes('Login'))).toBe(false));
  });
});
