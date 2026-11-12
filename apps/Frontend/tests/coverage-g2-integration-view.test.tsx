import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import type {
  ApiCollection,
  ApiRun,
  CollectionRunResult,
} from '../src/features/apitests/api-test-types.js';
import type * as RequestPaneModule from '../src/features/apitests/integration/RequestPane.js';
import type { ApiClient } from '../src/lib/api-client.js';

vi.mock('../src/features/apitests/integration/RequestPane.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RequestPaneModule>();
  return { ...actual, RequestPane: () => <div data-testid="request-pane-stub" /> };
});

beforeAll(() => {
  class TestPointerEvent extends MouseEvent {}
  (window as unknown as { PointerEvent: unknown }).PointerEvent = TestPointerEvent;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem('adk.integrationTests.layout');
});

const req = (id: string, name: string) => ({
  id,
  type: 'request' as const,
  name,
  method: 'GET' as const,
  url: '/x',
  headers: [],
  query: [],
  body: { mode: 'none' as const },
  auth: { type: 'inherit' as const },
  assertions: [],
  captures: [],
});

const makeCollection = (id = 'c1', name = 'Orders API'): ApiCollection => ({
  id,
  workspaceId: 'w1',
  name,
  variables: [
    { key: 'password', value: '', secret: true, hasValue: true },
    { key: 'other', value: '', secret: true, hasValue: false },
  ],
  auth: { type: 'none' },
  source: { kind: 'manual' },
  updatedAt: '',
  personalSecrets: ['var:password', 'auth:f1:token'],
  items: [
    req('login', 'Login'),
    {
      id: 'f1',
      type: 'folder',
      name: 'Orders',
      auth: { type: 'bearer', token: '' },
      items: [req('list', 'List')],
    },
  ],
});

const summary = (id: string, name: string) => ({
  id,
  name,
  description: '',
  source: { kind: 'manual' },
  requestCount: 2,
  updatedAt: '',
});

const run = (status: ApiRun['status'], results: CollectionRunResult['results'] = []) =>
  ({
    id: 'r1',
    kind: 'integration',
    collectionId: 'c1',
    scenarioId: null,
    environmentId: null,
    name: 'x',
    target: 'remote',
    status,
    claimLabel: null,
    error: null,
    createdAt: '',
    startedAt: null,
    finishedAt: null,
    result: { durationMs: 1, total: 1, passed: 1, failed: 0, results },
  }) as ApiRun<CollectionRunResult>;

const loginResult = {
  requestId: 'login',
  name: 'Login',
  path: [],
  method: 'GET' as const,
  url: '/x',
  status: 200,
  durationMs: 1,
  sizeBytes: 1,
  passed: true,
  assertions: [],
  response: { headers: {}, bodyPreview: '{}' },
};

function client(overrides: Record<string, unknown> = {}) {
  const stored = new Map<string, ApiCollection>([['c1', makeCollection()]]);
  return {
    listApiCollections: vi.fn(() =>
      Promise.resolve([...stored.values()].map((item) => summary(item.id, item.name))),
    ),
    listApiEnvironments: vi.fn(() => Promise.resolve([] as unknown[])),
    listApiMockValues: vi.fn(() => Promise.resolve([])),
    getApiCollection: vi.fn((id: string) => Promise.resolve(stored.get(id) ?? makeCollection(id))),
    saveApiCollection: vi.fn((value: ApiCollection, id?: string) => {
      const saved = { ...makeCollection(id ?? 'c2', value.name), ...value, id: id ?? 'c2' };
      stored.set(saved.id, saved);
      return Promise.resolve(saved);
    }),
    deleteApiCollection: vi.fn((id: string) => {
      stored.delete(id);
      return Promise.resolve();
    }),
    importApiCollection: vi.fn(() =>
      Promise.resolve({ format: 'postman', collection: makeCollection('c3', 'Imported') }),
    ),
    exportApiCollection: vi.fn(() =>
      Promise.resolve({ fileName: 'a.json', blob: new Blob(['{}']) }),
    ),
    startIntegrationRun: vi.fn(() => Promise.resolve(run('passed', [loginResult]))),
    getApiRun: vi.fn(() => Promise.resolve(run('passed', [loginResult]))),
    cancelApiRun: vi.fn(() => Promise.resolve(run('cancelled'))),
    clearPersonalSecret: vi.fn(() => Promise.resolve()),
    getApiRuntime: vi.fn(() => Promise.resolve({ variables: [], cookies: [] })),
    setApiRuntime: vi.fn((_id: string, next: unknown) => Promise.resolve(next)),
    clearApiRuntime: vi.fn(() => Promise.resolve({ variables: [], cookies: [] })),
    generateApiTests: vi.fn(() => Promise.resolve({ collection: { id: 'c1' } })),
    getAllSavedTestPlans: vi.fn(() => Promise.resolve([{ id: 'p', title: 'Plan' }])),
    ...overrides,
  };
}

