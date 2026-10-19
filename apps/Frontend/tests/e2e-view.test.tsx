import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2eView } from '../src/features/e2e/E2eView.js';
import type { ApiClient } from '../src/lib/api-client.js';
import type {
  E2eCreationSummary,
  E2eTestDetail,
  E2eTestSummary,
} from '../src/features/e2e/e2e-types.js';

function testSummary(overrides: Partial<E2eTestSummary> = {}): E2eTestSummary {
  return {
    id: 't1',
    creationId: 'c1',
    position: 1,
    code: 'TC001',
    title: 'Access public event page',
    description: 'Verify the public page.',
    steps: ['Open the page'],
    priority: 'high',
    scriptPath: 'tests/e2e/tc001-access.spec.ts',
    status: 'passed',
    error: null,
    analysis: null,
    verdict: null,
    durationMs: 1200,
    attempts: 1,
    hasVideo: true,
    externalCase: null,
    stepResults: [],
    createdAt: '2026-01-30T09:23:00Z',
    updatedAt: '2026-01-30T09:24:00Z',
    lastRunAt: '2026-01-30T09:24:00Z',
    ...overrides,
  };
}

function creation(overrides: Partial<E2eCreationSummary> = {}): E2eCreationSummary {
  return {
    id: 'c1',
    agentId: 'a1',
    name: 'ama',
    mode: 'frontend',
    scope: 'codebase',
    baseUrl: 'http://localhost:3000',
    path: '/e/123',
    username: null,
    hasPassword: false,
    reporting: null,
    lastReport: null,
    prdFileNames: [],
    repository: {
      provider: 'github',
      id: '42',
      name: 'acme/demo-app',
      branch: 'main',
      path: 'tests/e2e',
    },
    status: 'completed',
    error: null,
    createdAt: '2026-01-30T09:23:00Z',
    updatedAt: '2026-01-30T09:36:00Z',
    finishedAt: '2026-01-30T09:36:00Z',
    passed: 1,
    total: 2,
    tests: [
      testSummary(),
      testSummary({ id: 't2', code: 'TC002', title: 'Vote once', status: 'failed' }),
    ],
    ...overrides,
  };
}

function api(list: readonly E2eCreationSummary[] | Error = [creation()]) {
  return {
    getE2eCreations: vi.fn(() =>
      list instanceof Error ? Promise.reject(list) : Promise.resolve(list),
    ),
    rerunE2eCreation: vi.fn().mockResolvedValue(undefined),
    cancelE2eCreation: vi.fn().mockResolvedValue(undefined),
    deleteE2eCreation: vi.fn().mockResolvedValue(undefined),
    getAgents: vi.fn().mockResolvedValue([]),
    createE2eCreation: vi.fn(),
    getE2eCreation: vi.fn().mockResolvedValue({
      ...creation(),
      prd: 'PRD',
      diff: null,
      instructions: null,
    }),
    updateE2eCreation: vi.fn().mockResolvedValue(creation({ name: 'ama v2' })),
    getE2eTest: vi.fn().mockResolvedValue({
      ...testSummary(),
      logs: null,
      creation: {
        id: 'c1',
        name: 'ama',
        mode: 'frontend',
        baseUrl: 'http://localhost:3000',
        path: '/',
        status: 'completed',
      },
    } satisfies E2eTestDetail),
    getE2eTestVideo: vi.fn().mockResolvedValue(new Blob(['v'])),
    getE2eTestVideoUrl: vi.fn().mockResolvedValue(null),
    rerunE2eTest: vi.fn(),
    getE2eRepositories: vi.fn().mockResolvedValue({
      repositories: [
        { id: '42', provider: 'github', name: 'acme/demo-app', defaultBranch: 'main' },
      ],
      warnings: [],
    }),
    getE2eBranches: vi.fn().mockResolvedValue([{ name: 'main', isDefault: true }]),
    pullE2eCreation: vi.fn().mockResolvedValue({ linked: 2, imported: 1, missing: 0 }),
  };
}

const asClient = (value: ReturnType<typeof api>) => value as unknown as ApiClient;

afterEach(() => vi.useRealTimers());

