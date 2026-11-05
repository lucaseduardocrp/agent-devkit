import { useState } from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntegrationTestsView } from '../src/features/apitests/IntegrationTestsView.js';
import type {
  ApiCollection,
  CiConfig,
  CiPreview,
  CiPublication,
} from '../src/features/apitests/api-test-types.js';
import type { CiPipelineContext } from '../src/features/apitests/integration/CiPipelineSettings.js';
import { CollectionSettingsPane } from '../src/features/apitests/integration/CollectionSettingsPane.js';
import { ApiClient } from '../src/lib/api-client.js';

const github: CiConfig = {
  repository: {
    provider: 'github',
    id: '42',
    name: 'acme/app',
    branch: 'main',
    path: 'api/orders',
  },
  tool: 'bruno',
  environmentId: null,
};

const base: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  items: [],
  source: { kind: 'manual' },
  updatedAt: '',
};

const preview: CiPreview = {
  files: [
    { path: 'api/orders/bruno.json', content: '{}' },
    { path: '.github/workflows/api-tests-api-orders.yml', content: 'name: "API tests"' },
  ],
  pipelinePath: '.github/workflows/api-tests-api-orders.yml',
  secrets: [{ variable: 'password', name: 'PASSWORD' }],
};

const publication: CiPublication = {
  commitUrl: 'https://github.com/acme/app/commit/1',
  pipelinePath: '.github/workflows/api-tests-api-orders.yml',
  files: ['api/orders/bruno.json'],
  removed: ['api/orders/Old.bru'],
  secrets: [],
};

function client() {
  return {
    listApiTestRepositories: vi.fn(() =>
      Promise.resolve({
        repositories: [
          { id: '42', provider: 'github', name: 'acme/app', defaultBranch: 'main' },
          { id: 'g-1', provider: 'azure_devops', name: 'Fin/api', defaultBranch: 'develop' },
        ],
        warnings: [],
      }),
    ),
    listApiTestBranches: vi.fn((_provider: string, id: string) =>
      Promise.resolve([{ name: id === '42' ? 'main' : 'develop', isDefault: true }]),
    ),
    previewApiCollectionCi: vi.fn(() => Promise.resolve(preview)),
    publishApiCollectionCi: vi.fn(() => Promise.resolve(publication)),
  };
}

function Harness({
  initial,
  api = client(),
  onChange,
  onError,
  onSave = () => Promise.resolve(true),
  readOnly = false,
}: {
  initial: ApiCollection;
  api?: ReturnType<typeof client>;
  onChange?: (collection: ApiCollection) => void;
  onError?: (message: string) => void;
  onSave?: CiPipelineContext['onSave'];
  readOnly?: boolean;
}) {
  const [collection, setCollection] = useState(initial);
  return (
    <CollectionSettingsPane
      collection={collection}
      readOnly={readOnly}
      onChange={(next) => {
        setCollection(next);
        onChange?.(next);
      }}
      onExport={vi.fn()}
      onDelete={vi.fn()}
      onError={onError}
      pipeline={{
        apiClient: api as unknown as ApiClient,
        environments: [
          { id: 'e1', name: 'QA', variables: [], workspaceId: 'w1', updatedAt: '' },
        ] as never,
        onSave,
      }}
    />
  );
}

const openPipeline = (view: ReturnType<typeof render>) =>
  fireEvent.click(view.getByRole('tab', { name: /Pipeline/ }));