const mount = (api = client(), isReadOnly = false) => ({
  api,
  view: render(
    <IntegrationTestsView apiClient={api as unknown as ApiClient} isReadOnly={isReadOnly} />,
  ),
});

type View = ReturnType<typeof mount>['view'];

const menu = async (view: View, label: string, item: string | RegExp) => {
  fireEvent.click(view.getByRole('button', { name: label }));
  fireEvent.click(await view.findByRole('menuitem', { name: item }));
};

const name = async (view: View, value: string) => {
  const input = (await view.findByTestId('name-dialog-input')) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  fireEvent.click(view.getByTestId('name-dialog-submit'));
};

const confirmDelete = async (view: View) =>
  fireEvent.click(
    within(await view.findByRole('alertdialog')).getByRole('button', { name: 'Excluir' }),
  );

describe('IntegrationTestsView: split panes', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 };

  it('resizes by dragging, with the keyboard and with a double click', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
    const bar = view.getByLabelText('Redimensionar requisição e resposta');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    // Only the primary button starts a drag.
    fireEvent.pointerDown(bar, { button: 2 });
    expect(document.body.style.cursor).toBe('');
    fireEvent.pointerDown(bar, { button: 0 });
    expect(document.body.style.cursor).toBe('col-resize');
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    fireEvent.pointerMove(window, { clientX: 5000 });
    expect(bar.getAttribute('aria-valuenow')).toBe('80');
    fireEvent.pointerMove(window, { clientX: -50 });
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
    fireEvent.pointerUp(window);
    expect(document.body.style.cursor).toBe('');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    fireEvent.keyDown(bar, { key: 'ArrowUp' });
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
    fireEvent.keyDown(bar, { key: 'a' });
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
    fireEvent.doubleClick(bar);
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
  });

  it('stacks the panes after the layout is toggled and drags vertically', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
    fireEvent.click(view.getByTestId('toggle-layout'));
    const bar = view.getByLabelText('Redimensionar requisição e resposta');
    expect(bar.getAttribute('aria-orientation')).toBe('horizontal');
    expect(window.localStorage.getItem('adk.integrationTests.layout')).toBe('vertical');
    fireEvent.pointerDown(bar, { button: 0 });
    expect(document.body.style.cursor).toBe('row-resize');
    fireEvent.pointerMove(window, { clientY: 100 });
    expect(bar.getAttribute('aria-valuenow')).toBe('20');
    fireEvent.pointerUp(window);
    fireEvent.click(view.getByTestId('toggle-layout'));
    expect(
      view.getByLabelText('Redimensionar requisição e resposta').getAttribute('aria-orientation'),
    ).toBe('vertical');
    fireEvent.pointerDown(view.getByLabelText('Redimensionar requisição e resposta'), {
      button: 0,
    });
    fireEvent.pointerCancel(window);
    expect(document.body.style.cursor).toBe('');
  });
});

