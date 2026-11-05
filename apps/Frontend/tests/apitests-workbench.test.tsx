import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import type {
  ApiCollection,
  ApiRequestSpec,
  ApiRun,
  CollectionRunResult,
  RuntimeState,
} from '../src/features/apitests/api-test-types.js';
import type * as RequestPaneModule from '../src/features/apitests/integration/RequestPane.js';
import type { RequestActions } from '../src/features/apitests/integration/request-actions.js';
import type { ApiClient } from '../src/lib/api-client.js';

// The request pane is the other editors' work; here only what the workbench hands it matters.
const captured: { actions?: RequestActions; collection?: ApiCollection } = {};
vi.mock('../src/features/apitests/integration/RequestPane.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RequestPaneModule>();
  return {
    ...actual,
    RequestPane: (props: React.ComponentProps<typeof actual.RequestPane>) => {
      captured.actions = (props as { actions?: RequestActions }).actions;
      captured.collection = (props as { collection?: ApiCollection }).collection;
      return <div data-testid="request-pane-stub" />;
    },
  };
});

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [{ key: 'password', value: '', secret: true, hasValue: true }],
  auth: { type: 'none' },
  source: { kind: 'manual' },
  updatedAt: '',
  personalSecrets: ['var:password', 'auth:f1:token'],
  settings: { presets: { kind: 'graphql', baseUrl: '{{api}}' } },
  items: [
    {
      id: 'login',
      type: 'request',
      name: 'Login',
      method: 'POST',
      url: '{{baseUrl}}/login',
      headers: [],
      query: [],
      body: { mode: 'none' },
      auth: { type: 'inherit' },
      assertions: [],
      captures: [],
    },
    {
      id: 'f1',
      type: 'folder',
      name: 'Orders',
      auth: { type: 'bearer', token: '' },
      items: [
        {
          id: 'svc',
          type: 'request',
          kind: 'grpc',
          name: 'Get order',
          method: 'POST',
          url: 'grpc://localhost:50051',
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

const finished = (results: CollectionRunResult['results'], error: string | null = null) =>
  ({
    id: 'r1',
    kind: 'integration',
    collectionId: 'c1',
    scenarioId: null,
    environmentId: null,
    name: 'Orders API',
    target: 'remote',
    status: results?.length ? 'passed' : 'error',
    claimLabel: null,
    error,
    createdAt: '',
    startedAt: null,
    finishedAt: null,
    result: { durationMs: 1, total: 1, passed: 1, failed: 0, results },
  }) as ApiRun<CollectionRunResult>;

const loginResult = {
  requestId: 'login',
  name: 'Login',
  path: [],
  method: 'POST' as const,
  url: '/login',
  status: 200,
  durationMs: 5,
  sizeBytes: 2,
  passed: true,
  assertions: [],
  response: { headers: {}, bodyPreview: '{}' },
};

function client() {
  let runtime: RuntimeState = { variables: [{ key: 'token', value: 'abc' }], cookies: [] };
  return {
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
    listApiMockValues: vi.fn(() => Promise.resolve([])),
    getApiCollection: vi.fn(() => Promise.resolve(collection)),
    saveApiCollection: vi.fn((value: ApiCollection) => Promise.resolve(value)),
    startIntegrationRun: vi.fn(() => Promise.resolve(finished([loginResult]))),
    getApiRun: vi.fn(),
    clearPersonalSecret: vi.fn(() => Promise.resolve()),
    getApiRuntime: vi.fn(() => Promise.resolve(runtime)),
    setApiRuntime: vi.fn((_id: string, next: RuntimeState) => {
      runtime = next;
      return Promise.resolve(next);
    }),
    clearApiRuntime: vi.fn(() => Promise.resolve({ variables: [], cookies: [] })),
  };
}

const mount = (api = client(), isReadOnly = false) => ({
  api,
  view: render(
    <IntegrationTestsView apiClient={api as unknown as ApiClient} isReadOnly={isReadOnly} />,
  ),
});

describe('IntegrationTestsView workbench', () => {
  it('sends the request as edited, without saving, and refreshes the runtime state', async () => {
    const { api, view } = mount();
    await view.findByTestId('request-pane-stub');
    expect(captured.collection?.id).toBe('c1');
    fireEvent.change(view.getByLabelText('URL'), { target: { value: '{{baseUrl}}/auth' } });
    const runtimeLoads = api.getApiRuntime.mock.calls.length;
    fireEvent.click(view.getByTestId('run-request'));
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: 'c1',
          itemIds: ['login'],
          useRuntime: true,
          request: expect.objectContaining({ id: 'login', url: '{{baseUrl}}/auth' }) as unknown,
        }),
      ),
    );
    expect(api.saveApiCollection).not.toHaveBeenCalled();
    // Still unsaved: Ctrl+S saves it.
    expect((view.getByTestId('save-collection') as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(api.getApiRuntime.mock.calls.length).toBeGreaterThan(runtimeLoads));
  });

  it('gives the request editors ad hoc runs and gRPC service listing', async () => {
    const { api, view } = mount();
    await view.findByTestId('request-pane-stub');
    const actions = captured.actions!;
    const request = collection.items[0] as ApiRequestSpec;
    await expect(actions.runAdHoc(request)).resolves.toMatchObject({ status: 200 });
    expect(api.startIntegrationRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'run', request }),
    );

    api.startIntegrationRun.mockResolvedValueOnce(finished([], 'refused'));
    await expect(actions.runAdHoc(request)).rejects.toThrow('refused');
    api.startIntegrationRun.mockResolvedValueOnce(finished(undefined));
    await expect(actions.runAdHoc(request)).rejects.toThrow('Erro');

    const services = { services: [{ name: 'orders.Orders', methods: [] }] };
    api.startIntegrationRun.mockResolvedValueOnce(
      finished([
        { ...loginResult, response: { headers: {}, bodyPreview: JSON.stringify(services) } },
      ]),
    );
    await expect(actions.listGrpcServices(request)).resolves.toEqual(services);
    expect(api.startIntegrationRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'grpc-reflect' }),
    );
    api.startIntegrationRun.mockResolvedValueOnce(
      finished([{ ...loginResult, response: undefined }]),
    );
    await expect(actions.listGrpcServices(request)).resolves.toEqual({ services: [] });
    api.startIntegrationRun.mockResolvedValueOnce(
      finished([{ ...loginResult, error: 'no reflection' }]),
    );
    await expect(actions.listGrpcServices(request)).rejects.toThrow('no reflection');
  });

  it('creates requests of any kind from the New request dialog, with the presets', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('add-request'));
    const dialog = await view.findByTestId('new-request-dialog');
    // The collection presets choose GraphQL.
    expect(within(dialog).getByTestId('kind-graphql').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(dialog).getByTestId('kind-websocket'));
    fireEvent.change(within(dialog).getByTestId('new-request-name'), {
      target: { value: 'Live feed' },
    });
    fireEvent.change(within(dialog).getByLabelText('URL'), { target: { value: 'wss://feed ' } });
    fireEvent.click(within(dialog).getByTestId('new-request-submit'));
    const row = await view.findByTestId('tree-request-Live feed');
    expect(row.textContent).toContain('WS');
    expect((view.getByLabelText('URL') as HTMLInputElement).value).toBe('wss://feed');

    // From a folder, the default URL comes from the preset base URL.
    fireEvent.click(view.getByRole('button', { name: 'Ações de Orders' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Nova requisição' }));
    const second = await view.findByTestId('new-request-dialog');
    fireEvent.click(within(second).getByTestId('kind-http'));
    fireEvent.click(within(second).getByTestId('new-request-submit'));
    expect(await view.findAllByTestId('tree-request-Nova requisição')).toHaveLength(1);
    expect((view.getByLabelText('URL') as HTMLInputElement).value).toBe('{{api}}/');

    // An empty name cannot be submitted; cancel closes.
    fireEvent.click(view.getByTestId('add-request'));
    const third = await view.findByTestId('new-request-dialog');
    fireEvent.change(within(third).getByTestId('new-request-name'), { target: { value: ' ' } });
    expect(within(third).getByTestId<HTMLButtonElement>('new-request-submit').disabled).toBe(true);
    fireEvent.submit(third);
    fireEvent.click(within(third).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(view.queryByTestId('new-request-dialog')).toBeNull());
  });

  it('finds requests by protocol', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.change(view.getByLabelText('Buscar requisições', { exact: false }), {
      target: { value: 'grpc' },
    });
    expect(view.getByTestId('tree-request-Get order').textContent).toContain('gRPC');
    expect(view.queryByTestId('tree-request-Login')).toBeNull();
  });

  it('opens folder settings from the folder menu and closes them when the folder goes', async () => {
    const { view } = mount();
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Orders' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Configurações' }));
    const pane = await view.findByTestId('folder-settings');
    expect(view.getByRole('tab', { name: /Configurações · Orders/ })).toBeTruthy();
    // A folder edit leaves the collection unsaved, as the request editors show.
    fireEvent.click(within(pane).getByRole('button', { name: /Adicionar/ }));
    fireEvent.click(view.getByTestId('tree-request-Login'));
    expect((view.getByTestId('save-collection') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(
      within(view.getByRole('tab', { name: /Configurações · Orders/ })).getAllByRole('button')[0]!,
    );

    fireEvent.click(view.getByRole('button', { name: 'Ações de Orders' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Excluir' }));
    fireEvent.click(await view.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(view.queryByTestId('folder-settings')).toBeNull());
    expect(view.queryByRole('tab', { name: /Configurações · Orders/ })).toBeNull();
  });

  it('shows folder settings, read-only, to members who cannot edit', async () => {
    const { view } = mount(client(), true);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Orders' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Configurações' }));
    const pane = await view.findByTestId('folder-settings');
    expect(within(pane).queryByRole('button', { name: /Adicionar/ })).toBeNull();
  });

  it('clears a personal secret of a folder auth field', async () => {
    const api = client();
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Orders' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Configurações' }));
    const pane = await view.findByTestId('folder-settings');
    fireEvent.click(within(pane).getByRole('tab', { name: /Auth/ }));
    fireEvent.click(within(pane).getByTestId('clear-personal'));
    await waitFor(() =>
      expect(api.clearPersonalSecret).toHaveBeenCalledWith({
        scope: 'collection',
        scopeId: 'c1',
        ref: 'auth:f1:token',
      }),
    );
  });

  it('clears a personal secret of the collection and suggests runtime variables', async () => {
    const api = client();
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    // The runtime variables are suggested once they have arrived.
    await waitFor(() => expect(api.getApiRuntime).toHaveBeenCalledWith('c1'));
    const url = view.getByLabelText('URL') as HTMLInputElement;
    await waitFor(() => {
      url.focus();
      fireEvent.change(url, { target: { value: '{{tok', selectionStart: 5, selectionEnd: 5 } });
      expect(view.getByTestId('variable-suggestions')).toBeTruthy();
    });
    const suggestions = view.getByTestId('variable-suggestions');
    expect(within(suggestions).getByText('token')).toBeTruthy();
    expect(within(suggestions).getByText('runtime')).toBeTruthy();

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
    expect(await view.findByText('Seu valor pessoal foi limpo.')).toBeTruthy();
    expect(view.queryByTestId('personal-badge')).toBeNull();

    // A literal typed in a credential field says it will stay with this member only.
    fireEvent.click(view.getByRole('tab', { name: /Auth/ }));
    fireEvent.change(view.getByTestId('auth-type'), { target: { value: 'bearer' } });
    fireEvent.change(view.getByLabelText('Token'), { target: { value: 'ghp_literal' } });
    expect(view.getByRole('note').textContent).toContain('mantido pessoal');
    fireEvent.change(view.getByLabelText('Token'), { target: { value: '{{token}}' } });
    expect(view.queryByRole('note')).toBeNull();
  });

  it('reports a failed clear and a settings file that cannot be read', async () => {
    const api = client();
    api.clearPersonalSecret.mockRejectedValueOnce(new Error('vault offline'));
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-settings'));
    fireEvent.click(await view.findByRole('tab', { name: /Variáveis/ }));
    fireEvent.click(view.getByTestId('clear-personal'));
    expect(await view.findByText('vault offline')).toBeTruthy();
    fireEvent.click(view.getByRole('tab', { name: /TLS/ }));
    fireEvent.change(view.getByLabelText('Carregar arquivo', { selector: 'input' }), {
      target: { files: [{} as File] },
    });
    await waitFor(() => expect(view.getByRole('alert').textContent).not.toBe('vault offline'));
  });

  it('shows, edits and clears the runtime state of the current user', async () => {
    const api = client();
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByTestId('open-runtime'));
    const dialog = await view.findByTestId('runtime-dialog');
    await waitFor(() =>
      expect(within(dialog).getByLabelText<HTMLInputElement>('token').value).toBe('abc'),
    );
    fireEvent.change(within(dialog).getByLabelText('token'), { target: { value: 'new' } });
    fireEvent.click(within(dialog).getByTestId('runtime-save'));
    await waitFor(() =>
      expect(api.setApiRuntime).toHaveBeenCalledWith('c1', {
        variables: [{ key: 'token', value: 'new' }],
        cookies: [],
      }),
    );
    fireEvent.click(within(dialog).getByTestId('runtime-clear'));
    await waitFor(() => expect(api.clearApiRuntime).toHaveBeenCalledWith('c1'));
    await waitFor(() =>
      expect(within(dialog).getByText(/Nenhuma variável de runtime/)).toBeTruthy(),
    );

    api.setApiRuntime.mockRejectedValueOnce(new Error('save failed'));
    fireEvent.click(within(dialog).getByRole('button', { name: /Adicionar variável/ }));
    fireEvent.change(within(dialog).getByLabelText('Chave'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByTestId('runtime-save'));
    expect(await within(dialog).findByText('save failed')).toBeTruthy();
    api.clearApiRuntime.mockRejectedValueOnce('clear failed');
    api.getApiRuntime.mockResolvedValueOnce({ variables: [{ key: 'a', value: '1' }], cookies: [] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    fireEvent.click(view.getByTestId('open-runtime'));
    const again = await view.findByTestId('runtime-dialog');
    await waitFor(() => expect(within(again).getByLabelText('a')).toBeTruthy());
    fireEvent.click(within(again).getByTestId('runtime-clear'));
    expect(await within(again).findByText('clear failed')).toBeTruthy();
  });

  it('runs a single item from its menu and runs with a data file from the runner', async () => {
    const api = client();
    const { view } = mount(api);
    await view.findByTestId('request-pane-stub');
    fireEvent.click(view.getByRole('button', { name: 'Ações de Login' }));
    fireEvent.click(await view.findByRole('menuitem', { name: 'Executar' }));
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ itemIds: ['login'], iterations: 1, delayMs: 0 }),
      ),
    );
    fireEvent.click(await view.findByRole('button', { name: /Limpar/ }));
    fireEvent.change(await view.findByTestId('data-file-input'), {
      target: { files: [new File(['id\n1\n2'], 'ids.csv')] },
    });
    await view.findByTestId('data-preview');
    fireEvent.click(view.getByTestId('run-collection'));
    await waitFor(() =>
      expect(api.startIntegrationRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ iterations: 2, data: [{ id: '1' }, { id: '2' }] }),
      ),
    );
  });
});