describe('Pipeline tab', () => {
  it('builds the CI settings from the repository, branch, folder, runner and environment', async () => {
    const api = client();
    const onChange = vi.fn();
    const view = render(<Harness initial={base} api={api} onChange={onChange} />);
    openPipeline(view);
    const pane = view.getByTestId('ci-pipeline');
    expect(
      within(pane).getByText('Escolha o repositório, a branch e a pasta primeiro.'),
    ).toBeTruthy();
    const repository = within(pane).getByLabelText<HTMLSelectElement>('Repositório');
    await waitFor(() => expect(repository.disabled).toBe(false));
    fireEvent.change(repository, { target: { value: 'github:42' } });
    await waitFor(() => expect(api.listApiTestBranches).toHaveBeenCalledWith('github', '42'));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ci: {
          repository: {
            provider: 'github',
            id: '42',
            name: 'acme/app',
            branch: 'main',
            path: 'api-tests/orders-api',
          },
          tool: 'bruno',
          environmentId: null,
        },
      }),
    );
    fireEvent.change(within(pane).getByLabelText('Executor'), { target: { value: 'insomnia' } });
    expect(within(pane).getByText(/O Inso não gera relatório JUnit/)).toBeTruthy();
    fireEvent.change(within(pane).getByLabelText('Ambiente'), { target: { value: 'e1' } });
    fireEvent.change(within(pane).getByLabelText('Pasta da coleção'), {
      target: { value: '\\tests\\api\\' },
    });
    expect(onChange.mock.lastCall?.[0].ci).toMatchObject({
      repository: { path: 'tests/api' },
      tool: 'insomnia',
      environmentId: 'e1',
    });

    // A relative folder is refused and leaves the collection without CI settings.
    fireEvent.change(within(pane).getByLabelText('Pasta da coleção'), {
      target: { value: 'tests/../secrets' },
    });
    expect(within(pane).getByRole('alert').textContent).toContain('sem segmentos');
    expect(onChange.mock.lastCall?.[0].ci).toBeUndefined();
    const calls = onChange.mock.calls.length;
    fireEvent.change(within(pane).getByLabelText('Pasta da coleção'), {
      target: { value: 'tests/./x' },
    });
    expect(onChange.mock.calls.length).toBe(calls);
  });

  it('previews the files after saving and shows the secrets to create', async () => {
    const api = client();
    const onSave = vi.fn(() => Promise.resolve(true));
    const view = render(<Harness initial={{ ...base, ci: github }} api={api} onSave={onSave} />);
    openPipeline(view);
    fireEvent.click(view.getByRole('button', { name: /Ver arquivos/ }));
    const files = await view.findByTestId('ci-preview');
    expect(onSave).toHaveBeenCalled();
    expect(api.previewApiCollectionCi).toHaveBeenCalledWith('c1');
    expect(within(files).getByText('api/orders/bruno.json')).toBeTruthy();
    expect(within(files).getByText('name: "API tests"')).toBeTruthy();
    expect(view.getByTestId('ci-secrets').textContent).toContain('PASSWORD ← password');
    expect(view.getByText(/Settings → Secrets and variables → Actions/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Ocultar arquivos/ }));
    expect(view.queryByTestId('ci-preview')).toBeNull();
  });

  it('commits after confirmation and reports the commit and removed files', async () => {
    const api = client();
    const view = render(<Harness initial={{ ...base, ci: github }} api={api} />);
    openPipeline(view);
    fireEvent.click(view.getByRole('button', { name: /Commitar no repositório/ }));
    expect(view.getByText(/acme\/app, branch main, na pasta api\/orders/)).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(api.publishApiCollectionCi).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: /Commitar no repositório/ }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', {
        name: 'Commitar no repositório',
      }),
    );
    const status = await view.findByTestId('ci-publication');
    expect(status.textContent).toContain('Commit feito em main.');
    expect(within(status).getByRole('link', { name: 'Abrir commit' }).getAttribute('href')).toBe(
      publication.commitUrl,
    );
    expect(status.textContent).toContain('api/orders/Old.bru');
    expect(view.getByText(/não precisa de secrets/)).toBeTruthy();
  });

  it('explains Azure DevOps pipelines and unchanged repositories', async () => {
    const api = client();
    api.publishApiCollectionCi.mockResolvedValue({
      ...publication,
      commitUrl: null,
      removed: [],
      pipelinePath: 'api/azure-pipelines.yml',
      secrets: [{ variable: 'token', name: 'TOKEN' }],
    });
    const azure: CiConfig = {
      repository: { provider: 'azure_devops', id: 'g-1', name: '', branch: 'develop', path: 'api' },
      tool: 'postman',
    };
    const onChange = vi.fn();
    const view = render(<Harness initial={{ ...base, ci: azure }} api={api} onChange={onChange} />);
    openPipeline(view);
    fireEvent.click(view.getByRole('button', { name: /Commitar no repositório/ }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', {
        name: 'Commitar no repositório',
      }),
    );
    const status = await view.findByTestId('ci-publication');
    expect(status.textContent).toContain('O repositório já tinha esses arquivos.');
    expect(within(status).queryByRole('link')).toBeNull();
    expect(view.getByText(/Existing Azure Pipelines YAML file/).textContent).toContain(
      'api/azure-pipelines.yml',
    );
    expect(view.getByText(/variáveis secretas do pipeline no Azure DevOps/)).toBeTruthy();

    // Settings saved without a repository name fall back to its id.
    fireEvent.change(view.getByLabelText('Executor'), { target: { value: 'bruno' } });
    expect(onChange.mock.lastCall?.[0].ci.repository.name).toBe('g-1');
  });

  it('stops when saving fails, reports API errors and removes the settings', async () => {
    const api = client();
    api.previewApiCollectionCi.mockRejectedValueOnce(new Error('no access'));
    const onError = vi.fn();
    const onChange = vi.fn();
    const onSave = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(true);
    const view = render(
      <Harness
        initial={{ ...base, ci: github }}
        api={api}
        onSave={onSave}
        onError={onError}
        onChange={onChange}
      />,
    );
    openPipeline(view);
    const previewButton = view.getByRole('button', { name: /Ver arquivos/ });
    fireEvent.click(previewButton);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(api.previewApiCollectionCi).not.toHaveBeenCalled();
    await waitFor(() => expect((previewButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(previewButton);
    await waitFor(() => expect(onError).toHaveBeenCalledWith('no access'));
    expect(view.queryByTestId('ci-preview')).toBeNull();

    await waitFor(() => expect((previewButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole('button', { name: 'Remover configuração do pipeline' }));
    expect(onChange.mock.lastCall?.[0].ci).toBeUndefined();
    expect(view.queryByRole('button', { name: 'Remover configuração do pipeline' })).toBeNull();
  });

  it('does not report a publication when saving before it fails', async () => {
    const api = client();
    const onSave = vi.fn().mockResolvedValue(false);
    const view = render(<Harness initial={{ ...base, ci: github }} api={api} onSave={onSave} />);
    openPipeline(view);
    fireEvent.click(view.getByRole('button', { name: /Commitar no repositório/ }));
    fireEvent.click(
      within(view.getByRole('alertdialog')).getByRole('button', {
        name: 'Commitar no repositório',
      }),
    );
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(api.publishApiCollectionCi).not.toHaveBeenCalled();
    expect(view.queryByTestId('ci-publication')).toBeNull();
  });

  it('lets members who cannot edit see the settings and preview only', async () => {
    const view = render(<Harness initial={{ ...base, ci: github }} readOnly />);
    openPipeline(view);
    expect(view.queryByRole('button', { name: /Commitar no repositório/ })).toBeNull();
    expect((view.getByLabelText('Executor') as HTMLSelectElement).disabled).toBe(true);
    expect((view.getByLabelText('Pasta da coleção') as HTMLInputElement).disabled).toBe(true);
    expect(view.getByRole('button', { name: /Ver arquivos/ })).toBeTruthy();
  });

  it('suggests a folder named after the collection', () => {
    const view = render(<Harness initial={{ ...base, name: 'Pedidos & Faturação' }} />);
    openPipeline(view);
    expect((view.getByLabelText('Pasta da coleção') as HTMLInputElement).value).toBe(
      'api-tests/pedidos-faturacao',
    );
    view.unmount();
    const unnamed = render(<Harness initial={{ ...base, name: '???' }} />);
    openPipeline(unnamed);
    expect((unnamed.getByLabelText('Pasta da coleção') as HTMLInputElement).value).toBe(
      'api-tests/collection',
    );
  });
});

describe('IntegrationTestsView pipeline', () => {
  it('saves pending edits before previewing the pipeline', async () => {
    const collection: ApiCollection = {
      ...base,
      ci: github,
      items: [
        {
          id: 'r1',
          type: 'request',
          name: 'Login',
          method: 'GET',
          url: '/login',
          headers: [],
          query: [],
          body: { mode: 'none' },
          auth: { type: 'inherit' },
          assertions: [],
          captures: [],
        },
      ],
    };
    const api = {
      ...client(),
      listApiCollections: vi.fn(() =>
        Promise.resolve([
          {
            id: 'c1',
            name: 'Orders API',
            description: '',
            source: { kind: 'manual' },
            requestCount: 1,
            updatedAt: '',
          },
        ]),
      ),
      listApiEnvironments: vi.fn(() => Promise.resolve([])),
      listApiMockValues: vi.fn(() => Promise.resolve([])),
      getApiCollection: vi.fn(() => Promise.resolve(collection)),
      saveApiCollection: vi.fn((value: ApiCollection) => Promise.resolve(value)),
      getApiRuntime: vi.fn(() => Promise.resolve({ variables: [], cookies: [] })),
    };
    const onOpenIntegrations = vi.fn();
    const view = render(
      <IntegrationTestsView
        apiClient={api as unknown as ApiClient}
        onOpenIntegrations={onOpenIntegrations}
      />,
    );
    fireEvent.click(await view.findByTestId('open-settings'));
    openPipeline(view);
    fireEvent.change(view.getByLabelText('Executor'), { target: { value: 'postman' } });
    fireEvent.click(view.getByRole('button', { name: /Ver arquivos/ }));
    await view.findByTestId('ci-preview');
    expect(api.saveApiCollection).toHaveBeenCalledWith(
      expect.objectContaining({ ci: { ...github, tool: 'postman' } }),
      'c1',
    );
  });
});

describe('ApiClient pipelines', () => {
  it('calls the integration test routes for repositories, previews and commits', async () => {
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith('/integration-tests/repositories')
        ? { repositories: [], warnings: [] }
        : url.includes('/branches?')
          ? { branches: [{ name: 'main', isDefault: true }] }
          : url.endsWith('/ci')
            ? preview
            : {};
      return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
    });
    const api = new ApiClient({ fetcher });
    expect(await api.listApiTestRepositories()).toEqual({ repositories: [], warnings: [] });
    expect(await api.listApiTestBranches('github', '42')).toEqual([
      { name: 'main', isDefault: true },
    ]);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      '/integration-tests/repositories/branches?provider=github&repositoryId=42',
    );
    expect(await api.previewApiCollectionCi('c 1')).toEqual(preview);
    await api.publishApiCollectionCi('c1');
    expect(String(fetcher.mock.calls[2]?.[0])).toContain('/integration-tests/collections/c%201/ci');
    expect((fetcher.mock.calls[3] as unknown as [string, RequestInit])[1].method).toBe('POST');
  });
});