describe('IntegrationTestsView: sending', () => {
  it('cancels a send that is still running and reports a failed cancel', async () => {
    const api = client({
      startIntegrationRun: vi.fn(() => Promise.resolve(run('running'))),
      getApiRun: vi.fn(() => Promise.resolve(run('passed', [loginResult]))),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('run-request'));
    const cancel = await view.findByTestId('cancel-request');
    api.cancelApiRun.mockRejectedValueOnce(new Error('sem cancelar'));
    fireEvent.click(cancel);
    expect((await view.findByRole('alert')).textContent).toContain('sem cancelar');
    const inPane = view.queryAllByRole('button', { name: /Cancelar/ });
    expect(inPane.length).toBeGreaterThan(0);
    fireEvent.click(inPane[inPane.length - 1]!);
    await waitFor(() => expect(api.cancelApiRun.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(within(view.getByRole('alert')).getByRole('button'));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    await waitFor(() => expect(view.queryByTestId('cancel-request')).toBeNull(), {
      timeout: 4000,
    });
  });

  it('reports a failed send and sends with Ctrl+Enter', async () => {
    const api = client({
      startIntegrationRun: vi.fn().mockRejectedValueOnce(new Error('sem runner')),
    });
    api.startIntegrationRun.mockResolvedValue(run('passed', [loginResult]));
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('run-request'));
    expect((await view.findByRole('alert')).textContent).toContain('sem runner');
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.startIntegrationRun).toHaveBeenCalledTimes(2));
  });

  it('clears the response history', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('run-request'));
    await view.findByTestId('response-status');
    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Limpar resposta' }));
    await waitFor(() => expect(view.queryByTestId('response-status')).toBeNull());
  });

  it('does not send in read only mode', async () => {
    const { view, api } = mount(client(), true);
    await view.findByTestId('request-pane-stub');
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    await Promise.resolve();
    expect(api.startIntegrationRun).not.toHaveBeenCalled();
  });

  it('tolerates a failing poll while the send is running', async () => {
    const api = client({
      startIntegrationRun: vi.fn(() => Promise.resolve(run('running'))),
      getApiRun: vi
        .fn()
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValue(run('passed', [loginResult])),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('run-request'));
    await waitFor(() => expect(api.getApiRun).toHaveBeenCalledTimes(2), { timeout: 5000 });
  });
});

describe('IntegrationTestsView: tabs and shortcuts', () => {
  it('closes tabs with the close button and the middle click, then shows the empty pane', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(view.getByTestId('open-environments'));
    const tabs = () => view.getAllByRole('tab');
    expect(tabs()).toHaveLength(4);
    fireEvent(tabs()[3]!, new MouseEvent('auxclick', { bubbles: true, button: 0 }));
    expect(tabs()).toHaveLength(4);
    fireEvent(tabs()[3]!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(tabs()).toHaveLength(3);
    fireEvent.click(within(tabs()[0]!).getByRole('button', { name: 'Fechar aba' }));
    expect(tabs()).toHaveLength(2);
    for (const _ of [0, 1])
      fireEvent.click(within(tabs()[0]!).getByRole('button', { name: 'Fechar aba' }));
    expect(view.queryAllByRole('tab')).toHaveLength(0);
    expect(view.getByText('Integration Tests', { selector: 'h2' })).toBeTruthy();
  });

  it('saves with Ctrl+S only when something changed and ignores other keys', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveApiCollection).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 's' });
    fireEvent.change(view.getByLabelText('URL'), { target: { value: '/new' } });
    fireEvent.keyDown(window, { key: 'x', ctrlKey: true });
    expect(api.saveApiCollection).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(() => expect(api.saveApiCollection).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByTestId('open-environments'));
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(api.saveApiCollection).toHaveBeenCalledTimes(1);
  });

  it('reports a failed save', async () => {
    const api = client();
    api.saveApiCollection.mockRejectedValueOnce(new Error('sem salvar'));
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.change(view.getByLabelText('URL'), { target: { value: '/new' } });
    fireEvent.click(view.getByTestId('save-collection'));
    expect((await view.findByRole('alert')).textContent).toContain('sem salvar');
  });

  it('marks a settings tab as changed', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.change(await view.findByTestId('collection-name'), { target: { value: 'Renamed' } });
    expect(view.getAllByLabelText('Alterações não salvas').length).toBeGreaterThan(0);
  });
});