describe('E2eView', () => {
  it('marks runs that execute on the user computer and explains what they wait for', async () => {
    const client = api([
      creation({ executionTarget: 'local', status: 'running', passed: 0, tests: [] }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    expect(await view.findByText('No meu computador')).toBeInTheDocument();
    expect(view.getByText(/Aguardando o seu computador/)).toBeInTheDocument();
  });

  it('lists runs with pass counts and expands the newest one', async () => {
    const client = api([
      creation(),
      creation({
        id: 'c2',
        name: 'checkout',
        status: 'completed',
        passed: 2,
        total: 2,
        tests: [testSummary({ id: 't9', creationId: 'c2' })],
        updatedAt: '2026-01-29T09:00:00Z',
      }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('ama');
    expect(view.getByText('1/2 Pass')).toBeInTheDocument();
    expect(view.getByText('2/2 Pass')).toBeInTheDocument();
    const tests = view.getByRole('table', { name: 'ama' });
    expect(within(tests).getByText('TC001-Access public event page')).toBeInTheDocument();
    expect(within(tests).getAllByText('Frontend')).toHaveLength(2);
    expect(within(tests).getByText('Failed')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Expandir ou recolher ama' }));
    expect(view.queryByRole('table', { name: 'ama' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Expandir ou recolher checkout' }));
    expect(view.getByRole('table', { name: 'checkout' })).toBeInTheDocument();
  });

  it('searches, filters and sorts runs', async () => {
    const client = api([
      creation(),
      creation({
        id: 'c2',
        name: 'alpha',
        passed: 2,
        total: 2,
        tests: [],
        createdAt: '2026-02-01T00:00:00Z',
      }),
      creation({ id: 'c3', name: 'zeta', status: 'running', passed: 0, total: 0, tests: [] }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('alpha');
    const names = () =>
      Array.from(
        view.container.querySelectorAll('tbody > tr > td:nth-child(2) > span:first-child'),
      ).map((node) => node.textContent);

    fireEvent.change(view.getByLabelText('Ordenar'), { target: { value: 'name' } });
    expect(names()).toEqual(['alpha', 'ama', 'zeta']);
    fireEvent.change(view.getByLabelText('Ordenar'), { target: { value: 'createdAt' } });
    expect(names()[0]).toBe('alpha');

    fireEvent.change(view.getByLabelText('Filtrar por status'), { target: { value: 'passed' } });
    expect(names()).toEqual(['alpha']);
    fireEvent.change(view.getByLabelText('Filtrar por status'), { target: { value: 'failed' } });
    expect(names()).toEqual(['ama']);
    fireEvent.change(view.getByLabelText('Filtrar por status'), { target: { value: 'active' } });
    expect(names()).toEqual(['zeta']);
    fireEvent.change(view.getByLabelText('Filtrar por status'), { target: { value: 'all' } });

    fireEvent.change(view.getByLabelText('Buscar'), { target: { value: 'vote once' } });
    expect(names()).toEqual(['ama']);
    fireEvent.change(view.getByLabelText('Buscar'), { target: { value: 'nothing' } });
    expect(view.getByText('Nenhuma execução corresponde aos filtros.')).toBeInTheDocument();
  });

  it('shows planning progress and polls while a run is active', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = api([creation({ status: 'planning', passed: 0, total: 0, tests: [] })]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('Planejando');
    expect(
      view.getByText('A IA está explorando a aplicação e escrevendo o plano de testes…'),
    ).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(3100));
    expect(client.getE2eCreations.mock.calls.length).toBeGreaterThanOrEqual(2);
    view.unmount();
  });

  it('shows running progress with partial counts and failed planning errors', async () => {
    const client = api([
      creation({
        status: 'running',
        passed: 1,
        total: 2,
        tests: [testSummary(), testSummary({ id: 't2', status: 'running' })],
      }),
      creation({
        id: 'c2',
        name: 'broken',
        status: 'failed',
        error: 'Não foi possível acessar a aplicação.',
        passed: 0,
        total: 0,
        tests: [],
      }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('Executando');
    expect(view.getByText('· 1/2 Pass')).toBeInTheDocument();
    expect(view.getAllByText('Não foi possível acessar a aplicação.')).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'Expandir ou recolher broken' }));
    expect(view.getAllByText('Não foi possível acessar a aplicação.')).toHaveLength(2);
    expect(view.getByText('Falhou')).toBeInTheDocument();
  });

  it('reruns, cancels and deletes runs through the actions menu', async () => {
    const client = api([
      creation(),
      creation({ id: 'c2', name: 'live', status: 'queued', passed: 0, total: 0, tests: [] }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('live');
    const menus = view.getAllByRole('button', { name: 'Ações' });

    fireEvent.click(menus[0]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Executar todos novamente/ }));
    await waitFor(() => expect(client.rerunE2eCreation).toHaveBeenCalledWith('c1'));

    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[1]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Cancelar execução/ }));
    await waitFor(() => expect(client.cancelE2eCreation).toHaveBeenCalledWith('c2'));

    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[0]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Excluir execução/ }));
    expect(view.getByText('Excluir execução E2E?')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Cancelar' }));
    expect(view.queryByText('Excluir execução E2E?')).toBeNull();

    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[0]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Excluir execução/ }));
    fireEvent.click(view.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(client.deleteE2eCreation).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(view.queryByText('Excluir execução E2E?')).toBeNull());
  });

  it('edits idle runs from the actions menu', async () => {
    const client = api([
      creation(),
      creation({ id: 'c2', name: 'live', status: 'running', passed: 0, total: 0, tests: [] }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('live');

    // Active runs cannot be edited.
    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[1]!);
    await view.findAllByRole('menuitem');
    expect(view.queryAllByRole('menuitem', { name: /Editar/ })).toHaveLength(0);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[0]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Editar/ }));
    expect(await view.findByText('Editar execução')).toBeInTheDocument();
    expect(client.getE2eCreation).toHaveBeenCalledWith('c1');
    fireEvent.click(view.getByRole('button', { name: 'Voltar' }));
    await view.findByText('live');

    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[0]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Editar/ }));
    await waitFor(() =>
      expect((view.getByLabelText('Nome da execução') as HTMLInputElement).value).toBe('ama'),
    );
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Salvar' }));
    expect(
      await view.findByText(
        '"ama v2" atualizada. Use "Executar todos novamente" para rodar com a nova configuração.',
      ),
    ).toBeInTheDocument();
    expect(client.updateE2eCreation).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ prd: 'PRD' }),
    );
  });

  it('shows where the scripts live and pulls them from the repository', async () => {
    const client = api([
      creation(),
      creation({
        id: 'c2',
        name: 'azure run',
        repository: {
          provider: 'azure_devops',
          id: 'g',
          name: 'Finance/app',
          branch: 'develop',
          path: '',
        },
      }),
      creation({ id: 'c3', name: 'legacy', repository: null }),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('legacy');
    expect(view.getByText('acme/demo-app@main/tests/e2e')).toBeInTheDocument();
    expect(view.getByText('Finance/app@develop')).toBeInTheDocument();

    const menus = view.getAllByRole('button', { name: 'Ações' });
    fireEvent.click(menus[0]!);
    fireEvent.click(await view.findByRole('menuitem', { name: /Pull dos scripts/ }));
    await waitFor(() => expect(client.pullE2eCreation).toHaveBeenCalledWith('c1'));
    expect(
      await view.findByText(
        'ama: 2 script(s) sincronizado(s), 1 importado(s) e 0 removido(s) do repositório.',
      ),
    ).toBeInTheDocument();

    // Runs created before repositories existed cannot pull.
    fireEvent.click(view.getAllByRole('button', { name: 'Ações' })[2]!);
    await view.findAllByRole('menuitem');
    expect(view.queryAllByRole('menuitem', { name: /Pull dos scripts/ })).toHaveLength(0);
  });

  it('reports action failures', async () => {
    const client = api();
    client.rerunE2eCreation.mockRejectedValueOnce(new Error('Já em andamento'));
    client.rerunE2eCreation.mockRejectedValueOnce('boom');
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('ama');
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(await view.findByRole('menuitem', { name: /Executar todos novamente/ }));
    expect(await view.findByText('Já em andamento')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Ações' }));
    fireEvent.click(await view.findByRole('menuitem', { name: /Executar todos novamente/ }));
    expect(await view.findByText('Não foi possível concluir a ação.')).toBeInTheDocument();
  });

  it('shows the empty state, load errors and retries', async () => {
    const empty = render(<E2eView apiClient={asClient(api([]))} />);
    expect(await empty.findByText('Nenhuma execução E2E ainda')).toBeInTheDocument();
    empty.unmount();

    const client = api(new Error('offline'));
    const view = render(<E2eView apiClient={asClient(client)} />);
    expect(await view.findByText('offline')).toBeInTheDocument();
    client.getE2eCreations.mockRejectedValueOnce('down');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await view.findByText('Não foi possível carregar as execuções E2E.'),
    ).toBeInTheDocument();
    client.getE2eCreations.mockResolvedValueOnce([creation()]);
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText('ama')).toBeInTheDocument();
  });

  it('opens the configuration form, returns and opens new runs expanded', async () => {
    const client = api([creation({ tests: [] })]);
    client.createE2eCreation.mockResolvedValue(creation({ id: 'c9', name: 'new run' }));
    const view = render(<E2eView apiClient={asClient(client)} />);
    await view.findByText('ama');
    fireEvent.click(view.getByRole('button', { name: /Nova execução/ }));
    expect(await view.findByText('Configuração de testes')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: /Voltar/ }));
    await view.findByText('ama');

    client.getAgents.mockResolvedValue([{ id: 'a1', name: 'QA', role: 'QA' }]);
    client.getE2eCreations.mockResolvedValue([
      creation({ id: 'c9', name: 'new run', tests: [testSummary({ id: 't9' })] }),
      creation({ tests: [testSummary({ id: 't8', title: 'Old test' })] }),
    ]);
    fireEvent.click(view.getByRole('button', { name: /Nova execução/ }));
    await waitFor(() =>
      expect((view.getByLabelText('Agente') as HTMLSelectElement).value).toBe('a1'),
    );
    fireEvent.change(view.getByLabelText('Nome da execução'), { target: { value: 'new run' } });
    fireEvent.change(view.getByLabelText('Ou cole o conteúdo'), { target: { value: 'PRD' } });
    await waitFor(() =>
      expect(view.getByLabelText('Repositório').querySelectorAll('option').length).toBe(2),
    );
    fireEvent.change(view.getByLabelText('Repositório'), { target: { value: 'github:42' } });
    await waitFor(() =>
      expect((view.getByLabelText('Branch base') as HTMLSelectElement).value).toBe('main'),
    );
    fireEvent.change(view.getByLabelText('URL base'), {
      target: { value: 'https://example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continuar' }));
    expect(await view.findByRole('table', { name: 'new run' })).toBeInTheDocument();
    expect(view.queryByRole('table', { name: 'ama' })).toBeNull();
  });

  it('navigates to a test and back, hiding write actions for viewers', async () => {
    const client = api();
    const view = render(<E2eView apiClient={asClient(client)} isReadOnly />);
    await view.findByText('ama');
    expect(view.queryByRole('button', { name: /Nova execução/ })).toBeNull();
    expect(view.queryByRole('button', { name: 'Ações' })).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'TC001-Access public event page' }));
    expect(await view.findByTestId('e2e-test-detail')).toBeInTheDocument();
    expect(client.getE2eTest).toHaveBeenCalledWith('t1');
    fireEvent.click((await view.findAllByRole('button', { name: /Voltar/ }))[0]!);
    expect(await view.findByTestId('e2e-view')).toBeInTheDocument();
  });

  it('shows drafts waiting for a plan written through the MCP as in progress', async () => {
    const client = api([
      creation({ id: 'c3', name: 'login', status: 'draft', passed: 0, total: 0, tests: [] }),
      creation(),
    ]);
    const view = render(<E2eView apiClient={asClient(client)} />);
    expect(await view.findByText('Aguardando plano')).toBeInTheDocument();
    expect(view.getByText(/Aguardando o plano de testes e os scripts/)).toBeInTheDocument();
    const names = () =>
      Array.from(
        view.container.querySelectorAll('tbody > tr > td:nth-child(2) > span:first-child'),
      ).map((node) => node.textContent);
    fireEvent.change(view.getByLabelText('Filtrar por status'), { target: { value: 'active' } });
    expect(names()).toEqual(['login']);
    fireEvent.change(view.getByLabelText('Filtrar por status'), { target: { value: 'failed' } });
    expect(names()).toEqual(['ama']);
  });

  it('labels backend runs', async () => {
    const view = render(
      <E2eView
        apiClient={asClient(
          api([
            creation({
              mode: 'backend',
              passed: 0,
              total: 1,
              tests: [testSummary({ status: 'error' })],
            }),
          ]),
        )}
      />,
    );
    expect(await view.findByText('Backend')).toBeInTheDocument();
    expect(view.getByText('0/1 Pass')).toBeInTheDocument();
    expect(view.getByText('Erro')).toBeInTheDocument();
  });
});

describe('E2eView opened from Test Plans', () => {
  const withSavedPlans = () => ({
    ...api(),
    getE2eRunners: vi.fn().mockResolvedValue([]),
    getTestSuites: vi.fn().mockResolvedValue([]),
    getAllSavedTestPlans: vi.fn().mockResolvedValue([]),
  });

  it('opens the form of a new run for the chosen saved cases', async () => {
    const client = withSavedPlans();
    const view = render(
      <E2eView apiClient={asClient(client)} initialSavedCases={{ planId: 'plan-1' }} />,
    );
    expect(await view.findByRole('radio', { name: 'Test cases salvos no ADK' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(client.getE2eCreations).not.toHaveBeenCalled();
  });

  it('shows the list to members who cannot create runs', async () => {
    const client = withSavedPlans();
    const view = render(
      <E2eView apiClient={asClient(client)} isReadOnly initialSavedCases={{ planId: 'plan-1' }} />,
    );
    expect(await view.findByText('ama')).toBeInTheDocument();
    expect(view.queryByRole('radio', { name: 'Test cases salvos no ADK' })).toBeNull();
  });
});