describe('IntegrationTestsView: collections', () => {
  it('creates a collection from the sidebar and opens its first request', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('new-collection'));
    await name(view, 'Fresh API');
    await waitFor(() =>
      expect(api.saveApiCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Fresh API' }),
      ),
    );
    await waitFor(() => expect(api.getApiCollection).toHaveBeenCalledWith('c2'));
  });

  it('reports a collection that could not be created', async () => {
    const api = client();
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    api.saveApiCollection.mockRejectedValueOnce(new Error('cota'));
    fireEvent.click(view.getByTestId('new-collection'));
    await name(view, 'Nope');
    expect((await view.findByRole('alert')).textContent).toContain('cota');
  });

  it('offers to create and import when there are no collections', async () => {
    const api = client({ listApiCollections: vi.fn(() => Promise.resolve([])) });
    const { view } = mount(api);
    const create = await view.findAllByRole('button', { name: /Criar coleção|Nova coleção/ });
    fireEvent.click(create[create.length - 1]!);
    expect(await view.findByTestId('name-dialog')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const imports = view.getAllByRole('button', { name: /Importar/ });
    for (const button of imports) fireEvent.click(button);
    expect(click.mock.calls.length).toBeGreaterThanOrEqual(imports.length);
    expect(view.queryByTestId('rename-collection')).toBeNull();
    expect(view.queryByTestId('open-runtime')).toBeNull();
    expect(view.queryByTestId('add-request')).toBeNull();
  });

  it('hides creation from read only members of an empty workspace', async () => {
    const api = client({ listApiCollections: vi.fn(() => Promise.resolve([])) });
    const { view } = mount(api, true);
    await view.findByText('Integration Tests', { selector: 'h2' });
    expect(view.queryByRole('button', { name: 'Criar coleção' })).toBeNull();
  });

  it('imports a file, shows the notice and dismisses it', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    const input = view.getByTestId('import-input') as HTMLInputElement;
    const file = (content: string) => {
      const f = new File([content], 'a.json');
      Object.defineProperty(f, 'text', { value: () => Promise.resolve(content) });
      return f;
    };
    fireEvent.change(input, { target: { files: [file('{}')] } });
    await waitFor(() => expect(api.importApiCollection).toHaveBeenCalled());
    const status = await view.findByRole('status');
    expect(status.textContent).toContain('Imported');
    fireEvent.click(within(status).getByRole('button'));
    expect(view.queryByRole('status')).toBeNull();
    fireEvent.change(input, { target: { files: [] } });
    api.importApiCollection.mockRejectedValueOnce(new Error('formato ruim'));
    fireEvent.change(input, { target: { files: [file('x')] } });
    expect((await view.findByRole('alert')).textContent).toContain('formato ruim');
  });

  it('exports from the settings, saving pending edits first, and reports failures', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.change(view.getByLabelText('URL'), { target: { value: '/changed' } });
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(await view.findByRole('button', { name: 'Postman v2.1' }));
    await waitFor(() => expect(api.exportApiCollection).toHaveBeenCalledWith('c1', 'postman', []));
    expect(api.saveApiCollection).toHaveBeenCalled();
    api.exportApiCollection.mockRejectedValueOnce(new Error('sem export'));
    fireEvent.click(view.getByRole('button', { name: 'Bruno (.zip)' }));
    expect((await view.findByRole('alert')).textContent).toContain('sem export');
  });

  it('exports with the chosen environment', async () => {
    const api = client({
      listApiEnvironments: vi.fn(() =>
        Promise.resolve([{ id: 'e1', name: 'Staging', variables: [] }]),
      ),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('environment-select'));
    fireEvent.click(view.getByRole('option', { name: 'Staging' }));
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(await view.findByRole('button', { name: 'ADK (.json)' }));
    await waitFor(() => expect(api.exportApiCollection).toHaveBeenCalledWith('c1', 'adk', ['e1']));
  });

  it('deletes the collection from its settings', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(await view.findByRole('button', { name: 'Excluir coleção' }));
    const dialog = await view.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Orders API');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(view.queryByRole('alertdialog')).toBeNull());
    fireEvent.click(view.getByRole('button', { name: 'Excluir coleção' }));
    await confirmDelete(view);
    await waitFor(() => expect(api.deleteApiCollection).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(view.queryAllByRole('tab')).toHaveLength(0));
  });

  it('reports a collection that cannot be deleted from the sidebar', async () => {
    const api = client();
    api.deleteApiCollection.mockRejectedValueOnce(new Error('em uso'));
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Orders API', 'Excluir coleção');
    await confirmDelete(view);
    expect((await view.findByRole('alert')).textContent).toContain('em uso');
  });

  it('renames the collection from the header and reports a failure', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('rename-collection'));
    await name(view, 'Renamed API');
    await waitFor(() =>
      expect(api.saveApiCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Renamed API' }),
        'c1',
      ),
    );
    api.getApiCollection.mockRejectedValueOnce(new Error('sem coleção'));
    await menu(view, 'Ações de Renamed API', /Renomear/);
    await name(view, 'Again');
    expect((await view.findByRole('alert')).textContent).toContain('sem coleção');
  });

  it('renames before the collection is loaded, from the sidebar summary', async () => {
    const api = client({
      listApiCollections: vi.fn(() =>
        Promise.resolve([summary('c1', 'Orders API'), summary('c9', 'Lazy API')]),
      ),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Lazy API', /Renomear/);
    const input = (await view.findByTestId('name-dialog-input')) as HTMLInputElement;
    expect(input.value).toBe('Lazy API');
  });
});

describe('IntegrationTestsView: the tree', () => {
  it('creates a folder in the collection and inside another folder', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Orders API', 'Nova pasta');
    await name(view, 'Top folder');
    await view.findByText('Top folder');
    await menu(view, 'Ações de Orders', 'Nova pasta');
    await name(view, 'Inner');
    await view.findByText('Inner');
  });

  it('renames, clones and deletes requests and folders', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Login', 'Renomear');
    await name(view, 'Sign in');
    await view.findByTestId('tree-request-Sign in');
    await menu(view, 'Ações de Orders', 'Renomear');
    await name(view, 'Orders v2');
    await view.findByText('Orders v2');
    await menu(view, 'Ações de Sign in', 'Clonar');
    await name(view, 'Sign in copy');
    await view.findByTestId('tree-request-Sign in copy');
    await menu(view, 'Ações de Orders v2', 'Clonar');
    await name(view, 'Orders v3');
    await view.findByText('Orders v3');
    await menu(view, 'Ações de Sign in copy', 'Excluir');
    await confirmDelete(view);
    await waitFor(() => expect(view.queryByTestId('tree-request-Sign in copy')).toBeNull());
    await menu(view, 'Ações de Orders v2', 'Excluir');
    await confirmDelete(view);
    await waitFor(() => expect(view.queryByText('Orders v2')).toBeNull());
  });

  it('opens the runner from the collection menu and runs a request', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Orders API', /Executar|Runner/);
    expect(await view.findByTestId('collection-runner')).toBeTruthy();
    await menu(view, 'Ações de Login', /Executar/);
    await waitFor(() => expect(api.startIntegrationRun).toHaveBeenCalled());
  });

  it('opens the collection settings from the menu', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Orders API', 'Configurações');
    expect(await view.findByTestId('collection-settings')).toBeTruthy();
  });

  it('clears personal secrets and closes a folder tab whose folder was deleted', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Orders', 'Configurações');
    await view.findByTestId('folder-settings');
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(await view.findByRole('tab', { name: /Variáveis/ }));
    fireEvent.click(view.getByTestId('clear-personal'));
    await waitFor(() =>
      expect(api.clearPersonalSecret).toHaveBeenCalledWith({
        scope: 'collection',
        scopeId: 'c1',
        ref: 'var:password',
      }),
    );
    expect((await view.findByRole('status')).textContent).toBeTruthy();
    await menu(view, 'Ações de Orders', 'Excluir');
    await confirmDelete(view);
    await waitFor(() =>
      expect(view.queryByText('Configurações · Orders', { exact: true })).toBeNull(),
    );
  });

  it('reports a collection that cannot be opened from the sidebar', async () => {
    const api = client({
      listApiCollections: vi.fn(() =>
        Promise.resolve([summary('c1', 'Orders API'), summary('c9', 'Broken API')]),
      ),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    api.getApiCollection.mockRejectedValueOnce(new Error('quebrada'));
    fireEvent.click(view.getByTestId('collection-Broken API'));
    expect((await view.findByRole('alert')).textContent).toContain('quebrada');
    const calls = api.getApiCollection.mock.calls.length;
    fireEvent.click(view.getByTestId('collection-Orders API'));
    expect(api.getApiCollection.mock.calls.length).toBe(calls);
  });
});

describe('IntegrationTestsView: edge cases', () => {
  it('clears the personal value of a folder secret and opens a request from the runner', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Orders', 'Configurações');
    const pane = await view.findByTestId('folder-settings');
    fireEvent.click(within(pane).getByRole('tab', { name: /Auth/ }));
    fireEvent.click(await within(pane).findByTestId('clear-personal'));
    await waitFor(() =>
      expect(api.clearPersonalSecret).toHaveBeenCalledWith(
        expect.objectContaining({ ref: 'auth:f1:token' }),
      ),
    );
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    const results = await view.findByTestId('run-results');
    fireEvent.click(within(results).getByRole('button', { name: 'Abrir requisição' }));
    await waitFor(() => expect(view.getByTestId('request-pane-stub')).toBeTruthy());
  });

  it('records an empty or failed result of a send and of a run', async () => {
    const api = client({
      startIntegrationRun: vi
        .fn()
        .mockResolvedValueOnce({ ...run('error'), result: null, error: 'boom' })
        .mockResolvedValueOnce({ ...run('error'), result: null })
        .mockResolvedValue({ ...run('passed'), result: null }),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('run-request'));
    await view.findByText('boom');
    fireEvent.click(view.getByTestId('run-request'));
    await waitFor(() => expect(api.startIntegrationRun).toHaveBeenCalledTimes(2));
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    await waitFor(() => expect(api.startIntegrationRun).toHaveBeenCalledTimes(3));
  });

  it('creates requests in a collection without presets', async () => {
    const api = client();
    api.getApiCollection.mockResolvedValue({ ...makeCollection(), settings: undefined });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('add-request'));
    const dialog = await view.findByTestId('new-request-dialog');
    fireEvent.click(within(dialog).getByTestId('new-request-submit'));
    await waitFor(() => expect(view.queryByTestId('new-request-dialog')).toBeNull());
    expect((view.getByLabelText('URL') as HTMLInputElement).value).toBe('{{baseUrl}}/');
  });

  it('works with a first collection that cannot be read and with lazy collections', async () => {
    const api = client({
      listApiCollections: vi.fn(() =>
        Promise.resolve([summary('c1', 'Orders API'), summary('c9', 'Lazy API')]),
      ),
    });
    api.getApiCollection.mockRejectedValue(new Error('indisponível'));
    const { view } = mount(api);
    expect((await view.findByRole('alert')).textContent).toContain('indisponível');
    expect(view.queryByTestId('rename-collection')).toBeNull();
    // Running from the menu of a collection that cannot be loaded does nothing.
    await menu(view, 'Ações de Lazy API', /Executar/);
    await menu(view, 'Ações de Lazy API', 'Excluir coleção');
    expect((await view.findByRole('alertdialog')).textContent).toContain('Lazy API');
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(api.startIntegrationRun).not.toHaveBeenCalled();
    await menu(view, 'Ações de Lazy API', /Renomear/);
    await name(view, 'Lazy 2');
    await waitFor(() => expect(api.saveApiCollection).not.toHaveBeenCalled());
  });
});

describe('IntegrationTestsView: collections that are not open', () => {
  const lazy = () =>
    client({
      listApiCollections: vi.fn(() =>
        Promise.resolve([summary('c1', 'Orders API'), summary('c9', 'Lazy API')]),
      ),
    });

  it('adds a folder to a collection that was not opened and renames it', async () => {
    const { view, api } = mount(lazy());
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Lazy API', 'Nova pasta');
    await name(view, 'Early folder');
    await menu(view, 'Ações de Lazy API', /Renomear/);
    await name(view, 'Lazy 2');
    await waitFor(() =>
      expect(api.saveApiCollection).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Lazy 2' }),
        'c9',
      ),
    );
  });

  it('deletes a collection that was not opened, naming it from the list', async () => {
    const { view, api } = mount(lazy());
    await view.findByTestId('request-pane-stub');
    await menu(view, 'Ações de Lazy API', 'Excluir coleção');
    expect((await view.findByRole('alertdialog')).textContent).toContain('Lazy API');
    await confirmDelete(view);
    await waitFor(() => expect(api.deleteApiCollection).toHaveBeenCalledWith('c9'));
  });
});

describe('IntegrationTestsView: runner, runtime and generation', () => {
  it('cancels the run of the runner and reports a failed cancel', async () => {
    const api = client({
      startIntegrationRun: vi.fn(() => Promise.resolve(run('running'))),
      getApiRun: vi.fn(() => new Promise(() => {})),
    });
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    await waitFor(() => expect(api.startIntegrationRun).toHaveBeenCalled());
    const cancel = await view.findByRole('button', { name: /Cancelar/ });
    api.cancelApiRun.mockRejectedValueOnce(new Error('não deu'));
    fireEvent.click(cancel);
    expect((await view.findByRole('alert')).textContent).toContain('não deu');
    fireEvent.click(await view.findByRole('button', { name: /Cancelar/ }));
    await waitFor(() => expect(api.cancelApiRun).toHaveBeenCalledTimes(2));
  });

  it('records the results of a finished run and opens a request from them', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    const results = await view.findByTestId('run-results');
    fireEvent.click(within(results).getByText('Login'));
    fireEvent.click(await view.findByTestId('run-again'));
    await waitFor(() => expect(view.getByTestId('run-results')).toBeTruthy());
  });

  it('does not run when saving first fails and reports a failed start', async () => {
    const api = client();
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.change(view.getByLabelText('URL'), { target: { value: '/dirty' } });
    api.saveApiCollection.mockRejectedValueOnce(new Error('sem salvar'));
    fireEvent.click(view.getByTestId('open-runner'));
    fireEvent.click(await view.findByTestId('run-collection'));
    expect((await view.findByRole('alert')).textContent).toContain('sem salvar');
    expect(api.startIntegrationRun).not.toHaveBeenCalled();
    api.startIntegrationRun.mockRejectedValueOnce(new Error('runner caiu'));
    fireEvent.click(view.getByTestId('run-collection'));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('runner caiu'));
  });

  it('refreshes the list after generating, with or without a collection, and closes the dialog', async () => {
    const { view, api } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByRole('button', { name: 'Gerar com IA' }));
    const dialog = await view.findByTestId('generate-dialog');
    fireEvent.click(await within(dialog).findByLabelText('Plan'));
    fireEvent.click(within(dialog).getByTestId('generate-submit'));
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
    expect(api.listApiCollections.mock.calls.length).toBeGreaterThan(1);
    api.generateApiTests.mockResolvedValueOnce({} as never);
    fireEvent.click(view.getByRole('button', { name: 'Gerar com IA' }));
    const again = await view.findByTestId('generate-dialog');
    fireEvent.click(within(again).getByTestId('generate-submit'));
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
    fireEvent.click(view.getByRole('button', { name: 'Gerar com IA' }));
    const third = await view.findByTestId('generate-dialog');
    fireEvent.click(within(third).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(view.queryByTestId('generate-dialog')).toBeNull());
  });

  it('shows the lists failure and switches the target', async () => {
    const api = client({ listApiCollections: vi.fn(() => Promise.reject('offline')) });
    const { view } = mount(api);
    expect((await view.findByRole('alert')).textContent).toContain('offline');
    fireEvent.click(view.getByTestId('run-target'));
    fireEvent.click(view.getByRole('option', { name: /Meu computador/ }));
    expect(
      view.getByTestId('integration-tests-view').querySelector('.ti-device-laptop'),
    ).not.toBeNull();
    await act(async () => {});
  });
});
